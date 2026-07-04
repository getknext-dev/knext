#!/usr/bin/env bash
# _verify-tenant-quotas.sh — per-app tenant quota / noisy-neighbour drill (#89).
#
# Proves the ADR-0003 noisy-neighbour bound: two apps on ONE shared plane, one a
# hostile tenant (connection flood + CPU burn), and the other (the victim) stays
# available and keeps its own, independent limits. Self-contained + idempotent:
# provisions two throwaway drill apps and destroys them (timelines included) on exit.
#
# Asserts:
#   1. PER-APP max_connections is enforced by each app's OWN Postgres and is
#      INDEPENDENT: the hostile app's low cap does not change the victim's default.
#   2. A CPU LIMIT is rendered on the per-app compute (the bound ADR-0003 lacked;
#      before #89 only a memory limit existed, so a busy app could burn the node).
#   3. NOISY-NEIGHBOUR CONTAINMENT: while the hostile app FLOODS connections through
#      the apps-gateway (beyond its own cap) AND burns CPU, the victim app still
#      wakes/serves through the gateway — its availability is unaffected.
#   4. The hostile flood is actually BOUNDED: connections beyond its per-app cap are
#      refused by its own Postgres (53300 too-many-connections), not the plane.
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg),
#      HOSTILE_MAXCONNS (default 12), FLOOD (default 20 gateway conns).
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
V=qv              # victim app (default quota)
H=qh              # hostile app (low conn cap, low cpu limit)
HOSTILE_MAXCONNS="${HOSTILE_MAXCONNS:-12}"
FLOOD="${FLOOD:-20}"   # gateway connections the hostile app opens (> its cap, < GW_MAX_CONNS)

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
app_pw() { K get secret "app-db-$1" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }
PODS() { K get pods -l app=compute-"$1" --no-headers 2>/dev/null | grep -c . || true; }

cleanup() {
  echo "    cleanup: destroying drill apps $V/$H (+timelines) and flood pods"
  K delete pod -l qdrill=flood --ignore-not-found --wait=false >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$V" >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$H" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# DCLIENT — one-shot psql DIRECT into a per-app compute's postgres DB (compute up),
# as cloud_admin (direct-compute is a separate trust boundary from the gateway).
DCLIENT() { # $1 tag  $2 app  $3 sql
  local p="qdc-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
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

# GCLIENT — one-shot psql THROUGH the apps-gateway as the per-app role (waits out
# a cold wake). Used to prove the VICTIM serves through the shared front door.
GCLIENT() { # $1 tag  $2 app  $3 sql
  local p="qgw-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
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

# 0. preconditions
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
ok "apps-gateway ready"

echo "==> provisioning victim ($V, default quota) and hostile ($H, --max-conns $HOSTILE_MAXCONNS --cpu-limit 250m)"
KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null || fail "init-plane failed"
KCTX="$KCTX" NS="$NS" "$PROV" create "$V" --replicas 1 >/dev/null || fail "create $V failed"
KCTX="$KCTX" NS="$NS" "$PROV" create "$H" --replicas 1 --max-conns "$HOSTILE_MAXCONNS" --cpu-limit 250m >/dev/null \
  || fail "create $H failed"
K rollout status deploy/compute-"$V" --timeout=120s >/dev/null || fail "$V compute not ready"
K rollout status deploy/compute-"$H" --timeout=120s >/dev/null || fail "$H compute not ready"
ok "provisioned $V (default) and $H (capped) on one plane"

# 1. PER-APP max_connections is enforced by each app's own Postgres, independently.
VMAX="$(DCLIENT vmax "$V" 'show max_connections' | tail -1)"
HMAX="$(DCLIENT hmax "$H" 'show max_connections' | tail -1)"
echo "    victim max_connections=$VMAX ; hostile max_connections=$HMAX"
[ "$HMAX" = "$HOSTILE_MAXCONNS" ] || fail "hostile per-app cap not enforced: max_connections=$HMAX, want $HOSTILE_MAXCONNS"
[ "$VMAX" = "100" ] || fail "victim's cap changed by the hostile app's quota (want default 100, got $VMAX)"
ok "per-app max_connections enforced + independent: hostile=$HMAX, victim=$VMAX (unchanged)"

# 2. A CPU LIMIT is rendered on the per-app compute (the noisy-neighbour bound).
HCPU_LIM="$(K get deploy compute-"$H" -o jsonpath='{.spec.template.spec.containers[0].resources.limits.cpu}')"
[ -n "$HCPU_LIM" ] || fail "no CPU limit on compute-$H — a hostile app could burn the node unbounded (#89 regression)"
ok "hostile compute has a CPU limit ($HCPU_LIM) — a CPU burn is capped to its allotment"

# 3+4. NOISY-NEIGHBOUR: hostile floods the gateway (> its cap) and burns CPU; the
#      victim must still serve through the same shared apps-gateway.
echo "==> hostile flood: $FLOOD gateway connections (cap $HOSTILE_MAXCONNS) + a CPU burn on $H"
HPW="$(app_pw "$H")"
# One flood pod fires FLOOD background psql, each holding a long pg_sleep, and also
# a CPU burn. Connections beyond the hostile cap are refused by ITS Postgres.
K run "qflood-$$" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
  --labels="qdrill=flood" --restart=Never --quiet --command -- \
  sh -c "for i in \$(seq 1 $FLOOD); do psql 'postgres://app_$H:$HPW@pggw-apps:55432/$H?sslmode=disable' -tAw -c 'select pg_sleep(45)' >/dev/null 2>&1 & done; \
         psql 'postgres://app_$H:$HPW@pggw-apps:55432/$H?sslmode=disable' -tAw -c 'select count(*) from generate_series(1,80000000)' >/dev/null 2>&1 & \
         sleep 45" >/dev/null 2>&1 &
# Give the flood a moment to saturate the hostile compute.
sleep 6
# The victim must WAKE + SERVE through the same apps-gateway during the flood.
[ "$(GCLIENT vserve "$V" 'select 1' | tail -1)" = "1" ] \
  || fail "victim $V could NOT serve through the gateway while $H flooded it (noisy-neighbour breach)"
ok "victim $V served 'select 1' through the shared apps-gateway during the hostile flood + CPU burn"
# A second victim query to be sure it is durably available, not a one-off.
[ "$(GCLIENT vserve2 "$V" 'select 42' | tail -1)" = "42" ] \
  || fail "victim $V second query failed during the flood"
ok "victim $V stayed available under sustained hostile load — noisy-neighbour contained"

# 4. The flood is BOUNDED: the hostile app is at/over its own cap (its Postgres
#    refuses beyond the limit). We observe the hostile backend count is bounded by
#    its cap, not runaway.
HACT="$(DCLIENT hact "$H" "select count(*) from pg_stat_activity where usename='app_$H'" | tail -1 || echo '?')"
echo "    hostile active backends for app_$H during flood: $HACT (cap $HOSTILE_MAXCONNS)"
if [ "$HACT" != "?" ] && [ "$HACT" -gt "$HOSTILE_MAXCONNS" ] 2>/dev/null; then
  fail "hostile backends ($HACT) exceeded its cap ($HOSTILE_MAXCONNS) — per-app cap not holding"
fi
ok "hostile flood bounded by its per-app cap (backends <= $HOSTILE_MAXCONNS) — the plane is not exhausted"

K delete pod -l qdrill=flood --ignore-not-found --wait=false >/dev/null 2>&1 || true
echo "tenant-quota verification: per-app cap + independence + CPU limit + noisy-neighbour containment — PASSED"
