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
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  PHASES="" OUT="${dir}/results.txt" \
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

rm -rf "$T1" "$T2" "$T3" "$T4" "$T5"

echo
echo "== ${PASS} passed, ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
