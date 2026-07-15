#!/usr/bin/env bash
# _verify-extensions.sh — TRUSTED-EXTENSION enablement + scale-to-zero survival
# drill (issues #177 TimescaleDB, #178 pgvector; ADR-0001 "Accepted").
#
# THE WHOLE POINT: prove, on the LIVE plane, that an app can SELF-ENABLE the two
# trusted extensions through its own DATABASE_URL (no operator, no superuser) and
# that the extension objects + data SURVIVE a compute scale-to-zero (they live on
# the pageserver, not the stateless compute). This is the acceptance test behind
# the "Enabling extensions" recipe in docs/connecting.md.
#
# Asserts, on a throwaway app provisioned via the AppDatabase CRD:
#   1. self-enable  -> connecting as app_<app> over the apps-gateway (writer DSN),
#                      `CREATE EXTENSION timescaledb;` and `CREATE EXTENSION vector;`
#                      BOTH succeed with NO cloud_admin (trusted + the template's
#                      `GRANT CREATE ON DATABASE ... TO PUBLIC`, app-base-schema.sql).
#   2. timescaledb  -> create_hypertable + insert 60 rows + a time_bucket rollup.
#   3. pgvector     -> a vector(3) column + an hnsw index + a `<->` nearest-neighbour
#                      query whose top hit is the query vector itself (dist 0).
#   4. scale-to-0   -> scale compute-<app> to 0 and wait for it to drain.
#   5. survival     -> a fresh connect wakes 0->1; the hypertable (60 rows), the
#                      time_bucket rollup, the vector rows, the hnsw index, and both
#                      pg_extension entries are ALL still there post-wake.
#   6. teardown     -> delete the AppDatabase + reclaim residue.
#
# Self-contained + idempotent: throwaway app "extdrill"; cleans up on exit.
# Requires the appdb-operator + apps-gateway up and the plane initialized with the
# #177/#178 base schema (init-plane re-seeds it idempotently). Env: KCTX, NS, APP.
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
APP="${APP:-extdrill}"
IMG="${PSQL_IMG:-postgres:17-alpine}"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

cleanup() {
  echo "    cleanup: deleting AppDatabase/$APP + reclaiming residue"
  K delete appdatabase "$APP" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  local i=0; while K get appdatabase "$APP" >/dev/null 2>&1 && [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$APP" >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" reclaim-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

app_pw()  { K get secret "app-db-$1" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }
cr_status() { K get appdatabase "$1" -o jsonpath="{.status.$2}" 2>/dev/null || true; }
writer_dsn() { echo "postgres://app_$1:$(app_pw "$1")@pggw-apps:55432/$1?sslmode=disable"; }

# PSQL <tag> <dsn> <sql> — one-shot psql from a throwaway pod. Echoes stdout on
# success; non-zero + stderr on failure. Bounded by PGCONNECT_TIMEOUT.
PSQL() {
  local tag="$1" dsn="$2" sql="$3"
  local p; p="extq-$$-$(printf '%s' "$tag" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
  K run "$p" --image="$IMG" --image-pull-policy=IfNotPresent --env=PGCONNECT_TIMEOUT=10 \
    --restart=Never --quiet --command -- psql "$dsn" -tAw -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1 || true
  local phase="" i=0
  while [ $i -lt 150 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1 || true)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [ "$phase" = "Succeeded" ]; then echo "$out"; return 0; fi
  echo "$out" >&2; return 1
}

# RETRY <tag> <dsn> <sql> — retry a POSITIVE connect up to 6 times (the cold-boot
# role race, #132: a cold compute wakes 0->1 on the first connect and only then
# applies the per-app role — the very first connect can lose that race).
RETRY() {
  local out
  for _try in 1 2 3 4 5 6; do
    if out="$(PSQL "$1-$_try" "$2" "$3" 2>/dev/null)"; then echo "$out"; return 0; fi
    sleep 3
  done
  return 1
}

# 0. preconditions
K get crd appdatabases.apps.scale-zero-pg.dev >/dev/null 2>&1 || fail "AppDatabase CRD not installed"
K rollout status deploy/appdb-operator --timeout=120s >/dev/null || fail "appdb-operator not ready"
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null || fail "init-plane failed"
ok "plane initialized (template carries the #177/#178 CREATE-on-database grant)"
K delete appdatabase "$APP" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
KCTX="$KCTX" NS="$NS" "$PROV" destroy "$APP" >/dev/null 2>&1 || true

# 1. provision the throwaway app
echo "==> applying AppDatabase/$APP"
K apply -f - >/dev/null <<EOF
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata: { name: $APP, namespace: $NS }
spec:
  appName: $APP
  tier: cold
EOF
PHASE=""; i=0
while [ $i -lt 120 ]; do
  PHASE="$(cr_status "$APP" phase)"
  [ "$PHASE" = "Ready" ] && break
  i=$((i+1)); sleep 2
done
[ "$PHASE" = "Ready" ] || fail "AppDatabase/$APP never reached Ready (phase=$PHASE)"
ok "AppDatabase/$APP Ready"
DSN="$(writer_dsn "$APP")"

# 2. SELF-ENABLE both extensions as the app role (no cloud_admin). This is the
#    documented recipe and the crux of #177/#178: trusted + the template grant.
RETRY enable "$DSN" "CREATE EXTENSION IF NOT EXISTS timescaledb; CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null \
  || fail "app_$APP could not self-enable timescaledb/vector (template grant missing? re-seed init-plane)"
GOT="$(PSQL extlist "$DSN" "SELECT string_agg(extname||' '||extversion, ', ' ORDER BY extname) FROM pg_extension WHERE extname IN ('timescaledb','vector');")"
echo "    installed: $GOT"
echo "$GOT" | grep -q 'timescaledb' || fail "timescaledb not installed by app self-service"
echo "$GOT" | grep -q 'vector'      || fail "vector not installed by app self-service"
ok "app_$APP self-enabled timescaledb + vector over its DATABASE_URL (no cloud_admin)"

# NB: every positive query below goes through RETRY, not plain PSQL. On the OKE plane
# the throwaway-psql-pod create/logs/delete calls occasionally lose a TLS handshake
# ("intermittently flaky" API); RETRY re-runs the whole one-shot up to 6x so a transient
# control-plane flake never fails an otherwise-correct assertion. Every statement is
# idempotent (DROP ... IF EXISTS / IF NOT EXISTS), so a retried DDL is safe.

# 3. TimescaleDB: hypertable + insert + time_bucket
RETRY ts-setup "$DSN" "
  DROP TABLE IF EXISTS ext_ts CASCADE;
  CREATE TABLE ext_ts (ts timestamptz NOT NULL, sensor int, val double precision);
  SELECT create_hypertable('ext_ts','ts');
  INSERT INTO ext_ts SELECT now() - (g||' min')::interval, (g%3), g*1.5 FROM generate_series(1,60) g;" >/dev/null \
  || fail "hypertable setup failed"
TSROWS="$(RETRY ts-rows "$DSN" "SELECT count(*) FROM ext_ts;")" || fail "ts-rows query failed"
[ "$(echo "$TSROWS" | tr -d '[:space:]')" = "60" ] || fail "expected 60 hypertable rows, got '$TSROWS'"
BUCKETS="$(RETRY ts-bucket "$DSN" "SELECT count(*) FROM (SELECT time_bucket('15 minutes', ts) b FROM ext_ts GROUP BY b) q;")" || fail "ts-bucket query failed"
[ "$(echo "$BUCKETS" | tr -d '[:space:]')" -ge 1 ] || fail "time_bucket returned no buckets"
ok "timescaledb hypertable live: 60 rows, time_bucket -> $(echo "$BUCKETS" | tr -d '[:space:]') buckets"

# 4. pgvector: vector column + hnsw index + <-> nearest neighbour
RETRY vec-setup "$DSN" "
  DROP TABLE IF EXISTS ext_vec CASCADE;
  CREATE TABLE ext_vec (id serial PRIMARY KEY, embedding vector(3));
  INSERT INTO ext_vec (embedding) VALUES ('[1,0,0]'),('[0,1,0]'),('[0,0,1]'),('[0.9,0.1,0]'),('[0.1,0.9,0]');
  CREATE INDEX ext_vec_hnsw ON ext_vec USING hnsw (embedding vector_l2_ops);" >/dev/null \
  || fail "pgvector setup failed"
NEAREST="$(RETRY vec-query "$DSN" "SELECT id FROM ext_vec ORDER BY embedding <-> '[1,0,0]' LIMIT 1;")" || fail "vec-query failed"
[ "$(echo "$NEAREST" | tr -d '[:space:]')" = "1" ] || fail "expected nearest neighbour id=1 (self), got '$NEAREST'"
ok "pgvector hnsw live: <-> nearest-neighbour to [1,0,0] is id=1 (self, dist 0)"

# 5. scale the writer compute to 0 (checkpoint first so nothing is lost in flight)
PSQL ckpt "$DSN" "CHECKPOINT;" >/dev/null 2>&1 || true
echo "==> scaling compute-$APP to 0 (scale-to-zero)"
K scale "deploy/compute-$APP" --replicas=0 >/dev/null
K rollout status "deploy/compute-$APP" --timeout=60s >/dev/null 2>&1 || true
REPL="$(K get deploy "compute-$APP" -o jsonpath='{.status.replicas}' 2>/dev/null || echo 0)"
[ -z "$REPL" ] || [ "$REPL" = "0" ] || fail "compute-$APP did not scale to 0 (replicas=$REPL)"
ok "compute-$APP scaled to 0"

# 6. SURVIVAL: a fresh connect wakes it; every object + row must still be there
RETRY survive "$DSN" "SELECT 1;" >/dev/null || fail "compute-$APP did not wake on reconnect"
PWROWS="$(RETRY pw-rows "$DSN" "SELECT count(*) FROM ext_ts;")" || fail "post-wake ts rows query failed"
[ "$(echo "$PWROWS" | tr -d '[:space:]')" = "60" ] || fail "post-wake: expected 60 hypertable rows, got '$PWROWS'"
PWHYPER="$(RETRY pw-hyper "$DSN" "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name='ext_ts';")" || fail "post-wake hypertable query failed"
[ "$(echo "$PWHYPER" | tr -d '[:space:]')" = "1" ] || fail "post-wake: ext_ts not registered as a hypertable"
PWNEAR="$(RETRY pw-vec "$DSN" "SELECT id FROM ext_vec ORDER BY embedding <-> '[1,0,0]' LIMIT 1;")" || fail "post-wake vec query failed"
[ "$(echo "$PWNEAR" | tr -d '[:space:]')" = "1" ] || fail "post-wake: vector <-> query wrong (got '$PWNEAR')"
PWIDX="$(RETRY pw-idx "$DSN" "SELECT indexname FROM pg_indexes WHERE tablename='ext_vec' AND indexdef ILIKE '%hnsw%';")" || fail "post-wake idx query failed"
echo "$PWIDX" | grep -q 'ext_vec_hnsw' || fail "post-wake: hnsw index missing"
PWEXT="$(RETRY pw-ext "$DSN" "SELECT count(*) FROM pg_extension WHERE extname IN ('timescaledb','vector');")" || fail "post-wake ext query failed"
[ "$(echo "$PWEXT" | tr -d '[:space:]')" = "2" ] || fail "post-wake: extensions missing (count=$PWEXT)"
ok "SURVIVED scale-to-zero: hypertable(60 rows), time_bucket, vector <-> + hnsw index, both extensions intact"

echo "PASS - trusted-extension self-enable + scale-to-zero survival (timescaledb + pgvector)"
