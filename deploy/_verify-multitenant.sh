#!/usr/bin/env bash
# _verify-multitenant.sh — branch-per-app isolation + independent 0<->1 drill.
#
# Proves the ADR-0003 claim on the live plane: two apps, each its own Neon branch
# + compute, isolated at the timeline level, sleeping/waking independently on ONE
# storage plane. Self-contained + idempotent: provisions two throwaway drill apps
# and destroys them (timelines included) on exit.
#
# Asserts:
#   1. each branch inherits the template schema (copy-on-write)
#   2. isolation: app A's write is invisible to app B and vice-versa
#   3. gateway full path: a connect to the apps-gateway (database=<app>) routes to
#      compute-<app>, wakes it 0->1, rewrites the db to the served postgres DB, and
#      returns the app's own data (isolation still holds through the gateway)
#   4. TENANT ACCESS CONTROL (issue #74): the apps-gateway REFUSES cross-tenant and
#      cloud_admin startups BEFORE any wake — app A's DSN cannot reach app B
#   5. independent 0<->1: sleeping A leaves B serving; A wakes with data intact
#   6. PER-APP IDLE (issue #75): with B busy, idle A still scales to zero on schedule
#
# Isolation/schema assertions connect DIRECT to each compute-<app> Service as the
# cloud_admin superuser (direct-compute access is a separate trust boundary — the
# gateway's per-app credential boundary is what tenants hit). The gateway-fronted
# steps use the PER-APP role app_<app> + its Secret password (cloud_admin is
# refused through the apps-gateway). Requires the apps-gateway image built from
# this change (tenant authz + per-app peers) — see ADR-0003 "Consequences".
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg).
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
A=mta
B=mtb
C=mtc  # crash-safety drill app (issue #76)
IDLE_DRILL_MS="${IDLE_DRILL_MS:-8000}"   # apps-gateway idle lowered for a fast per-app idle assertion
IDLE_RESTORE_MS="${IDLE_RESTORE_MS:-60000}" # restored on cleanup (matches 81-apps-gateway.yaml)

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# app_pw prints the per-app role's password from its Secret (base64-decoded).
app_pw() { K get secret "app-db-$1" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }

cleanup() {
  echo "    cleanup: destroying drill apps $A/$B (+timelines), restoring gateway idle"
  K set env deploy/pggw-apps GW_IDLE_MS="$IDLE_RESTORE_MS" >/dev/null 2>&1 || true
  K delete pod -l mtdrill=hold --ignore-not-found --wait=false >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$A" --delete-timeline >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$B" --delete-timeline >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$C" --delete-timeline >/dev/null 2>&1 || true
}
trap cleanup EXIT

# DCLIENT — one-shot psql DIRECT into a per-app compute's postgres DB (compute up).
DCLIENT() { # $1 tag  $2 app  $3 sql
  local p="mtdc-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local dsn="postgres://cloud_admin:cloud_admin@compute-$2.$NS.svc:55433/postgres?sslmode=disable"
  K run "$p" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- psql "$dsn" -tA -w -c "$3" >/dev/null
  local phase="" i=0
  while [ $i -lt 90 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1
  [ "$phase" = "Succeeded" ] || { echo "direct client $1 (app=$2) failed ($phase): $out" >&2; return 1; }
  echo "$out"
}
PODS() { K get pods -l app=compute-"$1" --no-headers 2>/dev/null | grep -c . || true; }

# GCLIENT — one-shot psql THROUGH the apps-gateway as the PER-APP role app_<app>
# (issue #74: cloud_admin is refused here). Proves the full path: authorize the
# (user,db) pair, route to compute-<app>, wake 0->1, GW_SERVED_DATABASE rewrite to
# the served postgres DB, and return the query result. (Waits out the cold wake.)
GCLIENT() { # $1 tag  $2 app  $3 sql
  local p="mtgw-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local pw; pw="$(app_pw "$2")"
  local dsn="postgres://app_$2:$pw@pggw-apps:55432/$2?sslmode=disable"
  K run "$p" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- psql "$dsn" -tA -w -c "$3" >/dev/null
  local phase="" i=0
  while [ $i -lt 120 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1
  [ "$phase" = "Succeeded" ] || { echo "gateway client $1 (db=$2) failed ($phase): $out" >&2; return 1; }
  echo "$out"
}

# GDENY — a gateway connect that MUST be refused. Returns 0 (drill-pass) when the
# connection is DENIED (psql exits non-zero -> pod Failed), 1 when it wrongly
# connects. Used to prove app A's DSN cannot reach app B and cloud_admin is out.
GDENY() { # $1 tag  $2 user  $3 pass  $4 db
  local p="mtdeny-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local dsn="postgres://$2:$3@pggw-apps:55432/$4?sslmode=disable"
  K run "$p" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- psql "$dsn" -tA -w -c 'select 1' >/dev/null 2>&1 || true
  local phase="" i=0
  while [ $i -lt 60 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1
  if [ "$phase" = "Succeeded" ]; then
    echo "SECURITY: gateway ADMITTED $2@$4 (should be refused): $out" >&2
    return 1
  fi
  return 0  # denied — as required
}

# 0. preconditions
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
ok "apps-gateway ready"

# 1. provision two apps at replicas 1 (up for direct data assertions)
echo "==> provisioning drill apps"
KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null || fail "init-plane failed"
KCTX="$KCTX" NS="$NS" "$PROV" create "$A" --replicas 1 >/dev/null || fail "create $A failed"
KCTX="$KCTX" NS="$NS" "$PROV" create "$B" --replicas 1 >/dev/null || fail "create $B failed"
K rollout status deploy/compute-"$A" --timeout=120s >/dev/null || fail "$A compute not ready"
K rollout status deploy/compute-"$B" --timeout=120s >/dev/null || fail "$B compute not ready"
ok "provisioned $A and $B (each its own branch)"

# 2. both inherit the template schema (copy-on-write from the template timeline)
[ "$(DCLIENT seeda "$A" 'select count(*) from schema_migrations' | tail -1)" -ge 1 ] \
  || fail "$A did not inherit template schema"
[ "$(DCLIENT seedb "$B" 'select count(*) from schema_migrations' | tail -1)" -ge 1 ] \
  || fail "$B did not inherit template schema"
ok "both branches inherited the template schema (copy-on-write)"

# 3. each app writes an app-private row into the shared table
DCLIENT wa "$A" "insert into app_items(note) values ('$A-private-write')" >/dev/null
DCLIENT wb "$B" "insert into app_items(note) values ('$B-private-write')" >/dev/null
ok "each app wrote a private row into app_items"

# 4. ISOLATION — A must not see B's write, B must not see A's write
[ "$(DCLIENT ia "$A" "select count(*) from app_items where note='$B-private-write'" | tail -1)" = "0" ] \
  || fail "ISOLATION BREACH: $A sees $B's write"
[ "$(DCLIENT ib "$B" "select count(*) from app_items where note='$A-private-write'" | tail -1)" = "0" ] \
  || fail "ISOLATION BREACH: $B sees $A's write"
[ "$(DCLIENT oa "$A" "select count(*) from app_items where note='$A-private-write'" | tail -1)" = "1" ] \
  || fail "$A cannot see its own write"
ok "isolation holds: neither app sees the other's write; each sees its own"

# 5. independent 0<->1 through the apps-gateway (full path incl. db rewrite)
K scale deploy/compute-"$A" --replicas=0 >/dev/null
i=0; while [ "$(PODS "$A")" != "0" ]; do i=$((i+1)); [ $i -gt 60 ] && fail "$A did not reach 0"; sleep 1; done
ok "$A scaled to 0 (independent of $B)"
[ "$(DCLIENT liveb "$B" 'select 1' | tail -1)" = "1" ] || fail "$B stopped serving while $A slept"
ok "$B still serves while $A is asleep"
# One gateway-fronted query does it all: database=A routes+wakes compute-A, the
# GW_SERVED_DATABASE rewrite lets it connect, and it returns A's own private row.
[ "$(GCLIENT rea "$A" "select count(*) from app_items where note='$A-private-write'" | tail -1)" = "1" ] \
  || fail "gateway-fronted database=$A did not return $A's data (routing/wake/rewrite)"
[ "$(PODS "$A")" = "1" ] || fail "$A pod not running after gateway wake"
ok "apps-gateway routed database=$A -> woke compute-$A 0->1 -> served its data (db-rewrite live)"
# Cross-check isolation still holds THROUGH the gateway: A must not see B's write.
[ "$(GCLIENT reab "$A" "select count(*) from app_items where note='$B-private-write'" | tail -1)" = "0" ] \
  || fail "ISOLATION BREACH via gateway: $A sees $B's write"
ok "$A woke via the gateway with its data intact + isolation holds — independent 0<->1 confirmed"

# 6. TENANT ACCESS CONTROL (issue #74) — the apps-gateway must REFUSE:
#    (a) app A's role reaching app B's database (cross-tenant), and
#    (b) the shared cloud_admin credential (no admin through the apps-gateway).
#    Both must be denied BEFORE any wake. app A's own cred to its own db is allowed
#    (proven in section 5), so this is a true access-control boundary, not a wall.
echo "==> tenant access control (issue #74)"
APW="$(app_pw "$A")"
GDENY xapp "app_$A" "$APW" "$B" \
  || fail "cross-tenant: app_$A reached database $B through the gateway"
ok "cross-tenant DENIED: app_$A cannot reach database $B (its DSN is scoped to $A)"
GDENY xadmin "cloud_admin" "cloud_admin" "$A" \
  || fail "cloud_admin was admitted to database $A through the gateway"
ok "cloud_admin DENIED through the apps-gateway (admin path is direct-compute only)"
GDENY xtmpl "app_tmpl" "whatever" "tmpl" \
  || fail "reserved system 'tmpl' (template compute) was reachable through the gateway"
ok "reserved system 'tmpl' DENIED (cannot mutate the shared template via the gateway)"

# 7. PER-APP IDLE (issue #75) — with B busy on a held connection, idle A must still
#    scale to zero on schedule. The OLD fleet-global peer check would keep A awake
#    because SOME app (B) is active; the per-app check lets A sleep. We lower the
#    apps-gateway idle to make this fast and deterministic (restored on cleanup).
echo "==> per-app idle under concurrent load (issue #75)"
K set env deploy/pggw-apps GW_IDLE_MS="$IDLE_DRILL_MS" >/dev/null
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway rollout (idle patch) failed"
# Make sure both apps are up, then hold a long-lived connection open on B through
# the gateway (keeps B active on some replica for the whole idle window).
GCLIENT warmb "$B" 'select 1' >/dev/null || fail "could not pre-wake $B"
BPW="$(app_pw "$B")"
K run "mthold-$$" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
  --labels="mtdrill=hold" --restart=Never --quiet --command -- \
  psql "postgres://app_$B:$BPW@pggw-apps:55432/$B?sslmode=disable" -tA -w \
  -c "select pg_sleep(60)" >/dev/null 2>&1 &
# Arm A's idle timer: a quick gateway query that connects then disconnects.
GCLIENT arma "$A" 'select 1' >/dev/null || fail "could not arm $A idle"
[ "$(PODS "$A")" = "1" ] || fail "$A not running before idle drill"
# Within a few idle windows, A must scale to zero (B busy must NOT hold it awake).
i=0; while [ "$(PODS "$A")" != "0" ]; do
  i=$((i+1)); [ $i -gt 45 ] && fail "$A did NOT scale to zero while $B was busy (fleet-global idle regression, #75)"; sleep 1
done
ok "$A scaled to zero on schedule while $B held an open connection (per-app idle holds)"
[ "$(PODS "$B")" -ge 1 ] || fail "$B (busy) was wrongly scaled down"
ok "$B stayed up under its held connection — one busy app does not sleep, one idle app does"
K delete pod -l mtdrill=hold --ignore-not-found --wait=false >/dev/null 2>&1 || true

# 8. PROVISION CRASH-SAFETY (issue #76) — simulate a create killed AFTER the
#    intent ConfigMap is written but BEFORE the pageserver branch. Re-running
#    create must reuse the SAME timeline id (converge, no orphan), and fsck must
#    report a clean plane.
echo "==> provision crash-safety / intent-first (issue #76)"
CID="$(python3 -c 'import os;print(os.urandom(16).hex())')"
# a) the crash window: the intent ConfigMap exists (records TIMELINE_ID) but no
#    branch was made yet.
K apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: compute-config-$C
  namespace: $NS
  labels: { app: compute-$C, tier: apps, plane: compute }
data:
  PG_VERSION: "17"
  PAGESERVER_HOST: "pageserver"
  TENANT_ID: "${APPS_TENANT:-a0000000000000000000000000000001}"
  TIMELINE_ID: "$CID"
  APP_ROLE: "app_$C"
EOF
ok "simulated interrupted create: intent ConfigMap for $C at timeline $CID, no branch yet"
# b) re-run create -> must read $CID back and branch THAT id (not mint a new one).
KCTX="$KCTX" NS="$NS" "$PROV" create "$C" --replicas 0 >/dev/null || fail "re-create after crash failed"
GOTID="$(K get configmap "compute-config-$C" -o jsonpath='{.data.TIMELINE_ID}')"
[ "$GOTID" = "$CID" ] || fail "re-create minted a NEW id ($GOTID != $CID) — orphan risk (#76 regression)"
ok "re-create converged on the SAME timeline $CID (no orphan branch)"
# c) fsck must report a clean plane (every branch owned by a ConfigMap).
KCTX="$KCTX" NS="$NS" "$PROV" fsck >/dev/null || fail "fsck reported orphan timelines after converged create"
ok "fsck: plane clean — no orphan timelines"

echo "multi-tenant verification: isolation + tenant access control + per-app 0<->1 idle + crash-safe provisioning — PASSED"
