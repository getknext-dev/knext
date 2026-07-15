#!/usr/bin/env bash
# _verify-repl-wake.sh — LIVE drill for gateway-mediated replication-wake (v2-1,
# issue #139, ADR-0007 §4c). Proves the load-bearing claim of the zone axis:
#
#   a SLEEPING publisher (compute-<zone> at 0 replicas) is WOKEN by a subscriber's
#   walreceiver connecting THROUGH the apps-gateway — no manual scale, no warm tier
#   — and the publisher is HELD awake while the replication stream is live, then
#   becomes sleep-eligible once the subscriber disconnects.
#
# It stands up two THROWAWAY per-app branch computes (zpub = publisher, zsub =
# subscriber) via provision-app.sh, wires a SUBSCRIPTION whose CONNECTION points at
# the apps-gateway (NOT compute-zpub directly), and drives the sleep/wake dance.
# Reuses the #133 spike patterns. NEVER touches the live plane's real apps.
#
# REQUIRES the apps-gateway to run the replication-wake image (repl detection +
# repl_<zone> authz). Against an older image the repl startup is refused 28P01.
#
# Usage:
#   deploy/_verify-repl-wake.sh run       # full drill (provision -> prove -> teardown)
#   deploy/_verify-repl-wake.sh teardown  # remove the throwaway zpub/zsub branches
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg),
#      DRILL_IDLE_MS (default 15000: GW_IDLE_MS patched down for the sleep tests,
#      restored to ORIG_IDLE_MS on teardown).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ZP="${ZP:-zpub}"                 # publisher zone
ZS="${ZS:-zsub}"                 # subscriber zone
REPL_PW="${REPL_PW:-replwake}"
GW_SVC="pggw-apps.${NS}.svc"
GW_PORT="55432"
DRILL_IDLE_MS="${DRILL_IDLE_MS:-15000}"
ORIG_IDLE_MS="${ORIG_IDLE_MS:-60000}"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
log() { printf '\033[36m[repl-wake]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[repl-wake] PASS:\033[0m %s\n' "$*"; }
bad() { printf '\033[31m[repl-wake] FAIL:\033[0m %s\n' "$*" >&2; }

pod_of() { K get pod -l app=compute-"$1" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }
psqla() { local app="$1"; shift; K exec -i "$(pod_of "$app")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc "$@"; }
psqla_f() { local app="$1"; K exec -i "$(pod_of "$app")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1; }
replicas_of() { K get deploy compute-"$1" -o jsonpath='{.spec.replicas}' 2>/dev/null; }
ready_of()    { K get deploy compute-"$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null; }
sleep0() { log "scaling compute-$1 -> 0"; K scale deploy/compute-"$1" --replicas=0 >/dev/null
           K wait --for=delete pod -l app=compute-"$1" --timeout=90s >/dev/null 2>&1 || sleep 5; }
wake1()  { K scale deploy/compute-"$1" --replicas=1 >/dev/null
           K rollout status deploy/compute-"$1" --timeout=120s >/dev/null; }
now() { python3 -c 'import time;print(time.time())'; }
since() { python3 -c "print(f'{$(now)-$1:.2f}s')"; }

patch_idle() { # $1 = ms
  log "patching pggw-apps GW_IDLE_MS -> $1 for the drill (restored on teardown)"
  K set env deploy/pggw-apps GW_IDLE_MS="$1" >/dev/null
  K rollout status deploy/pggw-apps --timeout=120s >/dev/null
}

teardown() {
  log "TEARDOWN: restoring GW_IDLE_MS=$ORIG_IDLE_MS + destroying throwaway $ZP / $ZS"
  K set env deploy/pggw-apps GW_IDLE_MS="$ORIG_IDLE_MS" >/dev/null 2>&1 || true
  "$HERE/provision-app.sh" destroy "$ZP" 2>&1 | tail -1 || true
  "$HERE/provision-app.sh" destroy "$ZS" 2>&1 | tail -1 || true
  ok "teardown complete"
}

run() {
  trap teardown EXIT
  patch_idle "$DRILL_IDLE_MS"

  # 0. Provision the two throwaway branch computes, awake for setup.
  log "provisioning publisher $ZP + subscriber $ZS"
  "$HERE/provision-app.sh" create "$ZP" --replicas 1 >/dev/null
  "$HERE/provision-app.sh" create "$ZS" --replicas 1 >/dev/null
  K rollout status deploy/compute-"$ZP" --timeout=120s >/dev/null
  K rollout status deploy/compute-"$ZS" --timeout=120s >/dev/null

  # 1. Publisher: table + per-zone REPLICATION role repl_<zone> + publication.
  #    The gateway authorizes a replication startup as repl_<database> (ADR-0007
  #    §4b/§4c); logical replication (replication=database) is admitted over TCP by
  #    the compute's `host all all all md5` pg_hba catch-all (spike #133).
  psqla_f "$ZP" <<SQL
DROP TABLE IF EXISTS zone_events;
CREATE TABLE zone_events(id serial primary key, zone text, payload text);
INSERT INTO zone_events(zone,payload) SELECT 'pub','seed-'||g FROM generate_series(1,5) g;
DROP ROLE IF EXISTS repl_${ZP};
CREATE ROLE repl_${ZP} WITH LOGIN REPLICATION PASSWORD '${REPL_PW}';
GRANT USAGE ON SCHEMA public TO repl_${ZP}; GRANT SELECT ON zone_events TO repl_${ZP};
DROP PUBLICATION IF EXISTS zone_pub;
CREATE PUBLICATION zone_pub FOR TABLE zone_events;
SQL
  ok "publisher $ZP ready (publication zone_pub, role repl_${ZP})"

  # 2. Subscriber: SUBSCRIPTION whose CONNECTION points at the APPS-GATEWAY (not
  #    compute-zpub directly). This is the whole design: the walreceiver's connect
  #    is wake-on-connect-mediated. sslmode=disable -> the gateway declines SSL and
  #    pipes plaintext (front-door TLS is optional).
  local conn="host=${GW_SVC} port=${GW_PORT} user=repl_${ZP} password=${REPL_PW} dbname=${ZP} sslmode=disable"
  psqla_f "$ZS" <<SQL
DROP TABLE IF EXISTS zone_events;
CREATE TABLE zone_events(id serial primary key, zone text, payload text);
DROP SUBSCRIPTION IF EXISTS zone_sub;
CREATE SUBSCRIPTION zone_sub CONNECTION '${conn}' PUBLICATION zone_pub;
SQL
  local n=""; for _ in $(seq 1 60); do n="$(psqla "$ZS" 'select count(*) from zone_events')"; [ "$n" = "5" ] && break; sleep 0.3; done
  [ "$n" = "5" ] && ok "STEP 2 subscription via the gateway: initial COPY replicated 5 rows" \
    || { bad "STEP 2 initial copy through gateway failed ($ZS has $n rows)"; exit 1; }

  # 3. Put a backlog on the publisher, then sleep BOTH sides (subscriber first so
  #    its walreceiver disconnects, then the publisher through zero).
  sleep0 "$ZS"
  psqla "$ZP" "INSERT INTO zone_events(zone,payload) SELECT 'pub','backlog-'||g FROM generate_series(1,300) g" >/dev/null
  log "publisher slot retention while subscriber asleep: $(psqla "$ZP" "select active||' '||pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)) from pg_replication_slots where slot_name='zone_sub'")"
  sleep0 "$ZP"

  # 3a. THE PROOF — publisher at ZERO, wake ONLY the subscriber. Its walreceiver
  #     connects THROUGH the gateway; the gateway detects the replication startup,
  #     wakes compute-zpub (we NEVER scale it), and the backlog drains.
  [ "$(replicas_of "$ZP")" = "0" ] || { bad "precondition: compute-$ZP not at 0"; exit 1; }
  log "STEP 3 publisher compute-$ZP is at 0 replicas; waking ONLY the subscriber"
  local t0; t0="$(now)"
  wake1 "$ZS"
  # The gateway should scale compute-zpub 0->1 on the walreceiver's connect.
  local woke=""; for _ in $(seq 1 90); do
    [ "$(replicas_of "$ZP")" = "1" ] && { woke="$(since "$t0")"; break; }; sleep 0.3
  done
  [ -n "$woke" ] && ok "STEP 3 GATEWAY WOKE the sleeping publisher compute-$ZP (0->1) in $woke — no manual scale" \
    || { bad "STEP 3 publisher NOT woken by the subscriber through the gateway (still $(replicas_of "$ZP") replicas)"; exit 1; }

  # 3b. Backlog drains -> subscriber catches up all 305 rows.
  local caught=""; for _ in $(seq 1 90); do
    [ "$(psqla "$ZS" 'select count(*) from zone_events')" = "305" ] && { caught="$(since "$t0")"; break; }; sleep 0.3
  done
  [ -n "$caught" ] && ok "STEP 3 backlog drained: subscriber caught up 305 rows $caught after its wake (via gateway-woken publisher)" \
    || { bad "STEP 3 subscriber did not catch up (has $(psqla "$ZS" 'select count(*) from zone_events') rows)"; exit 1; }

  # 4. DON'T-SLEEP-WHILE-REPLICATING — the walreceiver holds a live stream through
  #    the gateway, so compute-zpub must stay awake across the (patched-short) idle
  #    window. Wait well past DRILL_IDLE_MS and assert it is still up.
  local wait_s=$(( DRILL_IDLE_MS/1000 + 12 ))
  log "STEP 4 holding for ${wait_s}s (> idle ${DRILL_IDLE_MS}ms) with the stream live; publisher must NOT sleep"
  # prove liveness mid-hold: a live insert must replicate while we wait
  psqla "$ZP" "INSERT INTO zone_events(zone,payload) VALUES('pub','livemark')" >/dev/null
  sleep "$wait_s"
  local rep; rep="$(replicas_of "$ZP")"
  local live; live="$(psqla "$ZS" "select count(*) from zone_events where payload='livemark'")"
  { [ "$rep" = "1" ] && [ "$live" = "1" ]; } \
    && ok "STEP 4 publisher HELD awake by the active replication stream ($rep replica) and live insert replicated" \
    || { bad "STEP 4 publisher slept while replicating (replicas=$rep) or live insert lost (live=$live)"; exit 1; }

  # 5. SLEEP-ELIGIBLE ONCE IDLE — drop the subscription (the walreceiver
  #    disconnects), and the publisher becomes eligible to sleep. After the idle
  #    window compute-zpub scales back to 0 on its own.
  log "STEP 5 dropping the subscription; publisher must become sleep-eligible"
  psqla "$ZS" "DROP SUBSCRIPTION IF EXISTS zone_sub" >/dev/null
  local slept=""; local t5; t5="$(now)"
  for _ in $(seq 1 $(( DRILL_IDLE_MS/1000 + 60 )) ); do
    r="$(replicas_of "$ZP")"; [ "$r" = "0" ] && { slept="$(since "$t5")"; break; }; sleep 1
  done
  [ -n "$slept" ] && ok "STEP 5 publisher became sleep-eligible and scaled to 0 in $slept after the stream closed" \
    || { bad "STEP 5 publisher never scaled to zero after the subscription dropped (replicas=$(replicas_of "$ZP"))"; exit 1; }

  ok "ALL STEPS GREEN — gateway-mediated replication-wake works: slept publisher woken by a subscriber, held awake while streaming, sleep-eligible once idle"
  echo
  log "SUMMARY: gateway-wake(0->1)=${woke} catch-up(305 rows)=${caught} held>${wait_s}s sleep-after-drop=${slept}"
}

case "${1:-run}" in
  run)      run;;
  teardown) teardown;;
  *) echo "usage: _verify-repl-wake.sh {run|teardown}"; exit 1;;
esac
