#!/bin/sh
# MVP acceptance: the full scale-to-zero loop THROUGH THE GATEWAY on k8s.
#
#   compute at 0 -> client connects to gateway -> compute wakes -> rows return
#   -> idle window passes -> compute back to 0 -> reconnect wakes it again.
#
# Client runs in-cluster (kubectl run) exactly like a knext app would:
# postgres://...@pggw.scale-zero-pg.svc:55432 from a DATABASE_URL secret.
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"
# cloud_admin/cloud_admin is the upstream spec's dev default: compute_ctl
# reconciles roles from config.json on every boot, so ALTER USER does not
# stick — change the encrypted_password in 54-compute-files.yaml instead.
DSN="postgres://cloud_admin:cloud_admin@pggw:55432/postgres?sslmode=disable"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# psql one-shot from a throwaway in-cluster pod (image already on the node)
CLIENT() {
  $K run pgclient-$$-$1 --image=ks-pg-compute:8464 --image-pull-policy=Never \
    --restart=Never --rm -i --quiet --command -- \
    psql "$DSN" -tA -c "$2" 2>&1
}
METRIC() {
  $K run metric-$$-$1 --image=curlimages/curl:8.11.1 --restart=Never --rm -i --quiet \
    --command -- curl -s "http://pggw:9090/metrics.json" 2>/dev/null | grep -o "\"$2\": *[0-9.]*" | head -1 | grep -o '[0-9.]*$'
}
COMPUTE_PODS() { $K get pods -l app=compute --no-headers 2>/dev/null | grep -c Running || true; }

# 0. gateway deployed and ready
$K rollout status deploy/pggw --timeout=120s >/dev/null || fail "gateway not ready"
ok "gateway ready"

# 1. seed the one-table test db (compute may be up or down; gateway handles both)
[ "$(CLIENT seed 'select 1' | tail -1)" = "1" ] || fail "cannot reach postgres through gateway"
CLIENT seed2 "drop table if exists t; create table t(id int); insert into t select generate_series(1,3)" >/dev/null
[ "$(CLIENT seed3 'select count(*) from t' | tail -1)" = "3" ] || fail "seed failed"
ok "one-table test db seeded through gateway (3 rows)"

# 2. force scale to zero and confirm no compute pods
$K scale deploy/compute --replicas=0 >/dev/null
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i+1)); [ $i -gt 60 ] && fail "compute did not reach 0"; sleep 1; done
ok "compute at zero (no pods)"

# 3. cold connect through the gateway: must wake and return the rows
W0=$(METRIC w0 wakes_total || echo 0)
T0=$(date +%s)
OUT=$(CLIENT wake 'select count(*) from t' | tail -1)
T1=$(date +%s)
[ "$OUT" = "3" ] || fail "cold connect did not return rows (got: $OUT)"
[ "$(COMPUTE_PODS)" = "1" ] || fail "compute pod not running after wake"
W1=$(METRIC w1 wakes_total || echo 0)
[ "${W1:-0}" -gt "${W0:-0}" ] || fail "gateway wakes_total did not increase ($W0 -> $W1)"
LAT=$(METRIC lat wake_latency_ms_last || echo '?')
ok "cold connect woke compute 0->1 and returned 3 rows in $((T1-T0))s (gateway wake latency: ${LAT}ms)"

# 4. idle -> back to zero (GW_IDLE_MS=60000 in 10-gateway.yaml)
echo "    waiting for idle scale-down (60s idle window)..."
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i+1)); [ $i -gt 180 ] && fail "compute never scaled back to zero (phantom keepalive?)"; sleep 1; done
ok "idle window elapsed -> compute back to zero"

# 5. reconnect: wakes again, data intact
OUT=$(CLIENT rewake 'select count(*) from t' | tail -1)
[ "$OUT" = "3" ] || fail "re-wake did not return rows (got: $OUT)"
ok "reconnect after zero wakes again, data intact"

echo "wake verification: full 0->1->0->1 loop passed"
