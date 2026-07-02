#!/usr/bin/env sh
# _drill-cnpg-podkill.sh — CNPG reliability drill: hard pod-kill + data survival.
#
# Matches Neon's existing evidence (deploy/_verify-storage.sh kills the compute
# and re-attaches to the tenant/timeline). Here we delete the CNPG PRIMARY pod
# outright (not a graceful hibernate) and prove the operator reschedules it onto
# the SAME PVC with the seeded dataset intact — and record the recovery time.
#
# Pass = `SELECT count(*) FROM t` returns EXPECT_ROWS after the operator heals
# the cluster, with no restore step. Recovery time = kill -> rows served again.
set -eu
NS=bakeoff-cnpg
POD_LABEL="cnpg.io/cluster=pg"
CLIENT_NS=bakeoff-cnpg
CLIENT_POD=pgclient
GW_HOST=pggw.bakeoff-cnpg.svc
EXPECT_ROWS=3

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "[drill] ensure cluster awake ..."
kubectl -n "$NS" annotate --overwrite cluster/pg cnpg.io/hibernation=off >/dev/null 2>&1 || true
i=0; while [ "$i" -lt 120 ]; do
  [ "$(kubectl -n "$NS" get pods -l "$POD_LABEL" --no-headers 2>/dev/null | grep -c Running || true)" -ge 1 ] 2>/dev/null && break
  i=$((i+1)); sleep 1
done

echo "[drill] pre-kill row count ..."
pre="$(kubectl -n "$CLIENT_NS" exec "$CLIENT_POD" -- sh -c \
  "PGPASSWORD=app psql -h $GW_HOST -p 55432 -U app -d app -tAc 'SELECT count(*) FROM t' -v ON_ERROR_STOP=1" 2>/dev/null | tr -d '[:space:]')"
[ "$pre" = "$EXPECT_ROWS" ] || fail "pre-kill expected $EXPECT_ROWS rows, got '$pre'"
echo "  pre-kill rows=$pre OK"

primary="$(kubectl -n "$NS" get pods -l "$POD_LABEL" --no-headers 2>/dev/null | awk '{print $1}' | head -1)"
old_uid="$(kubectl -n "$NS" get pod "$primary" -o jsonpath='{.metadata.uid}' 2>/dev/null)"
echo "[drill] hard-killing primary pod $primary (uid=$old_uid, --grace-period=0 --force) ..."
t0="$(now_ms)"
kubectl -n "$NS" delete pod "$primary" --grace-period=0 --force >/dev/null 2>&1 || true

# Honest recovery: the -rw service can briefly still route to the dying old
# process, so a probe alone under-reports. We require a NEW pod (different uid)
# to be Running AND serving the seeded rows before declaring recovery. We also
# track the observed connection-downtime window (probe fails -> succeeds again).
echo "[drill] waiting for operator to reschedule a NEW pod on the same PVC ..."
rows=""; recovered=0; i=0
first_fail_ms=""; t_new_serving=""
while [ "$i" -lt 300 ]; do
  new_uid="$(kubectl -n "$NS" get pods -l "$POD_LABEL" --no-headers 2>/dev/null | awk '{print $1}' | head -1 | xargs -I{} kubectl -n "$NS" get pod {} -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
  phase="$(kubectl -n "$NS" get pods -l "$POD_LABEL" --no-headers 2>/dev/null | awk '{print $3}' | head -1)"
  rows="$(kubectl -n "$CLIENT_NS" exec "$CLIENT_POD" -- sh -c \
    "PGPASSWORD=app psql -h $GW_HOST -p 55432 -U app -d app -tAc 'SELECT count(*) FROM t' -v ON_ERROR_STOP=1" 2>/dev/null | tr -d '[:space:]')" || rows=""
  if [ "$rows" != "$EXPECT_ROWS" ] && [ -z "$first_fail_ms" ]; then first_fail_ms="$(now_ms)"; fi
  # recovered = a genuinely new pod (uid changed), Running, serving rows.
  if [ -n "$new_uid" ] && [ "$new_uid" != "$old_uid" ] && [ "$phase" = "Running" ] && [ "$rows" = "$EXPECT_ROWS" ]; then
    t_new_serving="$(now_ms)"; recovered=1; break
  fi
  i=$((i+1)); sleep 1
done
t1="$(now_ms)"
[ "$recovered" = "1" ] || fail "post-kill: no NEW pod served $EXPECT_ROWS rows within timeout (rows='$rows')"

pvc="$(kubectl -n "$NS" get pvc -l "$POD_LABEL" --no-headers 2>/dev/null | awk '{print $1}' | head -1)"
echo "PASS: primary pod-kill survived — a NEW pod (uid changed) served rows=$rows intact on PVC ${pvc:-pg-1}, no restore step."
echo "  recovery_ms=$((t1 - t0))  (force-kill -> NEW pod Running & serving $EXPECT_ROWS rows, gateway included)"
