#!/usr/bin/env bash
#
# scaledown-contamination.test.sh — a "cold" sample taken with pods PROVABLY
# still up must contaminate the run's verdict, its index row, and its exit code.
#
# Why this exists (2026-08-19): a service carrying a `scale-down-delay`
# annotation kept its pod through the harness's scale-down window, and two
# 52 ms WARM hits flowed into a results file whose authoritative verdict read
# "dataset is complete" and whose exit code was 0. The inline log line said
# scale-to-zero "did NOT happen" — the harness's strongest per-rep statement —
# but nothing carried it into the verdict, the INDEX row, or the exit code.
# That is the exact "reads cleaner than reality" class this harness documents
# for its other five integrity bugs, one instance further along.
#
# Drives run.sh through the documented test seam (DRY_RUN=1 +
# DRY_RUN_EXERCISE_KC=1 + KUBECTL_BIN stub), same as k6-metrics-integrity.test.sh.
#
# Run: bash benchmarks/scale-to-zero-oke/scaledown-contamination.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${SCRIPT_DIR}/run.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   — $1"; }
nope() { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }
assert_contains() {
  if grep -qF -- "$2" "$1"; then ok "$3"; else
    nope "$3"; echo "        expected to find: $2"
  fi
}
assert_not_contains() {
  if grep -qF -- "$2" "$1"; then nope "$3"; echo "        did NOT expect: $2"; else ok "$3"; fi
}

make_stub() {
  local dir="$1"
  cat > "${dir}/ksvc.json" <<'JSON'
{ "spec": { "template": { "metadata": {}, "spec": {} } } }
JSON
  cat > "${dir}/kubectl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${dir}/calls.log"
args="\$*"
pods=\$(cat "${dir}/pod_count" 2>/dev/null || echo 1)
case "\$args" in
  *"get ksvc"*) cat "${dir}/ksvc.json" ;;
  *"wait --for=condition=complete"*) sleep 4; exit 0 ;;
  *"wait --for=condition=failed"*) exit 1 ;;
  *"logs"*) cat "${dir}/k6_logs" 2>/dev/null || true ;;
  *"get pods"*"job-name="*) printf 'Running' ;;
  # BSD seq counts DOWN ('seq 1 0' -> "1 0"), the exact trap abba.sh documents:
  # pod_count=0 would print TWO pods and turn the clean case into a disproof.
  *"get pods"*) if [ "\$pods" -gt 0 ]; then for i in \$(seq 1 "\$pods"); do echo "pod-\$i 1/1 Running 0 1s"; done; fi ;;
  *"apply -f"*) cat > /dev/null ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${dir}/kubectl"
  : > "${dir}/calls.log"
  cat > "${dir}/k6_logs" <<'K6'
     checks.........................: 100.00% 1000 out of 1000
     http_req_duration..............: avg=41ms med=33ms p(95)=98ms
     http_req_failed................: 0.00%   0 out of 1000
     http_reqs......................: 1000    98.4/s
K6
}

run_bench() {
  local dir="$1"; shift
  # SCALE_DOWN_TIMEOUT=1, not 0: zero is the documented "skip the wait" and the
  # disproof under test lives INSIDE the wait loop — with 0 polls there is
  # nothing to disprove and test A silently tests nothing.
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  OUT="${dir}/results.txt" RESULTS_INDEX="${dir}/INDEX.tsv" \
  SCALE_DOWN_TIMEOUT=1 APPLY_SETTLE_SECONDS=0 \
  POD_SAMPLE_BUDGET=3 SCHEDULE_CHECK_TIMEOUT=2 K6_JOB_TIMEOUT=5 \
    bash "$RUN_SH" --service demo-svc --namespace bench --phases cold --cold-samples 1 "$@" \
      > "${dir}/out.txt" 2>&1
}

echo "test A — pods provably still up: verdict, warning, index row and exit code all say so"
A=$(mktemp -d)
make_stub "$A"
echo 1 > "${A}/pod_count"     # every poll observes 1 Running pod -> positive disproof
run_bench "$A"; rc=$?
[ "$rc" -eq 3 ] && ok "exit code is 3 (dataset exists, trust compromised)" \
                || nope "exit code is $rc, wanted 3"
assert_contains "${A}/results.txt" "did NOT happen within the window" "the inline disproof line still prints"
assert_contains "${A}/results.txt" "RUN CONTAMINATED" "the run-level warning names the contamination"
assert_contains "${A}/results.txt" "dataset is CONTAMINATED" "the AUTHORITATIVE verdict says CONTAMINATED"
assert_not_contains "${A}/results.txt" "dataset is complete" "the verdict does NOT claim completeness"
grep -q "CONTAMINATED" "${A}/INDEX.tsv" 2>/dev/null && ok "INDEX row is CONTAMINATED" \
  || nope "INDEX row is not CONTAMINATED: $(tail -1 "${A}/INDEX.tsv" 2>/dev/null)"

echo "test B — genuine zero: nothing above fires, run is clean"
B=$(mktemp -d)
make_stub "$B"
echo 0 > "${B}/pod_count"     # polls observe 0 pods -> genuine scale-to-zero
run_bench "$B"; rc=$?
[ "$rc" -eq 0 ] && ok "exit code is 0 on a clean run" || nope "exit code is $rc, wanted 0"
assert_contains "${B}/results.txt" "dataset is complete" "clean run still gets its complete verdict"
assert_not_contains "${B}/results.txt" "CONTAMINATED" "no contamination text on a clean run"

rm -r "$A" "$B"
echo ""
echo "scaledown-contamination: ${PASS} ok, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
