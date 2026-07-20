#!/usr/bin/env bash
#
# k6-metrics-integrity.test.sh — tests for the SECOND most dangerous path in
# run.sh: the one that decides whether a rep's numbers made it into the results
# file at all (#425).
#
# Why this exists: on the OKE validation run for #424, `tuned burst rep 2`
# produced pod metrics but NO k6 metrics block, and the harness still exited 0.
# A benchmark that silently omits a rep is worse than one that crashes, because
# the partial dataset *looks complete* — it nearly caused a published
# "0 errors across all four reps / ~145k requests" claim the data did not
# support. These tests pin the honest-reporting behaviour:
#
#   - zero captured metric lines => a LOUD warning + a non-zero exit,
#   - the k6 Job is KEPT on that path (it is the only remaining evidence),
#   - `kubectl wait` completed / failed / timed-out are reported distinctly,
#   - an empty sampler file reports "<no sampler data>", never a fake "0",
#   - the "did NOT fan out" warning fires ONLY where fan-out is the measurement.
#
# The tests drive run.sh through the documented test seam
# (DRY_RUN=1 + DRY_RUN_EXERCISE_KC=1) with a stub kubectl (KUBECTL_BIN) that
# records every invocation, so the whole run_k6 path executes without a cluster.
#
# Run: bash benchmarks/scale-to-zero-oke/k6-metrics-integrity.test.sh
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

# ── a stub kubectl that can drive every branch of run_k6 ─────────────────────
# Behaviour is steered by small files in the stub dir, written per-test:
#   wait_complete_rc  exit code for `wait --for=condition=complete` (default 0)
#   wait_failed_rc    exit code for `wait --for=condition=failed`   (default 1)
#   pod_count         how many Running app pods `get pods` reports  (default 1)
#   k6_logs           what `kubectl logs job/...` prints            (default empty)
make_k6_stub() {
  local dir="$1"
  cat > "${dir}/ksvc.json" <<'JSON'
{ "spec": { "template": { "metadata": {}, "spec": {} } } }
JSON
  cat > "${dir}/kubectl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${dir}/calls.log"
args="\$*"
rc_complete=\$(cat "${dir}/wait_complete_rc" 2>/dev/null || echo 0)
rc_failed=\$(cat "${dir}/wait_failed_rc" 2>/dev/null || echo 1)
pods=\$(cat "${dir}/pod_count" 2>/dev/null || echo 1)
case "\$args" in
  *"get ksvc"*) cat "${dir}/ksvc.json" ;;
  *"wait --for=condition=complete"*)
    # A real k6 Job runs for tens of seconds, which is what gives the pod
    # sampler time to take a measurement. An instantly-returning stub would let
    # the parent kill the sampler before its first poll, producing a fixture
    # artifact (peak=0) rather than the behaviour under test.
    [ "\$rc_complete" = "0" ] && sleep 4
    exit "\$rc_complete" ;;
  *"wait --for=condition=failed"*) exit "\$rc_failed" ;;
  *"logs"*) cat "${dir}/k6_logs" 2>/dev/null || true ;;
  *"get pods"*"job-name="*) printf 'Running' ;;
  *"get pods"*) for i in \$(seq 1 "\$pods"); do echo "pod-\$i 1/1 Running 0 1s"; done ;;
  *"apply -f"*) cat > /dev/null ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${dir}/kubectl"
  : > "${dir}/calls.log"
  : > "${dir}/k6_logs"
}

REAL_K6_SUMMARY='     checks.........................: 100.00% 1000 out of 1000
     http_req_duration..............: avg=41ms med=33ms p(95)=98ms
     http_req_failed................: 0.00%   0 out of 1000
     http_reqs......................: 1000    98.4/s'

# run_bench <stubdir> <extra run.sh args...> -> exit code; output in out.txt
run_bench() {
  local dir="$1"; shift
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  OUT="${dir}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
  POD_SAMPLE_BUDGET=3 SCHEDULE_CHECK_TIMEOUT=2 K6_JOB_TIMEOUT=5 \
    bash "$RUN_SH" --service demo-svc --namespace bench "$@" \
      > "${dir}/out.txt" 2>&1
}

echo "== k6-metrics-integrity.test.sh =="

# ── Test 1: a rep whose k6 logs contain NO summary is loudly reported ────────
echo
echo "[1] a rep with no k6 summary in its logs is loudly reported as incomplete"
T1="$(mktemp -d)"
make_k6_stub "$T1"
# k6 logs contain startup chatter but no summary — exactly the observed failure.
printf 'running (0m03.0s), 010/010 VUs, 27 complete\n' > "${T1}/k6_logs"
run_bench "$T1" --phases cold --cold-samples 1
rc=$?

assert_contains "${T1}/results.txt" "no k6 metrics captured" \
  "a rep with zero metric lines emits a 'no k6 metrics captured' warning"
assert_contains "${T1}/results.txt" "***" \
  "the warning is as prominent (***-delimited) as the peak-pods warning"
assert_contains "${T1}/results.txt" "cold-1" \
  "the warning names the rep that lost its metrics"
if [ "$rc" -ne 0 ]; then ok "run.sh exits NON-ZERO when a rep's metrics were lost (got $rc)"
else nope "run.sh exits NON-ZERO when a rep's metrics were lost (got 0 — a partial dataset must not look like a clean run)"; fi
assert_contains "${T1}/results.txt" "RUN INCOMPLETE" \
  "the final summary states the run is incomplete"

# ── Test 2: on that path the Job is KEPT — it is the only evidence left ──────
echo
# NOTE the scope: this asserts only that the PER-REP delete is skipped, so the
# Job outlives the rep. It does NOT survive the run — cleanup()'s label sweep
# reaps it at the end (which is why test [11] pins the results-file capture as
# the evidence that actually survives).
echo "[2] the per-rep Job delete is skipped when metrics could not be captured"
assert_not_contains "${T1}/calls.log" "delete job,configmap -n bench k6-" \
  "no per-rep 'kubectl delete job' is issued when metrics were lost"
assert_contains "${T1}/calls.log" "delete job,configmap -n bench -l app=k6-loadtest" \
  "cleanup's label sweep still runs, so the kept Job does NOT survive the run"

# ── Test 3: a happy rep appends metrics, deletes its Job, and exits clean ────
echo
echo "[3] a rep with a real k6 summary is captured, its Job deleted, exit 0"
T3="$(mktemp -d)"
make_k6_stub "$T3"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T3}/k6_logs"
run_bench "$T3" --phases cold --cold-samples 1
rc=$?
if [ "$rc" -eq 0 ]; then ok "run.sh exits 0 when every rep captured metrics (got $rc)"
else nope "run.sh exits 0 when every rep captured metrics (got $rc)"; fi
assert_contains "${T3}/results.txt" "http_req_failed" \
  "the k6 metric lines are appended to the results file"
assert_not_contains "${T3}/results.txt" "no k6 metrics captured" \
  "no false 'metrics lost' warning on the happy path"
assert_contains "${T3}/calls.log" "delete job,configmap -n bench k6-" \
  "the per-rep Job IS deleted once its metrics are safely captured"
assert_not_contains "${T3}/results.txt" "RUN INCOMPLETE" \
  "a fully-captured run is not flagged incomplete"

# ── Test 4: `kubectl wait` timing out is reported distinctly from success ────
echo
echo "[4] a kubectl-wait timeout is reported distinctly from completion"
T4="$(mktemp -d)"
make_k6_stub "$T4"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T4}/k6_logs"
echo 1 > "${T4}/wait_complete_rc"   # neither complete...
echo 1 > "${T4}/wait_failed_rc"     # ...nor failed => timed out / still running
run_bench "$T4" --phases cold --cold-samples 1
assert_contains "${T4}/results.txt" "kubectl wait result: timed-out" \
  "a wait that matched neither condition is reported as timed-out"
assert_not_contains "${T4}/results.txt" "kubectl wait result: completed" \
  "a timed-out Job is never described as completed"

# ── Test 5: a FAILED k6 Job is reported as failed, not as a timeout ──────────
echo
echo "[5] a failed k6 Job is reported as 'failed', distinct from 'timed-out'"
T5="$(mktemp -d)"
make_k6_stub "$T5"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T5}/k6_logs"
echo 1 > "${T5}/wait_complete_rc"
echo 0 > "${T5}/wait_failed_rc"
run_bench "$T5" --phases cold --cold-samples 1
assert_contains "${T5}/results.txt" "kubectl wait result: failed" \
  "a Job matching condition=failed is reported as failed"
assert_not_contains "${T5}/results.txt" "kubectl wait result: timed-out" \
  "a genuinely-failed Job is not mislabelled as a timeout"

# ── Test 6: empty sampler data is NOT reported as a real peak of 0 ───────────
echo
echo "[6] empty sampler data reports '<no sampler data>', never a fabricated 0"
T6="$(mktemp -d)"
make_k6_stub "$T6"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T6}/k6_logs"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${T6}/kubectl" \
OUT="${T6}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
POD_SAMPLE_BUDGET=3 SCHEDULE_CHECK_TIMEOUT=2 K6_JOB_TIMEOUT=5 \
SAMPLER_SIMULATE_LOST=1 \
  bash "$RUN_SH" --service demo-svc --namespace bench --phases burst --burst-reps 1 \
    > "${T6}/out.txt" 2>&1
assert_contains "${T6}/results.txt" "<no sampler data>" \
  "a sampler that produced no measurement reports '<no sampler data>'"
assert_not_contains "${T6}/results.txt" "peak pods = 0" \
  "lost sampler data is never rendered as a real peak of 0"

# ── Test 7: the fan-out warning is scoped to the phase that measures fan-out ─
echo
echo "[7] the 'did NOT fan out' warning fires in burst only, not in cold/soak"
T7="$(mktemp -d)"
make_k6_stub "$T7"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T7}/k6_logs"
echo 1 > "${T7}/pod_count"   # peak = 1: correct for cold, suspicious for burst
run_bench "$T7" --phases cold --cold-samples 1
assert_not_contains "${T7}/results.txt" "did NOT fan out" \
  "cold phase does NOT emit the fan-out warning (1 request => 1 pod is correct)"
assert_contains "${T7}/results.txt" "peak pods = 1" \
  "cold phase still reports the peak, just without a meaningless warning"

T7B="$(mktemp -d)"
make_k6_stub "$T7B"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T7B}/k6_logs"
echo 1 > "${T7B}/pod_count"
run_bench "$T7B" --phases burst --burst-reps 1
assert_contains "${T7B}/results.txt" "did NOT fan out" \
  "burst phase DOES emit the fan-out warning when peak <= 1"

T7C="$(mktemp -d)"
make_k6_stub "$T7C"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T7C}/k6_logs"
echo 1 > "${T7C}/pod_count"
run_bench "$T7C" --phases soak --soak-ramp 1s --soak-hold 1s
assert_not_contains "${T7C}/results.txt" "did NOT fan out" \
  "soak phase does NOT emit the fan-out warning (think-time load, peak 1 expected)"

# ── Test 8: the dry-run banner must not claim safety while the seam mutates ──
echo
echo "[8] the dry-run banner tells the truth when the test seam is active"
T8="$(mktemp -d)"
make_k6_stub "$T8"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${T8}/kubectl" \
PHASES="none" OUT="${T8}/results.txt" \
  bash "$RUN_SH" --service demo-svc --namespace bench > "${T8}/out.txt" 2>&1
assert_not_contains "${T8}/results.txt" "no kubectl mutation, no cluster required" \
  "the seam run does NOT claim 'no kubectl mutation, no cluster required'"
assert_contains "${T8}/results.txt" "DRY_RUN_EXERCISE_KC" \
  "the banner names the seam that is making it mutate"

# ── Test 9: a PARTIAL k6 summary must not read as a complete rep ─────────────
# The #425 claim is "a partial dataset can no longer masquerade as complete".
# A count-based check ("did we get >=1 matching line?") does not deliver that:
# a truncated / partially-flushed summary containing a single http_reqs line
# passed as complete. Completeness must be a check for the expected SET of keys.
echo
echo "[9] a rep with a truncated k6 summary is flagged incomplete, not complete"
T9="$(mktemp -d)"
make_k6_stub "$T9"
printf '     http_reqs......................: 1000    98.4/s\n' > "${T9}/k6_logs"
run_bench "$T9" --phases cold --cold-samples 1
rc=$?
assert_contains "${T9}/results.txt" "RUN INCOMPLETE" \
  "a truncated summary (only http_reqs) makes the run report INCOMPLETE"
if [ "$rc" -ne 0 ]; then ok "run.sh exits NON-ZERO on a partially-captured rep (got $rc)"
else nope "run.sh exits NON-ZERO on a partially-captured rep (got 0 — a partial rep must not look clean)"; fi
assert_not_contains "${T9}/results.txt" "dataset is complete" \
  "the integrity verdict never says 'complete' when a rep is missing metric keys"
assert_contains "${T9}/results.txt" "http_req_duration" \
  "the warning names a missing metric key (http_req_duration)"
assert_contains "${T9}/results.txt" "checks" \
  "the warning names a missing metric key (checks)"

# ── Test 10: a run in which ZERO reps ran must not claim completeness ─────────
echo
echo "[10] a run where no rep ran does not claim 'dataset is complete'"
T10="$(mktemp -d)"
make_k6_stub "$T10"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${T10}/kubectl" \
OUT="${T10}/results.txt" \
  bash "$RUN_SH" --service demo-svc --namespace bench --phases none \
    > "${T10}/out.txt" 2>&1
assert_not_contains "${T10}/results.txt" "dataset is complete" \
  "a zero-rep run does not print 'dataset is complete'"
assert_contains "${T10}/results.txt" "no reps ran" \
  "a zero-rep run states plainly that no data was collected"

# ── Test 11: the evidence for a lost rep SURVIVES the run ────────────────────
# cleanup()'s label sweep deletes the "kept" Job at the end of the run, so for
# the final rep — the observed #425 failure — the printed `kubectl logs`
# instruction pointed at an object the same run had already reaped. The raw
# logs must therefore be written into the results file itself.
echo
echo "[11] raw k6 logs for a lost rep are captured into the results file"
assert_contains "${T1}/results.txt" "010/010 VUs" \
  "the raw k6 Job logs are copied into the results file when metrics were lost"
assert_contains "${T1}/results.txt" "raw k6 Job log" \
  "the captured raw log is labelled so a reader knows what it is"
assert_not_contains "${T1}/results.txt" "so it is reaped shortly — capture the logs now." \
  "the warning no longer points only at a Job this same run deletes"

# ── Test 12: a Job that did not complete cleanly is incomplete, metrics or not ─
echo
echo "[12] a failed k6 Job is incomplete even when its summary looks whole"
T12="$(mktemp -d)"
make_k6_stub "$T12"
printf '%s\n' "$REAL_K6_SUMMARY" > "${T12}/k6_logs"
echo 1 > "${T12}/wait_complete_rc"
echo 0 > "${T12}/wait_failed_rc"
run_bench "$T12" --phases cold --cold-samples 1
rc=$?
assert_contains "${T12}/results.txt" "RUN INCOMPLETE" \
  "a rep whose Job did not complete cleanly is flagged incomplete"
if [ "$rc" -ne 0 ]; then ok "run.sh exits NON-ZERO for a rep whose Job failed (got $rc)"
else nope "run.sh exits NON-ZERO for a rep whose Job failed (got 0)"; fi
assert_not_contains "${T12}/results.txt" "dataset is complete" \
  "a run containing a failed Job never claims a complete dataset"

rm -rf "$T1" "$T3" "$T4" "$T5" "$T6" "$T7" "$T7B" "$T7C" "$T8" "$T9" "$T10" "$T12"

echo
echo "== ${PASS} passed, ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
