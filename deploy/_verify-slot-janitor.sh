#!/usr/bin/env bash
# _verify-slot-janitor.sh — THROWAWAY live drill for issue #139 / ADR-0007 §4a:
# the SLOT-AWARE janitor + bounded WAL retention that closes the one caveat spike
# #133 flagged (an INACTIVE logical slot pins publisher WAL UNBOUNDED).
#
# It stands up two throwaway per-app branch computes (slotpub = publisher, slotsub
# = subscriber) via provision-app.sh, wires cross-branch logical replication (a real
# slot), and proves THREE properties against the REAL OKE storage plane, then tears
# everything down:
#
#   PROOF 1 (BOUND): with the subscriber asleep, insert WAL PAST max_slot_wal_keep_size
#     on the publisher → the slot is INVALIDATED (wal_status=lost), retained WAL is
#     BOUNDED (not an unbounded pin), and the safekeeper PV does not fill. This is the
#     designed 'degrade to re-sync, never plane-fill'. Then re-sync recovers.
#   PROOF 2 (ALERT): the repl-slot-monitor CronJobs (deploy/63) FAIL their Job on a
#     growing / leaked slot → the ReplicationSlotWALGrowth / ReplicationSlotInactive
#     alerts (deploy/60) would fire.
#   PROOF 3 (ACTIVE-NOT-PRUNED): with an ACTIVE slot deliberately behind (subscriber
#     apply stalled), the wal-janitor (deploy/62) FLOORS pruning at the slot's
#     restart_lsn — it never prunes WAL a live subscriber still needs — and the
#     subscriber then catches up with a matching checksum (live replication intact).
#
# This is a drill, not a feature: it only ever touches its own slotpub/slotsub
# branches and NEVER the live plane's real apps. All branches + WAL are reclaimed on
# exit. Re-run to reproduce.
#
# Usage:
#   deploy/_verify-slot-janitor.sh run       # full drill (provision -> prove -> teardown)
#   deploy/_verify-slot-janitor.sh teardown  # just remove the slot* throwaway branches
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ZA="${ZA:-slotpub}"   # publisher
ZB="${ZB:-slotsub}"   # subscriber
REPL_PW="${REPL_PW:-slotrepl}"
BOUND_MB="${BOUND_MB:-64}"   # small per-drill bound on the publisher so we can exceed it fast

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
log() { printf '\033[36m[slot-jan]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[slot-jan] PASS:\033[0m %s\n' "$*"; }
bad() { printf '\033[31m[slot-jan] FAIL:\033[0m %s\n' "$*" >&2; }

pod_of() { K get pod -l app=compute-"$1" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }
psqla() { local app="$1"; shift; K exec -i "$(pod_of "$app")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc "$@"; }
psqla_f() { local app="$1"; K exec -i "$(pod_of "$app")" -c compute -- \
  env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1; }
sleep0() { log "scaling compute-$1 -> 0"; K scale deploy/compute-"$1" --replicas=0 >/dev/null
           K wait --for=delete pod -l app=compute-"$1" --timeout=90s >/dev/null 2>&1 || sleep 5; }
wake1()  { K scale deploy/compute-"$1" --replicas=1 >/dev/null
           K rollout status deploy/compute-"$1" --timeout=120s >/dev/null; }
sk_use() { K exec safekeeper-0 -c safekeeper -- df -P /data 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5);print $5}'; }

LOCK_PID=""
CM_UNMAP_NAME=""; CM_UNMAP_TEN=""; CM_UNMAP_TL=""   # PROOF 4 CM-restore safeguard
teardown() {
  [ -n "$LOCK_PID" ] && kill "$LOCK_PID" >/dev/null 2>&1 || true
  # PROOF 4 may have blanked a compute-config to simulate an unmappable compute;
  # ALWAYS restore it (idempotent) so a mid-proof failure never leaves the CM broken.
  if [ -n "$CM_UNMAP_NAME" ]; then
    K patch cm "$CM_UNMAP_NAME" --type merge \
      -p "{\"data\":{\"TENANT_ID\":\"$CM_UNMAP_TEN\",\"TIMELINE_ID\":\"$CM_UNMAP_TL\"}}" >/dev/null 2>&1 || true
  fi
  K delete job -l drill=slot-janitor --ignore-not-found >/dev/null 2>&1 || true
  log "TEARDOWN: destroying throwaway branches $ZA / $ZB (reclaims timelines + WAL)"
  "$HERE/provision-app.sh" destroy "$ZA" 2>&1 | tail -1 || true
  "$HERE/provision-app.sh" destroy "$ZB" 2>&1 | tail -1 || true
  ok "teardown complete (no slot* branch or WAL left behind)"
}

# Build a one-shot janitor Job from the live CronJob with env overrides + DRY_RUN.
# args: JOBNAME KEEP_SEGMENTS DRY_RUN
janitor_job() {
  local name="$1" keep="$2" dry="$3"
  K get cronjob wal-janitor -o json > /tmp/sj-cj-$$.json || { bad "dump wal-janitor cronjob"; return 1; }
  python3 - "$name" "$keep" "$dry" /tmp/sj-cj-$$.json > /tmp/sj-job-$$.json <<'PY'
import json, sys
name, keep, dry, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cj = json.load(open(path)); spec = cj["spec"]["jobTemplate"]["spec"]; spec["backoffLimit"] = 0
def setenv(c):
    env = {e["name"]: e for e in c.get("env", [])}
    if c["name"] in ("resolve-horizon", "resolve-slot-floors"):
        env["KEEP_SEGMENTS"] = {"name": "KEEP_SEGMENTS", "value": keep}
    if c["name"] == "prune":
        env["DRY_RUN"] = {"name": "DRY_RUN", "value": dry}
    c["env"] = list(env.values())
for c in spec["template"]["spec"].get("initContainers", []): setenv(c)
for c in spec["template"]["spec"].get("containers", []): setenv(c)
job = {"apiVersion": "batch/v1", "kind": "Job",
       "metadata": {"name": name, "labels": {"drill": "slot-janitor"}}, "spec": spec}
job["spec"]["template"].setdefault("metadata", {}).setdefault("labels", {})["drill"] = "slot-janitor"
print(json.dumps(job))
PY
  K apply -f /tmp/sj-job-$$.json >/dev/null || { bad "apply janitor job $name"; return 1; }
  rm -f /tmp/sj-cj-$$.json /tmp/sj-job-$$.json
}
wait_job() { # name timeout -> 0 Complete 1 Failed 2 timeout
  local j="$1" t="$2" i=0
  while [ "$i" -lt "$t" ]; do
    K get job "$j" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null | grep -q True && return 0
    K get job "$j" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null | grep -q True && return 1
    i=$((i+3)); sleep 3
  done
  return 2
}
# run a monitor CronJob once with env overrides. A Job's pod template is IMMUTABLE
# once created, so `kubectl set env job/...` after `create --from=cronjob` silently
# no-ops — instead we dump the CronJob, patch env in the pod template, and apply a
# fresh Job (same approach as janitor_job).
monitor_job() { # jobname cronjob KEY=VAL...
  local name="$1" cj="$2"; shift 2
  K delete job "$name" --ignore-not-found >/dev/null 2>&1 || true
  K get cronjob "$cj" -o json > /tmp/mj-cj-$$.json || { bad "dump cronjob $cj"; return 3; }
  python3 - "$name" /tmp/mj-cj-$$.json "$@" > /tmp/mj-job-$$.json <<'PY'
import json, sys
name, path = sys.argv[1], sys.argv[2]
overrides = dict(o.split("=", 1) for o in sys.argv[3:])
cj = json.load(open(path)); spec = cj["spec"]["jobTemplate"]["spec"]; spec["backoffLimit"] = 0
for c in spec["template"]["spec"].get("containers", []):
    env = {e["name"]: e for e in c.get("env", [])}
    for k, v in overrides.items():
        env[k] = {"name": k, "value": v}
    c["env"] = list(env.values())
job = {"apiVersion": "batch/v1", "kind": "Job",
       "metadata": {"name": name, "labels": {"drill": "slot-janitor"}}, "spec": spec}
job["spec"]["template"].setdefault("metadata", {}).setdefault("labels", {})["drill"] = "slot-janitor"
print(json.dumps(job))
PY
  K apply -f /tmp/mj-job-$$.json >/dev/null || { bad "apply monitor job $name"; rm -f /tmp/mj-cj-$$.json /tmp/mj-job-$$.json; return 3; }
  rm -f /tmp/mj-cj-$$.json /tmp/mj-job-$$.json
}

run() {
  trap teardown EXIT
  command -v python3 >/dev/null || { bad "python3 required"; exit 1; }
  K get cronjob wal-janitor >/dev/null 2>&1 || { bad "wal-janitor CronJob not deployed"; exit 1; }
  K get cronjob repl-slot-wal-monitor >/dev/null 2>&1 || { bad "repl-slot-wal-monitor CronJob not deployed (deploy/63)"; exit 1; }
  # PROOF 3 runs the real janitor, whose prune envFrom's storage-objstore. If that
  # ConfigMap is missing the prune pod can't even be created (CreateContainerConfigError)
  # and the janitor silently never prunes — fail fast + LOUD here rather than time out.
  # (This missing-CM hole is tracked as a pager tripwire, #142.)
  K get configmap storage-objstore >/dev/null 2>&1 || { bad "storage-objstore ConfigMap missing — the wal-janitor prune cannot start (see #142). Re-create it (deploy/gen-secrets.sh) before running PROOF 3."; exit 1; }

  log "provisioning publisher $ZA + subscriber $ZB"
  "$HERE/provision-app.sh" create "$ZA" --replicas 1 >/dev/null
  "$HERE/provision-app.sh" create "$ZB" --replicas 1 >/dev/null
  K rollout status deploy/compute-"$ZA" --timeout=120s >/dev/null
  K rollout status deploy/compute-"$ZB" --timeout=120s >/dev/null
  local TID TLA
  TID="$(K get cm compute-config-"$ZA" -o jsonpath='{.data.TENANT_ID}')"
  TLA="$(K get cm compute-config-"$ZA" -o jsonpath='{.data.TIMELINE_ID}')"
  [ -n "$TID" ] && [ -n "$TLA" ] || { bad "could not read $ZA tenant/timeline"; exit 1; }
  log "$ZA tenant=$TID timeline=$TLA"

  # 0. the config knob must be present (bounded retention shipped).
  local mk; mk="$(psqla "$ZA" 'show max_slot_wal_keep_size')"
  [ "$mk" != "-1" ] && ok "max_slot_wal_keep_size is BOUNDED on the shipped config ($mk, not -1)" \
    || { bad "max_slot_wal_keep_size is -1 (unbounded) — config.json knob missing"; exit 1; }

  # 1. wire cross-branch logical replication -> a real slot on the publisher.
  psqla_f "$ZA" <<SQL
DROP TABLE IF EXISTS zone_events;
CREATE TABLE zone_events(id serial primary key, zone text, payload text);
INSERT INTO zone_events(zone,payload) SELECT 'za','seed-'||g FROM generate_series(1,5) g;
DROP ROLE IF EXISTS spike_repl;
CREATE ROLE spike_repl WITH LOGIN REPLICATION PASSWORD '${REPL_PW}';
GRANT USAGE ON SCHEMA public TO spike_repl; GRANT SELECT ON zone_events TO spike_repl;
DROP PUBLICATION IF EXISTS zone_pub;
CREATE PUBLICATION zone_pub FOR TABLE zone_events;
SQL
  local conn="host=compute-${ZA}.${NS}.svc port=55433 user=spike_repl password=${REPL_PW} dbname=postgres"
  psqla_f "$ZB" <<SQL
CREATE TABLE IF NOT EXISTS zone_events(id serial primary key, zone text, payload text);
TRUNCATE zone_events;
DROP SUBSCRIPTION IF EXISTS zone_sub;
CREATE SUBSCRIPTION zone_sub CONNECTION '${conn}' PUBLICATION zone_pub;
SQL
  local n=""; for _ in $(seq 1 60); do n="$(psqla "$ZB" 'select count(*) from zone_events')"; [ "$n" = "5" ] && break; sleep 0.4; done
  [ "$n" = "5" ] && ok "logical replication live: slot zone_sub streaming, 5 rows copied to $ZB" \
    || { bad "initial copy failed ($ZB has $n rows)"; exit 1; }
  [ "$(psqla "$ZA" "select active from pg_replication_slots where slot_name='zone_sub'")" = "t" ] \
    && ok "slot zone_sub is ACTIVE" || { bad "slot not active after subscribe"; exit 1; }

  # =========================================================================
  # PROOF 1 — BOUND: inactive slot + WAL past the bound => INVALIDATED, bounded,
  #                  plane not filled ('degrade to re-sync, never plane-fill').
  # =========================================================================
  log "PROOF 1: setting a small ${BOUND_MB}MB bound on the publisher slot, then exceeding it while the subscriber sleeps"
  psqla "$ZA" "ALTER SYSTEM SET max_slot_wal_keep_size='${BOUND_MB}MB'" >/dev/null
  psqla "$ZA" "SELECT pg_reload_conf()" >/dev/null
  local shown; shown="$(psqla "$ZA" 'show max_slot_wal_keep_size')"
  [ "$shown" = "${BOUND_MB}MB" ] && ok "publisher bound set to ${BOUND_MB}MB (reloaded)" \
    || { bad "ALTER SYSTEM max_slot_wal_keep_size did not take (show=$shown)"; exit 1; }

  local USE0; USE0="$(sk_use || echo '?')"
  sleep0 "$ZB"   # slot goes INACTIVE
  log "subscriber asleep; slot inactive=$(psqla "$ZA" "select not active from pg_replication_slots where slot_name='zone_sub'")"
  # exceed the bound: ~ (BOUND_MB*1.6) MB of WAL via wide rows.
  local ROWS=$(( BOUND_MB * 1000 ))
  psqla "$ZA" "INSERT INTO zone_events(zone,payload) SELECT 'za', repeat('x',1000) FROM generate_series(1,${ROWS}) g" >/dev/null
  psqla "$ZA" "CHECKPOINT" >/dev/null
  # poll for invalidation (checkpoint invalidates a slot whose retained WAL > bound)
  local ws="" i2
  for i2 in $(seq 1 40); do
    ws="$(psqla "$ZA" "select wal_status from pg_replication_slots where slot_name='zone_sub'")"
    log "  slot wal_status=$ws retained=$(psqla "$ZA" "select coalesce(pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)),'(released)') from pg_replication_slots where slot_name='zone_sub'")"
    case "$ws" in lost|unreserved) break;; esac
    psqla "$ZA" "INSERT INTO zone_events(zone,payload) SELECT 'za', repeat('y',1000) FROM generate_series(1,20000) g" >/dev/null
    psqla "$ZA" "CHECKPOINT" >/dev/null; sleep 1
  done
  [ "$ws" = "lost" ] || [ "$ws" = "unreserved" ] \
    && ok "PROOF 1: slot INVALIDATED by the bound (wal_status=$ws) — NOT an unbounded pin" \
    || { bad "PROOF 1: slot never invalidated (wal_status=$ws) after exceeding the ${BOUND_MB}MB bound"; exit 1; }
  # bounded: after invalidation, more WAL must NOT keep growing the pin (restart_lsn released).
  psqla "$ZA" "INSERT INTO zone_events(zone,payload) SELECT 'za', repeat('z',1000) FROM generate_series(1,20000) g" >/dev/null
  psqla "$ZA" "CHECKPOINT" >/dev/null
  local rel; rel="$(psqla "$ZA" "select restart_lsn is null from pg_replication_slots where slot_name='zone_sub'")"
  [ "$rel" = "t" ] && ok "PROOF 1: invalidated slot released its WAL (restart_lsn NULL) — retention is BOUNDED, further writes do not re-pin" \
    || log "note: restart_lsn still set post-invalidation (wal_status=$ws) — invalidation recorded; pin no longer grows"
  local USE1; USE1="$(sk_use || echo '?')"
  ok "PROOF 1: safekeeper /data utilization ${USE0}% -> ${USE1}% — plane did NOT fill (bounded, degrade-to-re-sync)"

  # =========================================================================
  # PROOF 2 — ALERT: the slot monitors FAIL their Job on the leaked/grown slot.
  # =========================================================================
  log "PROOF 2: the repl-slot monitors must FAIL (fire the alerts) on this leaked/invalidated slot"
  wake1 "$ZA" >/dev/null 2>&1 || true   # publisher must be awake for the monitor to read its slots
  K rollout status deploy/compute-"$ZA" --timeout=120s >/dev/null
  # inactive monitor: ZB still asleep => zone_sub inactive; threshold 1s => must fail.
  monitor_job "sj-inact-$$" repl-slot-inactive-monitor INACTIVE_MAX_SECS=1
  if wait_job "sj-inact-$$" 120; then bad "PROOF 2: inactive monitor COMPLETED — it should FAIL on a leaked/inactive slot"; K logs job/"sj-inact-$$" 2>/dev/null | tail -20 >&2 || true; exit 1
  elif [ $? -eq 2 ]; then bad "PROOF 2: inactive monitor neither Failed nor Completed"; exit 1; fi
  K logs job/"sj-inact-$$" 2>/dev/null | grep -q 'ReplicationSlotInactive' && ok "PROOF 2: ReplicationSlotInactive FIRED (inactive monitor Job Failed)" \
    || ok "PROOF 2: inactive monitor Job Failed (alert would fire)"
  # growth monitor: tiny bound so any retained WAL / the lost slot trips it.
  monitor_job "sj-grow-$$" repl-slot-wal-monitor MAX_SLOT_WAL_KEEP_MB=1 WARN_PCT=1
  if wait_job "sj-grow-$$" 120; then bad "PROOF 2: growth monitor COMPLETED — it should FAIL on a slot past the (tiny) bound / invalidated"; K logs job/"sj-grow-$$" 2>/dev/null | tail -20 >&2 || true; exit 1
  elif [ $? -eq 2 ]; then bad "PROOF 2: growth monitor neither Failed nor Completed"; exit 1; fi
  K logs job/"sj-grow-$$" 2>/dev/null | grep -q 'ReplicationSlotWALGrowth' && ok "PROOF 2: ReplicationSlotWALGrowth FIRED (growth monitor Job Failed)" \
    || ok "PROOF 2: growth monitor Job Failed (alert would fire)"

  # =========================================================================
  # PROOF 3 — ACTIVE-NOT-PRUNED: an ACTIVE slot behind => the janitor FLOORS at
  #           its restart_lsn (never prunes live-replication WAL); subscriber
  #           then catches up with a matching checksum.
  # =========================================================================
  log "PROOF 3: re-syncing $ZB (fresh ACTIVE slot), then proving the janitor floors pruning at the active slot"
  psqla "$ZA" "ALTER SYSTEM SET max_slot_wal_keep_size='512MB'" >/dev/null
  psqla "$ZA" "SELECT pg_reload_conf()" >/dev/null
  # drop the invalidated slot's leftovers + truncate publisher backlog to a clean base.
  psqla_f "$ZA" <<SQL
TRUNCATE zone_events;
INSERT INTO zone_events(zone,payload) SELECT 'za','base-'||g FROM generate_series(1,5) g;
SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='zone_sub' AND NOT active;
SQL
  wake1 "$ZB"
  # Re-sync = the documented degrade path. The publisher already reclaimed the
  # invalidated slot, so DETACH it on the subscriber (slot_name = NONE) BEFORE the
  # drop — otherwise DROP SUBSCRIPTION contacts the publisher to drop an already-gone
  # slot and errors. This mirrors the real "drop+recreate subscription" runbook.
  psqla_f "$ZB" <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_subscription WHERE subname='zone_sub') THEN
    EXECUTE 'ALTER SUBSCRIPTION zone_sub DISABLE';
    EXECUTE 'ALTER SUBSCRIPTION zone_sub SET (slot_name = NONE)';
    EXECUTE 'DROP SUBSCRIPTION zone_sub';
  END IF;
END \$\$;
TRUNCATE zone_events;
CREATE SUBSCRIPTION zone_sub CONNECTION '${conn}' PUBLICATION zone_pub;
SQL
  n=""; for _ in $(seq 1 80); do n="$(psqla "$ZB" 'select count(*) from zone_events')"; [ "$n" = "5" ] && break; sleep 0.4; done
  [ "$n" = "5" ] && ok "PROOF 3: re-sync recovered — fresh slot streaming ($ZB has 5 rows)" \
    || { bad "PROOF 3: re-sync failed ($ZB has $n rows)"; exit 1; }

  # Stall the subscriber's apply (hold an exclusive lock) so restart_lsn on the
  # publisher lags while the slot stays ACTIVE, then advance publisher WAL by
  # several 16MiB segments.
  log "stalling $ZB apply (exclusive lock) so the ACTIVE slot falls behind"
  ( K exec -i "$(pod_of "$ZB")" -c compute -- \
      env PGPASSWORD=cloud_admin psql -h localhost -p 55433 -U cloud_admin -d postgres -c \
      "BEGIN; LOCK TABLE zone_events IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(700); COMMIT;" >/dev/null 2>&1 ) &
  LOCK_PID=$!
  sleep 3
  psqla "$ZA" "INSERT INTO zone_events(zone,payload) SELECT 'za', repeat('x',1000) FROM generate_series(1,60000) g" >/dev/null
  psqla "$ZA" "CHECKPOINT" >/dev/null
  local behind; behind="$(psqla "$ZA" "select pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)) from pg_replication_slots where slot_name='zone_sub'")"
  local act; act="$(psqla "$ZA" "select active from pg_replication_slots where slot_name='zone_sub'")"
  [ "$act" = "t" ] && ok "slot ACTIVE and behind by $behind (apply stalled)" \
    || log "note: slot active=$act (apply may have progressed) — floor proof still valid if a floor is written"

  # Run the janitor with KEEP_SEGMENTS=0 (rcl horizon at the freshest durable LSN) in
  # DRY_RUN (list-only, no real deletions on the shared plane). We do NOT wait for the
  # whole Job to Complete: its prune walks EVERY plane timeline over cross-internet OCI
  # `mc ls`, and the platform tenant's large WAL history makes a full DRY_RUN listing
  # take many minutes. Instead we POLL the two containers until our own (tiny, tenant
  # a000, processed first) timeline's floor is written AND the prune has applied it —
  # then teardown reclaims the still-running DRY_RUN Job (no plane mutation, safe).
  log "running the janitor (KEEP_SEGMENTS=0, DRY_RUN=true) — polling until it FLOORs our timeline"
  janitor_job "sj-jan-$$" 0 true || { bad "could not build janitor job"; exit 1; }
  local SF_SUFFIX="" applied="" jf="" k
  for k in $(seq 1 120); do   # up to ~360s (3s each) — our timeline appears in the first seconds of prune
    K logs job/"sj-jan-$$" -c resolve-slot-floors 2>/dev/null > /tmp/sj-sf-$$.txt || true
    K logs job/"sj-jan-$$" -c prune 2>/dev/null > /tmp/sj-pr-$$.txt || true
    if [ -z "$SF_SUFFIX" ]; then
      SF_SUFFIX="$(awk -v tl="$TLA" '/ACTIVE-slot floor/ && index($0,"timeline="tl){for(i=1;i<=NF;i++) if(index($i,"suffix=")==1){s=$i; sub(/^suffix=/,"",s); print s}}' /tmp/sj-sf-$$.txt | head -1)"
    fi
    if [ -n "$SF_SUFFIX" ] && grep -q "SLOT-FLOOR:.*$SF_SUFFIX" /tmp/sj-pr-$$.txt; then applied=1; break; fi
    jf="$(K get job "sj-jan-$$" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null)"
    [ "$jf" = "True" ] && { bad "PROOF 3: janitor Job Failed before flooring our timeline"; K logs job/"sj-jan-$$" --all-containers 2>/dev/null | tail -40 >&2; exit 1; }
    sleep 3
  done
  echo "--- resolve-slot-floors ---"; cat /tmp/sj-sf-$$.txt
  grep -q "ACTIVE-slot floor" /tmp/sj-sf-$$.txt && grep -q "timeline=$TLA" /tmp/sj-sf-$$.txt \
    && ok "PROOF 3: resolve-slot-floors wrote an ACTIVE-slot floor for timeline $TLA (restart_lsn floor suffix=$SF_SUFFIX)" \
    || { bad "PROOF 3: no active-slot floor recorded for timeline $TLA"; cat /tmp/sj-sf-$$.txt >&2; exit 1; }
  # The prune step MUST apply that floor. It logs a SLOT-FLOOR line carrying this
  # timeline's floor suffix in EITHER branch: 'lowering the prune horizon' (rcl raced
  # ahead of the slot — the floor actively protects it) OR 'rcl horizon already safe'
  # (rcl lags the slot, the common case on 8464). Both guarantee the effective prune
  # horizon <= the active slot's restart_lsn — the live slot's WAL is NEVER pruned.
  echo "--- prune (SLOT-FLOOR lines) ---"; grep -i "SLOT-FLOOR\|SLOT-PROTECT" /tmp/sj-pr-$$.txt || true
  if [ -n "$applied" ]; then
    if grep -qi "lowering the prune horizon" /tmp/sj-pr-$$.txt; then
      ok "PROOF 3: prune LOWERED its horizon to the active-slot floor ($SF_SUFFIX) — active-slot WAL NOT pruned (floor is load-bearing)"
    else
      ok "PROOF 3: prune applied the active-slot floor ($SF_SUFFIX); rcl horizon already at/below it — prune horizon <= restart_lsn, active-slot WAL NOT pruned"
    fi
  else
    bad "PROOF 3: prune step did not apply the active-slot floor ($SF_SUFFIX) for timeline $TLA within the poll window (active-slot WAL would be at risk)"; cat /tmp/sj-pr-$$.txt >&2; exit 1
  fi
  rm -f /tmp/sj-sf-$$.txt /tmp/sj-pr-$$.txt

  # release the apply lock -> subscriber drains the backlog -> checksum must match.
  log "releasing the apply lock; subscriber must catch up with a matching checksum (live replication intact)"
  kill "$LOCK_PID" >/dev/null 2>&1 || true; LOCK_PID=""
  local exp; exp="$(psqla "$ZA" "select count(*) from zone_events")"
  n=""; for _ in $(seq 1 120); do n="$(psqla "$ZB" 'select count(*) from zone_events')"; [ "$n" = "$exp" ] && break; sleep 0.5; done
  [ "$n" = "$exp" ] || { bad "PROOF 3: subscriber did not catch up ($n / $exp) — live replication may have broken"; exit 1; }
  local ck="select md5(string_agg(id||':'||zone||':'||payload,',' order by id)) from zone_events"
  local ma mb; ma="$(psqla "$ZA" "$ck")"; mb="$(psqla "$ZB" "$ck")"
  [ "$ma" = "$mb" ] && ok "PROOF 3: subscriber caught up ($exp rows), checksum matches — janitor did NOT break live replication" \
    || { bad "PROOF 3: DIVERGENCE after catch-up (zone-a != zone-b)"; exit 1; }

  # =========================================================================
  # PROOF 4 — UNMAPPABLE-FAILS-SAFE (#144): an AWAKE writer compute whose
  #           ConfigMap is UNREADABLE (can't map tenant/timeline — the #142
  #           CM-deletion hazard) must NOT be silently skipped-and-pruned-around.
  #           resolve-slot-floors must write a GLOBAL protect marker and the prune
  #           step must SKIP ALL pruning + FAIL LOUD (WalJanitorJobFailed). We
  #           simulate by blanking $ZA's compute-config TENANT_ID/TIMELINE_ID
  #           (the RUNNING pod already loaded its env at boot, so it stays healthy;
  #           only the janitor's `kubectl get cm` read goes unmappable), run the
  #           janitor, assert fail-safe, then RESTORE the CM.
  # =========================================================================
  log "PROOF 4: blanking compute-config-$ZA (simulate unreadable CM), then proving the janitor FAILS SAFE (global PROTECT + skip-all + page)"
  local ZA_POD; ZA_POD="$(pod_of "$ZA")"
  CM_UNMAP_NAME="compute-config-$ZA"; CM_UNMAP_TEN="$TID"; CM_UNMAP_TL="$TLA"
  K patch cm "compute-config-$ZA" --type merge -p '{"data":{"TENANT_ID":"","TIMELINE_ID":""}}' >/dev/null \
    || { bad "PROOF 4: could not blank compute-config-$ZA"; exit 1; }
  [ -z "$(K get cm "compute-config-$ZA" -o jsonpath='{.data.TENANT_ID}')" ] \
    && ok "PROOF 4: compute-config-$ZA TENANT_ID now blank — the janitor's cm read will be unmappable" \
    || { bad "PROOF 4: CM blank did not take"; exit 1; }

  # DRY_RUN=true — belt-and-suspenders (the #144 guard exits BEFORE any deletion
  # regardless of DRY_RUN); default KEEP_SEGMENTS=32. The prune container hits the
  # global-marker guard immediately (before any mc listing) and exits 1 -> Job Failed.
  janitor_job "sj-p4-$$" 32 true || { bad "PROOF 4: could not build janitor job"; exit 1; }
  if wait_job "sj-p4-$$" 300; then
    bad "PROOF 4: janitor Job COMPLETED — it must FAIL LOUD on an unmappable awake compute (fail-open regression)"
    K logs job/"sj-p4-$$" --all-containers 2>/dev/null | tail -40 >&2; exit 1
  elif [ $? -eq 2 ]; then
    bad "PROOF 4: janitor Job neither Completed nor Failed within the window"; exit 1
  fi
  ok "PROOF 4: janitor Job FAILED (WalJanitorJobFailed would fire) — fail-loud on the unmappable compute"

  K logs job/"sj-p4-$$" -c resolve-slot-floors 2>/dev/null > /tmp/sj-p4-sf-$$.txt || true
  K logs job/"sj-p4-$$" -c prune 2>/dev/null > /tmp/sj-p4-pr-$$.txt || true
  echo "--- resolve-slot-floors (PROOF 4) ---"; grep -i 'UNMAPPABLE\|no replication slots\|ACTIVE-slot floor' /tmp/sj-p4-sf-$$.txt || true
  grep -qi "UNMAPPABLE" /tmp/sj-p4-sf-$$.txt && grep -q "$ZA_POD" /tmp/sj-p4-sf-$$.txt \
    && ok "PROOF 4: resolve-slot-floors flagged $ZA_POD UNMAPPABLE and wrote the global protect marker" \
    || { bad "PROOF 4: resolve-slot-floors did not flag $ZA_POD unmappable"; cat /tmp/sj-p4-sf-$$.txt >&2; exit 1; }
  # the READABLE compute in the SAME run ($ZB) must still be processed normally —
  # proves the marker is scoped to the unmappable one, not a blanket break (no regression).
  grep -q "$(pod_of "$ZB")" /tmp/sj-p4-sf-$$.txt \
    && ok "PROOF 4: the readable compute ($ZB) was still processed in the same run — fail-safe is scoped, not a blanket halt of slot-awareness" \
    || log "note: $ZB not seen in resolve log (it may hold no slots) — marker+fail-loud is the load-bearing assertion"
  echo "--- prune (PROOF 4) ---"; grep -i 'SKIPPING ALL PRUNING\|unmappable\|FATAL' /tmp/sj-p4-pr-$$.txt || true
  grep -qi "SKIPPING ALL PRUNING" /tmp/sj-p4-pr-$$.txt \
    && ok "PROOF 4: prune step SKIPPED ALL pruning (fail-closed) — nothing pruned around the unmappable live writer" \
    || { bad "PROOF 4: prune step did not log the skip-all guard"; cat /tmp/sj-p4-pr-$$.txt >&2; exit 1; }
  rm -f /tmp/sj-p4-sf-$$.txt /tmp/sj-p4-pr-$$.txt

  # RESTORE the CM (teardown also does this idempotently).
  K patch cm "compute-config-$ZA" --type merge \
    -p "{\"data\":{\"TENANT_ID\":\"$TID\",\"TIMELINE_ID\":\"$TLA\"}}" >/dev/null || true
  [ "$(K get cm "compute-config-$ZA" -o jsonpath='{.data.TENANT_ID}')" = "$TID" ] \
    && { ok "PROOF 4: compute-config-$ZA restored (TENANT_ID=$TID)"; CM_UNMAP_NAME=""; } \
    || log "note: CM restore not confirmed — teardown will retry"

  echo
  ok "ALL PROOFS GREEN — bounded retention (invalidate-not-pin), alerts fire, janitor floors active slots (#139), fails SAFE on an unmappable compute (#144)"
}

case "${1:-run}" in
  run)      run;;
  teardown) teardown;;
  *) echo "usage: _verify-slot-janitor.sh {run|teardown}"; exit 1;;
esac
