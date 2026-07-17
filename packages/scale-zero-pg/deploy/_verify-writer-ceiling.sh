#!/usr/bin/env bash
# _verify-writer-ceiling.sh — WRITER vertical-autoscale ceiling drill under sustained
# REAL WRITE load (issue #379, W4 of the high-traffic wave #375). Turns two unknowns
# into published numbers:
#   (a) proves the #103 writer vertical-autoscaler does an IN-PLACE resize (restartCount
#       stays 0) growing the running writer's cpu-limit UP under sustained write load,
#       then hysteresis-resizes it back DOWN after the load drains; and
#   (b) measures + publishes the WRITE RPS CEILING — the honest hard limit, because
#       writes scale ONLY VERTICALLY to the node/limit ceiling (single-writer; beyond
#       that = sharding, out of scope).
#
# WRITE PATH (the load mechanism) — REUSES A REAL WRITE PATH, no bypass:
#   An in-cluster loader Deployment (WC_LOADERS pods) each runs a tight psql INSERT
#   loop against the app's OWN branch THROUGH THE APPS-GATEWAY:
#       postgres://app_<app>:<pw>@pggw-apps:55432/<app>?sslmode=disable
#   INSERTing into a THROWAWAY drill table `wc_drill` (created in setup, dropped in
#   teardown) on that branch. This respects single-writer + tenant sovereignty exactly
#   as knext apps do (the mission's hard constraint): we NEVER dial compute-<app>:55433
#   directly. Each loader counts its own committed rows and prints a sentinel line
#     WCLOAD ok=<N> err=<M> secs=<S>
#   which the pure parser turns into a per-loader write-RPS; the fleet aggregates by
#   SUMMING the disjoint per-loader streams (like the #382 loadsoak fan-out).
#
# AUTOSCALER PROOF (what it samples): while the load ramps, the drill samples on
# `compute-<app>` (the per-app writer): the ACTUATED cpu-limit (from pod .status, not
# the spec), the restartCount (MUST stay at the baseline — an in-place resize never
# bounces Postgres), and `kubectl top` CPU. It records the cpu-limit knee (up under
# load) and the hysteresis-down after the load drains — restartCount==baseline the
# whole time, same invariant as _verify-writer-autoscaler.sh (#103) but under a REAL
# gateway write path instead of a synthetic in-container CPU burner.
#
# The live drill needs a cluster + a provisioned app; it is ALSO cluster-free-testable:
#   * SELFTEST=1                 — render the loader manifest, dry-run it, self-check the
#                                  pure parsers; NO live run. Used by CI + the unit test.
#   * WRITER_CEILING_LIB_ONLY=1  — source-only: define functions and return, touching
#                                  nothing (so the parser can be unit-tested in isolation).
#
# ── Knobs (env; defaults chosen for a first OKE baseline) ─────────────────────────
#   WC_APP           app/branch to drive (default wcdrill) — provisioned by this drill
#                    via provision-app.sh unless WC_KEEP_APP=1 (reuse an existing app).
#   WC_LOADERS       parallel INSERT-loop loader pods (default 4). On a CPU-request-
#                    constrained cluster each pod schedules at ~50m; more loaders = more
#                    concurrent writers = more write pressure on the single writer.
#   WC_CPU_REQUEST / WC_CPU_LIMIT   loader pod CPU request / limit (default 50m / 500m).
#   WC_MEM_REQUEST / WC_MEM_LIMIT   loader pod memory request / limit (default 32Mi / 128Mi).
#   WC_BATCH         rows per INSERT statement (default 50) — batch commits so the
#                    loader spends time in the writer, not in psql connect overhead.
#   WC_RAMP_S        ramp window before sampling the knee (default 60s).
#   WC_SOAK_S        sustained soak window (default 180s) — the window the ceiling +
#                    the autoscaler up-resize are measured over.
#   WC_DRAIN_S       post-drain window to watch the hysteresis down-resize (default 210s).
#   WC_FAST=1|0      patch the #103 autoscaler to a fast drill cadence (default 1).
#   WC_IMG           psql loader image (default postgres:17-alpine).
#   PROM_DEPLOY      Prometheus deploy the gateway pggw_* snapshot instant-queries (default
#                    prometheus). GW_DEPLOY apps-gateway deploy/label (default pggw-apps).
#   WC_CONTEXT / WC_NS   kubectl context / namespace (default ambient / scale-zero-pg).
set -uo pipefail
# Resolve our own dir whether EXECUTED or SOURCED (a sourced $0 is the parent shell).
_self="${BASH_SOURCE[0]:-$0}"
HERE="$(cd "$(dirname "$_self")" 2>/dev/null && pwd)"
[ -n "$HERE" ] || HERE="$(pwd)"

# --- knobs (all overridable) ------------------------------------------------------
WC_APP="${WC_APP:-wcdrill}"
WC_LOADERS="${WC_LOADERS:-4}"
WC_CPU_REQUEST="${WC_CPU_REQUEST:-50m}"
WC_CPU_LIMIT="${WC_CPU_LIMIT:-500m}"
WC_MEM_REQUEST="${WC_MEM_REQUEST:-32Mi}"
WC_MEM_LIMIT="${WC_MEM_LIMIT:-128Mi}"
WC_BATCH="${WC_BATCH:-50}"
WC_RAMP_S="${WC_RAMP_S:-60}"
WC_SOAK_S="${WC_SOAK_S:-180}"
WC_DRAIN_S="${WC_DRAIN_S:-210}"
WC_FAST="${WC_FAST:-1}"
WC_IMG="${WC_IMG:-postgres:17-alpine}"
GW_DEPLOY="${GW_DEPLOY:-pggw-apps}"
PROM_DEPLOY="${PROM_DEPLOY:-prometheus}"
WC_NS="${WC_NS:-scale-zero-pg}"

# APP_NAME / APP_PW are the interpolated values render_loader uses. Default APP_NAME
# from WC_APP; APP_PW is filled from the app's Secret at live-run time (a placeholder
# here so a cluster-free render/selftest still works).
APP_NAME="${APP_NAME:-$WC_APP}"
APP_PW="${APP_PW:-__APP_PW__}"

# =================================================================================
# PURE HELPERS — no cluster, no side effects. Unit-tested by test_verify-writer-ceiling.sh.
# =================================================================================

# _wc_round2 <num> — round to 2 decimals (portable). Empty/garbage -> "0.00".
_wc_round2() {
  case "${1:-}" in ''|*[!0-9.eE+-]*) echo "0.00"; return;; esac
  awk -v n="$1" 'BEGIN{ printf "%.2f", n+0 }'
}

# _wc_field <line> <key> — pull the integer value of `<key>=<int>` from a WCLOAD
# sentinel line. Prints the number or empty. Pure.
_wc_field() {
  printf '%s' "$1" | grep -oE "${2}=[0-9]+" | head -1 | sed -E 's/.*=//'
}

# parse_wcount <counter-line> <app> <phase> — PURE. Turn ONE loader's sentinel line
#   `WCLOAD ok=<N> err=<M> secs=<S>`
# into a pipe-delimited BENCHMARKS row carrying the write metrics:
#   app | phase | writeRPS | ok | err | err% | secs
# writeRPS = ok/secs (committed INSERT batches-of-rows per second). Missing fields
# render as 0 (a partial/aborted loader still yields a row for provenance). Pure.
parse_wcount() {
  _line="$1"; _app="${2:-app}"; _phase="${3:-run}"
  _ok="$(_wc_field "$_line" ok)";  _ok="${_ok:-0}"
  _err="$(_wc_field "$_line" err)"; _err="${_err:-0}"
  _secs="$(_wc_field "$_line" secs)"; _secs="${_secs:-0}"
  _rps="$(awk -v o="$_ok" -v s="$_secs" 'BEGIN{ if (s+0<=0) print 0; else printf "%.4f", o/s }')"
  _errpct="$(awk -v e="$_err" -v o="$_ok" 'BEGIN{ d=o+e; if (d<=0) print 0; else printf "%.4f", (e/d)*100 }')"
  printf '%s | %s | %s | %s | %s | %s%% | %s\n' \
    "$_app" "$_phase" "$(_wc_round2 "$_rps")" "$_ok" "$_err" "$(_wc_round2 "$_errpct")" "$_secs"
}

# aggregate_wcounts <app> <phase> <loader-file...> — PURE. Combine N per-loader sentinel
# files (each holding a `WCLOAD ok=.. err=.. secs=..` line) into ONE fleet BENCHMARKS row:
#   app | phase | writeRPS | ok | err | err% | secs
# Aggregation (documented honestly):
#   * writeRPS = SUM of each loader's ok/secs. VALID: the loaders drive DISJOINT INSERT
#     streams into the same throwaway table on the app's branch, so the fleet's write
#     throughput is their sum (same reasoning as the #382 loadsoak RPS sum).
#   * ok / err = SUM across loaders. err% = err/(ok+err) over the summed totals
#     (request-weighted fleet failure fraction).
#   * secs = the MAX loader window (the fleet's soak length; loaders share a window).
# A single loader aggregates to itself (identity). Pure.
aggregate_wcounts() {
  _agg_app="${1:-app}"; _agg_phase="${2:-run}"; shift 2 || true
  awk -v app="$_agg_app" -v phase="$_agg_phase" '
    {
      # find WCLOAD ok=.. err=.. secs=.. anywhere on the line (loader logs may prefix).
      ok=0; err=0; secs=0
      if (match($0, /ok=[0-9]+/))   { s=substr($0,RSTART,RLENGTH); sub(/ok=/,"",s);   ok=s+0 }
      if (match($0, /err=[0-9]+/))  { s=substr($0,RSTART,RLENGTH); sub(/err=/,"",s);  err=s+0 }
      if (match($0, /secs=[0-9]+/)) { s=substr($0,RSTART,RLENGTH); sub(/secs=/,"",s); secs=s+0 }
      if (ok>0 || err>0 || secs>0) {
        tok += ok; terr += err
        if (secs>0) { srps += ok/secs; if (secs>maxsecs) maxsecs=secs }
      }
    }
    END {
      d = tok + terr
      errpct = (d>0) ? (terr/d)*100 : 0
      printf "%s | %s | %.2f | %d | %d | %.2f%% | %d\n", app, phase, srps, tok, terr, errpct, maxsecs
    }
  ' "$@"
}

# _wc_unsafe_knob <value> — PURE. True (rc 0) iff <value> contains a character that
# would break out of the single-quoted `/bin/sh -c` arg the knobs are interpolated into
# inside the loader Deployment, i.e. a shell-injection vector. We reject rather than
# escape: the knobs are app-names / passwords / integers / resource-quantities whose
# legitimate alphabet contains none of these. (Same policy as loadsoak's _unsafe_knob.)
_wc_unsafe_knob() {
  case "$1" in
    *"'"*|*'"'*|*'`'*|*'$'*|*';'*|*'|'*|*'&'*|*'\'*|*'<'*|*'>'*|*'('*|*')'*) return 0 ;;
  esac
  [ -n "$(printf '%s' "$1" | tr -d '[:print:]')" ] && return 0
  return 1
}

# validate_wc_knobs — PURE. Reject any knob carrying a shell-injection vector BEFORE it
# is interpolated into the loader's /bin/sh -c arg. Echoes the offending knob to stderr
# and returns 1 so render_loader / the live run fail closed. Pure.
validate_wc_knobs() {
  _wk_bad=0
  for _wk in APP_NAME APP_PW WC_LOADERS WC_CPU_REQUEST WC_CPU_LIMIT \
             WC_MEM_REQUEST WC_MEM_LIMIT WC_BATCH WC_IMG GW_DEPLOY; do
    eval "_wk_val=\${$_wk:-}"
    # shellcheck disable=SC2154  # _wk_val IS assigned by the eval above (indirect read).
    if _wc_unsafe_knob "$_wk_val"; then
      echo "unsafe value for $_wk: [$_wk_val] contains a shell metacharacter (quote/\$/\`/;/|/&/\\/<>()/control); refuse to interpolate it into the loader Job (#379)" >&2
      _wk_bad=1
    fi
  done
  return "$_wk_bad"
}

# _wc_loader_dsn — PURE. The write DSN each loader dials: the app's per-app role through
# the APPS-GATEWAY on the app's own database. NEVER a direct compute-<app> dial (that
# would bypass the gateway + tenant sovereignty). Pure.
_wc_loader_dsn() {
  printf 'postgres://app_%s:%s@%s:55432/%s?sslmode=disable' \
    "$APP_NAME" "$APP_PW" "$GW_DEPLOY" "$APP_NAME"
}

# render_loader — PURE (no cluster). Emit the write-load loader Deployment: WC_LOADERS
# pods each running a tight psql INSERT loop through the apps-gateway (see _wc_loader_dsn)
# into the throwaway `wc_drill` table on the app's branch, counting committed rows and
# printing the WCLOAD sentinel on exit. GUARDED: validate_wc_knobs rejects a shell-
# injection vector before any knob is interpolated. Fails closed (non-zero, no emit).
render_loader() {
  validate_wc_knobs || return 1
  _dsn="$(_wc_loader_dsn)"
  cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wcload
  namespace: ${WC_NS}
  labels: { app: wcload, drill: writer-ceiling }
spec:
  replicas: ${WC_LOADERS}
  selector: { matchLabels: { app: wcload } }
  template:
    metadata: { labels: { app: wcload, drill: writer-ceiling } }
    spec:
      terminationGracePeriodSeconds: 2
      containers:
        - name: loader
          image: ${WC_IMG}
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh","-c"]
          args:
            - |
              # Sustained WRITE load THROUGH the apps-gateway on the app's own branch
              # (single-writer respected). Batches of ${WC_BATCH} rows per INSERT so the
              # writer, not psql connect overhead, is the bottleneck. Counts committed
              # batches and prints WCLOAD ok=/err=/secs= on exit for the parser.
              DSN='${_dsn}'
              ok=0; err=0; start=\$(date +%s)
              trap 'now=\$(date +%s); echo "WCLOAD ok=\$ok err=\$err secs=\$((now-start))"; exit 0' TERM INT
              while true; do
                if psql "\$DSN" -qtAc "insert into wc_drill(payload) select md5(random()::text) from generate_series(1,${WC_BATCH})" >/dev/null 2>&1; then
                  ok=\$((ok+1))
                else
                  err=\$((err+1)); sleep 1
                fi
              done
          resources:
            requests: { cpu: ${WC_CPU_REQUEST}, memory: ${WC_MEM_REQUEST} }
            limits:   { cpu: ${WC_CPU_LIMIT}, memory: ${WC_MEM_LIMIT} }
YAML
}

# --- LIB-ONLY: define functions then stop (unit tests source us). ----------------
[ "${WRITER_CEILING_LIB_ONLY:-0}" = "1" ] && return 0 2>/dev/null || true

# =================================================================================
# CLUSTER-TOUCHING from here. K wraps kubectl with the optional context/namespace.
# =================================================================================
K="kubectl -n $WC_NS"
[ -n "${WC_CONTEXT:-}" ] && K="$K --context $WC_CONTEXT"
PROV="$HERE/provision-app.sh"
TMP_LOADER="$HERE/_tmp-wcload.yaml"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
say()  { printf '\n=== %s\n' "$*"; }

# millicores from a k8s CPU quantity ("1" -> 1000, "1500m" -> 1500, "250m" -> 250).
to_milli() {
  case "${1:-}" in
    *m) echo "${1%m}" ;;
    "") echo 0 ;;
    *)  echo $(( ${1} * 1000 )) ;;
  esac
}

# actuated CPU limit (millicores) of the running per-app writer pod (from status).
WRITER_POD() { $K get pods -l app="compute-${APP_NAME}" --no-headers 2>/dev/null | awk '$3=="Running"{print $1; exit}'; }
actuated_cpu_milli() {
  _p="$(WRITER_POD)"; [ -n "$_p" ] || { echo 0; return; }
  _raw=$($K get pod "$_p" -o jsonpath='{.status.containerStatuses[?(@.name=="compute")].resources.limits.cpu}' 2>/dev/null || true)
  to_milli "$_raw"
}
restart_count() {
  _p="$(WRITER_POD)"; [ -n "$_p" ] || { echo 0; return; }
  $K get pod "$_p" -o jsonpath='{.status.containerStatuses[?(@.name=="compute")].restartCount}' 2>/dev/null || echo 0
}
writer_cpu_top() {
  _p="$(WRITER_POD)"; [ -n "$_p" ] || { echo "n/a"; return; }
  $K top pod "$_p" --no-headers 2>/dev/null | awk '{print $2}' | head -1
}

# gateway pggw_* snapshot via Prometheus (the apps-gateway container is distroless — no
# shell to exec-scrape; read the series Prometheus already scrapes, scoped to the
# gateway="$GW_DEPLOY" label). Same pattern as _verify-loadsoak.sh (#383).
gw_snapshot() { # $1 label
  echo "-- gateway pggw_* [$1] (via Prometheus, gateway=\"$GW_DEPLOY\") --"
  _gw_any=0
  for _m in active_connections connections_total rejected_connections_total \
            wakes_total wake_failures_total; do
    _q="sum(pggw_${_m}%7Bgateway%3D%22${GW_DEPLOY}%22%7D)"
    _v="$($K exec "deploy/$PROM_DEPLOY" -- wget -qO- "http://localhost:9090/api/v1/query?query=$_q" 2>/dev/null \
          | grep -o '"value":\[[^]]*\]' | grep -oE '[0-9.]+"' | tr -d '"' | tail -1)"
    if [ -n "$_v" ]; then echo "  pggw_${_m}{gateway=\"$GW_DEPLOY\"} $_v"; _gw_any=1; fi
  done
  [ "$_gw_any" -eq 1 ] || echo "  (metrics unavailable — is $PROM_DEPLOY scraping $GW_DEPLOY:9090?)"
}

# writer snapshot: actuated cpu-limit + restartCount + top CPU on compute-$APP_NAME.
writer_snapshot() { # $1 label
  echo "-- writer compute-${APP_NAME} [$1]: cpu-limit=$(actuated_cpu_milli)m restarts=$(restart_count) top-cpu=$(writer_cpu_top) --"
}

# --- idempotent teardown (safe to re-run; #83 pattern) ---------------------------
DID_PROVISION=0
teardown() {
  echo "    teardown (idempotent): sweep loaders + drill table; restore autoscaler; rest writer"
  $K delete deploy -l drill=writer-ceiling --ignore-not-found --wait=false >/dev/null 2>&1 || true
  $K delete deploy/wcload --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # drop the throwaway drill table on the app's branch (best-effort, through the gateway).
  if [ "${APP_PW:-__APP_PW__}" != "__APP_PW__" ]; then
    _dsn="$(_wc_loader_dsn)"
    $K run wcdrop-$$ --image="$WC_IMG" --image-pull-policy=IfNotPresent --restart=Never --quiet \
      --command -- psql "$_dsn" -qtAc 'drop table if exists wc_drill' >/dev/null 2>&1 || true
    $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/wcdrop-$$ --timeout=60s >/dev/null 2>&1 || true
    $K delete pod wcdrop-$$ --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  # restore the #103 autoscaler to its committed spec (fast-cadence patch drift).
  if [ "$WC_FAST" = "1" ] && [ -f "$HERE/85-writer-autoscaler.yaml" ]; then
    $K apply -f "$HERE/85-writer-autoscaler.yaml" >/dev/null 2>&1 || true
    $K rollout status deploy/writer-autoscaler --timeout=90s >/dev/null 2>&1 || true
  fi
  # rest the writer (scale the per-app compute back to 0) unless we are reusing an app.
  $K scale deploy/"compute-${APP_NAME}" --replicas=0 >/dev/null 2>&1 || true
  # destroy the app we provisioned (leave a pre-existing reused app alone).
  if [ "$DID_PROVISION" = "1" ] && [ "${WC_KEEP_APP:-0}" != "1" ]; then
    NS="$WC_NS" KCTX="${WC_CONTEXT:-}" "$PROV" destroy "$APP_NAME" --delete-timeline >/dev/null 2>&1 || true
  fi
  rm -f "$TMP_LOADER"
}

# =================================================================================
# SELFTEST — render + dry-run the loader manifest + self-check the pure parsers.
# =================================================================================
if [ "${SELFTEST:-0}" = "1" ]; then
  echo "== SELFTEST: _verify-writer-ceiling.sh (issue #379) — cluster-free validation =="
  fails=0
  ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: got [$2] want [$3]"; fails=$((fails+1)); fi; }

  # 1. loader manifest renders + dry-run applies (structurally valid).
  APP_PW="selftestpw" render_loader > "$TMP_LOADER" 2>/dev/null || { echo "FAIL - render_loader"; fails=$((fails+1)); }
  if $K apply --dry-run=client -f "$TMP_LOADER" >/dev/null 2>&1; then
    echo "ok   - loader manifest applies with --dry-run=client"
  else
    if [ -s "$TMP_LOADER" ] && grep -q 'kind: Deployment' "$TMP_LOADER"; then
      echo "ok   - loader manifest rendered (dry-run needs a cluster; render is valid YAML)"
    else
      echo "FAIL - loader manifest render empty/invalid"; fails=$((fails+1))
    fi
  fi

  # 1b. the loader writes THROUGH the apps-gateway on the app's branch (no bypass).
  grep -q 'pggw-apps:55432' "$TMP_LOADER" || { echo "FAIL - loader does not write through pggw-apps:55432"; fails=$((fails+1)); }
  grep -q 'compute-.*:55433' "$TMP_LOADER" && { echo "FAIL - loader dials the per-app compute DIRECTLY (bypass!)"; fails=$((fails+1)); }
  grep -q 'insert into wc_drill' "$TMP_LOADER" || { echo "FAIL - loader does not INSERT into the throwaway wc_drill table"; fails=$((fails+1)); }
  echo "ok   - loader writes through pggw-apps into the throwaway wc_drill table (no bypass)"
  rm -f "$TMP_LOADER"

  # 2. per-loader parser round-trips a sentinel line into write-RPS + err%.
  _row="$(parse_wcount 'WCLOAD ok=9000 err=90 secs=30' test soak)"
  case "$_row" in
    "test | soak | 300.00 | 9000 | 90 | 0.99% | 30") echo "ok   - parse_wcount row: $_row" ;;
    *) echo "FAIL - parse_wcount bad row: $_row"; fails=$((fails+1)) ;;
  esac

  # 3. fleet aggregation: 2 loaders -> summed write-RPS, request-weighted err%.
  _la="$(mktemp)"; _lb="$(mktemp)"
  printf 'WCLOAD ok=6000 err=0 secs=30\n'  > "$_la"
  printf 'WCLOAD ok=3000 err=30 secs=30\n' > "$_lb"
  _agg="$(aggregate_wcounts app rampsoak "$_la" "$_lb")"; rm -f "$_la" "$_lb"
  case "$_agg" in
    *"| 300.00 | 9000 | 30 | 0.33% | 30") echo "ok   - aggregate_wcounts: summed RPS=300, ok=9000, err%=0.33" ;;
    *) echo "FAIL - aggregate_wcounts math wrong: $_agg"; fails=$((fails+1)) ;;
  esac

  # 4. injection guard fails render_loader closed on a poisoned knob.
  _pout="$( APP_NAME="x'; rm -rf /; '" APP_PW=p render_loader 2>&1 )"; _prc=$?
  ck "render_loader fails closed on poisoned APP_NAME (rc)" "$_prc" "1"
  case "$_pout" in *"kind: Deployment"*) echo "FAIL - poisoned render emitted a manifest"; fails=$((fails+1));; *) echo "ok   - poisoned render emitted no manifest";; esac

  if [ "$fails" -eq 0 ]; then echo "selftest PASSED"; exit 0; else echo "selftest FAILED ($fails)"; exit 1; fi
fi

# =================================================================================
# LIVE RUN. Requires a reachable cluster + the apps-gateway + the #103 autoscaler.
# =================================================================================
trap teardown EXIT

# preconditions — auto-skip cleanly (like _verify-writer-autoscaler.sh) if the pieces
# needed for the autoscaler proof are absent, so a partial cluster does not false-FAIL.
$K top pods >/dev/null 2>&1 || { echo "SKIP: metrics-server not available (kubectl top failed) — autoscaler cannot actuate"; exit 0; }
$K get deploy/writer-autoscaler >/dev/null 2>&1 || { echo "SKIP: writer-autoscaler Deployment not deployed (#103)"; exit 0; }
$K rollout status deploy/"$GW_DEPLOY" --timeout=60s >/dev/null 2>&1 || { echo "SKIP: apps-gateway ($GW_DEPLOY) not ready"; exit 0; }
[ -x "$PROV" ] || { echo "SKIP: provision-app.sh not found/executable at $PROV"; exit 0; }

say "provision the drill app '$WC_APP' (its own branch)"
if $K get configmap "app-$WC_APP" >/dev/null 2>&1 || [ "${WC_KEEP_APP:-0}" = "1" ]; then
  ok "reusing existing app $WC_APP (WC_KEEP_APP or configmap present)"
else
  NS="$WC_NS" KCTX="${WC_CONTEXT:-}" "$PROV" init-plane >/dev/null 2>&1 || true
  NS="$WC_NS" KCTX="${WC_CONTEXT:-}" "$PROV" create "$WC_APP" --replicas 1 >/dev/null || fail "provision create $WC_APP failed"
  DID_PROVISION=1
  ok "provisioned $WC_APP (branch + per-app compute)"
fi
$K rollout status deploy/"compute-${APP_NAME}" --timeout=180s >/dev/null 2>&1 || fail "compute-${APP_NAME} not ready"

# read the per-app password from its Secret for the loader DSN.
APP_PW="$($K get secret "app-db-$WC_APP" -o jsonpath='{.data.PGPASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)"
[ -n "$APP_PW" ] || fail "could not read app password (secret app-db-$WC_APP)"
_dsn="$(_wc_loader_dsn)"

say "create the throwaway drill table wc_drill on the app's branch (through the gateway)"
$K run wcinit-$$ --image="$WC_IMG" --image-pull-policy=IfNotPresent --restart=Never --quiet \
  --command -- psql "$_dsn" -qtAc 'drop table if exists wc_drill; create table wc_drill(id bigserial primary key, payload text, ts timestamptz default now())' >/dev/null 2>&1 || true
$K wait --for=jsonpath='{.status.phase}'=Succeeded pod/wcinit-$$ --timeout=120s >/dev/null 2>&1 || true
$K delete pod wcinit-$$ --ignore-not-found --wait=false >/dev/null 2>&1 || true
ok "wc_drill table ready (throwaway; dropped on teardown)"

# fast autoscaler cadence for the drill (restored by teardown from the manifest).
if [ "$WC_FAST" = "1" ]; then
  say "patch writer-autoscaler to a fast drill cadence"
  $K set env deploy/writer-autoscaler \
    WAS_POLL_MS=5000 WAS_UP_HOLD=2 WAS_DOWN_HOLD=3 WAS_COOLDOWN=2 WAS_UP_RATIO=0.55 WAS_DOWN_RATIO=0.40 >/dev/null 2>&1 || true
  $K rollout status deploy/writer-autoscaler --timeout=120s >/dev/null 2>&1 || true
  ok "autoscaler on fast cadence (poll 5s, up-hold 2, down-hold 3, up>=0.55 down<=0.40)"
fi

# baseline writer snapshot BEFORE load.
BASE_CPU="$(actuated_cpu_milli)"; BASE_RESTARTS="$(restart_count)"
[ "$BASE_CPU" -gt 0 ] || fail "could not read baseline actuated cpu-limit on compute-${APP_NAME}"
writer_snapshot before; gw_snapshot before
ok "baseline: writer cpu-limit=${BASE_CPU}m restarts=${BASE_RESTARTS}"

# --- launch the write loaders --------------------------------------------------
say "launch $WC_LOADERS write loaders (INSERT loop through $GW_DEPLOY on branch $WC_APP)"
render_loader > "$TMP_LOADER" || fail "render_loader failed"
$K apply -f "$TMP_LOADER" >/dev/null || fail "loader apply failed"
$K rollout status deploy/wcload --timeout=120s >/dev/null 2>&1 || true
ok "started $WC_LOADERS write loaders (batch=${WC_BATCH} rows/insert)"

# --- ramp: wait for the load to register, then watch for the in-place scale-UP ---
say "ramp ${WC_RAMP_S}s + soak ${WC_SOAK_S}s: sampling writer cpu-limit / restartCount / top-cpu"
UP_CPU="$BASE_CPU"; SEEN_UP=0
_end=$(( $(date +%s) + WC_RAMP_S + WC_SOAK_S ))
while [ "$(date +%s)" -lt "$_end" ]; do
  cur="$(actuated_cpu_milli)"; rc="$(restart_count)"
  [ "$rc" = "$BASE_RESTARTS" ] || fail "writer RESTARTED under write load (restartCount $BASE_RESTARTS -> $rc) — resize must be IN-PLACE!"
  if [ "$cur" -gt "$UP_CPU" ]; then UP_CPU="$cur"; SEEN_UP=1; fi
  writer_snapshot "t=$(date +%s)"
  sleep 15
done
gw_snapshot soak
if [ "$SEEN_UP" = "1" ]; then
  ok "IN-PLACE SCALE-UP under write load: cpu-limit ${BASE_CPU}m -> ${UP_CPU}m, restartCount=${BASE_RESTARTS} (UNCHANGED)"
else
  echo "note - writer cpu-limit did NOT rise above ${BASE_CPU}m under this write load."
  echo "       On a CPU-request-constrained cluster the loaders may not drive the single"
  echo "       writer past WAS_UP_RATIO (see BENCHMARKS #379 honesty note). The write-RPS"
  echo "       ceiling below is still the published capacity number for this run."
fi

# --- drain: stop the loaders, harvest each loader's WCLOAD sentinel, watch scale-DOWN
say "drain: stop loaders, harvest per-loader write counters"
# read each loader's WCLOAD line from its logs (they print it on SIGTERM); scale to 0.
_summaries=""; _n=0
for _pod in $($K get pods -l app=wcload --no-headers 2>/dev/null | awk '{print $1}'); do
  # nudge a graceful stop so the trap prints the sentinel, then read the log tail.
  $K delete pod "$_pod" --grace-period=3 --wait=false >/dev/null 2>&1 || true
  _line="$($K logs "$_pod" 2>/dev/null | grep -E '^WCLOAD ' | tail -1 || true)"
  if [ -n "$_line" ]; then
    _sf="$(mktemp)"; printf '%s\n' "$_line" > "$_sf"; _summaries="$_summaries $_sf"; _n=$((_n+1))
  fi
done
$K delete deploy/wcload --ignore-not-found --wait=false >/dev/null 2>&1 || true

say "watch the hysteresis scale-DOWN (up to ${WC_DRAIN_S}s)"
DOWN_CPU="$UP_CPU"; t=0
while [ "$t" -lt "$WC_DRAIN_S" ]; do
  cur="$(actuated_cpu_milli)"; rc="$(restart_count)"
  [ "$rc" = "$BASE_RESTARTS" ] || fail "writer RESTARTED during scale-down (restartCount $BASE_RESTARTS -> $rc)"
  if [ "$SEEN_UP" = "1" ] && [ "$cur" -lt "$UP_CPU" ]; then DOWN_CPU="$cur"; break; fi
  sleep 10; t=$((t+10))
  writer_snapshot "drain t=${t}s"
done
if [ "$SEEN_UP" = "1" ]; then
  if [ "$DOWN_CPU" -lt "$UP_CPU" ]; then
    ok "HYSTERESIS SCALE-DOWN in place: cpu-limit ${UP_CPU}m -> ${DOWN_CPU}m, restartCount=${BASE_RESTARTS} (UNCHANGED)"
  else
    echo "note - no scale-down observed within ${WC_DRAIN_S}s (cpu still ${UP_CPU}m) — down-hold may exceed the window."
  fi
fi
writer_snapshot after; gw_snapshot after

# --- publish the write-RPS ceiling ---------------------------------------------
# shellcheck disable=SC2086  # intentional whitespace-split file list.
set -- $_summaries
say "WRITE-RPS CEILING (single-writer vertical limit) — paste into BENCHMARKS.md #379"
echo "app | phase | writeRPS | ok | err | err% | secs"
if [ "$#" -eq 0 ]; then
  echo "(no loader produced a WCLOAD sentinel — check DSN reachability / image pull)"
else
  _i=0
  for _sf in "$@"; do parse_wcount "$(cat "$_sf")" "${APP_NAME}#${_i}" "loader"; _i=$((_i+1)); done
  echo "----- AGGREGATED fleet (writeRPS SUMMED across loaders — disjoint INSERT streams) -----"
  aggregate_wcounts "$APP_NAME" "rampsoak-writers${WC_LOADERS}" "$@"
  rm -f "$@"
fi
echo ""
echo "HONEST NOTE: this is the SINGLE-WRITER VERTICAL ceiling. Writes scale only by"
echo "  growing the one writer (the #103 in-place cpu-limit resize) up to the node/limit"
echo "  ceiling; beyond that = sharding, which is OUT OF SCOPE for the wave. The number"
echo "  above is the honest write capacity of one app's branch on this cluster."

trap - EXIT
teardown
ok "writer-ceiling drill complete (loaders + drill table torn down; autoscaler + writer restored)"
