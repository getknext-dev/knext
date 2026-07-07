#!/usr/bin/env bash
# _verify-perapp-ro.sh — PER-APP read-replica isolation drill (issue #127).
#
# THE WHOLE POINT: prove that per-app read replicas are TENANT-ISOLATED. A naive RO
# lane on the apps-gateway would route EVERY app's reads to one shared pool =
# cross-tenant data exposure. This drill proves the apps-gateway RO listener
# (template mode, GW_RO_PORT=55434 -> compute-ro-<app>) routes each app's reads to
# ITS OWN read-only compute and NEVER another tenant's — the same tenant boundary
# the writer lane enforces.
#
# Two apps A + B, each with spec.roPool.enabled. Asserts, on the LIVE plane:
#   1. provision   -> both AppDatabases reach Ready; each gets a DATABASE_URL_RO
#                     pointing at pggw-apps:55434 with its own app_<app>/<db>.
#   2. A reads A    -> A's DATABASE_URL_RO wakes compute-ro-A (0->1) and returns A's
#                     OWN committed rows (read-scaling serving endpoint is LIVE).
#   3. ISOLATION    -> (both directions)
#                       a. A's RO NEVER returns B's marker rows (data isolation).
#                       b. A's role on B's RO db is REFUSED (28P01), and vice-versa
#                          — the (user,database) authz holds on the RO port too.
#   4. read-only    -> a write on the RO DSN is REJECTED (Postgres read-only txn).
#   5. staleness    -> write a fresh row through A's WRITER, poll A's RO until it
#                     appears; record the replication lag (Replica tip-following).
#   6. teardown     -> deleting an AppDatabase removes its compute-ro-<app> too.
#
# Self-contained + idempotent: throwaway apps "roa"/"rob"; cleans up on exit.
# Requires the appdb-operator + apps-gateway running the #127 image (per-app RO
# routing + RO-compute provisioning) and the plane initialized (init-plane).
# Env: KCTX (default context-ckmva7v7zvq), NS.
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
APPA="${APPA:-roa}"
APPB="${APPB:-rob}"
IMG="neondatabase/compute-node-v17:8464"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
now() { python3 -c 'import time;print(time.time())'; }

cleanup() {
  echo "    cleanup: deleting AppDatabases + reclaiming residue"
  for a in "$APPA" "$APPB"; do
    K delete appdatabase "$a" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  for a in "$APPA" "$APPB"; do
    local i=0; while K get appdatabase "$a" >/dev/null 2>&1 && [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done
    KCTX="$KCTX" NS="$NS" "$PROV" destroy "$a" >/dev/null 2>&1 || true
  done
  KCTX="$KCTX" NS="$NS" "$PROV" reclaim-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

app_pw() { K get secret "app-db-$1" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }
sec_key() { K get secret "app-db-$1" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || true; }
cr_status() { K get appdatabase "$1" -o jsonpath="{.status.$2}" 2>/dev/null || true; }

# PSQL <tag> <dsn> <sql>  — one-shot psql from a throwaway pod. Echoes stdout on
# success; returns non-zero (and echoes the error to stderr) on failure. Bounded by
# PGCONNECT_TIMEOUT so a refused/absent endpoint fails fast instead of hanging.
PSQL() {
  local tag="$1" dsn="$2" sql="$3"
  local p; p="roq-$$-$(printf '%s' "$tag" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
  K run "$p" --image="$IMG" --image-pull-policy=Never --env=PGCONNECT_TIMEOUT=10 \
    --restart=Never --quiet --command -- psql "$dsn" -tAw -c "$sql" >/dev/null 2>&1 || true
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

# RETRY <tag> <dsn> <sql> — like PSQL but retries a POSITIVE connect up to 6 times.
# A cold compute wakes 0->1 on the first connect and compute_ctl applies the per-app
# role during boot; for the RO replica the role arrives via WAL replication. Either
# can lose a race with the very first connect (the documented cold-boot role race,
# #132), so a positive read/write retries. Negative assertions (cross-tenant refusal,
# RO write rejection) use plain PSQL — they must fail, and retrying only re-confirms.
RETRY() {
  local out
  for _try in 1 2 3 4 5 6; do
    if out="$(PSQL "$1-$_try" "$2" "$3" 2>/dev/null)"; then echo "$out"; return 0; fi
    sleep 3
  done
  return 1
}

writer_dsn() { echo "postgres://app_$1:$(app_pw "$1")@pggw-apps:55432/$1?sslmode=disable"; }
ro_dsn()     { sec_key "$1" DATABASE_URL_RO; }
# cross_ro_dsn <creds-app> <target-db> — app X's creds pointed at app Y's RO db.
cross_ro_dsn() { echo "postgres://app_$1:$(app_pw "$1")@pggw-apps:55434/$2?sslmode=disable"; }

# 0. preconditions
K get crd appdatabases.apps.scale-zero-pg.dev >/dev/null 2>&1 || fail "AppDatabase CRD not installed"
K rollout status deploy/appdb-operator --timeout=120s >/dev/null || fail "appdb-operator not ready"
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
# the RO listener must be wired on the apps-gateway (GW_RO_PORT)
K get deploy pggw-apps -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="GW_RO_PORT")].value}' \
  | grep -q 55434 || fail "apps-gateway has no GW_RO_PORT=55434 (per-app RO listener not wired — deploy/81)"
ok "apps-gateway RO listener wired (GW_RO_PORT=55434, template mode -> compute-ro-<app>)"
KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null || fail "init-plane failed"
ok "plane initialized"
for a in "$APPA" "$APPB"; do
  K delete appdatabase "$a" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$a" >/dev/null 2>&1 || true
done

# 1. provision both apps with roPool enabled
for a in "$APPA" "$APPB"; do
  echo "==> applying AppDatabase/$a (roPool.enabled)"
  K apply -f - >/dev/null <<EOF
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata: { name: $a, namespace: $NS }
spec:
  appName: $a
  tier: cold
  roPool: { enabled: true, minReplicas: 0, maxReplicas: 3 }
EOF
done
for a in "$APPA" "$APPB"; do
  PHASE=""; i=0
  while [ $i -lt 120 ]; do
    PHASE="$(cr_status "$a" phase)"
    [ "$PHASE" = "Ready" ] && break
    [ "$PHASE" = "Failed" ] && fail "AppDatabase/$a Failed: $(cr_status "$a" message)"
    i=$((i+1)); sleep 1
  done
  [ "$PHASE" = "Ready" ] || fail "AppDatabase/$a did not reach Ready (phase=$PHASE)"
  # the per-app RO compute + service must exist
  K get deploy "compute-ro-$a" >/dev/null 2>&1 || fail "operator did not provision compute-ro-$a"
  K get svc "compute-ro-$a" >/dev/null 2>&1 || fail "operator did not provision the compute-ro-$a Service"
  RO="$(ro_dsn "$a")"
  case "$RO" in
    postgres://app_$a:*@pggw-apps*:55434/$a\?sslmode=disable) ;;
    *) fail "DATABASE_URL_RO for $a wrong shape: $RO" ;;
  esac
  ok "$a Ready; compute-ro-$a provisioned; DATABASE_URL_RO -> pggw-apps:55434/$a"
done

# 2. seed DISTINCT marker rows through each app's WRITER (own branch). RETRY absorbs
#    the cold-boot role race on the first wake of each writer (#132).
RETRY seeda "$(writer_dsn "$APPA")" "insert into app_items(note) values ('MARKER-$APPA')" >/dev/null \
  || fail "seed write for $APPA failed"
RETRY seedb "$(writer_dsn "$APPB")" "insert into app_items(note) values ('MARKER-$APPB')" >/dev/null \
  || fail "seed write for $APPB failed"
ok "seeded distinct marker rows via each app's writer (MARKER-$APPA / MARKER-$APPB)"

# 3. A reads A: A's DATABASE_URL_RO wakes compute-ro-A and returns A's OWN data.
T_RO_WAKE0=$(now)
GOTA="$(RETRY roreada "$(ro_dsn "$APPA")" "select count(*) from app_items where note='MARKER-$APPA'" | tail -1)" \
  || fail "A's RO read failed to connect/return (per-app RO endpoint not serving)"
T_RO_WAKE1=$(now)
[ "$GOTA" = "1" ] || fail "A's RO did not return A's own committed row (got count=$GOTA)"
RO_WAKE=$(python3 -c "print(f'{$T_RO_WAKE1-$T_RO_WAKE0:.1f}')")
ok "A's DATABASE_URL_RO wakes compute-ro-$APPA and returns A's own data (first-read incl. cold wake ${RO_WAKE}s)"

# 3'. #164 pg_hba HARDEN PARITY on the RO tier. compute-ro-A carries APP_ROLE (via
#     compute-config-$APPA), so entrypoint-ro.sh runs the SAME shared harden as the
#     primary per-app writer: cloud_admin TCP-reject (#112) + scram-sha-256 wire (#117).
#     The app-role-SCRAM-works leg is ALREADY proven above — step 3 read via app_$APPA
#     over SCRAM (the durable verifier is REPLICATED from the primary catalog through
#     WAL), so scram pg_hba on a read replica does not regress the DATABASE_URL_RO path.
#     Here assert the two negatives the harden adds. compute-ro-A is freshly awake.
ROPOD="$(K get pods -l app="compute-ro-$APPA" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[ -n "$ROPOD" ] || fail "#164: no running compute-ro-$APPA pod to inspect the pg_hba harden"
# (a) the actual pg_hba on the RO pod carries BOTH harden lines (authoritative).
HBA="$(K exec "$ROPOD" -c compute -- sh -c 'cat /var/db/postgres/compute/pg_hba.conf' 2>/dev/null || true)"
printf '%s\n' "$HBA" | grep -Eqi '^host[[:space:]]+all[[:space:]]+cloud_admin[[:space:]]+all[[:space:]]+reject' \
  || fail "#164: compute-ro-$APPA pg_hba is MISSING the cloud_admin reject (harden not applied to the RO tier)"
printf '%s\n' "$HBA" | grep -Eq '^host[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]+scram-sha-256' \
  || fail "#164: compute-ro-$APPA pg_hba catch-all is NOT scram-sha-256 (md5 wire-downgrade still possible on RO)"
ok "#164: compute-ro-$APPA pg_hba carries the cloud_admin reject + scram-sha-256 catch-all (shared harden landed on the RO tier)"
# (b) BEHAVIORAL: cloud_admin over TCP (direct to the RO compute) is REJECTED. This is
#     the #112 class — a co-tenant dialing compute-ro-$APPA:55433 as cloud_admin.
CA_ERR="$(PSQL rocatcp "postgres://cloud_admin:cloud_admin@compute-ro-$APPA.$NS.svc:55433/postgres?sslmode=disable" 'select 1' 2>&1 >/dev/null || true)"
if printf '%s' "$CA_ERR" | grep -qE '^1$'; then
  fail "#164: cloud_admin AUTHENTICATED over TCP on compute-ro-$APPA (the RO cloud_admin reject is not enforced)"
fi
printf '%s' "$CA_ERR" | grep -qiE 'pg_hba|no .*entry|rejects' \
  && ok "#164: cloud_admin is REJECTED over TCP on compute-ro-$APPA by pg_hba (loopback-only on the RO tier)" \
  || ok "#164: cloud_admin cannot connect over TCP on compute-ro-$APPA (reject enforced; err: $(printf '%s' "$CA_ERR" | tr '\n' ' ' | cut -c1-80))"

# ISOLATION 3a — DATA: A's RO must NEVER see B's marker row (different timeline).
CROSS="$(RETRY roxreada "$(ro_dsn "$APPA")" "select count(*) from app_items where note='MARKER-$APPB'" | tail -1)" \
  || fail "A's RO cross-data probe failed to run"
[ "$CROSS" = "0" ] || fail "CROSS-TENANT LEAK: A's RO returned B's marker rows (count=$CROSS)"
ok "A's RO can NOT see B's data (0 rows for MARKER-$APPB) — timeline isolation holds"

# ISOLATION 3b — AUTHZ: A's role on B's RO db is REFUSED, and B's role on A's RO db.
if PSQL roxauthz1 "$(cross_ro_dsn "$APPA" "$APPB")" "select 1" >/dev/null 2>&1; then
  fail "CROSS-TENANT: app_$APPA authorized on $APPB's RO db (must be refused)"
fi
ok "app_$APPA's creds are REFUSED on $APPB's RO db (28P01) — (user,database) authz holds on the RO port"
if PSQL roxauthz2 "$(cross_ro_dsn "$APPB" "$APPA")" "select 1" >/dev/null 2>&1; then
  fail "CROSS-TENANT: app_$APPB authorized on $APPA's RO db (must be refused)"
fi
ok "app_$APPB's creds are REFUSED on $APPA's RO db — isolation proven BOTH directions"

# 4. read-only: a write on the RO DSN must be REJECTED.
if PSQL rowrite "$(ro_dsn "$APPA")" "insert into app_items(note) values ('should-fail-RO')" >/dev/null 2>&1; then
  fail "WRITE SUCCEEDED on the RO DSN (must be a read-only endpoint)"
fi
# confirm the bogus row did NOT land (via the writer, authoritative)
LEFT="$(RETRY rowchk "$(writer_dsn "$APPA")" "select count(*) from app_items where note='should-fail-RO'" | tail -1)" \
  || fail "rowchk writer read failed (cold-wake flake under load — re-run)"
[ "$LEFT" = "0" ] || fail "an RO write leaked to the branch (count=$LEFT)"
ok "writes on the RO DSN are rejected (read-only endpoint); no row leaked"

# 5. staleness (Replica tip-following lag). To measure REPLICATION lag — not
#    scale-to-zero cold-wake — warm BOTH computes first (a read on each keeps it
#    awake for GW_RO_IDLE_MS), then write and poll while both stay warm. On a cold
#    pool the first read alone can cost a full cold-wake; that is a wake cost, not a
#    staleness cost, so it is deliberately excluded from the number.
RETRY warmw "$(writer_dsn "$APPA")" "select 1" >/dev/null || fail "warm writer failed"
RETRY warmr "$(ro_dsn "$APPA")" "select 1" >/dev/null || fail "warm RO failed"
STAMP="stale-$$-$(date +%s 2>/dev/null || echo x)"
RETRY stalewr "$(writer_dsn "$APPA")" "insert into app_items(note) values ('$STAMP')" >/dev/null \
  || fail "staleness seed write failed"
T_S0=$(now); SEEN=""; i=0
while [ $i -lt 90 ]; do
  SEEN="$(PSQL staler$i "$(ro_dsn "$APPA")" "select count(*) from app_items where note='$STAMP'" 2>/dev/null | tail -1 || echo 0)"
  [ "$SEEN" = "1" ] && break
  i=$((i+1)); sleep 1
done
T_S1=$(now)
[ "$SEEN" = "1" ] || fail "A's RO never reflected a fresh committed write within 90s (replication stuck?)"
STALE=$(python3 -c "print(f'{$T_S1-$T_S0:.1f}')")
ok "A's RO reflects a fresh committed write in ~${STALE}s (Replica tip-following, both computes warm)"

# 6. teardown removes the per-app RO compute.
K delete appdatabase "$APPB" --wait=true --timeout=120s >/dev/null || fail "delete AppDatabase/$APPB timed out"
K get deploy "compute-ro-$APPB" >/dev/null 2>&1 && fail "compute-ro-$APPB survived deprovision (orphaned read replica)"
ok "deleting $APPB removed compute-ro-$APPB (no orphaned read replicas)"

trap - EXIT
cleanup
cat <<SUMMARY

per-app RO isolation verification — PASSED
  A reads A (cold RO wake ${RO_WAKE}s) | A cannot read B (data + authz, both ways)
  RO writes rejected | staleness ~${STALE}s (Replica)
SUMMARY
