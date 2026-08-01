#!/usr/bin/env bash
#
# k6-latency-splits.test.sh — the harness must record k6's latency BREAKDOWN,
# not just the total (#551).
#
# Why this exists: every cold-start number this harness has ever produced was
# unattributable, because `run_k6` filtered the k6 summary down to
# `http_req_duration` and friends BEFORE writing it to disk. The three fields
# that separate the candidate causes were dropped at write time:
#
#   http_req_connecting / http_req_tls_handshaking → time spent getting a
#     connection: the ingress/activator path, a request waiting for capacity.
#   http_req_waiting                               → time spent after connecting:
#     the app itself slow to respond (the pod path).
#
# Run 24 measured a bimodal cold start (~2.5s vs ~10.5s, clean ~8s gap) and
# could not say which interval the extra 8s went into — and the artifacts cannot
# be re-analysed, because the data was never written down. Anything dropped
# before it hits disk is unrecoverable, and cold-start runs are expensive to
# repeat.
#
# The tests pin three things:
#   - the splits reach the results file when k6 reports them,
#   - a sample whose splits are ABSENT is recorded as missing (—), never as 0
#     (a zero here reads as "no time spent connecting", the opposite of the truth),
#   - adding these fields does NOT disturb provenance.sh's median extractor,
#     which every published Run entry depends on.
#
# Drives run.sh through the documented seam (DRY_RUN=1 + DRY_RUN_EXERCISE_KC=1)
# with a stub kubectl, so the whole run_k6 path executes without a cluster.
#
# Run: bash benchmarks/scale-to-zero-oke/k6-latency-splits.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${SCRIPT_DIR}/run.sh"
PROV_SH="${SCRIPT_DIR}/provenance.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   — $1"; }
nope() { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }
assert_contains() {
  if grep -qF -- "$2" "$1"; then ok "$3"; else
    nope "$3 (expected to find: $2)"
  fi
}
assert_not_contains() {
  if grep -qF -- "$2" "$1"; then nope "$3 (unexpectedly found: $2)"; else ok "$3"; fi
}

# Stub kubectl: same shape as k6-metrics-integrity.test.sh's, trimmed to what
# this file drives. `k6_logs` in the stub dir is what `kubectl logs job/...`
# prints — i.e. the k6 summary under test.
make_stub() {
  local dir="$1"
  cat > "${dir}/ksvc.json" <<'JSON'
{ "spec": { "template": { "metadata": {}, "spec": {} } } }
JSON
  cat > "${dir}/kubectl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${dir}/calls.log"
args="\$*"
case "\$args" in
  *"get ksvc"*) cat "${dir}/ksvc.json" ;;
  *"wait --for=condition=complete"*) sleep 4; exit 0 ;;
  *"wait --for=condition=failed"*) exit 1 ;;
  *"logs"*) cat "${dir}/k6_logs" 2>/dev/null || true ;;
  *"get pods"*"job-name="*) printf 'Running' ;;
  *"get pods"*) echo "pod-1 1/1 Running 0 1s" ;;
  *"apply -f"*) cat > /dev/null ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${dir}/kubectl"
  : > "${dir}/calls.log"
  : > "${dir}/k6_logs"
}

run_bench() {
  local dir="$1"; shift
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  OUT="${dir}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
  POD_SAMPLE_BUDGET=3 SCHEDULE_CHECK_TIMEOUT=2 K6_JOB_TIMEOUT=5 \
    bash "$RUN_SH" --service demo-svc --namespace bench "$@" \
      > "${dir}/out.txt" 2>&1
}

# A k6 summary WITH the splits — this is what real k6 emits.
SUMMARY_WITH_SPLITS='     checks.........................: 100.00% 1000 out of 1000
     http_req_connecting............: avg=1.2ms  med=0.9ms  p(95)=4ms
     http_req_duration..............: avg=41ms   med=33ms   p(95)=98ms
     http_req_failed................: 0.00%   0 out of 1000
     http_req_tls_handshaking.......: avg=0s     med=0s     p(95)=0s
     http_req_waiting...............: avg=39ms   med=31ms   p(95)=95ms
     http_reqs......................: 1000    98.4/s'

# A k6 summary WITHOUT the splits (older k6, or a truncated flush).
SUMMARY_NO_SPLITS='     checks.........................: 100.00% 1000 out of 1000
     http_req_duration..............: avg=41ms   med=33ms   p(95)=98ms
     http_req_failed................: 0.00%   0 out of 1000
     http_reqs......................: 1000    98.4/s'

echo "== k6-latency-splits.test.sh =="

# ── Test 1 ───────────────────────────────────────────────────────────────────
echo
echo "[1] the latency SPLITS reach the results file when k6 reports them"
T1="$(mktemp -d)"; make_stub "$T1"
printf '%s\n' "$SUMMARY_WITH_SPLITS" > "${T1}/k6_logs"
run_bench "$T1" --phases cold --cold-samples 1 >/dev/null 2>&1
assert_contains "${T1}/results.txt" "http_req_connecting" \
  "http_req_connecting is written to the results file"
assert_contains "${T1}/results.txt" "http_req_waiting" \
  "http_req_waiting is written to the results file"
assert_contains "${T1}/results.txt" "http_req_tls_handshaking" \
  "http_req_tls_handshaking is written to the results file"

# ── Test 2 ───────────────────────────────────────────────────────────────────
# The honest-reporting rule this harness exists to enforce: an absent
# measurement is NOT a zero measurement.
echo
echo "[2] absent splits are recorded as MISSING, never coerced to zero"
T2="$(mktemp -d)"; make_stub "$T2"
printf '%s\n' "$SUMMARY_NO_SPLITS" > "${T2}/k6_logs"
run_bench "$T2" --phases cold --cold-samples 1 >/dev/null 2>&1
assert_contains "${T2}/results.txt" "http_req_connecting" \
  "an absent split still appears as a named row (so its absence is visible)"
if grep -E 'http_req_connecting[^[:alnum:]_].*(—|<not reported>)' "${T2}/results.txt" >/dev/null 2>&1; then
  ok "the absent split is marked missing, not 0"
else
  nope "the absent split is marked missing, not 0 (must never read as a real 0ms)"
fi
if grep -E 'http_req_connecting[^[:alnum:]_][^0-9]*0(ms|s)?[[:space:]]*$' "${T2}/results.txt" >/dev/null 2>&1; then
  nope "absent split must NOT be written as a zero value"
else
  ok "absent split is not written as a zero value"
fi

# ── Test 3 ───────────────────────────────────────────────────────────────────
# The regression that would silently corrupt every published Run entry.
# provenance.sh extracts http_req_duration medians and MUST NOT start matching
# the new fields — the same care the harness already takes with
# iteration_duration, which runs ~10ms longer and would inflate every figure.
echo
echo "[3] the median extractor is unchanged by the presence of the new fields"
T3="$(mktemp -d)"
cat > "${T3}/with.txt" <<'EOF'
    http_req_connecting............: avg=1.2ms  med=0.9ms  p(95)=4ms
    http_req_duration..............: avg=41ms   med=33ms   p(95)=98ms
    http_req_tls_handshaking.......: avg=0s     med=0s     p(95)=0s
    http_req_waiting...............: avg=39ms   med=31ms   p(95)=95ms
EOF
cat > "${T3}/without.txt" <<'EOF'
    http_req_duration..............: avg=41ms   med=33ms   p(95)=98ms
EOF
if [ -x "$PROV_SH" ] || [ -f "$PROV_SH" ]; then
  a=$(bash "$PROV_SH" medians "${T3}/with.txt" 2>/dev/null)
  b=$(bash "$PROV_SH" medians "${T3}/without.txt" 2>/dev/null)
  if [ "$a" = "$b" ]; then
    ok "provenance.sh medians ignores the split fields (anchored on http_req_duration)"
  else
    nope "provenance.sh medians CHANGED when splits were added — the extractor is matching them
       with-splits: ${a}
       without   : ${b}"
  fi
else
  nope "provenance.sh not found at ${PROV_SH}"
fi

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
