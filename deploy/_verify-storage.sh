#!/bin/sh
# Storage-plane + survival verification on the k8s cluster.
# Proves: all storage pods Ready, compute serves Postgres, one-table data
# survives a compute pod kill (stateless compute, storage owns durability),
# and prints the measured cold-start seconds.
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

PSQL() { $K exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }

# 1. storage plane Ready
for d in minio storage-broker; do
  $K rollout status deploy/$d --timeout=180s >/dev/null || fail "deploy/$d not ready"
  ok "deploy/$d ready"
done
for s in safekeeper1 pageserver; do
  $K rollout status statefulset/$s --timeout=180s >/dev/null || fail "sts/$s not ready"
  ok "sts/$s ready"
done

# 2. compute up (scale to 1 if at 0) and answering
$K scale deploy/compute --replicas=1 >/dev/null
$K rollout status deploy/compute --timeout=300s >/dev/null || fail "compute not ready"
[ "$(PSQL 'select 1')" = "1" ] || fail "compute does not answer SELECT 1"
ok "compute serves queries"

# 3. tenant + timeline exist on the pageserver
TENANTS=$($K exec sts/pageserver -- curl -s http://localhost:9898/v1/tenant)
echo "$TENANTS" | grep -q '"id"' || fail "no tenant on pageserver: $TENANTS"
ok "tenant exists on pageserver"

# 4. one-table test data
PSQL "drop table if exists t" >/dev/null
PSQL "create table t(id int)" >/dev/null
PSQL "insert into t select generate_series(1,3)" >/dev/null
[ "$(PSQL 'select count(*) from t')" = "3" ] || fail "expected 3 rows before kill"
ok "one-table test db: 3 rows written"

# 5. kill the compute pod; data must survive; time the cold start
$K delete pod -l app=compute --wait=false >/dev/null
START=$(date +%s)
$K rollout status deploy/compute --timeout=300s >/dev/null || fail "compute did not come back"
i=0
until [ "$(PSQL 'select count(*) from t' 2>/dev/null || true)" = "3" ]; do
  i=$((i+1)); [ $i -gt 300 ] && fail "rows lost or compute unreachable after kill"
  sleep 1
done
END=$(date +%s)
ok "3 rows intact after compute pod kill (no volume, no restore)"
echo "cold-start-to-first-query: $((END-START))s (pod kill -> data served)"

echo "storage verification: all checks passed"
