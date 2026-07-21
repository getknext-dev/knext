#!/usr/bin/env bash
#
# running-pods-integrity.test.sh — tests for the scale-to-zero query-integrity fix
# (#429).
#
# The bug: running_pods piped `kubectl get pods` through `2>/dev/null | wc -l`, so
# a kubectl FAILURE produced `0` — indistinguishable from a genuine zero. wait_zero
# then logged "-> scaled to 0 after Ns" and returned success on a query that never
# observed zero pods. A transient API blip (the control plane TLS-times-out on ~2
# of 3 runs here) therefore produced a FALSE scale-to-zero confirmation: the pod
# was still Running, so the NEXT "cold start" sample measured a WARM start, biasing
# cold-start figures DOWNWARD — the most dangerous direction for a measurement
# error. This blocks the #309 p99 campaign, which performs thousands of these
# confirmations.
#
# What these tests pin:
#   - a FAILING `get pods` (non-zero exit) does NOT confirm scale-to-zero — no
#     "scaled to 0" line is ever written for a query that failed (the regression),
#   - a genuine zero (kubectl succeeds, no Running pods) STILL confirms scale-to-zero,
#   - a genuine non-zero keeps waiting and never falsely confirms,
#   - a transient query blip is RETRIED (via the existing api_retry helper) and the
#     failure is SURFACED in the results file (api-retry:/abandoned/DEGRADED),
#     consistent with the api-retry visibility precedent.
#
# Run: bash benchmarks/scale-to-zero-oke/running-pods-integrity.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${SCRIPT_DIR}/run.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   — $1"; }
nope() { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }
assert_contains() {
  if grep -qF -- "$2" "$1"; then ok "$3"; else
    nope "$3"; echo "        expected to find: $2"; echo "        in:"; sed 's/^/          /' "$1"
  fi
}
assert_not_contains() {
  if grep -qF -- "$2" "$1"; then
    nope "$3"; echo "        did NOT expect: $2"; echo "        in:"; sed 's/^/          /' "$1"
  else ok "$3"; fi
}
assert_eq() {
  if [ "$1" = "$2" ]; then ok "$3"; else nope "$3 — expected '$2', got '$1'"; fi
}

TRANSIENT_MSG='Unable to connect to the server: net/http: TLS handshake timeout'

# ── stub kubectl ─────────────────────────────────────────────────────────────
# Steered by small files in the stub dir, controlling ONLY the running_pods query
# (the one carrying status.phase=Running):
#   pods_mode        zero | nonzero            (default: nonzero)
#   pods_fail_count  first N running_pods queries fail                 (default 0)
#   pods_fail_mode   transient | terminal                       (default transient)
# Everything else (capture read, apply patch, k6 job) succeeds so the run reaches
# and exits wait_zero cleanly.
make_stub() {
  local dir="$1"
  cat > "${dir}/ksvc.json" <<'JSON'
{ "spec": { "template": { "metadata": {}, "spec": {} } } }
JSON
  cat > "${dir}/kubectl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${dir}/calls.log"
args="\$*"
transient_msg='${TRANSIENT_MSG}'
terminal_msg='Error from server (NotFound): pods not found'
case "\$args" in
  *"get pods"*"status.phase=Running"*)
    # The running_pods query. Count it, and fail the first N if asked.
    n=\$(cat "${dir}/pods_count" 2>/dev/null || echo 0); n=\$((n + 1))
    echo "\$n" > "${dir}/pods_count"
    failn=\$(cat "${dir}/pods_fail_count" 2>/dev/null || echo 0)
    if [ "\$n" -le "\$failn" ]; then
      mode=\$(cat "${dir}/pods_fail_mode" 2>/dev/null || echo transient)
      if [ "\$mode" = "terminal" ]; then echo "\$terminal_msg" >&2; else echo "\$transient_msg" >&2; fi
      exit 1
    fi
    mode=\$(cat "${dir}/pods_mode" 2>/dev/null || echo nonzero)
    if [ "\$mode" = "zero" ]; then
      # genuine zero: kubectl succeeds, prints NOTHING (--no-headers, no pods)
      exit 0
    fi
    printf 'pod-1 1/1 Running 0 1s\npod-2 1/1 Running 0 1s\n'
    exit 0 ;;
  *"get pods"*"job-name="*) printf 'Running' ;;
  *"get pods"*) echo "pod-1 1/1 Running 0 1s" ;;
  *"get ksvc"*) cat "${dir}/ksvc.json" ;;
  *"patch ksvc"*) : ;;
  *"wait --for=condition=complete"*) exit 0 ;;
  *"wait --for=condition=failed"*) exit 1 ;;
  *"logs"*) cat "${dir}/k6_logs" 2>/dev/null || true ;;
  *"apply -f"*) cat > /dev/null ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${dir}/kubectl"
  : > "${dir}/calls.log"
  cat > "${dir}/k6_logs" <<'LOGS'
     checks.........................: 100.00% 10 out of 10
     http_req_duration..............: avg=41ms med=33ms p(95)=98ms
     http_req_failed................: 0.00%   0 out of 10
     http_reqs......................: 10      9.4/s
LOGS
}

# run_bench <stubdir> <extra args...>. A short SCALE_DOWN_TIMEOUT + poll interval
# keeps the wait_zero loop fast; retry backoff is tiny.
run_bench() {
  local dir="$1"; shift
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  OUT="${dir}/results.txt" SCALE_DOWN_TIMEOUT="${SCALE_DOWN_TIMEOUT:-1}" \
  SCALE_DOWN_POLL_S="${SCALE_DOWN_POLL_S:-1}" APPLY_SETTLE_SECONDS=0 \
  POD_SAMPLE_BUDGET=1 SCHEDULE_CHECK_TIMEOUT=0 K6_JOB_TIMEOUT=5 \
  API_RETRY_BASE_MS=5 API_RETRY_MAX_MS=20 API_RETRY_ATTEMPTS="${API_RETRY_ATTEMPTS:-4}" \
    bash "$RUN_SH" --service demo-svc --namespace bench "$@" \
      > "${dir}/out.txt" 2>&1
}

echo "== running-pods-integrity.test.sh =="

# ── Test 1: a FAILING pod query must NOT confirm scale-to-zero ────────────────
# The core regression: with 2>/dev/null|wc -l, every failing query read as 0 and
# wait_zero logged "-> scaled to 0". The pod is actually still Running, so the
# next cold sample is a warm start recorded as cold.
echo
echo "[1] a failing 'get pods' does NOT confirm scale-to-zero"
T1="$(mktemp -d)"
make_stub "$T1"
# All pod queries fail (transient), so no query ever OBSERVES zero.
echo 999 > "${T1}/pods_fail_count"; echo transient > "${T1}/pods_fail_mode"
SCALE_DOWN_TIMEOUT=1 SCALE_DOWN_POLL_S=1 API_RETRY_ATTEMPTS=2 \
  run_bench "$T1" --phases cold --cold-samples 1
assert_not_contains "${T1}/results.txt" "scaled to 0" \
  "a query that never observed zero pods NEVER logs a scale-to-zero confirmation"

# ── Test 2: the query failure is SURFACED in the results file ────────────────
echo
echo "[2] the pod-query failure is visible in the results file (not swallowed)"
assert_contains "${T1}/results.txt" "DEGRADED" \
  "a run whose pod query failed is loudly marked degraded, not silently clean"
if grep -qE "api-retry:|abandoned|pod query FAILED" "${T1}/results.txt"; then
  ok "the failed pod query is recorded (api-retry:/abandoned/pod query FAILED)"
else
  nope "the failed pod query left no trace in the results file"
  sed 's/^/          /' "${T1}/results.txt"
fi

# ── Test 3: a genuine zero STILL confirms scale-to-zero ──────────────────────
echo
echo "[3] a genuine zero (kubectl succeeds, no pods) still confirms scale-to-zero"
T3="$(mktemp -d)"
make_stub "$T3"
echo zero > "${T3}/pods_mode"
SCALE_DOWN_TIMEOUT=30 SCALE_DOWN_POLL_S=1 run_bench "$T3" --phases cold --cold-samples 1
rc=$?
assert_eq "$rc" "0" "a genuine-zero run still completes (exit 0)"
assert_contains "${T3}/results.txt" "scaled to 0" \
  "a real zero — kubectl succeeded and reported no Running pods — still confirms scale-to-zero"

# ── Test 4: a genuine non-zero keeps waiting, never falsely confirms ─────────
echo
echo "[4] a genuine non-zero keeps waiting (no false confirmation)"
T4="$(mktemp -d)"
make_stub "$T4"
echo nonzero > "${T4}/pods_mode"
SCALE_DOWN_TIMEOUT=1 SCALE_DOWN_POLL_S=1 run_bench "$T4" --phases cold --cold-samples 1
assert_not_contains "${T4}/results.txt" "scaled to 0" \
  "pods still Running never yields a scaled-to-zero confirmation"
assert_contains "${T4}/results.txt" "still 2 pod(s)" \
  "a real non-zero reports the ACTUAL pod count it observed (2), then continues"

# ── Test 5: a transient blip is RETRIED then the real zero is observed ───────
# Distinguishes "query failed" from "zero pods": the first query fails transiently,
# api_retry retries, the retry sees a genuine zero, and scale-to-zero confirms.
echo
echo "[5] a transient blip is retried, then a genuine zero confirms scale-to-zero"
T5="$(mktemp -d)"
make_stub "$T5"
echo 1 > "${T5}/pods_fail_count"; echo transient > "${T5}/pods_fail_mode"
echo zero > "${T5}/pods_mode"
SCALE_DOWN_TIMEOUT=30 SCALE_DOWN_POLL_S=1 API_RETRY_ATTEMPTS=3 \
  run_bench "$T5" --phases cold --cold-samples 1
assert_contains "${T5}/results.txt" "scaled to 0" \
  "after a transient blip is retried, the observed genuine zero confirms scale-to-zero"
assert_contains "${T5}/results.txt" "DEGRADED" \
  "the transient blip is still surfaced — the run is marked degraded, not clean"

rm -rf "$T1" "$T3" "$T4" "$T5"

echo
echo "== ${PASS} passed, ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
