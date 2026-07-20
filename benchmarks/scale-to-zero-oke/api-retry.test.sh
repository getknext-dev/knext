#!/usr/bin/env bash
#
# api-retry.test.sh — tests for the bounded transient-API retry (#427).
#
# Why this exists: two of the three OKE harness runs for #423/#425 aborted on the
# same transient blip while applying the burst config:
#
#   FATAL: failed to apply autoscaling config ...; kubectl exited 1.
#          kubectl said: Unable to connect to the server: net/http: TLS handshake timeout
#
# Refusing to measure an UNAPPLIED config is correct and must be preserved. But
# discarding a valid partial dataset over a one-second control-plane blip forces a
# full re-run, and #309 (p99 cold start under concurrency) needs long runs that
# will hit that window often.
#
# The behaviour these tests pin:
#   - a TRANSIENT apiserver error is retried with backoff and the run completes,
#   - a TERMINAL error (NotFound/Forbidden/Invalid) is NEVER retried — it fails
#     as fast as it does today, because retrying a real misconfiguration just
#     turns a fast failure into a slow one,
#   - retry EXHAUSTION falls through to the unchanged FATAL -> restore -> ABORTED
#     path (the fail-closed contract from #424/#426 is not weakened),
#   - retries are RECORDED in the results file, so a run that limped through a
#     flaky window is visibly distinguishable from a clean first-try run. This
#     harness has already shipped three "results look cleaner than reality" bugs;
#     a silently-retried run must not be the fourth,
#   - a clean run reports zero retries.
#
# Run: bash benchmarks/scale-to-zero-oke/api-retry.test.sh
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
TERMINAL_MSG='Error from server (NotFound): services.serving.knative.dev "demo-svc" not found'

# ── stub kubectl ─────────────────────────────────────────────────────────────
# Steered by small files in the stub dir:
#   apply_fail_from / apply_fail_to   range of apply_autoscaling patch attempts to fail
#   apply_fail_mode                   transient | terminal
#   get_fail_count                    first N `get ksvc` calls fail
#   get_fail_mode                     transient | terminal
#
# The apply patch is identified by its payload carrying BOTH max-scale and
# panic-window-percentage; cleanup()'s restore patches are single-key, so they
# are never counted or failed here. That keeps "attempts for the apply operation"
# an exact, assertable number instead of a total polluted by the restore path.
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
terminal_msg='${TERMINAL_MSG}'
case "\$args" in
  *"get ksvc"*)
    n=\$(cat "${dir}/get_count" 2>/dev/null || echo 0); n=\$((n + 1))
    echo "\$n" > "${dir}/get_count"
    failn=\$(cat "${dir}/get_fail_count" 2>/dev/null || echo 0)
    if [ "\$n" -le "\$failn" ]; then
      mode=\$(cat "${dir}/get_fail_mode" 2>/dev/null || echo transient)
      if [ "\$mode" = "terminal" ]; then echo "\$terminal_msg" >&2; else echo "\$transient_msg" >&2; fi
      exit 1
    fi
    cat "${dir}/ksvc.json" ;;
  *"patch ksvc"*)
    case "\$args" in
      *"panic-window-percentage"*"target-burst-capacity"*|*"target-burst-capacity"*"panic-window-percentage"*)
        n=\$(cat "${dir}/apply_count" 2>/dev/null || echo 0); n=\$((n + 1))
        echo "\$n" > "${dir}/apply_count"
        from=\$(cat "${dir}/apply_fail_from" 2>/dev/null || echo 0)
        to=\$(cat "${dir}/apply_fail_to" 2>/dev/null || echo 0)
        if [ "\$from" != "0" ] && [ "\$n" -ge "\$from" ] && [ "\$n" -le "\$to" ]; then
          mode=\$(cat "${dir}/apply_fail_mode" 2>/dev/null || echo transient)
          if [ "\$mode" = "terminal" ]; then echo "\$terminal_msg" >&2; else echo "\$transient_msg" >&2; fi
          exit 1
        fi ;;
      *) : ;;
    esac ;;
  *"wait --for=condition=complete"*) exit 0 ;;
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
  cat > "${dir}/k6_logs" <<'LOGS'
     checks.........................: 100.00% 10 out of 10
     http_req_duration..............: avg=41ms med=33ms p(95)=98ms
     http_req_failed................: 0.00%   0 out of 10
     http_reqs......................: 10      9.4/s
LOGS
}

# run_bench <stubdir> <extra args...> — retry timings are tiny so the suite is fast.
run_bench() {
  local dir="$1"; shift
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  OUT="${dir}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
  POD_SAMPLE_BUDGET=1 SCHEDULE_CHECK_TIMEOUT=0 K6_JOB_TIMEOUT=5 \
  API_RETRY_BASE_MS="${API_RETRY_BASE_MS:-5}" API_RETRY_MAX_MS="${API_RETRY_MAX_MS:-20}" \
  API_RETRY_ATTEMPTS="${API_RETRY_ATTEMPTS:-4}" \
    bash "$RUN_SH" --service demo-svc --namespace bench "$@" \
      > "${dir}/out.txt" 2>&1
}

apply_attempts() { cat "${1}/apply_count" 2>/dev/null || echo 0; }
get_attempts()   { cat "${1}/get_count" 2>/dev/null || echo 0; }

echo "== api-retry.test.sh =="

# ── Test 1: a TRANSIENT apply error is retried and the run completes ─────────
echo
echo "[1] a transient apply error is retried and the run completes"
T1="$(mktemp -d)"
make_stub "$T1"
echo 1 > "${T1}/apply_fail_from"; echo 2 > "${T1}/apply_fail_to"
echo transient > "${T1}/apply_fail_mode"
run_bench "$T1" --phases cold --cold-samples 1
rc=$?
assert_eq "$rc" "0" "run.sh completes (exit 0) after recovering from a transient apply error"
assert_eq "$(apply_attempts "$T1")" "3" "the apply was attempted 3 times (2 transient failures + 1 success)"
assert_not_contains "${T1}/out.txt" "FATAL: failed to apply autoscaling config" \
  "no FATAL is raised for an error the retry recovered from"

# ── Test 2: retries are RECORDED — a degraded run must not look clean ────────
echo
echo "[2] the retries are recorded in the results file"
assert_contains "${T1}/results.txt" "api-retry:" \
  "each retry is logged to the results file"
assert_contains "${T1}/results.txt" "apply-autoscaling" \
  "the retry record names the operation that was retried"
assert_contains "${T1}/results.txt" "class=transient" \
  "the retry record names the error class that justified the retry"
assert_contains "${T1}/results.txt" "api retries: 2" \
  "the run summary states the total retry count (2)"
assert_contains "${T1}/results.txt" "DEGRADED" \
  "a retried run is loudly marked degraded, not silently equal to a clean run"

# ── Test 3: a TERMINAL apply error fails fast — no retry at all ──────────────
# Modelled on the real #427 incident: the FIRST (baseline) config applies, reps
# run, and the SECOND (tuned) apply fails — so the run has real data to lose and
# the ABORTED verdict is the one under test.
echo
echo "[3] a terminal apply error fails immediately without retrying"
T3="$(mktemp -d)"
make_stub "$T3"
echo 2 > "${T3}/apply_fail_from"; echo 999 > "${T3}/apply_fail_to"
echo terminal > "${T3}/apply_fail_mode"
run_bench "$T3" --phases burst --burst-reps 1
rc=$?
assert_eq "$(apply_attempts "$T3")" "2" \
  "a terminal (NotFound) error is attempted EXACTLY once — never retried (1 good apply + 1 failed)"
if [ "$rc" -ne 0 ]; then ok "run.sh still exits non-zero on a terminal apply error (got $rc)"
else nope "run.sh still exits non-zero on a terminal apply error (got 0)"; fi
assert_contains "${T3}/out.txt" "FATAL: failed to apply autoscaling config" \
  "the existing FATAL message is unchanged for terminal errors"
assert_contains "${T3}/results.txt" "ABORTED" \
  "a terminal error still yields the ABORTED run-integrity verdict"
assert_contains "${T3}/results.txt" "api retries: 0" \
  "a fail-fast terminal error records ZERO retries"

# ── Test 4: retry EXHAUSTION keeps the fail-closed contract ──────────────────
echo
echo "[4] retry exhaustion still FATALs, restores the config, and reports ABORTED"
T4="$(mktemp -d)"
make_stub "$T4"
echo 2 > "${T4}/apply_fail_from"; echo 999 > "${T4}/apply_fail_to"
echo transient > "${T4}/apply_fail_mode"
API_RETRY_ATTEMPTS=3 run_bench "$T4" --phases burst --burst-reps 1
rc=$?
assert_eq "$(apply_attempts "$T4")" "4" \
  "retrying is BOUNDED — 1 good apply + exactly API_RETRY_ATTEMPTS=3 attempts, then it stops"
if [ "$rc" -ne 0 ]; then ok "exhaustion still exits non-zero (got $rc)"
else nope "exhaustion still exits non-zero (got 0)"; fi
assert_contains "${T4}/out.txt" "FATAL: failed to apply autoscaling config" \
  "exhaustion falls through to the EXISTING FATAL path, unchanged"
assert_contains "${T4}/results.txt" "ABORTED" \
  "exhaustion yields the ABORTED run-integrity verdict"
# cleanup() must still restore the captured original config after exhaustion.
assert_contains "${T4}/calls.log" '"containerConcurrency":0' \
  "the captured original config is still restored after exhaustion"
assert_contains "${T4}/results.txt" "CLEANUP" "cleanup still runs after exhaustion"

# ── Test 5: a clean run records ZERO retries and is otherwise unchanged ──────
echo
echo "[5] a clean run records zero retries"
T5="$(mktemp -d)"
make_stub "$T5"
run_bench "$T5" --phases cold --cold-samples 1
rc=$?
assert_eq "$rc" "0" "a clean run still exits 0"
assert_eq "$(apply_attempts "$T5")" "1" "a clean apply is attempted exactly once"
assert_contains "${T5}/results.txt" "api retries: 0" "a clean run reports 'api retries: 0'"
assert_not_contains "${T5}/results.txt" "DEGRADED" "a clean run is NOT marked degraded"
assert_not_contains "${T5}/results.txt" "api-retry:" "a clean run logs no retry records"

# ── Test 6: the capture read retries transients but stays FAIL-CLOSED ────────
echo
echo "[6] capture_original retries a transient read, but never proceeds unread"
T6="$(mktemp -d)"
make_stub "$T6"
echo 2 > "${T6}/get_fail_count"; echo transient > "${T6}/get_fail_mode"
run_bench "$T6" --phases none
rc=$?
assert_eq "$rc" "0" "a transient read blip no longer aborts the whole run"
assert_eq "$(get_attempts "$T6")" "3" "the capture read was retried twice then succeeded"
assert_contains "${T6}/results.txt" "capture-original" "the capture retry is recorded by name"
assert_contains "${T6}/results.txt" "captured original config:" "the config was genuinely captured"

# ── Test 7: a terminal capture error is NOT retried and still aborts ─────────
echo
echo "[7] a terminal capture error is not retried and still aborts before mutation"
T7="$(mktemp -d)"
make_stub "$T7"
echo 999 > "${T7}/get_fail_count"; echo terminal > "${T7}/get_fail_mode"
run_bench "$T7" --phases cold --cold-samples 1
rc=$?
if [ "$rc" -ne 0 ]; then ok "a terminal capture error still aborts (got $rc)"
else nope "a terminal capture error still aborts (got 0)"; fi
assert_eq "$(get_attempts "$T7")" "1" "the terminal read is attempted exactly once — never retried"
assert_not_contains "${T7}/calls.log" "patch" \
  "still no mutation when the original config could not be read (fail-closed, #424)"

# ── Test 8: exhausting the capture read also aborts before any mutation ─────
echo
echo "[8] exhausting the capture retry aborts before any mutation"
T8="$(mktemp -d)"
make_stub "$T8"
echo 999 > "${T8}/get_fail_count"; echo transient > "${T8}/get_fail_mode"
API_RETRY_ATTEMPTS=2 run_bench "$T8" --phases cold --cold-samples 1
rc=$?
if [ "$rc" -ne 0 ]; then ok "an unreachable cluster still aborts the run (got $rc)"
else nope "an unreachable cluster still aborts the run (got 0)"; fi
assert_eq "$(get_attempts "$T8")" "2" "the capture read is BOUNDED at API_RETRY_ATTEMPTS=2"
assert_not_contains "${T8}/calls.log" "patch" \
  "an unreadable config is NEVER silently proceeded past — no patch is issued"
assert_contains "${T8}/out.txt" "ABORTING before any mutation" \
  "the existing fail-closed abort message is unchanged"

# ── Test 9: the classification table, against REAL kubectl error strings ─────
# Verified end-to-end rather than by unit-testing the classifier: what matters is
# that the harness retries/doesn't retry, not that a helper returns a string.
# attempts > 1 => classified transient; attempts == 1 => classified terminal.
echo
echo "[9] classification table — real kubectl messages"
classify_case() {
  local msg="$1" want="$2" desc="$3"
  local d; d="$(mktemp -d)"
  make_stub "$d"
  # Override the stub's transient message with the case under test.
  sed -i.bak "s|^transient_msg=.*|transient_msg='${msg//|/\\|}'|" "${d}/kubectl"
  echo 1 > "${d}/apply_fail_from"; echo 999 > "${d}/apply_fail_to"
  echo transient > "${d}/apply_fail_mode"
  API_RETRY_ATTEMPTS=2 run_bench "$d" --phases cold --cold-samples 1 >/dev/null 2>&1
  local n; n=$(apply_attempts "$d")
  if [ "$want" = "transient" ]; then
    if [ "$n" -gt 1 ]; then ok "transient: ${desc}"; else nope "transient: ${desc} — only ${n} attempt(s), was treated as terminal"; fi
  else
    if [ "$n" -eq 1 ]; then ok "terminal:  ${desc}"; else nope "terminal:  ${desc} — ${n} attempts, was wrongly retried"; fi
  fi
  rm -rf "$d"
}

classify_case 'Unable to connect to the server: net/http: TLS handshake timeout' transient "TLS handshake timeout (the observed #427 failure)"
classify_case 'The connection to the server 1.2.3.4:6443 was refused - did you specify the right host or port?' transient "connection refused (kubectl's real wording)"
classify_case 'Unable to connect to the server: read tcp 10.0.0.1:52000->1.2.3.4:6443: read: connection reset by peer' transient "connection reset by peer"
classify_case 'Unable to connect to the server: dial tcp 1.2.3.4:6443: i/o timeout' transient "i/o timeout"
classify_case 'Error from server (InternalError): an error on the server ("") has prevented the request from succeeding' transient "5xx InternalError"
classify_case 'Error from server (ServiceUnavailable): the server is currently unable to handle the request' transient "503 ServiceUnavailable"
classify_case 'Error from server (Timeout): the server was unable to return a response in the time allotted, but may still be processing the request' transient "server-side request timeout"
classify_case 'Error from server (TooManyRequests): please try again later' transient "429 throttling"
classify_case 'error: unexpected EOF' transient "unexpected EOF"
classify_case 'Error from server (NotFound): services.serving.knative.dev "demo-svc" not found' terminal "NotFound — a typo'd --service must fail fast"
classify_case 'Error from server (Forbidden): services.serving.knative.dev "demo-svc" is forbidden: User cannot patch resource' terminal "Forbidden — RBAC will never succeed on retry"
classify_case 'Error from server (Invalid): Service "demo-svc" is invalid: spec.template.spec.containerConcurrency: Invalid value: -1' terminal "Invalid — a bad annotation value is a real bug"
classify_case 'error: error validating data: unknown field "maxScale"' terminal "validation/unknown-field error"
classify_case 'error: forced patch failure (call 1)' terminal "UNRECOGNISED error is treated as terminal (bias to fail fast)"

rm -rf "$T1" "$T3" "$T4" "$T5" "$T6" "$T7" "$T8"

echo
echo "== ${PASS} passed, ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
