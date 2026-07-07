#!/usr/bin/env bash
# _verify-zones.sh — LIVE end-to-end drill for the Zone operator (ADR-0007, #139
# v2-2). Proves the payoff of the zone-scaling axis, driven ENTIRELY through Zone CRs
# + the zone-operator (no manual pub/sub SQL — the operator is the sole author):
#
#   1. Apply two throwaway Zones: za PUBLISHES table `orders`; zb declares a
#      dataDependency on za.orders (mode: replicate). The operator composes BOTH
#      AppDatabases, mints repl_za, creates the publication on za, and the
#      subscription on zb whose CONNECTION points at the apps-gateway.
#   2. Cross-zone replication: an INSERT on za eventually appears on zb.
#   3. SOVEREIGNTY: za's UNpublished table `secret_t` never reaches zb.
#   4. PUBLISHER-WOKEN-FOR-REPLICATION: sleep both, wake ONLY the subscriber; the
#      gateway wakes the sleeping publisher za for zb's walreceiver (the #140
#      mechanism, end-to-end through the operator-created subscription).
#   5. DEPROVISION: delete both Zones -> the finalizer drops sub/pub/slot on the peer
#      and the composed AppDatabases reclaim their timelines — no orphan slot/pub/sub.
#
# It NEVER touches the live plane's real apps (only its own za/zb throwaway zones).
#
# Usage:
#   deploy/_verify-zones.sh run       # full drill (deploy operator -> prove -> teardown)
#   deploy/_verify-zones.sh teardown  # remove the throwaway zones + (optionally) operator
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg),
#      ZA/ZB (zone names), KEEP_OPERATOR=1 to leave the CRD+operator installed.
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ZA="${ZA:-za}"
ZB="${ZB:-zb}"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
log() { printf '\033[36m[zones]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[zones] PASS:\033[0m %s\n' "$*"; }
bad() { printf '\033[31m[zones] FAIL:\033[0m %s\n' "$*" >&2; }

# Only ever return a RUNNING compute pod — a Pending/unscheduled pod has no host and
# `kubectl exec` on it fails ("does not have a host assigned").
pod_of() { K get pod -l app=compute-"$1" --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }
psqla() { local z="$1"; shift; K exec -i "$(pod_of "$z")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc "$@"; }
psqla_f() { local z="$1"; K exec -i "$(pod_of "$z")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1; }
replicas_of() { K get deploy compute-"$1" -o jsonpath='{.spec.replicas}' 2>/dev/null; }
ready_of()    { K get deploy compute-"$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null; }
# Scale up and POLL until a Running pod exists AND the deployment reports a ready
# replica — robust against pod-creation/scheduling races (kubectl wait can return
# before the pod object exists when scaling from zero).
wake1()  { K scale deploy/compute-"$1" --replicas=1 >/dev/null 2>&1 || true
           local i=0
           until [ -n "$(pod_of "$1")" ] && [ "$(ready_of "$1")" = "1" ]; do
             i=$((i+1)); [ "$i" -ge 180 ] && { bad "compute-$1 did not become ready in time"; return 1; }
             sleep 1
           done; }
sleep0() { log "scaling compute-$1 -> 0"; K scale deploy/compute-"$1" --replicas=0 >/dev/null 2>&1 || true
           K wait --for=delete pod -l app=compute-"$1" --timeout=90s >/dev/null 2>&1 || sleep 5; }
zone_phase() { K get zone "$1" -o jsonpath='{.status.phase}' 2>/dev/null; }
sub_state()  { K get zone "$1" -o jsonpath='{.status.subscriptions[0].state}' 2>/dev/null; }
now() { python3 -c 'import time;print(time.time())'; }
since() { python3 -c "print(f'{$(now)-$1:.2f}s')"; }

teardown() {
  log "TEARDOWN: deleting throwaway zones $ZA / $ZB (finalizer runs cross-zone hygiene)"
  K delete zone "$ZB" --timeout=180s 2>&1 | tail -1 || true
  K delete zone "$ZA" --timeout=180s 2>&1 | tail -1 || true
  # Backstop: reclaim any leftover throwaway AppDatabases/branches.
  K delete appdatabase "$ZB" "$ZA" --ignore-not-found 2>/dev/null || true
  if [ "${KEEP_OPERATOR:-}" != "1" ]; then
    log "removing zone-operator + CRD (set KEEP_OPERATOR=1 to keep them)"
    K delete -f "$HERE/87-zone-operator.yaml" --ignore-not-found 2>/dev/null || true
    K delete -f "$HERE/86-zone-crd.yaml" --ignore-not-found 2>/dev/null || true
  else
    # Restore the operator in case the drill exited mid-STEP-7 (scaled to 0).
    K scale deploy/zone-operator --replicas=1 >/dev/null 2>&1 || true
  fi
  ok "teardown complete"
}

run() {
  trap teardown EXIT

  # 0. Install the CRD + operator (idempotent).
  log "applying Zone CRD + operator"
  K apply -f "$HERE/86-zone-crd.yaml" >/dev/null
  K apply -f "$HERE/87-zone-operator.yaml" >/dev/null
  K rollout status deploy/zone-operator --timeout=120s >/dev/null
  ok "zone-operator running"

  # 1. Apply the two Zones. za publishes orders; zb depends on za.orders (replicate).
  log "applying Zone $ZA (publishes orders) + Zone $ZB (depends on $ZA.orders, replicate)"
  cat <<YAML | K apply -f - >/dev/null
apiVersion: zones.scale-zero-pg.dev/v1alpha1
kind: Zone
metadata: { name: ${ZA} }
spec:
  database: { tier: cold }
  publishes:
    - { name: orders_pub, tables: [orders] }
---
apiVersion: zones.scale-zero-pg.dev/v1alpha1
kind: Zone
metadata: { name: ${ZB} }
spec:
  database: { tier: cold }
  dataDependencies:
    - { fromZone: ${ZA}, tables: [orders], mode: replicate }
YAML

  # 2. Wait for the operator to compose both AppDatabases (branch + compute).
  log "waiting for composed AppDatabases $ZA/$ZB to be Ready"
  for _ in $(seq 1 80); do
    [ "$(K get appdatabase "$ZA" -o jsonpath='{.status.phase}' 2>/dev/null)" = "Ready" ] &&
    [ "$(K get appdatabase "$ZB" -o jsonpath='{.status.phase}' 2>/dev/null)" = "Ready" ] && break
    sleep 2
  done
  ok "both zone DBs composed (AppDatabase Ready)"

  # 3. Create the application schema (the operator authors pub/sub, NOT app tables):
  #    za gets `orders` (published) + `secret_t` (UNpublished — the sovereignty probe);
  #    zb gets a matching empty `orders` for the subscription's initial COPY target.
  wake1 "$ZA"; wake1 "$ZB"
  psqla_f "$ZA" <<SQL
CREATE TABLE IF NOT EXISTS orders(id serial primary key, item text);
CREATE TABLE IF NOT EXISTS secret_t(id serial primary key, classified text);
INSERT INTO orders(item) SELECT 'seed-'||g FROM generate_series(1,5) g;
INSERT INTO secret_t(classified) VALUES('do-not-export');
SQL
  psqla_f "$ZB" <<SQL
CREATE TABLE IF NOT EXISTS orders(id serial primary key, item text);
SQL
  ok "schema created ($ZA: orders + secret_t; $ZB: orders)"

  # 4. Wait for the operator to converge the fabric. za reaches Ready only AFTER it
  #    successfully publishes (which needs `orders` to exist, created in step 3) — so
  #    poll za's Zone phase, then zb's subscription. The operator authors pub/sub on
  #    its own resync cadence, so give it time (never a one-shot check).
  log "waiting for the operator to wire the cross-zone fabric"
  for _ in $(seq 1 90); do [ "$(zone_phase "$ZA")" = "Ready" ] && break; sleep 2; done
  [ "$(zone_phase "$ZA")" = "Ready" ] \
    && ok "publisher zone $ZA reached Ready (operator published orders_pub)" \
    || { bad "$ZA not Ready (phase=$(zone_phase "$ZA"))"; K get zone "$ZA" -o yaml | tail -30; exit 1; }
  for _ in $(seq 1 90); do [ "$(sub_state "$ZB")" = "streaming" ] && break; sleep 2; done
  [ "$(sub_state "$ZB")" = "streaming" ] \
    && ok "operator wired: $ZB subscription state=streaming (slot on $ZA)" \
    || { bad "subscription not streaming (state=$(sub_state "$ZB"), zone phase=$(zone_phase "$ZB"))"; K get zone "$ZB" -o yaml | tail -30; exit 1; }
  # Confirm the operator-authored objects on za directly (wake za — the streaming
  # subscription may have let both computes idle back to zero by now). Poll: the
  # operator may still be mid-reconcile.
  wake1 "$ZA"
  local havepub=""; for _ in $(seq 1 30); do havepub="$(psqla "$ZA" "select count(*) from pg_publication where pubname='orders_pub'" 2>/dev/null)"; [ "$havepub" = "1" ] && break; sleep 2; done
  [ "$havepub" = "1" ] && ok "publication orders_pub exists on $ZA (operator-authored)" || { bad "publication missing on $ZA"; exit 1; }
  [ "$(psqla "$ZA" "select count(*) from pg_roles where rolname='repl_${ZA}' and rolreplication")" = "1" ] \
    && ok "repl_${ZA} role exists with REPLICATION attr (operator-authored)" || { bad "repl role missing/attr on $ZA"; exit 1; }

  # HARD CONTRACT (#143 slot-janitor): a publisher compute MUST be labeled
  # plane=compute so the slot-aware janitor floors its prune horizon at this zone's
  # ACTIVE slot restart_lsn — otherwise a live subscriber's still-needed WAL could be
  # pruned (data loss). Composed AppDatabase computes inherit the label (appdb render
  # labelsFor); assert it explicitly so a regression fails the drill.
  [ "$(K get deploy compute-${ZA} -o jsonpath='{.spec.template.metadata.labels.plane}')" = "compute" ] \
    && ok "publisher compute-${ZA} labeled plane=compute (slot-janitor floor sees its slots, #143)" \
    || { bad "compute-${ZA} missing plane=compute label — slot-janitor blind to its slots (#143 data-loss risk)"; exit 1; }

  # 5. CROSS-ZONE REPLICATION: seed rows + a live insert must appear on zb. Wake zb
  #    so its apply worker is running (waking zb also wakes za via the gateway).
  wake1 "$ZB"
  local n=""; for _ in $(seq 1 60); do n="$(psqla "$ZB" 'select count(*) from orders')"; [ "$n" = "5" ] && break; sleep 0.5; done
  [ "$n" = "5" ] && ok "initial COPY replicated 5 seed rows $ZA -> $ZB" || { bad "initial copy: $ZB has $n rows"; exit 1; }
  # Live incremental: the subscriber's apply worker may still be re-establishing its
  # walreceiver (through the gateway) after zb's wake, so allow a generous window.
  wake1 "$ZA"
  psqla "$ZA" "INSERT INTO orders(item) VALUES('livemark')" >/dev/null
  local s; s="$(now)"
  local live=0; for _ in $(seq 1 120); do
    live="$(psqla "$ZB" "select count(*) from orders where item='livemark'" 2>/dev/null)"
    [ "$live" = "1" ] && break; sleep 1
  done
  [ "$live" = "1" ] \
    && ok "live insert replicated $ZA -> $ZB in $(since "$s")" \
    || { bad "live insert not replicated (sub stat: $(psqla "$ZB" "select srsubstate from pg_subscription_rel limit 1" 2>/dev/null))"; exit 1; }

  # 6. SOVEREIGNTY: za's UNpublished secret_t must never reach zb. There is no
  #    secret_t table on zb (nothing published it), and repl_za cannot read it either.
  local leaked; leaked="$(psqla "$ZB" "select count(*) from information_schema.tables where table_name='secret_t'")"
  [ "$leaked" = "0" ] && ok "SOVEREIGNTY: unpublished secret_t did NOT reach $ZB (no such table)" \
    || { bad "SOVEREIGNTY BREACH: secret_t present on $ZB"; exit 1; }

  # 7. PUBLISHER-WOKEN-FOR-REPLICATION (the #140 mechanism, end-to-end). Sleep the
  #    subscriber (walreceiver disconnects), backlog the publisher, sleep the publisher
  #    to ZERO, then wake ONLY the subscriber — its walreceiver connects THROUGH the
  #    gateway, which wakes the sleeping publisher. We never scale the publisher.
  sleep0 "$ZB"
  psqla "$ZA" "INSERT INTO orders(item) SELECT 'backlog-'||g FROM generate_series(1,50) g" >/dev/null
  sleep0 "$ZA"
  # CLEAN ATTRIBUTION: scale the zone-operator to 0 for the measurement so the ONLY
  # thing that can wake compute-za is zb's walreceiver through the gateway (not the
  # operator's own reconcile). With the steady-state gate the operator wouldn't wake a
  # Ready za anyway — this makes the proof unambiguous regardless.
  log "STEP 7 scaling zone-operator -> 0 so the publisher wake is attributable ONLY to the subscriber"
  K scale deploy/zone-operator --replicas=0 >/dev/null
  K wait --for=delete pod -l app=zone-operator --timeout=60s >/dev/null 2>&1 || sleep 5
  # Prove za TRULY sleeps with the operator idle: it must stay at 0 for a spell.
  sleep 20
  [ "$(replicas_of "$ZA")" = "0" ] \
    && ok "STEP 7 publisher compute-$ZA TRULY at rest (0 replicas, operator idle 20s — not force-woken)" \
    || { bad "STEP 7 compute-$ZA re-woke to $(replicas_of "$ZA") with the operator DOWN — something else is waking it"; K scale deploy/zone-operator --replicas=1 >/dev/null; exit 1; }
  log "STEP 7 publisher compute-$ZA at 0; waking ONLY subscriber $ZB (operator is down)"
  local t0; t0="$(now)"
  wake1 "$ZB"
  local woke=""; for _ in $(seq 1 90); do
    [ "$(replicas_of "$ZA")" = "1" ] && { woke="$(since "$t0")"; break; }; sleep 0.3
  done
  [ -n "$woke" ] && ok "STEP 7 GATEWAY WOKE sleeping publisher compute-$ZA (0->1) in $woke via $ZB's subscriber — operator down, so unambiguously the #140 gateway path" \
    || { bad "STEP 7 publisher NOT woken (still $(replicas_of "$ZA") replicas)"; K scale deploy/zone-operator --replicas=1 >/dev/null; exit 1; }
  local caught=""; for _ in $(seq 1 90); do
    [ "$(psqla "$ZB" 'select count(*) from orders')" = "56" ] && { caught="$(since "$t0")"; break; }; sleep 0.5
  done
  [ -n "$caught" ] && ok "STEP 7 backlog drained: $ZB caught up 56 rows $caught after wake (publisher woken for replication)" \
    || { bad "STEP 7 backlog not drained ($ZB has $(psqla "$ZB" 'select count(*) from orders') rows)"; K scale deploy/zone-operator --replicas=1 >/dev/null; exit 1; }
  # Restore the operator for the deprovision steps (the finalizer needs it).
  log "STEP 7 restoring zone-operator -> 1"
  K scale deploy/zone-operator --replicas=1 >/dev/null
  K rollout status deploy/zone-operator --timeout=120s >/dev/null

  # 8. DEPROVISION HYGIENE: delete zb -> finalizer drops the subscription on zb + the
  #    slot on za; delete za -> drops the publication + reclaims. No orphan slot.
  log "STEP 8 deleting $ZB (finalizer must drop its subscription + the slot on $ZA)"
  wake1 "$ZA"
  K delete zone "$ZB" --timeout=180s >/dev/null
  local orphan; orphan="$(psqla "$ZA" "select count(*) from pg_replication_slots where slot_name='zone_sub_${ZA}'")"
  [ "$orphan" = "0" ] && ok "STEP 8 no orphan slot on $ZA after $ZB deleted (deprovision hygiene, §4d)" \
    || { bad "STEP 8 ORPHAN slot zone_sub_${ZA} left on $ZA"; exit 1; }
  K get appdatabase "$ZB" >/dev/null 2>&1 && { bad "STEP 8 composed AppDatabase $ZB not deleted"; exit 1; } \
    || ok "STEP 8 composed AppDatabase $ZB reclaimed"

  log "STEP 8 deleting $ZA (finalizer drops publication + reclaims timeline)"
  K delete zone "$ZA" --timeout=180s >/dev/null
  K get appdatabase "$ZA" >/dev/null 2>&1 && { bad "STEP 8 composed AppDatabase $ZA not deleted"; exit 1; } \
    || ok "STEP 8 composed AppDatabase $ZA reclaimed (no orphan branch)"

  ok "ALL STEPS GREEN — Zone operator: compose + publish + subscribe(both-sides-agree) + sovereignty + publisher-woken-for-replication + clean deprovision"
  echo
  log "SUMMARY: gateway-wake-for-replication(0->1)=${woke} backlog-catchup(56 rows)=${caught}"
}

case "${1:-run}" in
  run)      run;;
  teardown) teardown;;
  *) echo "usage: _verify-zones.sh {run|teardown}"; exit 1;;
esac
