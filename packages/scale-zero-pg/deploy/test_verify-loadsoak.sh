#!/usr/bin/env bash
# test_verify-loadsoak.sh — cluster-free unit test for _verify-loadsoak.sh (issue #376,
# W1 of the high-traffic wave #375). The harness itself (the in-cluster k6 Job) needs a
# live OKE cluster to produce numbers; this test pins the CLUSTER-FREE parts so the
# harness can be reviewed + regression-guarded without a cluster:
#
#   1. SELFTEST mode runs, applies the manifest with --dry-run=client (a fake kubectl),
#      and reports OK — the manifest is well-formed and the drill's control flow is sound.
#   2. The pure summary parser (parse_k6_summary) turns a real k6 summary-export JSON
#      into the exact BENCHMARKS row fields the issue lists: RPS, p50/p95/p99, error rate.
#      This is the "bash assertion that the summary parser produces the expected row
#      format from a sample k6 JSON" the mission requires — a stub/weakened parser fails.
#   3. The concurrency->latency CSV row builder emits the paste-ready W2 sizing line.
#
# Run: bash deploy/test_verify-loadsoak.sh   (no cluster, no k6 binary needed).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/_verify-loadsoak.sh"
pass=0
ok()   { echo "ok   - $*"; pass=$((pass+1)); }
fail() { echo "FAIL: $*" >&2; exit 1; }
has()  { case "$2" in *"$1"*) return 0;; *) return 1;; esac; }

[ -f "$SUT" ] || fail "sut missing: $SUT"
[ -x "$SUT" ] || fail "sut not executable: $SUT"

# --- fake kubectl on a shim PATH: every op succeeds, dry-run apply echoes 'configured'
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
cat > "$SHIM/kubectl" <<'FAKE'
#!/bin/sh
case "$*" in
  *"apply"*"--dry-run=client"*) echo "job.batch/loadsoak-k6 created (dry run)"; exit 0;;
  *"apply"*)                    echo "applied"; exit 0;;
  *"get"*"jsonpath"*)           echo ""; exit 0;;
  *"config current-context"*)   echo "context-ckmva7v7zvq"; exit 0;;
  *"get crd"*|*"get node"*)      exit 0;;
  *)                             exit 0;;
esac
FAKE
chmod +x "$SHIM/kubectl"
export PATH="$SHIM:$PATH"

# ---------------------------------------------------------------------------------
# 1. SELFTEST: dry-run apply of the manifest + parser self-checks, no live cluster.
# ---------------------------------------------------------------------------------
out="$( SELFTEST=1 LOADSOAK_CONTEXT=context-ckmva7v7zvq bash "$SUT" 2>&1 || true )"
has "SELFTEST" "$out"            || fail "selftest: no SELFTEST banner:\n$out"
has "dry-run" "$out"             || fail "selftest: manifest not dry-run applied:\n$out"
has "selftest PASSED" "$out"     || fail "selftest did NOT report PASSED:\n$out"
ok "SELFTEST mode dry-runs the manifest and self-checks the parser"

# ---------------------------------------------------------------------------------
# 2. parse_k6_summary: from a REAL k6 summary-export JSON -> BENCHMARKS row fields.
#    We source the SUT with LOADSOAK_LIB_ONLY=1 so it defines its functions and
#    returns WITHOUT touching a cluster, then call the pure parser directly.
# ---------------------------------------------------------------------------------
# shellcheck disable=SC1090
LOADSOAK_LIB_ONLY=1 . "$SUT"

# A REALISTIC k6 --summary-export JSON. k6 emits ALL registered metrics, and a real
# export is NOT hand-ordered — the custom metrics this drill's k6 script registers
# (app_errors, app_ok, app_latency_ms) sort ALPHABETICALLY BEFORE the http_* built-ins,
# and built-ins checks/iterations/vus carry their own "rate"/"value" keys. So an
# UNANCHORED first-match extraction reads the WRONG metric:
#   * "rate"  -> app_ok.rate / checks.rate (not http_reqs.rate)   [RPS bug]
#   * "value" -> app_errors.value / checks.value / vus.value      [err% bug]
#   * "p(95)" -> app_latency_ms.p(95)  (not http_req_duration)    [latency bug]
# This fixture INCLUDES all of those confounders with DISTINCT values so a wrong-metric
# read is observable. It must FAIL the old (unanchored) parser and PASS the fixed one.
SAMPLE="$(mktemp)"; trap 'rm -rf "$SHIM" "$SAMPLE"' EXIT
cat > "$SAMPLE" <<'JSON'
{
  "root_group": { "name": "", "path": "", "checks": [] },
  "metrics": {
    "app_errors":     { "value": 0.9900, "passes": 9900, "fails": 100 },
    "app_latency_ms": { "avg": 999.9, "min": 111.1, "med": 888.8, "max": 4444.4,
                        "p(50)": 888.8, "p(90)": 999.9, "p(95)": 999.9, "p(99)": 999.9 },
    "app_ok":         { "count": 89811, "rate": 777.7 },
    "checks":         { "value": 0.9950, "passes": 89811, "fails": 189, "rate": 555.5 },
    "data_received":  { "count": 123456, "rate": 4096.0 },
    "data_sent":      { "count": 65432, "rate": 2048.0 },
    "http_req_duration": {
      "avg": 41.2, "min": 8.1, "med": 33.5, "max": 812.0,
      "p(50)": 33.5, "p(90)": 78.9, "p(95)": 96.4, "p(99)": 210.7
    },
    "http_req_failed": { "value": 0.0021, "passes": 89811, "fails": 189 },
    "http_reqs":       { "count": 90000, "rate": 300.0 },
    "iteration_duration": { "avg": 42.0, "med": 34.0, "p(95)": 97.0, "p(99)": 211.0 },
    "iterations":      { "count": 90000, "rate": 300.0 },
    "vus":             { "value": 118, "min": 0, "max": 120 },
    "vus_max":         { "value": 120, "min": 120, "max": 120 }
  }
}
JSON

row="$(parse_k6_summary "$SAMPLE" "file-manager" "soak")"
# Expect a single-line, pipe-delimited row carrying every issue-listed metric — read
# from the CORRECT block, not the alphabetically-first confounder.
has "file-manager" "$row"        || fail "parser: app name missing from row:\n$row"
# RPS must be http_reqs.rate=300.00, NOT app_ok.rate=777.70 or checks.rate=555.50.
has "300.00" "$row"              || fail "parser: RPS is not http_reqs.rate (confounder leaked):\n$row"
has "777"    "$row" && fail "parser: RPS leaked app_ok.rate=777.7 (unanchored grep bug):\n$row"
# latency must be http_req_duration.*, NOT app_latency_ms.888.8/999.9.
has "33.50" "$row"               || fail "parser: p50 is not http_req_duration.med (confounder):\n$row"
has "96.40" "$row"               || fail "parser: p95 is not http_req_duration.p(95):\n$row"
has "210.70" "$row"              || fail "parser: p99 is not http_req_duration.p(99):\n$row"
has "888"   "$row" && fail "parser: latency leaked app_latency_ms=888.8 (unanchored grep bug):\n$row"
# err% must be http_req_failed.value=0.0021 -> 0.21%, NOT app_errors.value=0.99 -> 99.00%
# nor checks.value=0.995 -> 99.50% nor vus.value=118 -> 11800.00%.
has "0.21%" "$row"               || fail "parser: err% is not http_req_failed.value (confounder):\n$row"
has "99.00%" "$row" && fail "parser: err% leaked app_errors.value=0.99 (unanchored grep bug):\n$row"
has "99.50%" "$row" && fail "parser: err% leaked checks.value=0.995 (unanchored grep bug):\n$row"
# peak VUs must be vus_max.value=120, NOT vus.value=118.
has "| 120" "$row"               || fail "parser: peak VUs is not vus_max.value=120:\n$row"
ok "parse_k6_summary reads the CORRECT metric block (no alphabetical-confounder leak)"

# A ZERO-error run must render 0.00% (the cold-storm/#339 confirm-errors-0 case), even
# with a non-zero app_errors/checks confounder present.
cat > "$SAMPLE" <<'JSON'
{ "metrics": {
  "app_errors":      { "value": 0.5000 },
  "app_latency_ms":  { "med": 700.0, "p(95)": 800.0, "p(99)": 900.0 },
  "app_ok":          { "rate": 999.9 },
  "checks":          { "value": 1.0 },
  "http_req_duration": { "med": 20.0, "p(95)": 40.0, "p(99)": 60.0 },
  "http_req_failed": { "value": 0.0 },
  "http_reqs":       { "count": 5000, "rate": 250.0 },
  "vus":             { "value": 39 },
  "vus_max":         { "value": 40 }
} }
JSON
row0="$(parse_k6_summary "$SAMPLE" "file-manager" "coldstorm")"
has "0.00%" "$row0"              || fail "parser: zero-error run not rendered as 0.00%:\n$row0"
has "| 250.00 |" "$row0"         || fail "parser: RPS not http_reqs.rate=250 in zero-err run:\n$row0"
has "| 40" "$row0"               || fail "parser: peak VUs not vus_max=40 in zero-err run:\n$row0"
ok "parse_k6_summary renders a zero-error run as 0.00% (cold-storm errors=0)"

# ---------------------------------------------------------------------------------
# 3. conc_lat_row: concurrency->latency CSV line for the W2 ContainerConcurrency curve.
# ---------------------------------------------------------------------------------
cl="$(conc_lat_row 20 33.5 96.4 210.7 0.21 300)"
has "20" "$cl"                   || fail "conc_lat_row: concurrency col missing:\n$cl"
has "96.4" "$cl"                 || fail "conc_lat_row: p95 col missing:\n$cl"
# comma-delimited CSV (paste-ready for the W2 curve table)
case "$cl" in *,*,*) ok "conc_lat_row emits a CSV concurrency->latency line" ;; *) fail "conc_lat_row not CSV:\n$cl" ;; esac

# ---------------------------------------------------------------------------------
# 4. Shell-injection guard (#376 review): a knob carrying a shell metachar must be
#    REJECTED before it is interpolated into the k6 Job's /bin/sh -c arg. A benign
#    URL/duration/int must be ACCEPTED.
# ---------------------------------------------------------------------------------
# _unsafe_knob true for an injection vector, false for a legit value.
_unsafe_knob "http://app.knext-apps.svc.cluster.local/users?x=1" && fail "guard: benign URL flagged unsafe"
_unsafe_knob "2m" && fail "guard: benign duration flagged unsafe"
_unsafe_knob "grafana/k6:0.49.0" && fail "guard: benign image flagged unsafe"
# resource-quantity knobs (#376 follow-up) must pass the guard (alphanum + m/Mi/Gi).
_unsafe_knob "150m" && fail "guard: cpu quantity 150m flagged unsafe"
_unsafe_knob "2" && fail "guard: cpu quantity 2 flagged unsafe"
_unsafe_knob "256Mi" && fail "guard: mem quantity 256Mi flagged unsafe"
_unsafe_knob "2Gi" && fail "guard: mem quantity 2Gi flagged unsafe"
_unsafe_knob "x'; touch /tmp/pwned; '" || fail "guard: single-quote breakout NOT flagged"
_unsafe_knob 'x$(id)' || fail "guard: command-substitution NOT flagged"
_unsafe_knob 'a`id`b' || fail "guard: backtick NOT flagged"
_unsafe_knob 'a;b' || fail "guard: semicolon NOT flagged"
_unsafe_knob 'a|b' || fail "guard: pipe NOT flagged"
ok "_unsafe_knob flags shell-injection vectors, accepts benign URLs/durations/images"

# render_manifest must FAIL CLOSED on a poisoned TARGET_URL (does not emit the manifest).
poison_out="$( TARGET_URL="x'; rm -rf /; '" render_manifest 2>&1 )"; poison_rc=$?
[ "$poison_rc" -ne 0 ] || fail "render_manifest did NOT fail on a poisoned TARGET_URL:\n$poison_out"
case "$poison_out" in *"kind: Job"*) fail "render_manifest EMITTED a manifest with a poisoned knob:\n$poison_out";; esac
has "unsafe value for TARGET_URL" "$poison_out" || fail "render_manifest gave no injection diagnostic:\n$poison_out"
ok "render_manifest fails closed on a poisoned knob (no manifest emitted)"

# a clean set of knobs still renders a Job.
clean_out="$( TARGET_URL='http://app.svc/users' render_manifest 2>&1 )"; clean_rc=$?
[ "$clean_rc" -eq 0 ] || fail "render_manifest failed on CLEAN knobs:\n$clean_out"
has "kind: Job" "$clean_out" || fail "render_manifest did not emit a Job on clean knobs:\n$clean_out"
ok "render_manifest renders a Job for clean knobs"

# ---------------------------------------------------------------------------------
# 4b. k6 pod resources are KNOBS (#376 follow-up): a CPU-request-constrained cluster must
#     be able to lower the request so the Job schedules. Assert the value renders into the
#     resources: block (no leftover placeholder), and the default still renders.
# ---------------------------------------------------------------------------------
res_out="$( TARGET_URL='http://app.svc/users' K6_CPU_REQUEST=150m K6_MEM_REQUEST=128Mi K6_CPU_LIMIT=1 K6_MEM_LIMIT=256Mi render_manifest 2>&1 )"
has 'requests: { cpu: "150m", memory: 128Mi }' "$res_out" || fail "resources: CPU/mem request knob did not render:\n$(printf '%s' "$res_out" | grep -A2 'resources:')"
has 'limits:   { cpu: "1",   memory: 256Mi }' "$res_out"  || fail "resources: CPU/mem limit knob did not render:\n$(printf '%s' "$res_out" | grep -A2 'resources:')"
case "$res_out" in *'${K6_CPU_REQUEST}'*|*'${K6_MEM_LIMIT}'*) fail "resources: knob left as unrendered placeholder:\n$res_out";; esac
ok "k6 pod resources render from K6_CPU/MEM_REQUEST/LIMIT knobs (schedules-shaped on a constrained cluster)"

# default render still carries the shipped defaults (500m request).
def_out="$( TARGET_URL='http://app.svc/users' render_manifest 2>&1 )"
has 'cpu: "500m"' "$def_out" || fail "resources: default CPU request 500m missing:\n$def_out"
ok "k6 pod resources fall back to shipped defaults (cpu 500m) when unset"

# ---------------------------------------------------------------------------------
# 5. GW_DEPLOY knob is actually wired into the gateway= query label (not hardcoded).
#    (#383: gw_snapshot moved from a dead pod-exec to a Prometheus query scoped to the
#    gateway="$GW_DEPLOY" series — the knob must still be live in that scope.)
# ---------------------------------------------------------------------------------
grep -q '\${GW_DEPLOY}' "$SUT" || fail "gw_snapshot query does not use \$GW_DEPLOY (knob is dead)"
ok "gw_snapshot scopes its Prometheus query via the GW_DEPLOY knob"

# ---------------------------------------------------------------------------------
# 6. #383 (instrument fix — gateway pggw_* scrape). The apps-gateway container is
#    distroless (gcr.io/distroless/static:nonroot) — it has NO shell, NO wget, NO
#    curl — so the old `kubectl exec <gw-pod> -- sh -c 'wget .../metrics'` ALWAYS
#    returned "(metrics unavailable)". The fix scrapes the pggw_* series through the
#    PROMETHEUS instant-query API (Prometheus already scrapes the gateway's :9090 and
#    labels the series gateway="pggw-apps"), the same pattern _verify-wake-guard.sh
#    uses. Assert the wall-relevant counters are queried, scoped to the gateway label.
# ---------------------------------------------------------------------------------
sut_src="$(cat "$SUT")"
# must query Prometheus (deploy/prometheus wget of the instant-query API), NOT sh-exec
# the shell-less gateway pod.
has 'deploy/$PROM_DEPLOY' "$sut_src" || fail "#383: gw_snapshot does not query Prometheus (gateway pod is distroless, has no shell to exec wget)"
has '/api/v1/query' "$sut_src"     || fail "#383: gw_snapshot does not use the Prometheus instant-query API"
# the wall analysis hinges on rejected_connections_total>0 => GW_MAX_CONNS wall; it
# must be one of the queried series, scoped to the apps-gateway plane label.
# the counters are queried via the `sum(pggw_${_m}{...})` loop over the metric list —
# assert both the loop template and the wall-critical metric names appear.
has 'sum(pggw_${_m}' "$sut_src"       || fail "#383: gw_snapshot does not query sum(pggw_<metric>{...})"
has 'rejected_connections_total' "$sut_src" || fail "#383: gw_snapshot does not query rejected_connections_total (the GW_MAX_CONNS wall signal)"
has 'active_connections' "$sut_src"         || fail "#383: gw_snapshot does not query active_connections (the connection-cap headroom signal)"
# the label must be the GW_DEPLOY knob (pggw-apps), not hardcoded — URL-encoded gateway= scope.
has 'gateway%3D%22${GW_DEPLOY}%22' "$sut_src" \
  || fail "#383: gw_snapshot does not scope its Prometheus query to gateway=\"\$GW_DEPLOY\" (label hardcoded or missing)"
# the dead distroless exec path must be GONE.
has "http://127.0.0.1:9090/metrics" "$sut_src" && fail "#383: gw_snapshot still exec-scrapes the shell-less gateway pod (dead path not removed)"
ok "#383: gw_snapshot scrapes pggw_* via the Prometheus instant-query API, scoped to gateway=\$GW_DEPLOY"

# ---------------------------------------------------------------------------------
# 7. #383 (instrument fix — DB-compute snapshot). The old plane_snapshot fell through
#    from compute-<app> to the base single-DB `compute` deployment (always replicas=0
#    in branch-per-app mode), producing the misleading "writer compute: replicas=0"
#    line WHILE the app was being served. The fix points the DB-compute snapshot at
#    the per-app deployment compute-$APP_NAME ONLY (no fall-through to base compute).
# ---------------------------------------------------------------------------------
has 'compute-${APP_NAME}' "$sut_src" || fail "#383: plane_snapshot does not target the per-app compute-\$APP_NAME deployment"
# the misleading fall-through `for d in "compute-${APP_NAME}" compute;` must be gone.
has 'for d in "compute-${APP_NAME}" compute' "$sut_src" && fail "#383: plane_snapshot still falls through to base 'compute' (mislabels the DB compute as replicas=0)"
ok "#383: plane_snapshot targets compute-\$APP_NAME only (no base-compute fall-through mislabel)"

# ---------------------------------------------------------------------------------
# 8. #382 (fan-out). K6_FANOUT=N renders N distinct k6 Jobs (loadsoak-k6-0..N-1),
#    each sharding the VU target, so a CPU-request-constrained cluster (one k6 pod
#    ~150m) can drive real high-traffic load. K6_FANOUT=1 stays byte-compatible with
#    the single-Job behavior (name loadsoak-k6, no shard suffix).
# ---------------------------------------------------------------------------------
# default (K6_FANOUT unset / 1): one Job named loadsoak-k6 (backward-compatible).
one_out="$( TARGET_URL='http://app.svc/users' render_all_manifests 2>&1 )"; one_rc=$?
[ "$one_rc" -eq 0 ] || fail "#382: render_all_manifests failed for the default (K6_FANOUT=1):\n$one_out"
has 'name: loadsoak-k6' "$one_out" || fail "#382: K6_FANOUT=1 did not render the single Job 'loadsoak-k6':\n$one_out"
case "$one_out" in *'name: loadsoak-k6-1'*) fail "#382: K6_FANOUT=1 rendered a shard-suffixed Job (should be byte-compatible single Job)";; esac
ok "#382: K6_FANOUT=1 renders the single 'loadsoak-k6' Job (backward-compatible)"

# K6_FANOUT=3: three distinct shard Jobs loadsoak-k6-0/-1/-2.
three_out="$( TARGET_URL='http://app.svc/users' K6_FANOUT=3 render_all_manifests 2>&1 )"; three_rc=$?
[ "$three_rc" -eq 0 ] || fail "#382: render_all_manifests failed for K6_FANOUT=3:\n$three_out"
for i in 0 1 2; do
  has "name: loadsoak-k6-$i" "$three_out" || fail "#382: K6_FANOUT=3 missing shard Job loadsoak-k6-$i:\n$three_out"
  has "name: loadsoak-k6-script-$i" "$three_out" || fail "#382: K6_FANOUT=3 missing per-shard ConfigMap loadsoak-k6-script-$i:\n$three_out"
done
# each shard must carry a distinct VU target sum = original (sharding, not N-fold load).
njobs="$(printf '%s\n' "$three_out" | grep -c '^kind: Job')"
[ "$njobs" -eq 3 ] || fail "#382: K6_FANOUT=3 rendered $njobs Jobs, want 3:\n$three_out"
ok "#382: K6_FANOUT=3 renders 3 distinct shard Jobs (loadsoak-k6-0..2) + per-shard ConfigMaps"

# sharding: N shards each get ceil(RAMP_CEIL_VU/N) so N*per-shard >= target. With
# RAMP_CEIL_VU=120, K6_FANOUT=3 -> each shard RAMP_CEIL_VU=40.
has 'RAMP_CEIL_VU=40' "$three_out" || has "value: \"40\"" "$three_out" || has "RAMP_CEIL_VU='40'" "$three_out" \
  || fail "#382: K6_FANOUT=3 did not shard RAMP_CEIL_VU=120 into 40/shard:\n$(printf '%s' "$three_out" | grep -i ceil)"
ok "#382: fan-out shards the VU target across N shards (120 VU / 3 = 40 VU each)"

# the fan-out knob is injection-guarded like the others.
poison_fan="$( TARGET_URL='http://app.svc/users' K6_FANOUT='2; rm -rf /' render_all_manifests 2>&1 )"; poison_fan_rc=$?
[ "$poison_fan_rc" -ne 0 ] || fail "#382: render_all_manifests did NOT fail on a poisoned K6_FANOUT"
has 'unsafe' "$poison_fan" || has 'K6_FANOUT' "$poison_fan" || fail "#382: no diagnostic on poisoned K6_FANOUT:\n$poison_fan"
ok "#382: K6_FANOUT is injection-guarded (poisoned value fails closed)"

# ---------------------------------------------------------------------------------
# 9. #382 (aggregation math). aggregate_summaries sums RPS across shards and pools the
#    percentiles (count-weighted mean — an honest approximation, documented). Unit-test
#    with TWO fake per-shard summaries so the arithmetic is checked exactly.
# ---------------------------------------------------------------------------------
# shard A: 100 RPS, p50=20 p95=50 p99=90, err 0.00%, vus 40, count 60000
# shard B: 200 RPS, p50=30 p95=60 p99=120, err 0.00%, vus 40, count 120000
# pooled RPS = 300. Count-weighted p95 = (50*60000 + 60*120000)/180000 = 56.6667.
SA="$(mktemp)"; SB="$(mktemp)"; trap 'rm -rf "$SHIM" "$SAMPLE" "$SA" "$SB"' EXIT
cat > "$SA" <<'JSON'
{ "metrics": {
  "http_req_duration": { "med": 20.0, "p(50)": 20.0, "p(95)": 50.0, "p(99)": 90.0 },
  "http_req_failed": { "value": 0.0 },
  "http_reqs":       { "count": 60000, "rate": 100.0 },
  "vus_max":         { "value": 40 }
} }
JSON
cat > "$SB" <<'JSON'
{ "metrics": {
  "http_req_duration": { "med": 30.0, "p(50)": 30.0, "p(95)": 60.0, "p(99)": 120.0 },
  "http_req_failed": { "value": 0.0 },
  "http_reqs":       { "count": 120000, "rate": 200.0 },
  "vus_max":         { "value": 40 }
} }
JSON
agg="$(aggregate_summaries "file-manager" "rampsoak" "$SA" "$SB")"
# aggregated row: app | phase | RPS | p50 | p95 | p99 | err% | peakVUs(sum)
has "file-manager" "$agg" || fail "#382: aggregate_summaries dropped the app name:\n$agg"
has "| 300.00 |" "$agg"   || fail "#382: aggregate_summaries did not SUM RPS (100+200=300):\n$agg"
# count-weighted pooled p95 = 56.67 (2dp).
has "56.67" "$agg"        || fail "#382: aggregate_summaries pooled p95 wrong (want count-weighted 56.67):\n$agg"
# count-weighted pooled p99 = (90*60000+120*120000)/180000 = 110.00.
has "110.00" "$agg"       || fail "#382: aggregate_summaries pooled p99 wrong (want 110.00):\n$agg"
# peak VUs are SUMMED across shards (40+40=80): the whole fleet's concurrency.
has "| 80" "$agg"         || fail "#382: aggregate_summaries did not sum peak VUs across shards (40+40=80):\n$agg"
has "0.00%" "$agg"        || fail "#382: aggregate_summaries error% wrong for a zero-error fleet:\n$agg"
ok "#382: aggregate_summaries sums RPS+VUs and count-weight-pools the percentiles (2 shards -> correct row)"

# a SINGLE shard aggregates to itself (identity — K6_FANOUT=1 path).
agg1="$(aggregate_summaries "file-manager" "rampsoak" "$SA")"
has "| 100.00 |" "$agg1" || fail "#382: single-shard aggregate did not pass RPS through (100.00):\n$agg1"
has "| 40" "$agg1"       || fail "#382: single-shard aggregate did not pass VUs through (40):\n$agg1"
ok "#382: aggregate_summaries is identity on a single shard (K6_FANOUT=1)"

echo "PASSED ($pass checks)"
