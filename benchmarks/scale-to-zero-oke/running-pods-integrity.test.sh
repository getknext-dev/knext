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
    # pods_fail_after=N: succeed for the first N polls, then fail every one after.
    # The mirror of pods_fail_count, and the only way to build a run whose FINAL
    # poll failed after earlier polls observed pods.
    failafter=\$(cat "${dir}/pods_fail_after" 2>/dev/null || echo 0)
    if [ "\$failafter" -gt 0 ] && [ "\$n" -gt "\$failafter" ]; then
      mode=\$(cat "${dir}/pods_fail_mode" 2>/dev/null || echo transient)
      if [ "\$mode" = "terminal" ]; then echo "\$terminal_msg" >&2; else echo "\$transient_msg" >&2; fi
      exit 1
    fi
    if [ "\$n" -le "\$failn" ]; then
      mode=\$(cat "${dir}/pods_fail_mode" 2>/dev/null || echo transient)
      if [ "\$mode" = "terminal" ]; then echo "\$terminal_msg" >&2; else echo "\$transient_msg" >&2; fi
      exit 1
    fi
    # Optional: emit a warning on STDERR while SUCCEEDING, so the count path can
    # be tested for stderr contamination (#453 item 3).
    [ -f "${dir}/pods_warn_on_stderr" ] && \
      echo "W0000 00:00:00.000000   1 warnings.go:70] some/api is deprecated" >&2
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
  # Isolate the durable index: inheriting the default appended a row to the
  # repo's real results/INDEX.tsv on every test run (it is now ~962 KB).
  # provenance.test.sh already isolates it; follow that convention.
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  RESULTS_INDEX="${dir}/INDEX.tsv" \
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

# -- Test A (#453 item 1): a PERSISTENTLY TERMINAL query still degrades the run --
# api_retry's terminal fast-return increments neither API_RETRY_COUNT nor
# API_ABANDONED_COUNT -- correctly, since a terminal error is usually the caller's
# business. But wait_zero then timed out "continuing anyway" with the truth only in
# per-poll lines and NO top-level signal. The stub's terminal path existed and
# nothing exercised it.
echo
echo "[A] a persistently TERMINAL pod query degrades the run and says it never observed a count"
TA="$(mktemp -d)"
make_stub "$TA"
echo 999 > "${TA}/pods_fail_count"; echo terminal > "${TA}/pods_fail_mode"
TA_RC=0
SCALE_DOWN_TIMEOUT=2 SCALE_DOWN_POLL_S=1 API_RETRY_ATTEMPTS=2 \
  run_bench "$TA" --phases cold --cold-samples 1 || TA_RC=$?
assert_not_contains "${TA}/results.txt" "scaled to 0" \
  "a terminal query never fabricates a scale-to-zero confirmation"
assert_contains "${TA}/results.txt" "NEVER OBSERVED" \
  "the timeout says it never observed a count, not 'still N pods'"
assert_contains "${TA}/results.txt" "DEGRADED" \
  "a purely-terminal failure trips the top-level DEGRADED banner (#453 item 1)"
# A substring check on "DEGRADED" was satisfied by a banner that was factually
# WRONG: it called a terminal failure TRANSIENT, printed "0 retry/retries, 0
# abandoned call(s):" with an empty ops list, and pointed at 'api-retry:' lines
# that a terminal failure never writes. Pin the properties, not the word.
assert_not_contains "${TA}/results.txt" "RUN DEGRADED BY TRANSIENT API ERRORS" \
  "a TERMINAL failure is not reported as a TRANSIENT one"
assert_not_contains "${TA}/results.txt" "clean control-plane run" \
  "a run that never observed a pod count is never reported as clean"
assert_contains "${TA}/results.txt" "NEVER OBSERVED a pod count" \
  "the degraded banner names the actual cause"
# Pin the INDEX line, not the bare word: "UNCONFIRMED" also occurs in wait_zero's
# own per-rep message, so a substring check passed even with the run-status branch
# reverted -- it proved nothing. Caught by mutation, which is the point of doing it.
assert_contains "${TA}/results.txt" "run indexed as UNCONFIRMED" \
  "the durable run status records the dataset as UNCONFIRMED, not COMPLETE"
# The EXIT CODE is the half that automated callers actually read. Prose in a
# results file does not stop a CI job from treating a biased dataset as good.
if [ "$TA_RC" -ne 0 ]; then
  ok "an unconfirmed run exits NON-ZERO (${TA_RC}), so a caller cannot read it as clean"
else
  nope "an unconfirmed run exited 0 — every automated caller reads it as a clean dataset"
fi
# The index status and exit code are not the only verdicts in the file. Round 2
# set both to UNCONFIRMED while these two lines still asserted the data was good
# -- three verdicts, two contradicting the one that had just been added.
assert_not_contains "${TA}/results.txt" "The data is valid" \
  "the 'data is valid' claim is not made about an UNCONFIRMED dataset"
assert_not_contains "${TA}/results.txt" "dataset is complete" \
  "the authoritative run-integrity verdict does not call an UNCONFIRMED dataset complete"

# -- Test B (#453 item 2): SCALE_DOWN_POLL_S=0 must not spin forever --
# Unsanitised, `t=$((t + 0))` never advances and wait_zero hangs. A benchmark that
# hangs is worse than one that errors, because CI just sits there.
echo
echo "[B] SCALE_DOWN_POLL_S=0 is clamped rather than hanging"
TB="$(mktemp -d)"
make_stub "$TB"
echo 999 > "${TB}/pods_fail_count"; echo transient > "${TB}/pods_fail_mode"
# HARD-BOUND the run. Measuring elapsed time AFTER run_bench returns cannot detect
# a hang -- if the loop truly spins, run_bench never returns and the TEST hangs
# too. A test that hangs is worse than one that fails: CI sits there burning a
# runner with no signal. Proven the hard way while mutation-proving this fix, when
# removing the clamp wedged the harness instead of turning it red.
#
# `timeout` returns 124 when it had to kill the run, which is the hang signal.
#
# If `timeout` is ABSENT the command fails with 127, which is not 124, so the
# check would report "ok" having tested nothing -- a vacuous green, which is
# worse than a skip because it reads as coverage. Detect that and say so.
# (ubuntu-latest ships coreutils; a bare macOS box does not.)
TIMEOUT_BIN=""
for c in timeout gtimeout; do
  if command -v "$c" >/dev/null 2>&1; then TIMEOUT_BIN="$c"; break; fi
done
TB_RC=0
if [ -z "$TIMEOUT_BIN" ]; then
  echo "  SKIP  [B] needs timeout(1) (coreutils) to bound the run -- not asserting a vacuous pass"
else
"$TIMEOUT_BIN" 45 env DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${TB}/kubectl" \
  RESULTS_INDEX="${TB}/INDEX.tsv" \
  OUT="${TB}/results.txt" SCALE_DOWN_TIMEOUT=2 SCALE_DOWN_POLL_S=0 \
  APPLY_SETTLE_SECONDS=0 POD_SAMPLE_BUDGET=1 SCHEDULE_CHECK_TIMEOUT=0 \
  K6_JOB_TIMEOUT=5 API_RETRY_BASE_MS=5 API_RETRY_MAX_MS=20 API_RETRY_ATTEMPTS=1 \
  bash "$RUN_SH" --service demo-svc --namespace bench --phases cold --cold-samples 1 \
    > "${TB}/out.txt" 2>&1 || TB_RC=$?
if [ "$TB_RC" = "124" ]; then
  nope "SCALE_DOWN_POLL_S=0 HUNG -- the clamp is missing (timeout had to kill it)"
else
  ok "the run terminated instead of spinning forever (exit ${TB_RC})"
fi
# "did not hang" is NOT the same as "the clamp worked": ANY non-124 exit passed
# the check above, including a run that FATALed in setup and never reached
# wait_zero at all. Proven vacuous by review -- corrupting the stub's ksvc.json
# gave exit 1 and a green check over an empty results file. Pin that the code
# under test actually executed.
assert_contains "${TB}/results.txt" "pod query FAILED" \
  "the run actually reached wait_zero (not a vacuous pass on an early exit)"
fi

# -- Test D (finding 3): a MIXED run reports the pods it DID see --
# The first cut of item 1 keyed "never observed" on qfail>0, so one early failed
# poll suppressed "still N pod(s)" -- the load-bearing fact that scale-to-zero
# genuinely did NOT happen -- and claimed it was "not disproven" when it had been
# positively disproven. This is #429's confusion mirrored: that bug read a failed
# query as observed state; this one read observed state as a failed query.
echo
echo "[D] a run that fails SOME polls but observes pods reports the pods, not 'never observed'"
TD="$(mktemp -d)"
make_stub "$TD"
echo 1 > "${TD}/pods_fail_count"      # exactly one failure, then it recovers
echo transient > "${TD}/pods_fail_mode"
echo nonzero > "${TD}/pods_mode"      # ...and thereafter reports 2 pods
# ATTEMPTS=1 deliberately: with retries enabled api_retry ABSORBS the single
# transient failure, wait_zero never sees a failed poll, and the mixed state this
# test exists to cover is never reached -- the test would pass without proving
# anything. One attempt means the failure reaches wait_zero as a failed poll,
# and the polls after it succeed.
SCALE_DOWN_TIMEOUT=4 SCALE_DOWN_POLL_S=1 API_RETRY_ATTEMPTS=1 \
  run_bench "$TD" --phases cold --cold-samples 1
assert_not_contains "${TD}/results.txt" "NEVER OBSERVED" \
  "a run that DID observe pods is not reported as never having observed a count"
assert_contains "${TD}/results.txt" "last OBSERVED 2 pod(s)" \
  "the count it actually saw is reported, by value"

# -- Test G (round-3 defect 2): the banner must not assert a failure CLASS --
# API_UNOBSERVED_COUNT carries no class information. Round 1 called a TERMINAL
# failure transient; round 2 then hardcoded "terminally" on a branch that purely
# TRANSIENT failures reach -- the same defect mirrored. Test A only covers the
# terminal cause, so nothing saw it.
echo
echo "[G] an unobserved run caused by TRANSIENT errors is not described as terminal"
TG="$(mktemp -d)"
make_stub "$TG"
echo 999 > "${TG}/pods_fail_count"; echo transient > "${TG}/pods_fail_mode"
SCALE_DOWN_TIMEOUT=3 SCALE_DOWN_POLL_S=1 API_RETRY_ATTEMPTS=1 \
  run_bench "$TG" --phases cold --cold-samples 1
assert_contains "${TG}/results.txt" "NEVER OBSERVED" \
  "an all-transient failure still reports that no count was observed"
assert_not_contains "${TG}/results.txt" "terminally" \
  "the banner does not claim a failure class it cannot know"
# The "data is valid" line lives INSIDE the transient branch, so only a run with
# BOTH abandonment and an unobserved wait can reach it -- test A (terminal-only)
# never does, which is why the gate looked like decoration under mutation.
assert_not_contains "${TG}/results.txt" "The data is valid" \
  "'the data is valid' is not claimed when a scale-down wait went unobserved"

# -- Test F (round-3 defect 1): a run whose LAST poll failed --
# `n` holds the last poll's RAW OUTPUT, so when the final poll fails it holds
# kubectl's error text. Round 2 printed it where the pod count belongs --
# "still Unable to connect to the server: ... pod(s)" -- and asserted
# "scale-to-zero did NOT happen" from an observation already seconds stale.
# Test D cannot see this: its failure LEADS, so its last poll succeeds.
echo
echo "[F] a trailing poll failure never prints error text as a pod count"
TF="$(mktemp -d)"
make_stub "$TF"
echo 2 > "${TF}/pods_fail_after"       # polls 1-2 observe pods, 3+ fail
echo transient > "${TF}/pods_fail_mode"
echo nonzero > "${TF}/pods_mode"
SCALE_DOWN_TIMEOUT=5 SCALE_DOWN_POLL_S=1 API_RETRY_ATTEMPTS=1 \
  run_bench "$TF" --phases cold --cold-samples 1
assert_not_contains "${TF}/results.txt" "Unable to connect to the server: net/http: TLS handshake timeout pod(s)" \
  "kubectl error text is never interpolated into the pod-count sentence"
assert_contains "${TF}/results.txt" "last OBSERVED 2 pod(s)" \
  "the last OBSERVED count is reported, not the last raw output"
assert_not_contains "${TF}/results.txt" "scale-to-zero did NOT happen" \
  "no confident disproof is drawn from a stale observation"

# -- Test E (finding 5): a failed mktemp must not present as a query failure --
# `errf=$(mktemp)` returning empty made `2>"$errf"` an AMBIGUOUS REDIRECT, which
# fails the command -- so a full disk or a bad TMPDIR would have read as "the
# pod query failed" and blocked every scale-to-zero confirmation.
echo
echo "[E] a failed mktemp falls back to /dev/null instead of breaking the query"
TE="$(mktemp -d)"
make_stub "$TE"
echo zero > "${TE}/pods_mode"
DRY_RUN_EXERCISE_MKTEMP_FAIL=1 SCALE_DOWN_TIMEOUT=3 SCALE_DOWN_POLL_S=1 \
  run_bench "$TE" --phases cold --cold-samples 1
assert_contains "${TE}/results.txt" "scaled to 0" \
  "a genuine zero is still confirmed when mktemp fails"
assert_not_contains "${TE}/results.txt" "pod query FAILED" \
  "a failed mktemp is not misreported as a failed pod query"

# -- Test J (round-3 defect 6): the mktemp seam is DRY_RUN-gated --
# SOURCE-LEVEL, and weaker than the rest of this file on purpose: every test here
# runs with DRY_RUN=1, so no behavioural test in this suite can distinguish a
# gated seam from an ungated one -- that needs a real cluster. Stated plainly
# rather than dressed up as behavioural coverage. It still fails if the gate is
# removed, which is the regression that matters: an exported
# DRY_RUN_EXERCISE_MKTEMP_FAIL would otherwise silently degrade a REAL run.
echo
echo "[J] DRY_RUN_EXERCISE_MKTEMP_FAIL cannot take effect on a real run"
if grep -q 'if \[ "\${DRY_RUN:-0}" = "1" \] && \[ "\${DRY_RUN_EXERCISE_MKTEMP_FAIL:-0}" = "1" \]' "$RUN_SH"; then
  ok "the mktemp-failure seam is gated on DRY_RUN=1"
else
  nope "DRY_RUN_EXERCISE_MKTEMP_FAIL is NOT gated on DRY_RUN — it can degrade a real measurement run"
fi

# -- Test H (round-3 defect 7): SCALE_DOWN_TIMEOUT=0 polls nothing --
# The loop body never runs, so observed=0 AND qfail=0. The old tail fell through
# to "still <unknown> pod(s)", asserting pods were up on zero observations.
echo
echo "[H] a zero-length scale-down window says nothing was polled"
TH="$(mktemp -d)"
make_stub "$TH"
SCALE_DOWN_TIMEOUT=0 SCALE_DOWN_POLL_S=1 \
  run_bench "$TH" --phases cold --cold-samples 1
assert_contains "${TH}/results.txt" "no scale-down poll was made" \
  "a window that polled nothing says so"
assert_not_contains "${TH}/results.txt" "still unknown pod(s)" \
  "no claim about pods is made from zero observations"

# -- Test I (round-3 defect 5): mktemp failure must not blind error classification --
# Falling back to /dev/null discarded stderr, handing classify_api_error a BLANK
# string -- which run.sh:1055 says is worse than an imprecise one. Every failure
# would classify terminal: no retry, no diagnostic, on exactly the box (full /tmp)
# where the fallback exists. Test E cannot see it: its query SUCCEEDS.
echo
echo "[I] when mktemp fails, a transient error is still classified and retried"
TI="$(mktemp -d)"
make_stub "$TI"
echo 1 > "${TI}/pods_fail_count"; echo transient > "${TI}/pods_fail_mode"
echo zero > "${TI}/pods_mode"
DRY_RUN_EXERCISE_MKTEMP_FAIL=1 SCALE_DOWN_TIMEOUT=4 SCALE_DOWN_POLL_S=1 API_RETRY_ATTEMPTS=3 \
  run_bench "$TI" --phases cold --cold-samples 1
assert_contains "${TI}/results.txt" "TLS handshake timeout" \
  "kubectl's diagnostic survives the mktemp-failure path"
assert_contains "${TI}/results.txt" "api-retry:" \
  "a transient error is still classified transient and RETRIED when mktemp fails"

# -- Test C (#453 item 3): a stderr warning is not counted as a pod --
# running_pods used 2>&1 and counted combined output on success, so a kubectl
# deprecation notice read as a pod: the count never reaches zero and a perfectly
# healthy scale-to-zero looks broken.
echo
echo "[C] a kubectl warning on stderr is not counted as a running pod"
TC="$(mktemp -d)"
make_stub "$TC"
echo zero > "${TC}/pods_mode"
echo 1 > "${TC}/pods_warn_on_stderr"
SCALE_DOWN_TIMEOUT=3 SCALE_DOWN_POLL_S=1 \
  run_bench "$TC" --phases cold --cold-samples 1
assert_contains "${TC}/results.txt" "scaled to 0" \
  "a genuine zero is still confirmed when kubectl also writes a warning to stderr"

rm -rf "$T1" "$T3" "$T4" "$T5" "$TA" "$TB" "$TC" "$TD" "$TE" "$TF" "$TG" "$TH" "$TI"

echo
echo "== ${PASS} passed, ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
