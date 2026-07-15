#!/usr/bin/env bash
# _spike-logrepl.sh — REPEATABLE spike for issue #133 (zone-scaling axis 4 gate).
#
# Proves/disproves cross-branch LOGICAL REPLICATION on neon:8464 and its survival
# across scale-to-zero, end to end, against the REAL storage plane. It stands up two
# THROWAWAY per-app branch computes (spike-za = publisher/zone-a, spike-zb =
# subscriber/zone-b) via provision-app.sh, exercises pub/sub, sleeps/wakes each side,
# checks data integrity, and TEARS DOWN fully. This is a spike, not a feature: it
# NEVER touches the live plane's real apps (only its own spike-* branches).
#
# Findings written up in docs/spikes/133-logical-replication.md. Re-run to reproduce.
#
# Usage:
#   deploy/_spike-logrepl.sh run       # full spike (provision -> prove -> teardown)
#   deploy/_spike-logrepl.sh teardown  # just remove the spike-* throwaway branches
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ZA="${ZA:-spike-za}"   # zone-a: publisher
ZB="${ZB:-spike-zb}"   # zone-b: subscriber
REPL_PW="${REPL_PW:-spikerepl}"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
log() { printf '\033[36m[spike-133]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[spike-133] PASS:\033[0m %s\n' "$*"; }
bad() { printf '\033[31m[spike-133] FAIL:\033[0m %s\n' "$*" >&2; }

pod_of() { K get pod -l app=compute-"$1" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }
# psql over pod-local loopback as cloud_admin (loopback is TRUSTed; cloud_admin is
# rejected over TCP by the #112 pg_hba hardening — so admin SQL must be in-pod).
psqla() { local app="$1"; shift; K exec -i "$(pod_of "$app")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc "$@"; }
psqla_f() { local app="$1"; K exec -i "$(pod_of "$app")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1; }
sleep0() { log "scaling compute-$1 -> 0"; K scale deploy/compute-"$1" --replicas=0 >/dev/null
           K wait --for=delete pod -l app=compute-"$1" --timeout=90s >/dev/null 2>&1 || sleep 5; }
wake1()  { K scale deploy/compute-"$1" --replicas=1 >/dev/null
           K rollout status deploy/compute-"$1" --timeout=120s >/dev/null; }
now() { python3 -c 'import time;print(time.time())'; }

teardown() {
  log "TEARDOWN: destroying throwaway branches $ZA / $ZB (reclaims timelines + WAL)"
  "$HERE/provision-app.sh" destroy "$ZA" 2>&1 | tail -2 || true
  "$HERE/provision-app.sh" destroy "$ZB" 2>&1 | tail -2 || true
  ok "teardown complete (no spike-* branch or WAL left behind)"
}

run() {
  trap teardown EXIT
  # 0. Provision two throwaway branch computes, awake for setup.
  log "provisioning publisher $ZA (zone-a) + subscriber $ZB (zone-b)"
  "$HERE/provision-app.sh" create "$ZA" --replicas 1 >/dev/null
  "$HERE/provision-app.sh" create "$ZB" --replicas 1 >/dev/null
  K rollout status deploy/compute-"$ZA" --timeout=120s >/dev/null
  K rollout status deploy/compute-"$ZB" --timeout=120s >/dev/null

  # STEP 1 — wal_level bootstraps to logical (set in deploy/compute-files/config.json).
  local wl; wl="$(psqla "$ZA" 'show wal_level')"
  [ "$wl" = "logical" ] && ok "STEP 1 wal_level=logical (as booted)" || { bad "STEP 1 wal_level=$wl (need logical)"; exit 1; }

  # STEP 2 — publisher: table + REPLICATION role + PUBLICATION.
  psqla_f "$ZA" <<SQL
DROP TABLE IF EXISTS zone_events;
CREATE TABLE zone_events(id serial primary key, zone text, payload text, created_at timestamptz default now());
INSERT INTO zone_events(zone,payload) SELECT 'zone-a','seed-'||g FROM generate_series(1,5) g;
DROP ROLE IF EXISTS spike_repl;
CREATE ROLE spike_repl WITH LOGIN REPLICATION PASSWORD '${REPL_PW}';
GRANT USAGE ON SCHEMA public TO spike_repl; GRANT SELECT ON zone_events TO spike_repl;
CREATE PUBLICATION zone_pub FOR TABLE zone_events;
SQL
  ok "STEP 2 PUBLICATION zone_pub created on $ZA (5 seed rows)"

  # STEP 3 — subscriber: matching table + SUBSCRIPTION to zone-a's compute Service.
  local conn="host=compute-${ZA}.${NS}.svc port=55433 user=spike_repl password=${REPL_PW} dbname=postgres"
  psqla_f "$ZB" <<SQL
CREATE TABLE IF NOT EXISTS zone_events(id serial primary key, zone text, payload text, created_at timestamptz default now());
TRUNCATE zone_events;
DROP SUBSCRIPTION IF EXISTS zone_sub;
CREATE SUBSCRIPTION zone_sub CONNECTION '${conn}' PUBLICATION zone_pub;
SQL
  local n=""; for _ in $(seq 1 60); do n="$(psqla "$ZB" 'select count(*) from zone_events')"; [ "$n" = "5" ] && break; sleep 0.3; done
  [ "$n" = "5" ] && ok "STEP 3 initial copy replicated 5 rows to $ZB" || { bad "STEP 3 initial copy: $ZB has $n rows"; exit 1; }

  # STEP 3b — live incremental lag.
  psqla "$ZA" "INSERT INTO zone_events(zone,payload) VALUES('zone-a','lagmark')" >/dev/null
  local s; s="$(now)"
  for _ in $(seq 1 60); do [ "$(psqla "$ZB" "select count(*) from zone_events where payload='lagmark'")" = "1" ] && break; sleep 0.2; done
  ok "STEP 3b live insert replicated in $(python3 -c "print(f'{$(now)-$s:.2f}s')")"

  # STEP 4a — subscriber sleeps, publisher inserts, slot pins WAL, subscriber catches up.
  sleep0 "$ZB"
  psqla "$ZA" "INSERT INTO zone_events(zone,payload) SELECT 'zone-a','asleep-'||g FROM generate_series(1,1000) g" >/dev/null
  log "slot WAL retention while subscriber asleep: $(psqla "$ZA" "select active||' '||pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)) from pg_replication_slots where slot_name='zone_sub'")"
  s="$(now)"; wake1 "$ZB"
  for _ in $(seq 1 80); do [ "$(psqla "$ZB" 'select count(*) from zone_events')" = "1006" ] && break; sleep 0.3; done
  ok "STEP 4a subscriber-asleep: 1000-row backlog caught up in $(python3 -c "print(f'{$(now)-$s:.2f}s')") from wake"

  # STEP 4b — WORST CASE: subscriber behind AND publisher scales to zero (drops local
  # pg_wal). Proves the pinned backlog WAL survives via the durable safekeeper.
  sleep0 "$ZB"
  psqla "$ZA" "INSERT INTO zone_events(zone,payload) SELECT 'zone-a','backlog-'||g FROM generate_series(1,500) g" >/dev/null
  sleep0 "$ZA"; wake1 "$ZA"
  local surv; surv="$(psqla "$ZA" "select count(*) from pg_replication_slots where slot_name='zone_sub'")"
  [ "$surv" = "1" ] && ok "STEP 4b logical slot SURVIVED publisher scale-to-zero" || { bad "STEP 4b slot LOST after publisher restart"; exit 1; }
  s="$(now)"; wake1 "$ZB"
  for _ in $(seq 1 80); do [ "$(psqla "$ZB" "select count(*) from zone_events where payload like 'backlog-%'")" = "500" ] && break; sleep 0.3; done
  ok "STEP 4b worst-case backlog (500 rows) caught up in $(python3 -c "print(f'{$(now)-$s:.2f}s')") from subscriber wake"

  # STEP 5 — data integrity: ordered md5 must match across the zones.
  local ck="select md5(string_agg(id||':'||zone||':'||payload,',' order by id))||' '||count(*) from zone_events"
  local ma mb; ma="$(psqla "$ZA" "$ck")"; mb="$(psqla "$ZB" "$ck")"
  log "zone-a: $ma"; log "zone-b: $mb"
  [ "$ma" = "$mb" ] && ok "STEP 5 data integrity: zone-a == zone-b (zero divergence)" \
    || { bad "STEP 5 DIVERGENCE: zone-a != zone-b"; exit 1; }

  ok "ALL STEPS GREEN — logical replication viable on neon:8464 and survives scale-to-zero"
}

case "${1:-run}" in
  run)      run;;
  teardown) teardown;;
  *) echo "usage: _spike-logrepl.sh {run|teardown}"; exit 1;;
esac
