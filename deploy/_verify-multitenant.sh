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
#   4. independent 0<->1: sleeping A leaves B serving; A wakes with data intact
#
# Isolation/schema assertions connect DIRECT to each compute-<app> Service
# (database=postgres). The gateway-fronted step then proves the FULL path through
# the apps-gateway: database=<app> -> route to compute-<app> -> wake 0->1 ->
# GW_SERVED_DATABASE rewrite to the served postgres DB -> query returns the app's
# own data. (Requires the apps-gateway image built from this change — see
# ADR-0003 "Routing".)
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg).
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
A=mta
B=mtb

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

cleanup() {
  echo "    cleanup: destroying drill apps $A/$B (+timelines)"
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$A" --delete-timeline >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$B" --delete-timeline >/dev/null 2>&1 || true
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

# GCLIENT — one-shot psql THROUGH the apps-gateway with database=<app>. Proves the
# full path: route to compute-<app>, wake 0->1, GW_SERVED_DATABASE rewrite to the
# served postgres DB, and return the query result. (Waits out the cold wake.)
GCLIENT() { # $1 tag  $2 app  $3 sql
  local p="mtgw-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local dsn="postgres://cloud_admin:cloud_admin@pggw-apps:55432/$2?sslmode=disable"
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

echo "multi-tenant verification: two branches, one storage plane, isolated + independently scaled — PASSED"
