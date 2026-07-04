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
#   4b. GATEWAY-BYPASS ATTACK CLOSED (issue #112): a co-tenant pod dialing
#      compute-<app>:55433 DIRECTLY as cloud_admin over TCP is REJECTED by pg_hba
#      (loopback-only cloud_admin), CNI-independent — the enforcing tenant boundary
#   5. independent 0<->1: sleeping A leaves B serving; A wakes with data intact
#   5b. APPS-GATEWAY TLS (issue #113): sslmode=require to pggw-apps is encrypted
#   6. PER-APP IDLE (issue #75): with B busy, idle A still scales to zero on schedule
#
# Isolation/schema/admin assertions run over the pod-LOCAL LOOPBACK via
# `kubectl exec` as cloud_admin (loopback-trust; TCP cloud_admin is rejected since
# #112 — that dial is the very bypass step 4b proves closed). The gateway-fronted
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

# DCLIENT — admin psql into a per-app compute's postgres DB over the pod-LOCAL
# LOOPBACK via `kubectl exec` (compute-<app> pod must be Running). cloud_admin is
# loopback-trust and, since issue #112, REJECTED over TCP — so admin/isolation
# queries go through the pod (compute_ctl's own path), NOT a network dial. This is
# ALSO the compute_ctl/provision-app "legit localhost cloud_admin" path, so a green
# DCLIENT proves that path is intact after the pg_hba hardening.
DCLIENT() { # $1 tag(unused)  $2 app  $3 sql
  K exec "deploy/compute-$2" -c compute -- \
    psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -w -c "$3"
}
PODS() { K get pods -l app=compute-"$1" --no-headers 2>/dev/null | grep -c . || true; }

# ATTACK_TCP — simulate a co-tenant / compromised pod (default SA, no special
# labels) dialing a per-app compute DIRECTLY as cloud_admin over TCP: the exact
# #112 gateway-bypass. Prints the psql result (expected AFTER the fix: a pg_hba
# reject, never superuser). compute-<app> must be Running.
ATTACK_TCP() { # $1 app
  local p="mtatk-$$-$1"
  local dsn="postgres://cloud_admin:cloud_admin@compute-$1.$NS.svc:55433/postgres?sslmode=disable&connect_timeout=8"
  K run "$p" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- \
    sh -c "PGPASSWORD=cloud_admin psql \"$dsn\" -tAc 'select rolsuper from pg_roles where rolname=current_user' 2>&1 || true" >/dev/null 2>&1 || true
  local phase="" i=0
  while [ $i -lt 60 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1
  printf '%s\n' "$out"
}

# TLSCLIENT — one-shot psql THROUGH the apps-gateway as the per-app role with
# sslmode=require, printing \conninfo (expects "SSL connection ..."). Proves the
# apps-gateway front door is encrypted (issue #113).
TLSCLIENT() { # $1 tag  $2 app  $3 pw
  local p="mttls-$$-$1"
  local dsn="postgres://app_$2:$3@pggw-apps:55432/$2?sslmode=require"
  K run "$p" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- psql "$dsn" -tA -w -c '\conninfo' >/dev/null 2>&1 || true
  local phase="" i=0
  while [ $i -lt 120 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1
  [ "$phase" = "Succeeded" ] || { echo "$out"; return 1; }
  echo "$out"
}

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

# GERR — a gateway connect that MUST be refused; prints the psql FATAL message
# line (the client-visible error text) so the caller can assert the apps-gateway
# leaks NO existence oracle / internal object names (issue #92). Extracts just the
# `FATAL: ...` tail so unrelated psql connection-noise does not affect the compare.
GERR() { # $1 tag  $2 user  $3 pass  $4 db
  local p="mterr-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
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
  # Print the FATAL message tail (everything from the last 'FATAL:'), trimmed.
  printf '%s\n' "$out" | grep -o 'FATAL:.*' | tail -1
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

# 4b. GATEWAY-BYPASS ATTACK CLOSED (issue #112 CRITICAL) — the headline fix. A
#     co-tenant pod that dials a per-app compute DIRECTLY as cloud_admin over TCP
#     (bypassing the apps-gateway's (user,database) authz) MUST be REJECTED by
#     pg_hba — regardless of the CNI (flannel enforces no NetworkPolicy). And the
#     LEGIT paths must still work: (a) loopback cloud_admin (compute_ctl +
#     provision/drills, proven by every green DCLIENT above), (b) the app path
#     through pggw-apps (proven in section 5). This is the enforcing tenant boundary.
echo "==> gateway-bypass attack closed (issue #112 CRITICAL)"
# The control must be LIVE on the compute (definitive, not timing-dependent):
K exec "deploy/compute-$A" -c compute -- sh -c \
  'grep -qiE "^host[[:space:]]+all[[:space:]]+cloud_admin[[:space:]]+all[[:space:]]+reject" /var/db/postgres/compute/pg_hba.conf' \
  || fail "compute-$A pg_hba missing the cloud_admin TCP-reject — #112 control not live"
ok "compute-$A pg_hba binds cloud_admin to loopback (rejects it over TCP) — control live"
# legit loopback cloud_admin still works (compute_ctl / provision-app path):
[ "$(DCLIENT lb "$A" 'select 1' | tail -1)" = "1" ] \
  || fail "loopback cloud_admin regressed on compute-$A (compute_ctl/provision path broke)"
ok "legit path intact: loopback cloud_admin still works on compute-$A"
# the attack itself: off-localhost cloud_admin over TCP must be REJECTED + no superuser:
ATK="$(ATTACK_TCP "$A")"
echo "    attacker (off-localhost cloud_admin -> compute-$A:55433): $(printf '%s' "$ATK" | grep -o 'FATAL:.*\|^t$\|^f$' | head -1)"
case "$ATK" in
  *"pg_hba.conf rejects connection"*) ;;
  *) fail "SECURITY: off-localhost cloud_admin to compute-$A was NOT pg_hba-rejected (bypass OPEN): $ATK";;
esac
case "$ATK" in
  *rolsuper*|*"|t"*) fail "SECURITY: attacker obtained cloud_admin/superuser on compute-$A: $ATK";;
esac
# printf 't' alone (a bare superuser row) would also be a breach:
[ "$(printf '%s' "$ATK" | grep -cE '^t$')" = "0" ] \
  || fail "SECURITY: attacker got a superuser row from compute-$A"
ok "ATTACK CLOSED: off-localhost cloud_admin REJECTED by pg_hba on compute-$A (no superuser)"

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

# 5b. APPS-GATEWAY FRONT-DOOR TLS (issue #113 HIGH) — the same per-app path over
#     sslmode=require must establish a real TLS session (psql \conninfo reports
#     "SSL connection ..."). Before the fix pggw-apps answered SSLRequest with 'N'
#     and served every query/result row in plaintext; now per-tenant traffic is
#     encrypted on the wire. (compute-$A is up from section 5.)
echo "==> apps-gateway front-door TLS (issue #113)"
ATPW="$(app_pw "$A")"
TLSOUT="$(TLSCLIENT tlsa "$A" "$ATPW")" || fail "sslmode=require to pggw-apps FAILED (TLS not served?): $TLSOUT"
echo "    $(echo "$TLSOUT" | grep -o 'SSL connection.*' | head -1)"
echo "$TLSOUT" | grep -q "SSL connection" \
  || fail "pggw-apps did NOT negotiate TLS under sslmode=require (still plaintext): $TLSOUT"
ok "apps-gateway serves TLS: app_$A over sslmode=require established an encrypted session"

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

# 6b. NO EXISTENCE ORACLE (issue #92) — the client-visible refusal for a
#     NON-existent app (valid-syntax pair app_ghost/ghost, no such app) must be
#     IDENTICAL to a wrong-pair and a reserved refusal, and must leak NO internal
#     k8s object name ("compute-ghost", "deployments.apps", "not found"). All three
#     use the SAME user (app_ghost) so the messages must match verbatim.
echo "==> no tenant-existence oracle (issue #92)"
E_UNKNOWN="$(GERR unknown app_ghost whatever ghost)"   # valid syntax, app does not exist
E_WRONG="$(GERR wrongp  app_ghost whatever "$A")"       # app_ghost != app_$A (wrong pair)
E_RESV="$(GERR resv     app_ghost whatever tmpl)"       # reserved system name
echo "    unknown-app : $E_UNKNOWN"
echo "    wrong-pair  : $E_WRONG"
echo "    reserved    : $E_RESV"
[ -n "$E_UNKNOWN" ] || fail "unknown-app produced no FATAL message (did it connect?!)"
[ "$E_UNKNOWN" = "$E_WRONG" ] || fail "existence oracle: unknown-app '$E_UNKNOWN' != wrong-pair '$E_WRONG'"
[ "$E_UNKNOWN" = "$E_RESV" ]  || fail "existence oracle: unknown-app '$E_UNKNOWN' != reserved '$E_RESV'"
case "$E_UNKNOWN" in
  *"password authentication failed for user \"app_ghost\""*) ;;
  *) fail "refusal is not the uniform 28P01 password message: '$E_UNKNOWN'";;
esac
for leak in "compute-ghost" "compute-" "deployments.apps" "not found" "unavailable"; do
  case "$E_UNKNOWN" in *"$leak"*) fail "refusal LEAKS internal detail '$leak': $E_UNKNOWN";; esac
done
ok "no existence oracle: unknown-app == wrong-pair == reserved, uniform 28P01, no k8s names leaked"

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

echo "multi-tenant verification: isolation + tenant access control + no existence oracle (#92) + per-app 0<->1 idle + crash-safe provisioning — PASSED"
