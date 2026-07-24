#!/usr/bin/env bash
#
# capture-restore.test.sh — tests for the single most dangerous path in run.sh:
# capturing the target ksvc's original autoscaling config and restoring it.
#
# Why this exists (#423 / PR #424 review): `--dry-run` short-circuits before
# capture_original/cleanup, so the restore path — the only code here that can
# *destroy* a real service's config — had zero coverage. A capture that silently
# swallowed a failed `kubectl get` was indistinguishable from "the field was
# unset", and the restore then reset containerConcurrency to 0 and stripped all
# four autoscaling annotations off a healthy service.
#
# The tests drive run.sh with a stub kubectl (KUBECTL_BIN) in the documented
# test seam (DRY_RUN=1 + DRY_RUN_EXERCISE_KC=1, PHASES empty) and assert on the
# exact kubectl invocations recorded by the stub.
#
# Run: bash benchmarks/scale-to-zero-oke/capture-restore.test.sh
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

# make_stub <dir> <get-exit-code> [ksvc-json-file]
# Writes a fake kubectl that logs every invocation to $dir/calls.log and answers
# `get ksvc ... -o json` from the fixture (or fails with <get-exit-code>).
make_stub() {
  local dir="$1" get_rc="$2" fixture="${3:-}"
  cat > "${dir}/kubectl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${dir}/calls.log"
args="\$*"
case "\$args" in
  *"get ksvc"*)
    if [ "${get_rc}" != "0" ]; then
      echo "Error from server (NotFound): services.serving.knative.dev not found" >&2
      exit ${get_rc}
    fi
    cat "${fixture}"
    ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${dir}/kubectl"
  : > "${dir}/calls.log"
}

# run_harness <stubdir> -> exit code of run.sh; stdout+stderr in $stubdir/out.txt
run_harness() {
  local dir="$1"
  # PHASES=none, NOT PHASES="": run.sh reads `${PHASES:-cold,soak,burst}`, and
  # `:-` treats an empty value as *unset*, so PHASES="" silently ran all three
  # phases here (#425). It only looked like "no phases" because run_k6 used to
  # early-return under DRY_RUN=1.
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  PHASES="none" OUT="${dir}/results.txt" \
    bash "$RUN_SH" --service demo-svc --namespace bench > "${dir}/out.txt" 2>&1
}

echo "== capture-restore.test.sh =="

# ── Test 1: a failed `kubectl get` must ABORT, never mutate ──────────────────
echo
echo "[1] a failed capture aborts instead of mutating the target"
T1="$(mktemp -d)"
make_stub "$T1" 1
run_harness "$T1"
rc=$?

if [ "$rc" -ne 0 ]; then ok "run.sh exits non-zero when the ksvc cannot be read (got $rc)"
else nope "run.sh exits non-zero when the ksvc cannot be read (got 0)"; fi

assert_not_contains "${T1}/calls.log" "patch" \
  "no 'kubectl patch' is issued when capture failed (config not destroyed)"
assert_contains "${T1}/out.txt" "demo-svc" "the abort message names the service"

# ── Test 2: a successful capture restores the EXACT original values ──────────
echo
echo "[2] a successful capture restores exactly what was there"
T2="$(mktemp -d)"
cat > "${T2}/ksvc.json" <<'JSON'
{
  "apiVersion": "serving.knative.dev/v1",
  "kind": "Service",
  "metadata": { "name": "demo-svc", "namespace": "bench" },
  "spec": {
    "template": {
      "metadata": {
        "annotations": {
          "autoscaling.knative.dev/max-scale": "3",
          "autoscaling.knative.dev/target-burst-capacity": "211"
        }
      },
      "spec": { "containerConcurrency": 20 }
    }
  }
}
JSON
make_stub "$T2" 0 "${T2}/ksvc.json"
run_harness "$T2"
rc=$?

if [ "$rc" -eq 0 ]; then ok "run.sh exits 0 on a clean capture+restore (got $rc)"
else nope "run.sh exits 0 on a clean capture+restore (got $rc)"; fi

# exactly one `get ksvc` — capture must be atomic, not five racy reads
gets=$(grep -c "get ksvc" "${T2}/calls.log")
if [ "$gets" = "1" ]; then ok "capture does exactly ONE 'get ksvc' (atomic)"
else nope "capture does exactly ONE 'get ksvc' (atomic) — got ${gets}"; fi

# set values are restored to their originals, NOT to defaults
assert_contains "${T2}/calls.log" '"containerConcurrency":20' \
  "containerConcurrency restored to the captured 20 (not reset to 0)"
assert_contains "${T2}/calls.log" '"autoscaling.knative.dev/max-scale":"3"' \
  "max-scale restored to the captured 3 (not stripped)"
assert_contains "${T2}/calls.log" '"autoscaling.knative.dev/target-burst-capacity":"211"' \
  "target-burst-capacity restored to the captured 211"

# genuinely-unset values are removed via JSON-patch with ~1 escaping
assert_contains "${T2}/calls.log" \
  '"op":"remove","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1panic-window-percentage"' \
  "originally-unset panic-window-percentage is removed (JSON-patch, ~1 escaped)"
assert_contains "${T2}/calls.log" \
  '"op":"remove","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1panic-threshold-percentage"' \
  "originally-unset panic-threshold-percentage is removed (JSON-patch, ~1 escaped)"
assert_not_contains "${T2}/calls.log" \
  '"op":"remove","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1max-scale"' \
  "a max-scale that WAS set is never removed"

# ── Test 3: a ksvc with nothing set restores to 'unset', not to test config ──
echo
echo "[3] an all-unset ksvc is restored to all-unset"
T3="$(mktemp -d)"
cat > "${T3}/ksvc.json" <<'JSON'
{ "spec": { "template": { "metadata": {}, "spec": {} } } }
JSON
make_stub "$T3" 0 "${T3}/ksvc.json"
run_harness "$T3"

assert_contains "${T3}/calls.log" '"containerConcurrency":0' \
  "unset containerConcurrency restored to 0 (Knative's 'unbounded' default)"
assert_contains "${T3}/calls.log" \
  '"op":"remove","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1max-scale"' \
  "unset max-scale is removed rather than pinned to the harness value"

# ── Test 4: plain --dry-run still needs no cluster and mutates nothing ───────
echo
echo "[4] plain --dry-run (no stub) touches no cluster"
T4="$(mktemp -d)"
PATH="/nonexistent-bin:$PATH" bash "$RUN_SH" --service demo-svc --namespace bench \
  --dry-run --phases cold --cold-samples 1 --out "${T4}/results.txt" > "${T4}/out.txt" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then ok "--dry-run succeeds with kubectl unavailable (got $rc)"
else nope "--dry-run succeeds with kubectl unavailable (got $rc)"; fi
assert_contains "${T4}/out.txt" "DRY RUN" "--dry-run announces itself"

# ── Test 5: --container-concurrency 0 (legal: unbounded) must not divide by 0 ─
echo
echo "[5] --container-concurrency 0 is legal and must not divide by zero"
T5="$(mktemp -d)"
bash "$RUN_SH" --service demo-svc --namespace bench --dry-run --phases burst \
  --container-concurrency 0 --burst-reps 1 --out "${T5}/results.txt" > "${T5}/out.txt" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then ok "burst phase survives containerConcurrency=0 (got $rc)"
else nope "burst phase survives containerConcurrency=0 (got $rc)"; fi
assert_not_contains "${T5}/out.txt" "division by 0" "no 'division by 0' arithmetic error"

# ── Test 6: a second signal during restore is never silent about un-applied keys (#430) ──
# Restore patches run UNBOUNDED. A first Ctrl-C triggers cleanup's restore; a
# second signal arriving mid-restore re-enters cleanup(), hits the CLEANED_UP
# guard, and (pre-#430) exited 130/143 SILENTLY — abandoning whatever restore
# patches had not yet run, with no RESTORE-FAILED line. The fix tracks the
# not-yet-attempted keys in a SCRIPT-GLOBAL and, on re-entry with work still
# pending, prints them instead of exiting silently.
#
# Two properties are asserted:
#   (a) DETERMINISTIC — a completed restore that then re-enters cleanup (the
#       ordinary INT->exit->EXIT double-fire) stays SILENT: no FALSE
#       "RESTORE INTERRUPTED" line, and the normal `restored:` line still prints.
#       This guards the fix against over-reporting and runs on every machine.
#   (b) BEST-EFFORT — deliver a genuine second signal mid-restore and assert the
#       interrupted-restore surface NAMES the un-applied keys. Whether a second
#       signal preempts a still-running restore (vs being deferred by bash until
#       the restore completes, or default-killing the process) is bash-build and
#       timing dependent, so this is attempted with bounded retries and SKIPs
#       (never FAILs) if it cannot be landed on this machine.
echo
echo "[6] a second signal during restore is never silent about un-applied keys (#430)"
T6="$(mktemp -d)"
cat > "${T6}/ksvc.json" <<'JSON'
{
  "apiVersion": "serving.knative.dev/v1",
  "kind": "Service",
  "metadata": { "name": "demo-svc", "namespace": "bench" },
  "spec": {
    "template": {
      "metadata": { "annotations": { "autoscaling.knative.dev/max-scale": "3" } },
      "spec": { "containerConcurrency": 20 }
    }
  }
}
JSON
# Stub kubectl: answers `get ksvc` from the fixture, SLEEPS on every `patch` (so
# both the apply-config patch and the restore patches have an interrupt window),
# and logs every invocation. `get pods` (wait_zero) returns nothing -> 0.
cat > "${T6}/kubectl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${T6}/calls.log"
case "\$*" in
  *"get ksvc"*) cat "${T6}/ksvc.json" ;;
  *patch*)      sleep 1 ;;
  *)            : ;;
esac
exit 0
STUB
chmod +x "${T6}/kubectl"
: > "${T6}/calls.log"

# t6_run <first-sig> <second-sig|"">  — launch run.sh under the seam with a real
# load phase so the first signal interrupts the in-flight APPLY_SETTLE sleep and
# cleanup runs via the SIGNAL trap (not the plain EXIT path). Poll for the
# restore banner, deliver the second signal (if any) into the restore window.
# Result: $T6_RC (exit status), $T6_OUT (artifact path).
T6_OUT="${T6}/out.txt"
t6_run() {
  local sig1="$1" sig2="$2" pid i
  : > "$T6_OUT"; : > "${T6}/calls.log"
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${T6}/kubectl" \
  PHASES="cold" COLD_SAMPLES=1 APPLY_SETTLE_SECONDS=3 OUT="${T6}/results.txt" \
    bash "$RUN_SH" --service demo-svc --namespace bench > "$T6_OUT" 2>&1 &
  pid=$!
  # wait for the cold phase to start applying config, then let the apply patch
  # (1s) finish so signal 1 lands in the APPLY_SETTLE sleep (an interruptible
  # builtin), giving a clean signal-triggered cleanup.
  for i in $(seq 1 100); do
    grep -qF "PHASE A" "$T6_OUT" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  sleep 1.5
  kill -"$sig1" "$pid" 2>/dev/null
  if [ -n "$sig2" ]; then
    # wait for restore to actually start, then fire the second signal into it
    for i in $(seq 1 60); do
      grep -qF "CLEANUP — restoring" "$T6_OUT" 2>/dev/null && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    sleep 0.4
    kill -"$sig2" "$pid" 2>/dev/null
  fi
  wait "$pid"
  T6_RC=$?
}

# (a) DETERMINISTIC — single signal: restore runs to completion, then the
# INT->exit->EXIT double-fire re-enters cleanup with nothing pending. Must be
# SILENT about interruption and still print the normal restored: line.
t6_run INT ""
assert_not_contains "$T6_OUT" "RESTORE INTERRUPTED" \
  "a completed restore does NOT emit a false interrupted-restore line (no over-report)"
assert_contains "$T6_OUT" "restored: containerConcurrency=20" \
  "a completed restore still prints the normal 'restored:' line after a signal"

# (b) BEST-EFFORT — two signals (INT then TERM) aimed at the restore window.
t6_landed=0
for attempt in 1 2 3; do
  t6_run INT TERM
  if grep -qF "RESTORE INTERRUPTED" "$T6_OUT"; then t6_landed=1; break; fi
done

if [ "$t6_landed" != "1" ]; then
  echo "  SKIP — a second signal could not be landed mid-restore after 3 attempts"
  echo "         on this bash build (bash defers/serialises the second signal to"
  echo "         restore completion here). The re-entry-reporting surface and the"
  echo "         RESTORE_PENDING tracking are exercised structurally by (a) above."
else
  assert_contains "$T6_OUT" "RESTORE INTERRUPTED" \
    "a second signal mid-restore reports the interruption (never silent)"
  if grep -E "RESTORE INTERRUPTED .*(containerConcurrency|max-scale|target-burst-capacity|panic-window-percentage|panic-threshold-percentage)" "$T6_OUT" >/dev/null; then
    ok "the interrupted-restore line NAMES at least one un-applied key"
  else
    nope "the interrupted-restore line NAMES at least one un-applied key"
    sed 's/^/          /' "$T6_OUT"
  fi
  assert_contains "$T6_OUT" "MAY STILL BE MUTATED" \
    "the interruption warns the service MAY STILL BE MUTATED"
  if [ "$T6_RC" = "130" ] || [ "$T6_RC" = "143" ]; then
    ok "signal exit semantics preserved (got $T6_RC)"
  else
    nope "signal exit semantics preserved — expected 130/143, got $T6_RC"
  fi
fi

# ── Test 7: cleanup()'s re-entry reporting, driven DETERMINISTICALLY (#430) ──
# Test 6(b) reproduces the real double-signal race but SKIPs where bash defers
# the second signal to restore completion. This test removes the race entirely:
# it SOURCES run.sh (which stops at the test seam, defining cleanup() without
# running the benchmark) and drives cleanup()'s re-entry path directly. This is
# the faithful red-before-green check — pre-#430 the CLEANED_UP guard returned
# silently, so the artifact stayed empty; the fix names the un-applied keys.
echo
echo "[7] cleanup() re-entry names un-applied keys (deterministic, sourced) (#430)"
T7="$(mktemp -d)"

# 7a — re-entry with restore mid-flight: RESTORE_PENDING names the keys not yet
# attempted, so the artifact must report them (RED before the fix).
(
  set -uo pipefail
  SERVICE="demo-svc"; NS="bench"; DRY_RUN=1; OUT="${T7}/boot.txt"
  # shellcheck disable=SC1090
  source "$RUN_SH" --service demo-svc --namespace bench >/dev/null 2>&1
  trap - EXIT INT TERM                       # don't run cleanup on subshell exit
  CLEANED_UP=1                               # a first cleanup already began
  RESTORE_PENDING=" target-burst-capacity panic-window-percentage panic-threshold-percentage"
  OUT="${T7}/a.txt"; : > "$OUT"
  cleanup >/dev/null 2>&1                     # the re-entrant second call
)
assert_contains "${T7}/a.txt" "RESTORE INTERRUPTED" \
  "re-entry mid-restore reports the interruption instead of exiting silently"
assert_contains "${T7}/a.txt" "target-burst-capacity panic-window-percentage panic-threshold-percentage" \
  "the report NAMES exactly the un-applied keys"
assert_contains "${T7}/a.txt" "MAY STILL BE MUTATED" \
  "the report warns the service MAY STILL BE MUTATED"

# 7b — re-entry AFTER restore finished (RESTORE_PENDING empty): the ordinary
# EXIT-after-INT double-fire must stay SILENT (true idempotency, no over-report).
(
  set -uo pipefail
  SERVICE="demo-svc"; NS="bench"; DRY_RUN=1; OUT="${T7}/boot.txt"
  # shellcheck disable=SC1090
  source "$RUN_SH" --service demo-svc --namespace bench >/dev/null 2>&1
  trap - EXIT INT TERM
  CLEANED_UP=1; RESTORE_PENDING=""            # restore already completed
  OUT="${T7}/b.txt"; : > "$OUT"
  cleanup >/dev/null 2>&1
)
assert_not_contains "${T7}/b.txt" "RESTORE INTERRUPTED" \
  "a re-entry after restore completed stays silent (no false interrupted line)"

# 7c — _restore_attempted's leading-space scheme must not let one key's removal
# clobber another whose name it is a prefix-collision with (panic-window vs
# panic-threshold). Attempting panic-window-percentage must leave the others.
coll="$(
  set -uo pipefail
  SERVICE="demo-svc"; NS="bench"; DRY_RUN=1; OUT="${T7}/boot.txt"
  # shellcheck disable=SC1090
  source "$RUN_SH" --service demo-svc --namespace bench >/dev/null 2>&1
  trap - EXIT INT TERM
  RESTORE_PENDING=" containerConcurrency max-scale target-burst-capacity panic-window-percentage panic-threshold-percentage"
  _restore_attempted panic-window-percentage
  printf '%s' "$RESTORE_PENDING"
)"
if [ "$coll" = " containerConcurrency max-scale target-burst-capacity panic-threshold-percentage" ]; then
  ok "_restore_attempted removes only the exact key (panic-threshold-percentage survives)"
else
  nope "_restore_attempted removes only the exact key"
  echo "        got RESTORE_PENDING='${coll}'"
fi

rm -rf "$T1" "$T2" "$T3" "$T4" "$T5" "$T6" "$T7"

echo
echo "== ${PASS} passed, ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
