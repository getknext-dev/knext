#!/usr/bin/env bash
#
# pending-restore.test.sh — the captured config must survive SIGKILL (#536).
#
# Why this exists: the captured original config lived only in the running
# process's variables, and the restore was trap-based. `SIGKILL` cannot be
# trapped, so killing the process outright destroyed the knowledge of what to
# restore and left the service in benchmark configuration with nothing on disk
# recording what it used to be.
#
# That is not hypothetical. During Run 23 a benchmark process was terminated
# without its trap running, and the originals had to be reconstructed by hand
# from a `captured original config:` log line that happened to still exist.
#
# The blast radius is the quiet kind: a lowered max-scale silently caps a later
# load test, and panic-window settings change autoscaler behaviour for every
# subsequent measurement on that service. The next benchmark then produces
# plausible-but-wrong numbers rather than failing.
#
# These tests pin the contract:
#   - the file is written BEFORE any mutation,
#   - an actual `kill -9` leaves it behind (proven by killing, not by reading),
#   - a later run REFUSES to start and names the service + restore command,
#   - `--restore-pending` applies it, and is idempotent,
#   - a PARTIAL restore keeps the file — a key that did not apply is exactly when
#     the next run must still refuse.
#
# Run: bash benchmarks/scale-to-zero-oke/pending-restore.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${SCRIPT_DIR}/run.sh"
PENDING_DIR="${SCRIPT_DIR}/results"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   — $1"; }
nope() { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }

# Stub kubectl: a `get ksvc` returning a known original config, and a patch that
# can be made to hang so a run can be killed mid-flight.
make_stub() {
  local dir="$1"
  cat > "${dir}/kubectl" <<STUB
#!/usr/bin/env bash
args="\$*"
case "\$args" in
  *"get ksvc"*)
    cat <<'JSON'
{ "spec": { "template": {
    "metadata": { "annotations": {
        "autoscaling.knative.dev/max-scale": "17",
        "autoscaling.knative.dev/target-burst-capacity": "211",
        "autoscaling.knative.dev/panic-window-percentage": "6",
        "autoscaling.knative.dev/panic-threshold-percentage": "150" } },
    "spec": { "containerConcurrency": 23 } } } }
JSON
    ;;
  *"patch ksvc"*)
    hang=\$(cat "${dir}/patch_hang_s" 2>/dev/null || echo 0)
    [ "\$hang" != "0" ] && sleep "\$hang"
    ;;
  *"get pods"*"job-name="*) printf 'Running' ;;
  *"get pods"*) echo "pod-1 1/1 Running 0 1s" ;;
  *"wait --for=condition=complete"*) sleep 1; exit 0 ;;
  *"logs"*) echo "     http_req_duration..............: avg=1ms med=1ms" ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${dir}/kubectl"
}

pending_file_for() {
  local ctx="$1" ns="$2" svc="$3"
  local key
  key=$(printf '%s_%s_%s' "$ctx" "$ns" "$svc" | tr -c 'A-Za-z0-9_.-' '_')
  printf '%s/.pending-restore-%s.json' "$PENDING_DIR" "$key"
}

CTX="pendingtest-ctx"
NS="pendingtest-ns"
SVC="pendingtest-svc"
PF="$(pending_file_for "$CTX" "$NS" "$SVC")"
rm -f "$PF"

echo "== pending-restore.test.sh =="

# ── Test 1: SIGKILL leaves the file behind ──────────────────────────────────
# The whole point. A trap cannot run on SIGKILL, so this is proven by actually
# killing a run — reading the source would prove nothing about signal behaviour.
echo
echo "[1] a SIGKILLed run leaves its captured config on disk"
T1="$(mktemp -d)"; make_stub "$T1"
echo 30 > "${T1}/patch_hang_s"   # hang in the first mutation, after capture
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 DRY_RUN_EXERCISE_PENDING=1 KUBECTL_BIN="${T1}/kubectl" \
OUT="${T1}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
POD_SAMPLE_BUDGET=1 SCHEDULE_CHECK_TIMEOUT=0 K6_JOB_TIMEOUT=5 \
  bash "$RUN_SH" --context "$CTX" --namespace "$NS" --service "$SVC" \
    --phases cold --cold-samples 1 > "${T1}/out.txt" 2>&1 &
KILL_PID=$!

ARMED=0
for _ in $(seq 1 600); do
  [ -f "$PF" ] && { ARMED=1; break; }
  sleep 0.1
done
if [ "$ARMED" = "1" ]; then
  ok "the pending-restore file exists BEFORE the run is killed (written at capture)"
else
  nope "the pending-restore file was never written (expected at $PF)"
  sed 's/^/      /' "${T1}/out.txt" 2>/dev/null | tail -15
fi

kill -9 "$KILL_PID" 2>/dev/null
wait "$KILL_PID" 2>/dev/null

if [ -f "$PF" ]; then
  ok "it SURVIVES kill -9 (a trap could not have done this)"
else
  nope "the file did not survive kill -9"
fi

if grep -q '"maxScale": "17"' "$PF" 2>/dev/null && grep -q '"containerConcurrency": "23"' "$PF" 2>/dev/null; then
  ok "it carries the real captured originals (max-scale 17, containerConcurrency 23)"
else
  nope "the captured originals are wrong or missing"
  sed 's/^/      /' "$PF" 2>/dev/null
fi

# ── Test 2: a later run refuses ─────────────────────────────────────────────
echo
echo "[2] a later run REFUSES to start while a restore is outstanding"
T2="$(mktemp -d)"; make_stub "$T2"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 DRY_RUN_EXERCISE_PENDING=1 KUBECTL_BIN="${T2}/kubectl" \
OUT="${T2}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
  bash "$RUN_SH" --context "$CTX" --namespace "$NS" --service "$SVC" \
    --phases cold --cold-samples 1 > "${T2}/out.txt" 2>&1
RC2=$?

[ "$RC2" != "0" ] && ok "it exits non-zero rather than proceeding" \
                  || nope "it exited 0 — it started over an outstanding restore"
grep -q "REFUSING TO START" "${T2}/out.txt" \
  && ok "the refusal is loud" || nope "no loud refusal in the output"
grep -q -- "--restore-pending" "${T2}/out.txt" \
  && ok "it prints the exact command to fix it" || nope "no restore command printed"
grep -q "$SVC" "${T2}/out.txt" \
  && ok "it names the service" || nope "it does not name the service"

# ── Test 3: a DIFFERENT service is not blocked ──────────────────────────────
# The documented design trap: keying on anything coarser than
# context+namespace+service would make one stuck service block all benchmarking.
echo
echo "[3] a pending restore for one service does not block a different one"
T3="$(mktemp -d)"; make_stub "$T3"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 DRY_RUN_EXERCISE_PENDING=1 KUBECTL_BIN="${T3}/kubectl" \
OUT="${T3}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
POD_SAMPLE_BUDGET=1 SCHEDULE_CHECK_TIMEOUT=0 K6_JOB_TIMEOUT=5 \
  bash "$RUN_SH" --context "$CTX" --namespace "$NS" --service "other-svc" \
    --phases none > "${T3}/out.txt" 2>&1
grep -q "REFUSING TO START" "${T3}/out.txt" \
  && nope "a different service was wrongly blocked" \
  || ok "a different service runs unaffected"
rm -f "$(pending_file_for "$CTX" "$NS" other-svc)"

# ── Test 4: --restore-pending applies it, and is idempotent ─────────────────
echo
echo "[4] --restore-pending applies the file, clears it, and is idempotent"
T4="$(mktemp -d)"; make_stub "$T4"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 DRY_RUN_EXERCISE_PENDING=1 KUBECTL_BIN="${T4}/kubectl" \
OUT="${T4}/results.txt" \
  bash "$RUN_SH" --context "$CTX" --namespace "$NS" --service "$SVC" \
    --restore-pending > "${T4}/out.txt" 2>&1
RC4=$?

[ "$RC4" = "0" ] && ok "it exits 0" || nope "it exited $RC4"
[ ! -f "$PF" ] && ok "the pending file is gone after a successful restore" \
               || nope "the pending file survived a successful restore"

DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 DRY_RUN_EXERCISE_PENDING=1 KUBECTL_BIN="${T4}/kubectl" \
OUT="${T4}/results2.txt" \
  bash "$RUN_SH" --context "$CTX" --namespace "$NS" --service "$SVC" \
    --restore-pending > "${T4}/out2.txt" 2>&1
RC4B=$?
[ "$RC4B" = "0" ] && ok "running it a second time is safe (idempotent)" \
                  || nope "the second run exited $RC4B — not idempotent"

rm -f "$PF"
echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
