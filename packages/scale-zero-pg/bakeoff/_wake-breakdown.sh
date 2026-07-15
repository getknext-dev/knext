#!/usr/bin/env sh
# _wake-breakdown.sh — instrument ONE CNPG un-hibernate end-to-end and attribute
# the ~14s wake to phases: operator reconcile -> pod create -> schedule -> init
# container -> main container start -> PG accepting -> gateway serves rows.
#
# Method: hibernate to zero, stamp t0 at the un-hibernate annotate, then poll the
# reborn pod's own Kubernetes timestamps (creationTimestamp, PodScheduled /
# Initialized / ContainersReady / Ready condition lastTransitionTime, startTime)
# plus a tight psql probe for "PG actually serves". All deltas are ms from t0.
set -eu
NS=bakeoff-cnpg
LBL="cnpg.io/cluster=pg"
CLIENT_POD=pgclient
GW_HOST=pggw.bakeoff-cnpg.svc
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

echo "[bd] hibernate -> zero ..."
kubectl -n "$NS" annotate --overwrite cluster/pg cnpg.io/hibernation=on >/dev/null 2>&1 || true
i=0; while [ "$i" -lt 60 ]; do
  [ "$(kubectl -n "$NS" get pods -l "$LBL" --no-headers 2>/dev/null | grep -c . || true)" = 0 ] && break
  i=$((i+1)); sleep 1
done

echo "[bd] un-hibernate (t0) ..."
T0="$(now_ms)"
kubectl -n "$NS" annotate --overwrite cluster/pg cnpg.io/hibernation=off >/dev/null 2>&1 || true

# poll until Ready + PG serves, recording first-seen wallclock for each milestone
pod=""; t_podcreate=""; t_serve=""
i=0
while [ "$i" -lt 400 ]; do   # 400 * 0.1s = 40s cap
  if [ -z "$pod" ]; then
    pod="$(kubectl -n "$NS" get pods -l "$LBL" --no-headers 2>/dev/null | awk '{print $1}' | head -1 || true)"
    [ -n "$pod" ] && t_podcreate="$(now_ms)"
  fi
  if [ -n "$pod" ] && [ -z "$t_serve" ]; then
    r="$(kubectl -n "$NS" exec "$CLIENT_POD" -- sh -c \
      "PGPASSWORD=app psql -h $GW_HOST -p 55432 -U app -d app -tAc 'SELECT 1' -v ON_ERROR_STOP=1" 2>/dev/null | tr -d '[:space:]')" || r=""
    [ "$r" = "1" ] && t_serve="$(now_ms)"
  fi
  [ -n "$t_serve" ] && break
  i=$((i+1)); sleep 0.1
done
T_END="$(now_ms)"

echo "[bd] extracting pod k8s timestamps ($pod) ..."
kubectl -n "$NS" get pod "$pod" -o json > /tmp/wake_pod.json 2>/dev/null || true

python3 - "$T0" "${t_podcreate:-0}" "${t_serve:-0}" <<'PY'
import json, sys, datetime
t0=int(sys.argv[1]); tpc=int(sys.argv[2]); tserve=int(sys.argv[3])
def ms(dt):  # iso8601 Z -> epoch ms
    if not dt: return None
    return int(datetime.datetime.strptime(dt,"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()*1000)
try:
    p=json.load(open("/tmp/wake_pod.json"))
except Exception:
    p={}
meta=p.get("metadata",{}); st=p.get("status",{})
created=ms(meta.get("creationTimestamp"))
started=ms(st.get("startTime"))
conds={c["type"]:ms(c.get("lastTransitionTime")) for c in st.get("conditions",[])}
# container running start (main container 'postgres')
crun=None
for cs in st.get("containerStatuses",[]):
    run=(cs.get("state") or {}).get("running") or {}
    if run.get("startedAt"): crun=ms(run["startedAt"])
def d(x): return "n/a" if x is None else f"{x-t0:>6} ms"
print("=== CNPG un-hibernate breakdown (ms from t0 = annotate hibernation=off) ===")
print(f"  operator reconcile -> Pod object created : {d(created)}   (pod.metadata.creationTimestamp)")
print(f"  Pod scheduled to node                    : {d(conds.get('PodScheduled'))}")
print(f"  init containers done (Initialized)       : {d(conds.get('Initialized'))}")
print(f"  main container running (postgres)        : {d(crun)}")
print(f"  pod startTime                            : {d(started)}")
print(f"  ContainersReady                          : {d(conds.get('ContainersReady'))}")
print(f"  Ready (readiness probe pass)             : {d(conds.get('Ready'))}")
print(f"  --- client-observed ---")
print(f"  first saw pod via API (poll)             : {d(tpc)}")
print(f"  PG serves 'SELECT 1' through gateway     : {d(tserve)}")
# phase deltas
seq=[("annotate->pod-created",t0,created),
     ("pod-created->scheduled",created,conds.get('PodScheduled')),
     ("scheduled->initialized",conds.get('PodScheduled'),conds.get('Initialized')),
     ("initialized->container-running",conds.get('Initialized'),crun),
     ("container-running->ready",crun,conds.get('Ready')),
     ("ready->PG-serves",conds.get('Ready'),tserve)]
print("  --- phase durations ---")
for name,a,b in seq:
    if a and b: print(f"    {name:32}: {b-a:>6} ms")
    else:       print(f"    {name:32}:    n/a")
print(f"  TOTAL annotate->serves                   : {tserve-t0 if tserve else 'n/a'} ms")
PY
echo "[bd] event stream (reason/age) ..."
kubectl -n "$NS" get events --field-selector "involvedObject.name=$pod" --sort-by=.lastTimestamp 2>/dev/null | tail -20 || true