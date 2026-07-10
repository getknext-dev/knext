#!/bin/sh
# Gateway HA verification: 2 replicas, no SPOF, no idle split-brain.
#
#   1. Two gateway pods Ready.
#   2. A LONG-lived connection (via the Service, i.e. through ONE of the pods)
#      must keep the compute up across the idle window even though the OTHER
#      gateway pod sees zero local connections (peer-aware sleep).
#   3. After the connection closes, the fleet goes quiet and the compute
#      scales to zero as usual.
#   4. Kill one gateway pod; a fresh connection still works (no SPOF).
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"
# Base cloud_admin credential (issue #168): read from the DATABASE_URL Secret
# (gen-secrets.sh owns it; no longer the public default). Bare fallback only.
CA_CRED=$(kubectl -n scale-zero-pg get secret myapp-database -o jsonpath='{.data.DATABASE_URL}' 2>/dev/null | base64 -d 2>/dev/null | sed -E 's#^postgres://([^@]+)@.*#\1#'); [ -n "$CA_CRED" ] || CA_CRED="cloud_admin:cloud_admin"
DSN="postgres://${CA_CRED}@pggw:55432/postgres?sslmode=disable"
IDLE_S=60 # must match GW_IDLE_MS in 10-gateway.yaml

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
COMPUTE_PODS() { $K get pods -l app=compute --no-headers 2>/dev/null | grep -c Running || true; }

# 1. two gateways
$K rollout status deploy/pggw --timeout=120s >/dev/null || fail "gateway not ready"
[ "$($K get deploy pggw -o jsonpath='{.status.readyReplicas}')" = "2" ] || fail "need 2 gateway replicas"
ok "2 gateway replicas ready"

# 2. hold a connection across the idle window; compute must stay up
$K run ha-holder --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
  --restart=Never --quiet --command -- \
  psql "$DSN" -c "select pg_sleep($((IDLE_S + 45)))" >/dev/null &
HOLDER=$!
sleep 20 # connection established, compute awake
[ "$(COMPUTE_PODS)" = "1" ] || fail "compute not up under held connection"
sleep $((IDLE_S + 15)) # a full idle window passes while the peer pod is idle
[ "$(COMPUTE_PODS)" = "1" ] || fail "SPLIT-BRAIN: compute slept under a live connection"
ok "compute stayed up across the idle window with a live connection (peer-aware)"
wait $HOLDER 2>/dev/null || true
$K delete pod ha-holder --ignore-not-found >/dev/null 2>&1

# 3. fleet quiet -> back to zero
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i+1)); [ $i -gt 180 ] && fail "compute never reached zero after fleet went quiet"; sleep 1; done
ok "fleet quiet -> compute at zero"

# 4. no SPOF: kill one gateway, connect again
$K delete pod "$($K get pods -l app=pggw -o jsonpath='{.items[0].metadata.name}')" --wait=false >/dev/null
OUT=$($K run ha-probe --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
  --restart=Never --rm -i --quiet --command -- psql "$DSN" -tA -c "select count(*) from t" | tail -1)
[ "$OUT" = "3" ] || fail "connection failed after gateway pod kill (got: $OUT)"
ok "gateway pod killed mid-flight; fresh connection still served (no SPOF)"

echo "HA verification: all checks passed"
