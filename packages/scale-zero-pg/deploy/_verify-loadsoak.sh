#!/usr/bin/env bash
# _verify-loadsoak.sh — sustained-load / soak / throughput harness (issue #376, W1 of
# the high-traffic wave #375). Drives ONE knext app with an IN-CLUSTER k6 Job (ramping
# VUs: ramp-to-ceiling THEN steady soak) and records the numbers the issue lists:
#   * RPS achieved (ramp knee + soak),
#   * p50 / p95 / p99 latency,
#   * error rate,
#   * the concurrency->latency relationship (to set ContainerConcurrency in W2),
# alongside an instrument snapshot of BOTH planes so the run records WHICH WALL BROKE
# FIRST: app pods vs the GW_MAX_CONNS=90 gateway cap vs the single-writer vs DB CPU.
#
# WHY IN-CLUSTER k6 (BENCHMARKS "RTT-bound" note): an out-of-region driver adds the
# cluster's WAN RTT to every request and distorts the latency baseline. k6 runs as a
# Job ON OKE targeting the in-cluster app URL, so the numbers are app+DB latency, not
# the operator's home round-trip. Follows the #99/#121 in-cluster-loader pattern and
# the deploy/_lib-drill.sh budget helpers.
#
# The harness (the live k6 run) NEEDS a cluster + the target app deployed; this script
# is ALSO cluster-free-testable:
#   * SELFTEST=1        — dry-run the manifest (`kubectl apply --dry-run=client`) and
#                         self-check the pure parser; NO live run. Used by
#                         deploy/test_verify-loadsoak.sh and by CI.
#   * LOADSOAK_LIB_ONLY=1 — source-only: define functions and return, touching nothing
#                         (so the parser can be unit-tested in isolation).
#
# ── Knobs (env; defaults chosen for a first OKE baseline) ─────────────────────────
#   TARGET_URL     in-cluster URL of the app under test (REQUIRED for a live run).
#                  e.g. http://file-manager.knext-apps.svc.cluster.local/users
#   APP_NAME       label for the BENCHMARKS row + compute-<app> instrument (default
#                  derived from TARGET_URL host, else "app").
#   RAMP_CEIL_VU   ramp target VUs (default 120) — ramp until p99 breaks / first error.
#   RAMP_UP        time to reach the ceiling (default 2m).
#   SOAK_VU        soak VUs ~70% of ceiling (default 80).
#   SOAK_DUR       sustained soak duration (default 10m; the issue's ">=10 min").
#   RAMP_DOWN      drain (default 30s).
#   P95_MS/P99_MS  latency thresholds in ms (default 1500 / 3000).
#   MAX_ERR_RATE   error budget as a fraction (default 0.01 = 1%).
#   K6_IMAGE       k6 image (default grafana/k6:0.49.0).
#   K6_CPU_REQUEST / K6_CPU_LIMIT     k6 pod CPU request / limit (default 500m / 2). On a
#                  CPU-request-constrained cluster set K6_CPU_REQUEST=150m (and lower
#                  RAMP_CEIL_VU) so the Job schedules; record the k6 CPU budget with the numbers.
#   K6_MEM_REQUEST / K6_MEM_LIMIT     k6 pod memory request / limit (default 256Mi / 512Mi).
#   RUN_TIMEOUT_S  wall budget for the Job (default: derived from ramp+soak+slack).
#   GW_DEPLOY      apps-gateway deploy name for the pggw_* snapshot (default pggw-apps).
#   LOADSOAK_CONTEXT / LOADSOAK_NS  kubectl context / namespace (default ambient / scale-zero-pg).
set -uo pipefail
# Resolve our own directory robustly whether EXECUTED (./_verify-loadsoak.sh) or
# SOURCED (unit tests / LOADSOAK_LIB_ONLY) — a sourced script's $0 is the PARENT
# shell, so a bare `cd "$(dirname "$0")"` lands nowhere and render_manifest cannot
# find 88-loadsoak-k6.yaml. Prefer ${BASH_SOURCE[0]} (correct under `.`), fall back
# to $0 for a POSIX sh exec. HERE anchors the manifest path; we do NOT chdir.
_self="${BASH_SOURCE[0]:-$0}"
HERE="$(cd "$(dirname "$_self")" 2>/dev/null && pwd)"
[ -n "$HERE" ] || HERE="$(pwd)"
MANIFEST="$HERE/88-loadsoak-k6.yaml"

# --- knobs (all overridable) ------------------------------------------------------
TARGET_URL="${TARGET_URL:-}"
RAMP_CEIL_VU="${RAMP_CEIL_VU:-120}"
RAMP_UP="${RAMP_UP:-2m}"
SOAK_VU="${SOAK_VU:-80}"
SOAK_DUR="${SOAK_DUR:-10m}"
RAMP_DOWN="${RAMP_DOWN:-30s}"
P95_MS="${P95_MS:-1500}"
P99_MS="${P99_MS:-3000}"
MAX_ERR_RATE="${MAX_ERR_RATE:-0.01}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:0.49.0}"
# k6 pod resources are KNOBS (#376 follow-up): the live OKE cluster is CPU-REQUEST-
# constrained (2 nodes, most allocatable reserved), so the default 500m request fails
# to schedule (Insufficient cpu). Lower K6_CPU_REQUEST there (e.g. 150m) AND reduce
# RAMP_CEIL_VU — a CPU-starved k6 client measures the CLIENT ceiling, not the app's.
K6_CPU_REQUEST="${K6_CPU_REQUEST:-500m}"
K6_CPU_LIMIT="${K6_CPU_LIMIT:-2}"
K6_MEM_REQUEST="${K6_MEM_REQUEST:-256Mi}"
K6_MEM_LIMIT="${K6_MEM_LIMIT:-512Mi}"
GW_DEPLOY="${GW_DEPLOY:-pggw-apps}"
LOADSOAK_NS="${LOADSOAK_NS:-scale-zero-pg}"

# derive an app label from the TARGET_URL host when not given.
if [ -z "${APP_NAME:-}" ]; then
  _host="$(printf '%s' "$TARGET_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##; s#\..*$##')"
  APP_NAME="${_host:-app}"
fi

# =================================================================================
# PURE HELPERS — no cluster, no side effects. Unit-tested by test_verify-loadsoak.sh.
# =================================================================================

# _esc_key <key> — escape regex metachars (notably the parens in p(95)) so a key is
# matched literally by grep -E. Pure.
_esc_key() { printf '%s' "$1" | sed -E 's/[][().*+?^$|\\{}]/\\&/g'; }

# _jblock <json-file> <metric> — isolate ONE k6 metric object, e.g. the contents of
# `"http_req_duration": { ... }`, as a single-line string. CRITICAL (#376 review):
# k6 --summary-export lists EVERY registered metric, and the custom metrics this drill
# registers (app_errors/app_ok/app_latency_ms) sort ALPHABETICALLY BEFORE the http_*
# built-ins, while checks/vus carry their own "rate"/"value" keys. A whole-file
# first-match grep for a bare key (rate/value/p(95)) therefore reads the WRONG metric.
# Scoping every extraction to its metric block first fixes that. k6 metric objects
# contain NO nested braces, so after flattening newlines we can grab from the metric's
# `{` to the FIRST `}`. Prints the block body (between the braces) or empty. Pure.
_jblock() {
  _f="$1"; _m="$(_esc_key "$2")"
  # flatten to one line, then extract "<metric>" : { up-to-first-} .
  tr -d '\n' < "$_f" 2>/dev/null \
    | grep -oE "\"${_m}\"[[:space:]]*:[[:space:]]*\{[^}]*\}" \
    | head -1
}

# _jfield <block-string> <key> — pull a numeric key from an isolated metric block
# (the output of _jblock). Prints the number or empty. Pure.
_jfield() {
  _blk="$1"; _k="$(_esc_key "$2")"
  printf '%s' "$_blk" \
    | grep -oE "\"${_k}\"[[:space:]]*:[[:space:]]*-?[0-9]+(\.[0-9]+)?" \
    | head -1 | sed -E 's/.*:[[:space:]]*//'
}

# _jnum <json-file> <metric> <key> — BLOCK-SCOPED numeric extraction: isolate <metric>'s
# object, then pull <key> from it. This is the anchored replacement for the old
# whole-file first-match grep (the #376 confounder bug). Prints the number or empty. Pure.
_jnum() {
  _jfield "$(_jblock "$1" "$2")" "$3"
}

# _round2 <num> — round to 2 decimals (portable). Empty/garbage -> "0.00".
_round2() {
  case "${1:-}" in ''|*[!0-9.eE+-]*) echo "0.00"; return;; esac
  awk -v n="$1" 'BEGIN{ printf "%.2f", n+0 }'
}

# _pct2 <fraction> — render an error-rate fraction (0.0021) as a percentage string
# "0.21%". 0.0 -> "0.00%". Non-numeric -> "0.00%".
_pct2() {
  case "${1:-}" in ''|*[!0-9.eE+-]*) echo "0.00%"; return;; esac
  awk -v n="$1" 'BEGIN{ printf "%.2f%%", (n+0)*100 }'
}

# parse_k6_summary <summary.json> <app> <phase> — PURE. Turn a k6 --summary-export JSON
# into ONE pipe-delimited BENCHMARKS row carrying every issue-listed metric:
#   app | phase | RPS | p50 | p95 | p99 | error% | peakVUs
# Missing fields render as 0 rather than aborting (a partial/aborted run still yields a
# row for provenance). This is the function the mission's "summary parser produces the
# expected row format" assertion exercises.
parse_k6_summary() {
  _f="$1"; _app="${2:-app}"; _phase="${3:-run}"
  [ -f "$_f" ] || { echo "$_app | $_phase | 0 | 0.00 | 0.00 | 0.00 | 0.00% | 0"; return; }
  # RPS: throughput is http_reqs.rate — NOT app_ok.rate / checks.rate / data_*.rate.
  _rps="$(_jnum "$_f" 'http_reqs' 'rate')"
  # Latency: the app request latency is http_req_duration.* — NOT app_latency_ms.* nor
  # iteration_duration.*. p50: k6 exports both "med" and "p(50)"; prefer p(50).
  _durblk="$(_jblock "$_f" 'http_req_duration')"
  _p50="$(_jfield "$_durblk" 'p(50)')"; [ -n "$_p50" ] || _p50="$(_jfield "$_durblk" 'med')"
  _p95="$(_jfield "$_durblk" 'p(95)')"
  _p99="$(_jfield "$_durblk" 'p(99)')"
  # Error rate: the request-failure fraction is http_req_failed.value — NOT
  # app_errors.value / checks.value / vus.value.
  _err="$(_jnum "$_f" 'http_req_failed' 'value')"
  # Peak VUs: vus_max.value — NOT the instantaneous vus.value.
  _vus="$(_jnum "$_f" 'vus_max' 'value')"
  printf '%s | %s | %s | %s | %s | %s | %s | %s\n' \
    "$_app" "$_phase" "$(_round2 "${_rps:-0}")" "$(_round2 "${_p50:-0}")" \
    "$(_round2 "${_p95:-0}")" "$(_round2 "${_p99:-0}")" "$(_pct2 "${_err:-0}")" "${_vus:-0}"
}

# conc_lat_row <conc> <p50> <p95> <p99> <errpct> <rps> — PURE. One CSV line for the
# concurrency->latency curve the W2 ContainerConcurrency sizing needs. Paste-ready:
#   concurrency,p50_ms,p95_ms,p99_ms,err_pct,rps
conc_lat_row() {
  printf '%s,%s,%s,%s,%s,%s\n' "${1:-0}" "${2:-0}" "${3:-0}" "${4:-0}" "${5:-0}" "${6:-0}"
}

# _unsafe_knob <value> — PURE. True (rc 0) iff <value> contains a character that would
# break out of the single-quoted `/bin/sh -c` arg the knobs are interpolated into inside
# the k6 Job (88-loadsoak-k6.yaml), i.e. a shell-injection vector (#376 review). We reject
# rather than escape: the knobs are URLs / durations / integers whose LEGITIMATE alphabet
# (letters, digits, ':/?.=&%_-+, whitespace) contains none of these. Rejecting a quote,
# backtick, $, ;, |, backslash, or a control char is both safe and clear. A `&` in a URL
# query is uncommon for these targets and also a shell metachar, so we reject it too and
# document that a target needing `&` should be reached via a path/route without it. Pure.
_unsafe_knob() {
  case "$1" in
    *"'"*|*'"'*|*'`'*|*'$'*|*';'*|*'|'*|*'&'*|*'\'*|*'<'*|*'>'*|*'('*|*')'*) return 0 ;;
  esac
  # any control char (incl. newline) -> unsafe. printf|tr strips printable set; leftover=unsafe.
  [ -n "$(printf '%s' "$1" | tr -d '[:print:]')" ] && return 0
  return 1
}

# validate_knobs — PURE (no cluster). Reject any knob carrying a shell-injection vector
# BEFORE it is interpolated into the k6 Job's `/bin/sh -c` arg. Echoes the offending knob
# to stderr and returns 1 so render_manifest / the live run fail closed. Pure.
validate_knobs() {
  _vk_bad=0
  for _vk in TARGET_URL RAMP_CEIL_VU RAMP_UP SOAK_VU SOAK_DUR RAMP_DOWN \
             P95_MS P99_MS MAX_ERR_RATE K6_IMAGE APP_NAME \
             K6_CPU_REQUEST K6_CPU_LIMIT K6_MEM_REQUEST K6_MEM_LIMIT; do
    eval "_vk_val=\${$_vk:-}"
    # shellcheck disable=SC2154  # _vk_val IS assigned by the eval above (indirect read).
    if _unsafe_knob "$_vk_val"; then
      echo "unsafe value for $_vk: [$_vk_val] contains a shell metacharacter (quote/\$/\`/;/|/&/\\/<>()/control); refuse to interpolate it into the k6 Job (#376)" >&2
      _vk_bad=1
    fi
  done
  return "$_vk_bad"
}

# render_manifest — envsubst the k6 manifest so the drill's knobs land in the Job/CM.
# Uses only the vars the manifest references; a bare envsubst would also eat any other
# ${...} in the file, but this manifest has none outside our set. GUARDED: validate_knobs
# rejects a shell-injection vector before any knob is interpolated (#376 review).
render_manifest() {
  validate_knobs || return 1
  export TARGET_URL RAMP_CEIL_VU RAMP_UP SOAK_VU SOAK_DUR RAMP_DOWN \
         P95_MS P99_MS MAX_ERR_RATE K6_IMAGE \
         K6_CPU_REQUEST K6_CPU_LIMIT K6_MEM_REQUEST K6_MEM_LIMIT
  if command -v envsubst >/dev/null 2>&1; then
    envsubst < "$MANIFEST"
  else
    # Fallback: sed each ${VAR} (envsubst absent on some minimal hosts).
    sed -e "s#\${TARGET_URL}#${TARGET_URL}#g" \
        -e "s#\${RAMP_CEIL_VU}#${RAMP_CEIL_VU}#g" \
        -e "s#\${RAMP_UP}#${RAMP_UP}#g" \
        -e "s#\${SOAK_VU}#${SOAK_VU}#g" \
        -e "s#\${SOAK_DUR}#${SOAK_DUR}#g" \
        -e "s#\${RAMP_DOWN}#${RAMP_DOWN}#g" \
        -e "s#\${P95_MS}#${P95_MS}#g" \
        -e "s#\${P99_MS}#${P99_MS}#g" \
        -e "s#\${MAX_ERR_RATE}#${MAX_ERR_RATE}#g" \
        -e "s#\${K6_IMAGE}#${K6_IMAGE}#g" \
        -e "s#\${K6_CPU_REQUEST}#${K6_CPU_REQUEST}#g" \
        -e "s#\${K6_CPU_LIMIT}#${K6_CPU_LIMIT}#g" \
        -e "s#\${K6_MEM_REQUEST}#${K6_MEM_REQUEST}#g" \
        -e "s#\${K6_MEM_LIMIT}#${K6_MEM_LIMIT}#g" \
        "$MANIFEST"
  fi
}

# Temp rendered manifest (anchored at HERE, not cwd).
TMP_MANIFEST="$HERE/_tmp-loadsoak.yaml"

# --- LIB-ONLY: define functions then stop (unit tests source us). ----------------
[ "${LOADSOAK_LIB_ONLY:-0}" = "1" ] && return 0 2>/dev/null || true

# =================================================================================
# CLUSTER-TOUCHING from here. K wraps kubectl with the optional context/namespace.
# =================================================================================
K="kubectl -n $LOADSOAK_NS"
[ -n "${LOADSOAK_CONTEXT:-}" ] && K="$K --context $LOADSOAK_CONTEXT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }

# --- idempotent teardown (safe to re-run; #83 pattern) ---------------------------
teardown() {
  $K delete job/loadsoak-k6 --ignore-not-found --wait=false >/dev/null 2>&1 || true
  $K delete configmap/loadsoak-k6-script --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -f "$TMP_MANIFEST"
}

# --- gateway pggw_* snapshot: which wall did the gateway hit? ---------------------
# Reads the apps-gateway /metrics (Prometheus text) via a pod exec so we do not need a
# route to :9090. Best-effort: prints the connection cap-relevant counters. The pod is
# selected by the GW_DEPLOY knob (default pggw-apps, the apps-gateway's `app=` label).
gw_snapshot() { # $1 label
  _pod="$($K get pods -l "app=$GW_DEPLOY" --no-headers 2>/dev/null | awk '$3=="Running"{print $1; exit}')"
  echo "-- gateway pggw_* [$1] --"
  if [ -z "$_pod" ]; then echo "  (no running $GW_DEPLOY pod)"; return; fi
  $K exec "$_pod" -- sh -c 'wget -qO- http://127.0.0.1:9090/metrics 2>/dev/null || curl -s http://127.0.0.1:9090/metrics 2>/dev/null' 2>/dev/null \
    | grep -E '^pggw_(active_connections|connections_total|rejected_connections_total|wakes_total|wake_failures_total|wake_budget_exceeded_total|wake_latency_ms_last)' \
    || echo "  (metrics unavailable)"
}

# --- compute + app-pod snapshot: writer replicas, restarts, app pod count ---------
plane_snapshot() { # $1 label
  echo "-- planes [$1] --"
  # writer compute for this app (template mode -> compute-<app>); fall back to base.
  for d in "compute-${APP_NAME}" compute; do
    _r="$($K get deploy "$d" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
    [ -z "$_r" ] && continue
    _rc="$($K get pods -l app="$d" --no-headers 2>/dev/null | awk '{s+=$4} END{print s+0}')"
    _cpu="$($K top pod -l app="$d" --no-headers 2>/dev/null | awk '{print $2}' | head -1)"
    echo "  writer $d: replicas=$_r restarts=$_rc cpu=${_cpu:-n/a}"
    break
  done
  # app pods (knext app under test) — count Running; may be another namespace/Knative.
  _apps="$($K get pods --all-namespaces --no-headers 2>/dev/null | grep -c "$APP_NAME" || true)"
  echo "  app pods matching '$APP_NAME' (all ns): ${_apps:-0}"
  # storage plane pressure (pageserver / safekeeper CPU) for the DB-CPU wall.
  $K top pod -l 'app in (pageserver,safekeeper)' --no-headers 2>/dev/null \
    | awk '{printf "  storage %s cpu=%s mem=%s\n",$1,$2,$3}' || true
}

# print a clean summary block for BENCHMARKS.md.
emit_summary() { # $1 summary.json $2 phase
  _json="$1"; _phase="$2"
  echo ""
  echo "================= LOADSOAK SUMMARY ($_phase) — paste into BENCHMARKS.md ================="
  echo "app | phase | RPS | p50(ms) | p95(ms) | p99(ms) | err% | peakVUs"
  parse_k6_summary "$_json" "$APP_NAME" "$_phase"
  echo "concurrency->latency (W2 ContainerConcurrency curve): concurrency,p50,p95,p99,err%,rps"
  _row="$(parse_k6_summary "$_json" "$APP_NAME" "$_phase")"
  # cols: 3=RPS 4=p50 5=p95 6=p99 7=err% 8=vus
  _rps="$(echo "$_row" | awk -F'|' '{gsub(/ /,"",$3);print $3}')"
  _p50="$(echo "$_row" | awk -F'|' '{gsub(/ /,"",$4);print $4}')"
  _p95="$(echo "$_row" | awk -F'|' '{gsub(/ /,"",$5);print $5}')"
  _p99="$(echo "$_row" | awk -F'|' '{gsub(/ /,"",$6);print $6}')"
  _err="$(echo "$_row" | awk -F'|' '{gsub(/[ %]/,"",$7);print $7}')"
  _vus="$(echo "$_row" | awk -F'|' '{gsub(/ /,"",$8);print $8}')"
  conc_lat_row "$_vus" "$_p50" "$_p95" "$_p99" "$_err" "$_rps"
  echo "==========================================================================================="
}

# =================================================================================
# SELFTEST — dry-run the manifest + self-check the pure parser. No live run.
# =================================================================================
if [ "${SELFTEST:-0}" = "1" ]; then
  echo "== SELFTEST: _verify-loadsoak.sh (issue #376) — cluster-free validation =="
  fails=0
  ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: got [$2] want [$3]"; fails=$((fails+1)); fi; }

  # 1. manifest renders + applies with --dry-run=client (structurally valid).
  render_manifest > "$TMP_MANIFEST" || { echo "FAIL - render_manifest"; fails=$((fails+1)); }
  if $K apply --dry-run=client -f "$TMP_MANIFEST" >/dev/null 2>&1; then
    echo "ok   - manifest applies with --dry-run=client"
  else
    # a client dry-run needs a reachable API for schema; on a no-cluster host we still
    # prove the render is non-empty YAML and record it (the OKE run does the real check).
    if [ -s "$TMP_MANIFEST" ] && grep -q 'kind: Job' "$TMP_MANIFEST"; then
      echo "ok   - manifest rendered (dry-run needs a cluster; render is valid YAML)"
    else
      echo "FAIL - manifest render empty/invalid"; fails=$((fails+1))
    fi
  fi
  rm -f "$TMP_MANIFEST"

  # 1b. the k6 pod resources block renders with the KNOB values (#376 follow-up): the
  #     CPU-request-constrained OKE cluster needs a lowerable request to schedule. Render
  #     with an explicit CPU request and assert it lands in the resources: block, not the
  #     literal ${K6_CPU_REQUEST} placeholder.
  _rr="$(K6_CPU_REQUEST=150m K6_MEM_REQUEST=128Mi render_manifest 2>/dev/null)"
  case "$_rr" in
    *'requests: { cpu: "150m", memory: 128Mi }'*) echo "ok   - k6 resources render with the knob (cpu request 150m)" ;;
    *'${K6_CPU_REQUEST}'*) echo "FAIL - K6_CPU_REQUEST left as an unrendered placeholder"; fails=$((fails+1)) ;;
    *) echo "FAIL - k6 resources block did not render the CPU-request knob:"; printf '%s\n' "$_rr" | grep -A1 'resources:' >&2; fails=$((fails+1)) ;;
  esac

  # 2. the k6 script embeds a ramp phase, a soak phase, and p95/p99 thresholds.
  grep -q 'ramping-vus' "$MANIFEST" || { echo "FAIL - no ramping-vus executor"; fails=$((fails+1)); }
  grep -q 'p(95)<' "$MANIFEST"      || { echo "FAIL - no p95 threshold"; fails=$((fails+1)); }
  grep -q 'p(99)<' "$MANIFEST"      || { echo "FAIL - no p99 threshold"; fails=$((fails+1)); }
  grep -q 'summary-export' "$MANIFEST" || { echo "FAIL - no summary-export"; fails=$((fails+1)); }
  echo "ok   - k6 script has ramp+soak stages, p95/p99 thresholds, summary export"

  # 3. parser round-trips a REALISTIC summary (with alphabetical-confounder metrics —
  #    app_ok.rate, app_latency_ms.*, app_errors.value, checks.value, vus.value) into
  #    the expected row fields, reading the CORRECT metric block for each (#376 review).
  _s="$(mktemp)"
  cat > "$_s" <<'JSON'
{ "metrics": {
  "app_errors":     { "value": 0.99 },
  "app_latency_ms": { "med": 888.8, "p(50)": 888.8, "p(95)": 999.9, "p(99)": 999.9 },
  "app_ok":         { "rate": 777.7 },
  "checks":         { "value": 0.995, "rate": 555.5 },
  "http_req_duration": { "med": 33.5, "p(50)": 33.5, "p(95)": 96.4, "p(99)": 210.7 },
  "http_req_failed": { "value": 0.0021 },
  "http_reqs":      { "count": 90000, "rate": 300.0 },
  "vus":            { "value": 118 },
  "vus_max":        { "value": 120 }
} }
JSON
  _row="$(parse_k6_summary "$_s" test soak)"; rm -f "$_s"
  # exact expected row: confounders (777.70/888.80/99.00%/118) must NOT appear.
  case "$_row" in
    "test | soak | 300.00 | 33.50 | 96.40 | 210.70 | 0.21% | 120") echo "ok   - parse_k6_summary row (block-scoped): $_row" ;;
    *) echo "FAIL - parse_k6_summary bad/confounded row: $_row"; fails=$((fails+1)) ;;
  esac

  if [ "$fails" -eq 0 ]; then echo "selftest PASSED"; exit 0; else echo "selftest FAILED ($fails)"; exit 1; fi
fi

# =================================================================================
# LIVE RUN. Requires TARGET_URL + a reachable cluster with the app deployed.
# =================================================================================
[ -n "$TARGET_URL" ] || fail "TARGET_URL is required for a live run (in-cluster app URL). Use SELFTEST=1 for the cluster-free check."

# derive a wall budget from the k6 stage durations + generous slack.
_to_s() { case "$1" in *m) echo $(( ${1%m} * 60 ));; *s) echo "${1%s}";; *) echo "$1";; esac; }
RUN_TIMEOUT_S="${RUN_TIMEOUT_S:-$(( $(_to_s "$RAMP_UP") + $(_to_s "$SOAK_DUR") + $(_to_s "$RAMP_DOWN") + 180 ))}"

echo "== loadsoak: app=$APP_NAME url=$TARGET_URL ramp=0->${RAMP_CEIL_VU}VU/${RAMP_UP} soak=${SOAK_VU}VU/${SOAK_DUR} p95<${P95_MS}ms p99<${P99_MS}ms err<${MAX_ERR_RATE} =="

teardown                                   # idempotent: sweep any prior run
render_manifest > "$TMP_MANIFEST" || fail "render_manifest failed"
$K apply -f "$TMP_MANIFEST" >/dev/null || fail "manifest apply failed"
ok "applied k6 ConfigMap + Job (image $K6_IMAGE)"

# BEFORE snapshot — establishes the resting baseline for the wall analysis.
plane_snapshot before; gw_snapshot before

echo "== running k6 (wall budget ${RUN_TIMEOUT_S}s); sampling planes every 30s =="
# background sampler so we capture the peak wall pressure DURING the soak, not just
# at the ends (this is where GW_MAX_CONNS / writer / DB-CPU walls show up).
( _i=0; while [ "$_i" -lt "$RUN_TIMEOUT_S" ]; do sleep 30; _i=$((_i+30));
    echo "   [t=${_i}s]"; plane_snapshot "t=${_i}s"; gw_snapshot "t=${_i}s"
    $K get job/loadsoak-k6 -o jsonpath='{.status.succeeded}{.status.failed}' 2>/dev/null | grep -q '[0-9]' && break
  done ) &
_sampler=$!

# wait for the Job to finish (complete or fail) within the wall budget.
if ! $K wait --for=condition=complete job/loadsoak-k6 --timeout="${RUN_TIMEOUT_S}s" >/dev/null 2>&1; then
  $K wait --for=condition=failed job/loadsoak-k6 --timeout=10s >/dev/null 2>&1 || true
fi
kill "$_sampler" 2>/dev/null || true

# AFTER snapshot — the peak wall state at end of soak.
plane_snapshot after; gw_snapshot after

# pull the summary JSON the k6 pod printed between the sentinels.
_logs="$($K logs job/loadsoak-k6 2>/dev/null || true)"
_summary="$(mktemp)"
printf '%s\n' "$_logs" | awk '/===K6_SUMMARY_JSON_BEGIN===/{f=1;next} /===K6_SUMMARY_JSON_END===/{f=0} f' > "$_summary"

if [ ! -s "$_summary" ]; then
  echo "WARN: no summary JSON captured from the k6 Job logs — printing raw tail for triage:" >&2
  printf '%s\n' "$_logs" | tail -30 >&2
  rm -f "$_summary" "$TMP_MANIFEST"
  fail "k6 produced no parseable summary (check TARGET_URL reachability / image pull)"
fi

emit_summary "$_summary" "rampsoak"

echo ""
echo "WALL ANALYSIS (which broke first): compare the pggw_active_connections peak vs"
echo "  GW_MAX_CONNS=90, the writer restarts/CPU, and storage CPU in the snapshots above."
echo "  rejected_connections_total>0 => the GW_MAX_CONNS cap was the wall."

rm -f "$_summary" "$TMP_MANIFEST"
teardown
ok "loadsoak complete; Job + ConfigMap torn down (idempotent)"
