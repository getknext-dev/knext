#!/usr/bin/env sh
# _measure.sh — warm-standby (design A) wake measurement.
#
# One "wake" sample = (gate release -> first successful SELECT) against a warm
# pod that is already scheduled + running but whose compute_ctl has NOT yet
# attached to the timeline. This isolates the wake cost that a warm pool removes
# (pod sandbox + image + init) from the cost it cannot (compute_ctl attach +
# first probe).
#
# Per sample:
#   1. assert SINGLE-WRITER: deploy/compute == 0 and 0 compute pods (else abort)
#   2. scale compute-warm 0->1; wait until the pod prints WARM_GATE_WAITING
#      (scheduled, RAM held, NOT attached = the "asleep" warm state)
#   3. t0 = now; release the gate (kubectl exec touch); poll psql direct to the
#      warm pod on :55433 until SELECT returns; t1
#   4. wake_ms = t1 - t0; also capture compute_ctl's self-reported startup ms
#   5. scale compute-warm 0; wait full drain
#
# Because the pod is created BEFORE t0, pod-creation cost is excluded by design.
# The kubectl-exec trigger + psql-poll overhead ARE included in wake_ms (honest
# headline); a measured exec baseline + compute_ctl total_startup_ms decompose
# the intrinsic floor. See README.
#
# Env:
#   N            samples (default 20)
#   NS           namespace (default scale-zero-pg)
#   PROBE_SQL    default "SELECT count(*) FROM t"; falls back to "SELECT 1"
#   LABEL        csv label (default neon-warmstandby)
#   RESULTS_DIR  where to write the CSV (default ../bakeoff/results)
set -eu

N="${N:-20}"
NS="${NS:-scale-zero-pg}"
LABEL="${LABEL:-neon-warmstandby}"
PROBE_SQL="${PROBE_SQL:-SELECT count(*) FROM t}"
CLIENT_POD="${CLIENT_POD:-warm-client}"
WARM_SVC="${WARM_SVC:-compute-warm}"
K="kubectl -n $NS"
DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${RESULTS_DIR:-$DIR/../bakeoff/results}"
mkdir -p "$RESULTS_DIR"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
STAMP="$(python3 -c 'import time;print(time.strftime("%Y%m%dT%H%M%S"))')"
RUNID="${RUNID:-$STAMP}"
CSV="$RESULTS_DIR/${LABEL}-${RUNID}.csv"
echo "idx,wake_ms,compute_ctl_startup_ms,rows,ok" > "$CSV"

fail() { echo "FATAL: $*" >&2; exit 1; }

# SACRED single-writer guard: the normal compute must be at 0 and fully drained
# before we ever attach the warm pod to the shared timeline.
assert_single_writer() {
  r="$($K get deploy compute -o jsonpath='{.spec.replicas}' 2>/dev/null || echo '?')"
  [ "$r" = "0" ] || fail "deploy/compute replicas=$r (must be 0 for single-writer)"
  p="$($K get pods -l app=compute --no-headers 2>/dev/null | grep -c . || true)"
  [ "$p" = "0" ] || fail "compute pods present ($p) — not drained; refusing to attach warm pod"
}

warm_pod() { $K get pods -l app=compute-warm --no-headers 2>/dev/null | awk '{print $1}' | head -1; }

# psql direct to the warm pod on :55433 (no gateway). Returns rows or empty.
probe() {
  $K exec "$CLIENT_POD" -- sh -c \
    "PGPASSWORD=cloud_admin psql -h '$WARM_SVC' -p 55433 -U cloud_admin -d postgres -tAc \"$1\" -v ON_ERROR_STOP=1" \
    2>/dev/null | tr -d '[:space:]'
}

echo "== warm-standby measure: N=$N ns=$NS probe='$PROBE_SQL' =="

# One-time: measure the kubectl-exec baseline (overhead of establishing an exec
# session), so the README can subtract it from wake_ms to estimate the floor.
assert_single_writer
$K get pod "$CLIENT_POD" >/dev/null 2>&1 || fail "client pod $CLIENT_POD missing (apply 30-warm-client.yaml)"
$K wait --for=condition=Ready pod/"$CLIENT_POD" --timeout=60s >/dev/null 2>&1 || fail "client pod not ready"
eb0="$(now_ms)"; $K exec "$CLIENT_POD" -- true >/dev/null 2>&1 || true; eb1="$(now_ms)"
EXEC_BASELINE_MS=$((eb1 - eb0))
echo "  kubectl-exec baseline (single round-trip): ${EXEC_BASELINE_MS}ms"

RAM_RECORDED=0
i=1
while [ "$i" -le "$N" ]; do
  assert_single_writer

  # 2. arm: scale warm pod up and wait for the gate-waiting sentinel
  $K scale deploy/compute-warm --replicas=1 >/dev/null
  wp=""; j=0
  while [ "$j" -lt 300 ]; do
    wp="$(warm_pod)"
    if [ -n "$wp" ] && $K logs "$wp" 2>/dev/null | grep -q WARM_GATE_WAITING; then break; fi
    j=$((j+1)); sleep 0.2
  done
  [ -n "$wp" ] || fail "warm pod never appeared"
  $K logs "$wp" 2>/dev/null | grep -q WARM_GATE_WAITING || fail "warm pod never reached gate"

  # RAM held while asleep (first sample only): cgroup current + request.
  if [ "$RAM_RECORDED" = "0" ]; then
    RAM_CUR_BYTES="$($K exec "$wp" -- sh -c 'cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo 0' 2>/dev/null | tr -d '[:space:]')"
    RAM_REQ="$($K get deploy compute-warm -o jsonpath='{.spec.template.spec.containers[0].resources.requests.memory}')"
    RAM_RECORDED=1
    echo "  RAM held while asleep (gated): cgroup.current=$(python3 -c "print(f'{int(${RAM_CUR_BYTES:-0})/1048576:.1f} MiB')") | scheduler reservation (request)=$RAM_REQ"
  fi

  assert_single_writer   # re-check RIGHT before releasing the gate

  # 3. release gate + time to first successful SELECT
  t0="$(now_ms)"
  $K exec "$wp" -- touch /tmp/go >/dev/null 2>&1 || fail "gate release failed"
  rows=""; ok=0; k=0
  while [ "$k" -lt 300 ]; do   # 300 * 0.1s = 30s cap
    rows="$(probe "$PROBE_SQL" || true)"
    if [ -n "$rows" ]; then ok=1; break; fi
    # fall back to SELECT 1 if the probe table is absent
    if [ "$k" = 20 ] && [ "$PROBE_SQL" != "SELECT 1" ]; then
      one="$(probe 'SELECT 1' || true)"
      [ "$one" = "1" ] && { PROBE_SQL="SELECT 1"; echo "  (probe table absent; falling back to SELECT 1)"; }
    fi
    k=$((k+1)); sleep 0.1
  done
  t1="$(now_ms)"
  wake_ms=$((t1 - t0))
  [ -z "$rows" ] && rows="NA"

  # compute_ctl self-reported startup (exec-overhead-free intrinsic attach cost)
  cc="$($K logs "$wp" 2>/dev/null | grep -oE 'total_startup_ms[":= ]+[0-9]+' | grep -oE '[0-9]+' | tail -1 || true)"
  [ -z "$cc" ] && cc="NA"

  echo "  [$i/$N] wake=${wake_ms}ms compute_ctl_startup=${cc}ms rows=$rows ok=$ok"
  echo "$i,$wake_ms,$cc,$rows,$ok" >> "$CSV"

  # 5. disarm: scale warm pod down, wait full drain (single-writer hygiene)
  $K scale deploy/compute-warm --replicas=0 >/dev/null
  d=0; while [ "$($K get pods -l app=compute-warm --no-headers 2>/dev/null | grep -c . || true)" != "0" ]; do
    d=$((d+1)); [ "$d" -gt 120 ] && fail "warm pod did not drain"; sleep 0.5
  done
  i=$((i+1))
done

echo "== percentiles ($LABEL) =="
python3 - "$CSV" "$EXEC_BASELINE_MS" <<'PY'
import sys, csv
rows=[r for r in csv.DictReader(open(sys.argv[1])) if r["ok"]=="1"]
xs=sorted(int(r["wake_ms"]) for r in rows)
ccs=sorted(int(r["compute_ctl_startup_ms"]) for r in rows if r["compute_ctl_startup_ms"] not in ("NA",""))
eb=int(sys.argv[2])
def pct(a,p):
    if not a: return float("nan")
    k=(len(a)-1)*p/100.0; f=int(k); c=min(f+1,len(a)-1)
    return a[f]+(a[c]-a[f])*(k-f)
n=len(xs)
if xs:
    print(f"  wake_ms          n={n} min={xs[0]} p50={pct(xs,50):.0f} p95={pct(xs,95):.0f} p99={pct(xs,99):.0f} max={xs[-1]}")
    print(f"  minus exec-base  ({eb}ms): p50={pct(xs,50)-eb:.0f} p95={pct(xs,95)-eb:.0f} (est. floor incl. psql poll)")
if ccs:
    print(f"  compute_ctl_ms   n={len(ccs)} min={ccs[0]} p50={pct(ccs,50):.0f} p95={pct(ccs,95):.0f} max={ccs[-1]}  (intrinsic attach, exec-free)")
print(f"  sub-second (wake p50 < 1000ms)? {'YES' if xs and pct(xs,50)<1000 else 'NO'}")
PY
echo "  raw CSV -> $CSV"
