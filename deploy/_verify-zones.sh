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
  K delete job zbad-phasecheck --ignore-not-found >/dev/null 2>&1 || true
  K delete zone zbadfail --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
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

  # 6b. SCALE-TO-ZERO REGRESSION GUARD (the #145 invariant, WITH the operator RUNNING).
  #     The re-sync health poll must NEVER force-wake a settled healthy publisher. Sleep
  #     the subscriber (its walreceiver releases $ZA), sleep $ZA, and — with the operator
  #     up 1/1 and reconciling every 15s — assert $ZA stays at 0 replicas for 60s. If the
  #     poll re-read a healthy peer's slot each tick it would wake $ZA; it must not.
  log "STEP 6b REGRESSION GUARD: operator UP — a Ready+healthy publisher must rest at 0 for 60s"
  [ "$(K get deploy zone-operator -o jsonpath='{.status.readyReplicas}')" = "1" ] \
    || { bad "STEP 6b zone-operator not 1/1 — cannot prove the no-force-wake guard"; exit 1; }
  sleep0 "$ZB"; sleep0 "$ZA"
  local rewoke=""
  for _ in $(seq 1 12); do
    local ra; ra="$(replicas_of "$ZA")"
    [ "$ra" != "0" ] && { rewoke="$ra"; break; }
    sleep 5
  done
  [ -z "$rewoke" ] \
    && ok "STEP 6b publisher compute-$ZA rested at 0 for 60s with the operator RUNNING — poll does NOT force-wake a healthy peer (#145 not reintroduced)" \
    || { bad "STEP 6b compute-$ZA re-woke to $rewoke replicas with the operator up — the health poll is force-waking a healthy peer (#145 REGRESSION)"; K logs deploy/zone-operator --tail=30; exit 1; }

  # 7. PUBLISHER-WOKEN-FOR-REPLICATION (the #140 mechanism, end-to-end). Sleep the
  #    subscriber (walreceiver disconnects), backlog the publisher, sleep the publisher
  #    to ZERO, then wake ONLY the subscriber — its walreceiver connects THROUGH the
  #    gateway, which wakes the sleeping publisher. We never scale the publisher.
  sleep0 "$ZB"
  wake1 "$ZA" # STEP 6b left $ZA asleep; wake it to write the backlog (then sleep it below)
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

  # 7b. RE-SYNC ACTUATOR (ADR-0007 §4a). Invalidate $ZA's slot (tiny max_slot_wal_keep_size
  #     + WAL while the subscriber sleeps → wal_status=lost). The RUNNING operator must
  #     detect it (peer awake), flip $ZB's subscription to a truthful needs_resync, and
  #     AUTO re-sync (DROP+CREATE SUBSCRIPTION copy_data) — restoring streaming with a
  #     fresh slot and a matching checksum. Fill WAL via an UNpublished table so the
  #     re-copy stays cheap and orders counts stay comparable.
  log "STEP 7b RE-SYNC ACTUATOR: invalidate $ZA's slot; operator must flip needs_resync -> auto re-sync"
  wake1 "$ZA"; wake1 "$ZB"
  psqla_f "$ZA" <<SQL
CREATE TABLE IF NOT EXISTS wal_filler(id serial primary key, payload text);
SQL
  sleep0 "$ZB" # subscriber asleep -> its slot on $ZA goes inactive and starts to lag
  psqla "$ZA" "ALTER SYSTEM SET max_slot_wal_keep_size='1MB'" >/dev/null
  psqla "$ZA" "SELECT pg_reload_conf()" >/dev/null
  local ws=""
  for _ in $(seq 1 40); do
    psqla "$ZA" "INSERT INTO wal_filler(payload) SELECT repeat('x',1000) FROM generate_series(1,20000) g" >/dev/null
    psqla "$ZA" "SELECT pg_switch_wal()" >/dev/null 2>&1 || true
    ws="$(psqla "$ZA" "select coalesce(wal_status,'') from pg_replication_slots where slot_name='zone_sub_${ZA}'" 2>/dev/null)"
    case "$ws" in lost|unreserved) break;; esac
    sleep 1
  done
  { [ "$ws" = "lost" ] || [ "$ws" = "unreserved" ]; } \
    && ok "STEP 7b slot zone_sub_${ZA} INVALIDATED on $ZA (wal_status=$ws) — the #143 degrade" \
    || { bad "STEP 7b slot never invalidated (wal_status=$ws)"; exit 1; }
  # restore the real bound so the fresh slot behaves normally
  psqla "$ZA" "ALTER SYSTEM SET max_slot_wal_keep_size='512MB'" >/dev/null
  psqla "$ZA" "SELECT pg_reload_conf()" >/dev/null
  # The operator polls every 15s: peer $ZA must be AWAKE for detection (ComputeAwake gate),
  # so keep it awake while we wait for the auto re-sync to land.
  local seen_nr="" healed="" freshws=""
  for _ in $(seq 1 60); do
    wake1 "$ZA" >/dev/null 2>&1 || true
    [ "$(sub_state "$ZB")" = "needs_resync" ] && seen_nr=1
    freshws="$(psqla "$ZA" "select coalesce(wal_status,'(none)') from pg_replication_slots where slot_name='zone_sub_${ZA}'" 2>/dev/null)"
    if [ "$(sub_state "$ZB")" = "streaming" ] && [ "$freshws" != "lost" ] && [ "$freshws" != "unreserved" ] && [ "$freshws" != "(none)" ]; then healed=1; break; fi
    sleep 2
  done
  [ -n "$healed" ] \
    && ok "STEP 7b operator AUTO RE-SYNCED: $ZB subscription streaming again on a FRESH slot (wal_status=$freshws; observed needs_resync=${seen_nr:-not-caught})" \
    || { bad "STEP 7b operator did NOT re-sync (sub_state=$(sub_state "$ZB"), slot wal_status=$freshws)"; K logs deploy/zone-operator --tail=40; exit 1; }
  # CHECKSUM: a fresh insert on $ZA must replicate (streaming truly restored) + counts match.
  wake1 "$ZB"
  psqla "$ZA" "INSERT INTO orders(item) VALUES('post-resync-canary')" >/dev/null
  local canary=""
  for _ in $(seq 1 60); do canary="$(psqla "$ZB" "select count(*) from orders where item='post-resync-canary'" 2>/dev/null)"; [ "$canary" = "1" ] && break; sleep 1; done
  [ "$canary" = "1" ] && ok "STEP 7b post-resync live insert replicated $ZA -> $ZB (streaming restored)" \
    || { bad "STEP 7b post-resync replication broken (canary not on $ZB)"; exit 1; }
  local cza czb; cza="$(psqla "$ZA" 'select count(*) from orders')"; czb="$(psqla "$ZB" 'select count(*) from orders')"
  [ "$cza" = "$czb" ] && ok "STEP 7b CHECKSUM: orders row counts match after re-sync ($ZA=$cza $ZB=$czb)" \
    || { bad "STEP 7b row-count mismatch after re-sync ($ZA=$cza $ZB=$czb)"; exit 1; }

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

# ALERTING PROOF (SRE F2): a Failed zone must fire ZoneDegradedOrFailed. Self-contained
# + cheap — an INVALID-spec zone (self-dependency) reaches phase=Failed in validate()
# WITHOUT composing an AppDatabase (no branch/compute), then the zone-phase-monitor Job
# must FAIL (exit 1 -> Job Failed -> the kube_job_owner alert fires + PAGES).
alerts() {
  log "ALERTING PROOF: a Failed zone must fail the zone-phase-monitor Job (-> ZoneDegradedOrFailed page)"
  K apply -f "$HERE/86-zone-crd.yaml" >/dev/null
  K apply -f "$HERE/64-zone-status-monitor.yaml" >/dev/null
  cat <<YAML | K apply -f - >/dev/null
apiVersion: zones.scale-zero-pg.dev/v1alpha1
kind: Zone
metadata: { name: zbadfail }
spec:
  dataDependencies:
    - { fromZone: zbadfail, tables: [x], mode: replicate }
YAML
  local ph=""; for _ in $(seq 1 30); do ph="$(zone_phase zbadfail)"; [ "$ph" = "Failed" ] && break; sleep 2; done
  [ "$ph" = "Failed" ] \
    && ok "zbadfail reached phase=Failed (invalid self-dependency spec — no compose)" \
    || { bad "zbadfail not Failed (phase=$ph)"; K delete zone zbadfail --ignore-not-found >/dev/null 2>&1; exit 1; }
  K delete job zbad-phasecheck --ignore-not-found >/dev/null 2>&1 || true
  K create job zbad-phasecheck --from=cronjob/zone-phase-monitor >/dev/null
  local jr=""
  for _ in $(seq 1 60); do
    [ "$(K get job zbad-phasecheck -o jsonpath='{.status.failed}' 2>/dev/null)" = "1" ] && { jr=fail; break; }
    [ "$(K get job zbad-phasecheck -o jsonpath='{.status.succeeded}' 2>/dev/null)" = "1" ] && { jr=ok; break; }
    sleep 2
  done
  [ "$jr" = "fail" ] \
    && ok "ALERTING: zone-phase-monitor Job FAILED on the Failed zone -> ZoneDegradedOrFailed PAGES (kube_job_owner join)" \
    || { bad "ALERTING: zone-phase-monitor did not fail (jr=$jr) — a Failed zone would NOT page"; K logs job/zbad-phasecheck 2>/dev/null | tail -20; }
  log "ALERTING cleanup: removing zbadfail + the on-demand Job"
  K delete job zbad-phasecheck --ignore-not-found >/dev/null 2>&1 || true
  K delete zone zbadfail --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
  [ "$jr" = "fail" ] && ok "ALERTING proof GREEN" || exit 1
}

case "${1:-run}" in
  run)      run;;
  alerts)   alerts;;
  teardown) teardown;;
  *) echo "usage: _verify-zones.sh {run|alerts|teardown}"; exit 1;;
esac
