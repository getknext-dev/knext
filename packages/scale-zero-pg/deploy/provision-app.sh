#!/usr/bin/env bash
# provision-app.sh — branch-per-app multi-tenancy provisioning (ADR-0003, #6).
#
# Each app is a Neon TIMELINE branched from a shared TEMPLATE timeline under one
# "apps" tenant: N apps share one storage plane (pageserver + safekeeper quorum)
# but are isolated at the timeline level. Provisioning an app = one pageserver
# branch call + one rendered per-app compute (ConfigMap + Deployment + Service).
# The apps-gateway (deploy/81-apps-gateway.yaml, template mode) then wakes each
# app's compute 0<->1 on connect, keyed by the DSN database name.
#
# The safekeeper needs NOTHING for a branched timeline: a branch created on a LIVE
# pageserver has its WAL initialized by the child compute's walproposer on first
# connect (proven in Phase 1 — no skctl craft, unlike the cold-restore path). See
# docs/adr-0003-multi-tenancy.md.
#
# Usage:
#   provision-app.sh init-plane   [--schema FILE]        # one-time: apps tenant + template timeline + base schema
#   provision-app.sh create  <app> [--replicas N] \       # branch the template -> per-app compute (default replicas 0)
#     [--cpu-request 250m] [--cpu-limit 1000m] \          # per-app quota (issue #89): CPU request/limit,
#     [--mem-request 256Mi] [--mem-limit 1Gi] \           #   memory request/limit, and Postgres max_connections.
#     [--max-conns 100]                                    #   Persisted in the ConfigMap; re-create preserves them.
#   provision-app.sh render  <app> [quota flags]          # print the rendered per-app manifest (no cluster; for tests/preview)
#   provision-app.sh destroy <app> [--keep-timeline]     # remove k8s objects AND reclaim the timeline BY DEFAULT
#   provision-app.sh reclaim-orphans                     # reclaim every orphan timeline (no owning ConfigMap) + drain pending SK-deletes
#   provision-app.sh list                                # list apps tenant timelines
#   provision-app.sh fsck [--converge]                   # reconcile branches <-> ConfigMaps/Secrets (both directions); --converge re-branches dangling intents
#   provision-app.sh rotate-cred <app> [--bounce]        # rotate the app's per-app password into its Secret; --bounce applies it now
#
# DEPROVISION IS SAFE BY DEFAULT (issue #91). `destroy <app>` now DELETES the app's
# Neon timeline (pageserver + all safekeeper WAL dirs) as well as its k8s objects, so
# the obvious command leaves NO orphan branch and NO unbounded safekeeper WAL. The
# escape hatch `--keep-timeline` retains the branch for PITR/forensics but prints the
# now-orphaned timeline id + the exact reclamation command (it is your job to reclaim
# it later). A safekeeper that is down/unreachable at destroy time is RECORDED to a
# durable ConfigMap (apps-wal-reclaim-pending) so `reclaim-orphans` can finish the job
# — never silently swallowed (was best-effort `|| true`). `reclaim-orphans` is the
# scheduled reclamation drill (docs/operations.md): it reclaims any branch with no
# owning ConfigMap and drains recorded SK-delete failures — closing the leak the
# wal-janitor only WARNs on (issues #87/#90).
#
# Env: KCTX (kube context, default context-ckmva7v7zvq), NS (default scale-zero-pg).
#
# Tenant security (issue #74): each app gets a per-app role app_<app> with a
# per-app md5 password, minted here into a Secret (app-db-<app>, mirrors the knext
# DATABASE_URL contract) and applied to the app's compute spec every boot by
# compute_ctl. The apps-gateway refuses any (user,database) pair that is not
# app_<db>/<db>, so knowing one app's DSN never grants access to another and
# cloud_admin cannot route through the apps-gateway. Data isolation is the Neon
# timeline branch; the credential is authentication.
#
# Crash-safety (issue #76): the per-app ConfigMap (which records TIMELINE_ID, the
# only durable owner of the branch) is applied BEFORE the pageserver branch call,
# so a crash between the two leaves NO orphan — re-running `create` reads the id
# back and converges. `fsck` surfaces any pre-existing orphan branches.
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"

APPS_TENANT="${APPS_TENANT:-a0000000000000000000000000000001}"
TEMPLATE_TL="${TEMPLATE_TL:-a0000000000000000000000000000010}"
PG_VERSION="${PG_VERSION:-17}"
APP_ROLE_PREFIX="${APP_ROLE_PREFIX:-app_}" # must match the gateway's GW_APP_ROLE_PREFIX

# System names that must NEVER be provisioned as apps: they route to non-app
# computes (the shared template / warm / RO lanes). Kept in lock-step with the
# apps-gateway's GW_RESERVED_SYSTEMS (deploy/81-apps-gateway.yaml).
RESERVED_NAMES="${RESERVED_NAMES:-tmpl warm ro}"

# Per-app quota defaults (issue #89, tenant quotas). Each app's compute gets a CPU
# request+limit, a memory request+limit, and a Postgres max_connections cap so one
# runaway tenant cannot starve the shared node (CPU/mem) or open unbounded backends
# (connections). Overridable per-app on `create` (--cpu-request/--cpu-limit/
# --mem-request/--mem-limit/--max-conns) and persisted in the app's ConfigMap so an
# idempotent re-`create` / `fsck --converge` preserves them (readback below). A CPU
# LIMIT is now rendered (was absent) — the noisy-neighbour bound ADR-0003 lacked.
DEF_CPU_REQUEST="${DEF_CPU_REQUEST:-250m}"
DEF_CPU_LIMIT="${DEF_CPU_LIMIT:-1000m}"
DEF_MEM_REQUEST="${DEF_MEM_REQUEST:-256Mi}"
DEF_MEM_LIMIT="${DEF_MEM_LIMIT:-1Gi}"
DEF_MAX_CONNS="${DEF_MAX_CONNS:-100}" # matches the shared compute default (config.json)

SK_REPLICAS="${SK_REPLICAS:-3}" # safekeeper StatefulSet size (52-safekeeper.yaml)
# Durable record of safekeeper timeline-DELETEs that failed (a safekeeper down at
# destroy time). `reclaim-orphans` drains it; nothing is silently swallowed (#91).
RECLAIM_CM="${RECLAIM_CM:-apps-wal-reclaim-pending}"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
# All pageserver mgmt calls go in-pod (port 9898); host curl is blocked anyway.
PS() { K exec pageserver-0 -c pageserver -- curl -sf "$@"; }
# Safekeeper mgmt API is on port 7676, per-pod (headless Service). DELETE exists
# on 8464 (POST/PUT do not — that's why skctl exists for restore); we use DELETE
# to fully clean a timeline so re-`create` of the same app name is not poisoned by
# stale WAL. Best-effort per pod (a timeline may not exist on every safekeeper).
SK() { local ord="$1"; shift; K exec "safekeeper-$ord" -- curl -sf "$@"; }
log() { printf '\033[36m[provision]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[provision] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Per-app timeline id. It must be FRESH per lifecycle, not derived from the app
# name: on `destroy` the safekeepers TOMBSTONE the deleted timeline id and refuse
# to recreate it ("Timeline <id> has been deleted"), so a deterministic id would
# poison re-`create` of the same app name. We instead mint a random id on first
# create and persist it in the app's ConfigMap; re-provisioning reads it back
# (idempotent), and a create after destroy mints a new id (dodges the tombstone).
fresh_timeline() { python3 -c "import os;print(os.urandom(16).hex())"; }
app_timeline() { # echo the app's current timeline id (from its ConfigMap) or empty
  K get configmap "compute-config-$1" -o jsonpath='{.data.TIMELINE_ID}' 2>/dev/null || true
}

# validate_app_name enforces an RFC1123 DNS label so $app is safe to substitute
# into k8s object names (compute-<app>, compute-config-<app>, app-db-<app>) and a
# DSN token, and rejects the reserved system names (issue #79 / #74). This runs
# FIRST in create/destroy, before any cluster call, so a bad name fails fast with
# no partial render.
validate_app_name() {
  local app="$1"
  # LC_ALL=C so [a-z0-9-] is byte-range ASCII, not locale collation (under
  # e.g. en_US.UTF-8, [a-z] can match uppercase — silently accepting 'Bad').
  local LC_ALL=C LC_COLLATE=C
  [ -n "$app" ] || die "app name required"
  case "$app" in
    *[!a-z0-9-]*) die "invalid app name '$app': only lowercase [a-z0-9-] allowed (RFC1123 label)";;
  esac
  case "$app" in
    -*|*-) die "invalid app name '$app': must not start or end with '-'";;
  esac
  [ "${#app}" -le 63 ] || die "invalid app name '$app': max 63 chars (RFC1123 label)"
  local r
  for r in $RESERVED_NAMES; do
    [ "$app" = "$r" ] && die "app name '$app' is reserved (routes to a non-app compute) — pick another"
  done
  return 0
}

# app_scram_verifier computes the compute_ctl encrypted_password as a PostgreSQL
# SCRAM-SHA-256 verifier (issue #117): SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>.
# compute_ctl stores a recognised verifier VERBATIM (only a bare md5-hex gets the "md5"
# prefix), so the app role is SCRAM from boot — no md5, and NO plaintext on the compute.
# PBKDF2 is the Python stdlib hashlib.pbkdf2_hmac (not hand-rolled); a random per-role
# salt is drawn once here and baked into the (stable, no-silent-rotation) Secret.
app_scram_verifier() {
  python3 - "$1" <<'PY'
import hashlib, hmac, base64, os, sys
pw = sys.argv[1].encode(); salt = os.urandom(16); it = 4096
salted = hashlib.pbkdf2_hmac('sha256', pw, salt, it)
ck = hmac.new(salted, b'Client Key', hashlib.sha256).digest()
sk = hashlib.sha256(ck).digest()
srv = hmac.new(salted, b'Server Key', hashlib.sha256).digest()
b = lambda x: base64.b64encode(x).decode()
print(f"SCRAM-SHA-256${it}:{b(salt)}${b(sk)}:{b(srv)}")
PY
}

# mint_credential ensures the per-app Secret app-db-<app> exists (idempotent:
# re-provisioning keeps the SAME password so live apps are not locked out). Echoes
# the app role name. The Secret mirrors the knext DATABASE_URL contract: PGUSER,
# PGPASSWORD, DATABASE_URL (through the apps-gateway) + APP_ROLE_VERIFIER (a SCRAM
# verifier consumed by the compute spec). Written BEFORE the branch so credentials
# survive a crash.
mint_credential() {
  local app="$1" role="${APP_ROLE_PREFIX}$1"
  if K get secret "app-db-$app" >/dev/null 2>&1; then
    echo "$role"; return 0
  fi
  local pw verifier dsn
  pw="$(python3 -c 'import os;print(os.urandom(18).hex())')"
  verifier="$(app_scram_verifier "$pw")"
  dsn="postgres://$role:$pw@pggw-apps.$NS.svc:55432/$app?sslmode=disable"
  K create secret generic "app-db-$app" \
    --from-literal=PGUSER="$role" \
    --from-literal=PGPASSWORD="$pw" \
    --from-literal=APP_ROLE_VERIFIER="$verifier" \
    --from-literal=DATABASE_URL="$dsn" >/dev/null
  K label secret "app-db-$app" app="compute-$app" tier=apps --overwrite >/dev/null 2>&1 || true
  echo "$role"
}

ps_last_lsn() { # last_record_lsn of a timeline (the safe branch point)
  PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline/$1" \
    | tr ',' '\n' | grep '"last_record_lsn"' | head -1 | cut -d'"' -f4
}
tl_exists() { PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" | grep -q "$1"; }

ensure_tenant() {
  log "ensuring apps tenant $APPS_TENANT"
  PS -X PUT -H 'Content-Type: application/json' \
    -d '{"mode":"AttachedSingle","generation":1,"tenant_conf":{}}' \
    "http://localhost:9898/v1/tenant/$APPS_TENANT/location_config" >/dev/null
}

# render_app_compute — substitute the per-app compute template to STDOUT (no
# cluster). Positional quota args default to the DEF_* knobs so the seed-time tmpl
# compute and any caller that does not care about quotas render unchanged. This is
# the pure, testable seam (see `render` subcommand + test_provision-app.sh).
render_app_compute() {
  local app="$1" tl="$2" replicas="$3"
  local cpu_req="${4:-$DEF_CPU_REQUEST}" cpu_lim="${5:-$DEF_CPU_LIMIT}"
  local mem_req="${6:-$DEF_MEM_REQUEST}" mem_lim="${7:-$DEF_MEM_LIMIT}"
  local max_conns="${8:-$DEF_MAX_CONNS}"
  sed -e "s/__APP__/$app/g" -e "s/__TENANT_ID__/$APPS_TENANT/g" \
      -e "s/__TIMELINE_ID__/$tl/g" -e "s/__REPLICAS__/$replicas/g" \
      -e "s/__CPU_REQ__/$cpu_req/g" -e "s/__CPU_LIM__/$cpu_lim/g" \
      -e "s/__MEM_REQ__/$mem_req/g" -e "s/__MEM_LIM__/$mem_lim/g" \
      -e "s/__MAX_CONNS__/$max_conns/g" \
      "$HERE/compute-app.template.yaml"
}

# Render + apply a per-app compute (ConfigMap + Deployment + Service).
apply_app_compute() { render_app_compute "$@" | K apply -f -; }

# app_cfg <app> <key> — echo a data key from the app's compute-config ConfigMap (or
# empty). Used to read back persisted quota knobs on an idempotent re-`create`.
app_cfg() { K get configmap "compute-config-$1" -o jsonpath="{.data.$2}" 2>/dev/null || true; }

# Parse the shared quota flags into Q_CPU_REQ/Q_CPU_LIM/Q_MEM_REQ/Q_MEM_LIM/
# Q_MAX_CONNS (empty = "not set on the command line", resolved later) and the
# remaining non-quota args into Q_REST. Sets GLOBALS (must NOT be called in a
# command-substitution subshell, or the assignments are lost). The caller does:
#   parse_quota_flags "$@"; set -- $Q_REST
Q_CPU_REQ="" Q_CPU_LIM="" Q_MEM_REQ="" Q_MEM_LIM="" Q_MAX_CONNS="" Q_REST=""
parse_quota_flags() {
  Q_CPU_REQ="" Q_CPU_LIM="" Q_MEM_REQ="" Q_MEM_LIM="" Q_MAX_CONNS="" Q_REST=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --cpu-request) Q_CPU_REQ="$2"; shift 2;;
      --cpu-limit)   Q_CPU_LIM="$2"; shift 2;;
      --mem-request) Q_MEM_REQ="$2"; shift 2;;
      --mem-limit)   Q_MEM_LIM="$2"; shift 2;;
      --max-conns)   Q_MAX_CONNS="$2"; shift 2;;
      *) Q_REST="$Q_REST${Q_REST:+ }$1"; shift;;
    esac
  done
}

cmd_init_plane() {
  local schema=""
  while [ $# -gt 0 ]; do case "$1" in --schema) schema="$2"; shift 2;; *) die "unknown flag $1";; esac; done
  ensure_tenant
  if tl_exists "$TEMPLATE_TL"; then
    log "template timeline $TEMPLATE_TL already exists"
  else
    log "creating template timeline $TEMPLATE_TL (bootstrap)"
    PS -X POST -H 'Content-Type: application/json' \
      -d "{\"new_timeline_id\":\"$TEMPLATE_TL\",\"pg_version\":$PG_VERSION}" \
      "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline/" >/dev/null
  fi
  # Boot a template compute, apply the base schema, then park it at 0.
  log "booting template compute to seed base schema"
  apply_app_compute "tmpl" "$TEMPLATE_TL" 1 >/dev/null
  K rollout status deploy/compute-tmpl --timeout=120s
  local pod; pod="$(K get pod -l app=compute-tmpl -o jsonpath='{.items[0].metadata.name}')"
  local sql; sql="${schema:-$HERE/testdata/app-base-schema.sql}"
  [ -f "$sql" ] || die "schema file not found: $sql"
  log "applying base schema from $sql"
  K exec -i "$pod" -c compute -- env PGPASSWORD=cloud_admin \
    psql -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1 -f - < "$sql"
  K exec "$pod" -c compute -- env PGPASSWORD=cloud_admin \
    psql -h localhost -p 55433 -U cloud_admin -d postgres -tAc 'CHECKPOINT;' >/dev/null
  log "parking template compute at 0 (branch point is durable on the pageserver)"
  K scale deploy/compute-tmpl --replicas=0 >/dev/null
  log "init-plane done. template timeline=$TEMPLATE_TL"
}

cmd_create() {
  local app="${1:-}"; shift || true
  local replicas=0
  # Split quota flags out first (sets Q_* globals + Q_REST), then parse the rest.
  parse_quota_flags "$@"
  # shellcheck disable=SC2086
  set -- $Q_REST
  while [ $# -gt 0 ]; do case "$1" in --replicas) replicas="$2"; shift 2;; *) die "unknown flag $1";; esac; done
  validate_app_name "$app"                # issue #79: fail fast on bad/reserved names
  tl_exists "$TEMPLATE_TL" || die "template timeline missing — run 'init-plane' first"

  # Resolve each quota knob: explicit flag > persisted ConfigMap value (idempotent
  # re-create / fsck --converge preserves a customized app's limits) > default.
  local cpu_req cpu_lim mem_req mem_lim max_conns
  cpu_req="${Q_CPU_REQ:-$(app_cfg "$app" QUOTA_CPU_REQUEST)}"; cpu_req="${cpu_req:-$DEF_CPU_REQUEST}"
  cpu_lim="${Q_CPU_LIM:-$(app_cfg "$app" QUOTA_CPU_LIMIT)}";   cpu_lim="${cpu_lim:-$DEF_CPU_LIMIT}"
  mem_req="${Q_MEM_REQ:-$(app_cfg "$app" QUOTA_MEM_REQUEST)}"; mem_req="${mem_req:-$DEF_MEM_REQUEST}"
  mem_lim="${Q_MEM_LIM:-$(app_cfg "$app" QUOTA_MEM_LIMIT)}";   mem_lim="${mem_lim:-$DEF_MEM_LIMIT}"
  max_conns="${Q_MAX_CONNS:-$(app_cfg "$app" PG_MAX_CONNECTIONS)}"; max_conns="${max_conns:-$DEF_MAX_CONNS}"

  local t0; t0="$(python3 -c 'import time;print(time.time())')"

  # 1. Per-app credential (Secret) — idempotent, minted BEFORE the branch so a
  #    crash never leaves a branch without a recoverable owner (issue #76).
  local role; role="$(mint_credential "$app")"

  local tl; tl="$(app_timeline "$app")"   # existing id from the ConfigMap, or empty
  [ -n "$tl" ] || tl="$(fresh_timeline)"  # mint a fresh id on first create

  # 2. INTENT-FIRST (issue #76): apply the full compute at replicas 0. This
  #    durably persists compute-config-$app.TIMELINE_ID — the ONLY record that
  #    owns the branch — BEFORE the pageserver branch call. A Deployment at 0
  #    starts nothing. A crash here leaves a ConfigMap but no branch; re-running
  #    reads the id back and branches the SAME id (converges, no orphan).
  log "recording intent: compute-config-$app (timeline $tl, role $role, quota cpu=$cpu_req/$cpu_lim mem=$mem_req/$mem_lim max_conns=$max_conns) before branch"
  apply_app_compute "$app" "$tl" 0 "$cpu_req" "$cpu_lim" "$mem_req" "$mem_lim" "$max_conns" >/dev/null

  # 3. Branch the template (durable on the pageserver). Idempotent on the id.
  if tl_exists "$tl"; then
    log "app '$app' timeline $tl already exists (idempotent)"
  else
    local lsn; lsn="$(ps_last_lsn "$TEMPLATE_TL")"
    [ -n "$lsn" ] || die "could not read template last_record_lsn"
    log "branching '$app': timeline $tl from template@$lsn"
    PS -X POST -H 'Content-Type: application/json' \
      -d "{\"new_timeline_id\":\"$tl\",\"ancestor_timeline_id\":\"$TEMPLATE_TL\",\"ancestor_start_lsn\":\"$lsn\",\"pg_version\":$PG_VERSION}" \
      "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline/" >/dev/null
  fi

  # 4. Bring the compute to the requested replica count (default 0 = scale-to-zero).
  if [ "$replicas" != "0" ]; then
    log "scaling compute-$app to $replicas"
    K scale deploy/compute-"$app" --replicas="$replicas" >/dev/null
  fi

  local t1; t1="$(python3 -c 'import time;print(time.time())')"
  printf '\033[32m[provision] app "%s" provisioned in %.2fs (timeline %s, role %s)\033[0m\n' "$app" "$(python3 -c "print($t1-$t0)")" "$tl" "$role"
  cat <<EOF

  DSN (through the apps-gateway, in-cluster) — from Secret app-db-$app:
    kubectl -n $NS get secret app-db-$app -o jsonpath='{.data.DATABASE_URL}' | base64 -d
    (postgres://$role:<per-app-password>@pggw-apps.$NS.svc:55432/$app?sslmode=disable)
  The user MUST be "$role" (app_<db>); cloud_admin and other apps' roles are
  refused by the apps-gateway BEFORE any wake. The database name "$app" routes to
  compute-$app, served as the branch's postgres DB (GW_SERVED_DATABASE). Wake on
  first connect; idle -> back to 0.
EOF
}

# reclaim_timeline <timeline> — DELETE a timeline's WAL/pages off the pageserver
# AND every safekeeper (port 7676). The pageserver DELETE alone leaves per-timeline
# WAL dirs on the safekeepers (a slow leak as apps churn), so we DELETE on all
# $SK_REPLICAS too. The safekeepers tombstone the id, which is why `create` mints a
# FRESH random timeline id rather than reusing the app-name-derived one.
#
# A safekeeper that is DOWN/unreachable at reclaim time would drop its WAL dir on the
# floor forever with the old best-effort `|| true`. Instead we RECORD the failed
# (timeline -> safekeeper ordinals) to a durable ConfigMap so `reclaim-orphans` (or a
# re-run) can reconcile it later (issue #91). Returns 0 if fully reclaimed, 1 if any
# safekeeper DELETE failed (and was recorded).
reclaim_timeline() {
  local tl="$1"
  [ -n "$tl" ] || return 0
  log "reclaiming timeline $tl (pageserver + all $SK_REPLICAS safekeepers)"
  # pageserver DELETE: a 404 (already gone) is success for our purposes.
  PS -X DELETE "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline/$tl" >/dev/null 2>&1 \
    || log "note: pageserver DELETE of $tl returned non-2xx (already gone / will retry via reclaim-orphans)"
  local ord=0 failed=""
  while [ "$ord" -lt "$SK_REPLICAS" ]; do
    if ! SK "$ord" -X DELETE "http://localhost:7676/v1/tenant/$APPS_TENANT/timeline/$tl" >/dev/null 2>&1; then
      failed="${failed}${failed:+,}$ord"
    fi
    ord=$((ord+1))
  done
  if [ -n "$failed" ]; then
    record_reclaim_pending "$tl" "$failed"
    log "WARN: safekeeper DELETE of $tl failed on ordinal(s) [$failed] (safekeeper down/unreachable) — RECORDED to ConfigMap $RECLAIM_CM. Reconcile with: provision-app.sh reclaim-orphans"
    return 1
  fi
  # Fully reclaimed — clear any stale pending record for this timeline.
  clear_reclaim_pending "$tl"
  return 0
}

# record_reclaim_pending <timeline> <csv-ordinals> — durably note a safekeeper
# DELETE that could not complete, so it is never silently lost (issue #91). Keyed
# by the 32-hex timeline id (a valid ConfigMap data key).
record_reclaim_pending() {
  local tl="$1" ords="$2" ts
  ts="$(date -u +%FT%TZ 2>/dev/null || echo unknown)"
  K get configmap "$RECLAIM_CM" >/dev/null 2>&1 || K create configmap "$RECLAIM_CM" >/dev/null 2>&1 || true
  K label configmap "$RECLAIM_CM" tier=apps app=wal-reclaim --overwrite >/dev/null 2>&1 || true
  K patch configmap "$RECLAIM_CM" --type merge \
    -p "{\"data\":{\"$tl\":\"safekeepers=$ords recorded=$ts\"}}" >/dev/null 2>&1 || true
}

# clear_reclaim_pending <timeline> — drop a timeline's pending record once reclaimed.
clear_reclaim_pending() {
  local tl="$1"
  K get configmap "$RECLAIM_CM" >/dev/null 2>&1 || return 0
  K patch configmap "$RECLAIM_CM" --type json \
    -p "[{\"op\":\"remove\",\"path\":\"/data/$tl\"}]" >/dev/null 2>&1 || true
}

cmd_destroy() {
  local app="${1:-}"; shift || true
  local keep_tl=0
  while [ $# -gt 0 ]; do case "$1" in
    --keep-timeline)   keep_tl=1; shift;;
    # Deletion is now the DEFAULT (issue #91); accept the old flag as a no-op so
    # existing scripts/drills that pass it keep working.
    --delete-timeline) log "note: --delete-timeline is now the DEFAULT and can be omitted"; shift;;
    *) die "unknown flag $1";;
  esac; done
  validate_app_name "$app"
  # Read the timeline id from the ConfigMap BEFORE deleting it.
  local tl; tl="$(app_timeline "$app")"
  log "deleting k8s objects for '$app'"
  K delete deploy/compute-"$app" svc/compute-"$app" configmap/compute-config-"$app" \
    secret/app-db-"$app" --ignore-not-found

  if [ "$keep_tl" = 1 ]; then
    # Explicit opt-out: retain the branch (PITR / forensics). Deleting the ConfigMap
    # above just orphaned it — say so LOUDLY and hand the operator the reclaim command
    # so the retention is a deliberate, tracked decision, not a silent leak (#91).
    if [ -n "$tl" ]; then
      log "RETAINED timeline $tl per --keep-timeline. It is now an ORPHAN (no owning ConfigMap)."
      log "  Reclaim it later with:  provision-app.sh reclaim-orphans"
      log "  (or DELETE .../timeline/$tl on the pageserver + all $SK_REPLICAS safekeepers by hand)"
    else
      log "no timeline recorded for '$app' — nothing retained"
    fi
    log "destroy done (timeline retained — remember to reclaim it)"
    return
  fi

  # DEFAULT (safe): reclaim the timeline so no orphan branch / unbounded safekeeper
  # WAL is manufactured on the obvious command (issue #91 — the leak was the default).
  if [ -z "$tl" ]; then
    log "no timeline recorded for '$app' (nothing to reclaim)"
    log "destroy done"
    return
  fi
  if reclaim_timeline "$tl"; then
    log "destroy done (timeline $tl reclaimed — no orphan)"
  else
    log "destroy done (k8s objects removed; timeline $tl reclaim INCOMPLETE — see WARN above, run reclaim-orphans)"
  fi
}

# cmd_reclaim_orphans — the scheduled reclamation drill (issues #87/#90/#91). Reclaims
# EVERY orphan apps-tenant timeline (a branch on the pageserver with NO owning
# compute-config ConfigMap — residue from a prior --keep-timeline, a hand-deleted
# ConfigMap, or a pre-fix interrupted create) AND drains any safekeeper-DELETE failures
# recorded during a prior destroy. Safe + idempotent: an orphan by definition has no
# live app reading it and (its branch being deleted) no PITR hold. This is what closes
# the leak the wal-janitor only WARNs on. Exit 1 if any reclaim is left incomplete.
cmd_reclaim_orphans() {
  log "reclaiming orphan apps-tenant timelines (no owning ConfigMap) + draining recorded SK-delete failures"
  local owned all skpresent candidates tl reclaimed=0 incomplete=0
  owned="$(K get configmap -l tier=apps \
    -o jsonpath='{range .items[*]}{.data.TIMELINE_ID}{"\n"}{end}' 2>/dev/null | grep -v '^$' | sort -u || true)"
  # Candidate orphans come from BOTH sides of the plane, unioned, because residue can
  # outlive one side of a partial delete:
  #  - pageserver branches with no owning ConfigMap (orphan branch), AND
  #  - safekeeper WAL dirs (present under /data/<apps-tenant>/) whose branch is already
  #    404 on the pageserver — SK-only residue a pageserver-only sweep would MISS (the
  #    exact class apps-wal-monitor flags). safekeeper-0 is representative (quorum).
  all="$(PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" \
    | python3 -c 'import sys,json;[print(t["timeline_id"]) for t in json.load(sys.stdin)]' 2>/dev/null || true)"
  skpresent="$(K exec safekeeper-0 -c safekeeper -- sh -c "ls -1 /data/$APPS_TENANT 2>/dev/null" 2>/dev/null \
    | grep -E '^[0-9a-fA-F]{32}$' || true)"
  candidates="$(printf '%s\n%s\n' "$all" "$skpresent" | grep -v '^$' | sort -u || true)"
  for tl in $candidates; do
    [ "$tl" = "$TEMPLATE_TL" ] && continue                  # the shared template is not an app
    if printf '%s\n' "$owned" | grep -qx "$tl"; then continue; fi   # owned by a live app — never touch
    log "orphan timeline $tl has no owning ConfigMap — reclaiming (pageserver + all safekeepers)"
    if reclaim_timeline "$tl"; then reclaimed=$((reclaimed+1)); else incomplete=$((incomplete+1)); fi
  done

  # Drain recorded SK-delete failures (a timeline already gone from the pageserver but
  # whose safekeeper dirs a prior destroy could not remove). Re-issue the SK DELETE.
  local pending
  pending="$(K get configmap "$RECLAIM_CM" -o jsonpath='{range .data}{@}{"\n"}{end}' 2>/dev/null || true)"
  local keys
  keys="$(K get configmap "$RECLAIM_CM" -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null || true)"
  for tl in $keys; do
    [ -n "$tl" ] || continue
    log "draining recorded SK-delete for timeline $tl"
    local ord=0 failed=""
    while [ "$ord" -lt "$SK_REPLICAS" ]; do
      SK "$ord" -X DELETE "http://localhost:7676/v1/tenant/$APPS_TENANT/timeline/$tl" >/dev/null 2>&1 || failed="${failed}${failed:+,}$ord"
      ord=$((ord+1))
    done
    if [ -z "$failed" ]; then clear_reclaim_pending "$tl"; reclaimed=$((reclaimed+1)); else
      log "WARN: safekeeper(s) [$failed] still unreachable for $tl — left in $RECLAIM_CM"; incomplete=$((incomplete+1)); fi
  done

  if [ "$incomplete" -gt 0 ]; then
    log "reclaim-orphans: $reclaimed reclaimed, $incomplete INCOMPLETE (safekeeper still down?) — re-run once it recovers"
    return 1
  fi
  log "reclaim-orphans done: $reclaimed timeline(s) reclaimed, plane clean"
}

cmd_list() {
  PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" \
    | python3 -c 'import sys,json;[print(t["timeline_id"],"ancestor="+str(t.get("ancestor_timeline_id")),"@"+str(t.get("ancestor_lsn"))) for t in json.load(sys.stdin)]'
}

# cmd_fsck reconciles the branch-per-app plane in BOTH directions (issues #76, #93):
#
#   (1) ORPHAN timeline — a branch on the pageserver with NO owning ConfigMap.
#       Intent-first `create` can no longer produce these, but an OLD (pre-fix)
#       interrupted create or a hand-deleted ConfigMap can. Report-only (deleting
#       WAL is high blast-radius; the operator confirms + cleans by hand).
#
#   (2) DANGLING INTENT — a ConfigMap (and/or credential Secret) written with NO
#       corresponding branch. This is the intent-first FAILURE MODE (issue #93a): a
#       crash AFTER the ConfigMap/Secret apply but BEFORE the pageserver branch call
#       leaves durable k8s "intent" the compute can never boot against (its
#       wait-timeline initContainer blocks forever). fsck detects it and, with
#       --converge, RE-BRANCHES the recorded timeline id (idempotent `create`),
#       finishing the interrupted provision. Without --converge it is reported and
#       fsck exits non-zero so CI/drills can assert a converged plane.
#
# Exit 1 if any orphan timeline OR any UNCONVERGED dangling intent remains.
cmd_fsck() {
  local converge=0
  while [ $# -gt 0 ]; do case "$1" in --converge) converge=1; shift;; *) die "unknown flag $1";; esac; done

  log "fsck: reconciling apps tenant $APPS_TENANT (branches <-> ConfigMaps/Secrets)"
  # Live branches on the pageserver.
  local all; all="$(PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" \
    | python3 -c 'import sys,json;[print(t["timeline_id"]) for t in json.load(sys.stdin)]')"
  # Owner ConfigMaps as "name timeline" pairs (name = compute-config-<app>).
  local owned_pairs; owned_pairs="$(K get configmap -l tier=apps \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.data.TIMELINE_ID}{"\n"}{end}' 2>/dev/null | grep -v '^ *$' || true)"
  local owned_tls; owned_tls="$(printf '%s\n' "$owned_pairs" | awk '{print $2}' | grep -v '^$' | sort -u || true)"

  local problems=0 tl

  # (1) ORPHAN timelines — branch with no owning ConfigMap.
  for tl in $all; do
    [ "$tl" = "$TEMPLATE_TL" ] && continue                 # the shared template is not an app
    if printf '%s\n' "$owned_tls" | grep -qx "$tl"; then continue; fi
    printf '\033[31m[provision] ORPHAN timeline (no owning ConfigMap): %s\033[0m\n' "$tl"
    log "  clean with: PS DELETE .../timeline/$tl on pageserver + all $SK_REPLICAS safekeepers"
    log "  (not auto-converged: deleting WAL is high blast-radius — confirm by hand). See docs/operations.md."
    problems=$((problems+1))
  done

  # (2) DANGLING INTENT — a ConfigMap whose recorded timeline has NO branch (#93a).
  local cm app
  while IFS=' ' read -r cm tl; do
    [ -n "${cm:-}" ] || continue
    app="${cm#compute-config-}"
    if [ -z "${tl:-}" ]; then
      printf '\033[31m[provision] DANGLING INTENT: ConfigMap %s has no TIMELINE_ID\033[0m\n' "$cm"
      log "  destroy + recreate app '$app' to reset intent (no branch to lose)."
      problems=$((problems+1)); continue
    fi
    if printf '%s\n' "$all" | grep -qx "$tl"; then continue   # branch exists -> healthy
    fi
    printf '\033[31m[provision] DANGLING INTENT: app "%s" recorded timeline %s but NO branch exists\033[0m\n' "$app" "$tl"
    if [ "$converge" = 1 ]; then
      log "  --converge: re-branching $tl for '$app' (idempotent create finishes the interrupted provision)"
      cmd_create "$app"        # reads $tl back from the ConfigMap, branches it, converges
      if tl_exists "$tl"; then
        log "  converged: branch $tl now exists for '$app'"
      else
        printf '\033[31m[provision] converge FAILED for %s (branch %s still missing)\033[0m\n' "$app" "$tl"
        problems=$((problems+1))
      fi
    else
      log "  converge with: provision-app.sh fsck --converge   (or: provision-app.sh create $app)"
      problems=$((problems+1))
    fi
  done <<EOF
$owned_pairs
EOF

  # (3) ORPHAN Secret — credential minted but no owning ConfigMap (crash between the
  #     Secret and ConfigMap applies). The app has no recorded timeline; the safe
  #     resolution is destroy (removes the stray Secret) or a fresh create.
  local sec; for sec in $(K get secret -l tier=apps -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep -v '^$' || true); do
    app="${sec#app-db-}"
    if K get configmap "compute-config-$app" >/dev/null 2>&1; then continue; fi
    printf '\033[31m[provision] ORPHAN Secret %s (no owning ConfigMap for app "%s")\033[0m\n' "$sec" "$app"
    log "  resolve with: provision-app.sh create $app  (completes provisioning) or destroy $app (removes it)."
    problems=$((problems+1))
  done

  if [ "$problems" -eq 0 ]; then
    log "fsck: plane is clean (no orphan timelines, no dangling intents)"
  else
    log "fsck: $problems problem(s) — see docs/operations.md 'fsck: orphans & dangling intents'."
    log "  reclaim orphan timelines (pageserver + every safekeeper) with: provision-app.sh reclaim-orphans"
    return 1
  fi
}

# cmd_rotate_cred rotates an app's per-app password (issue #93b): mint a fresh
# password, write its SCRAM verifier into the app's Secret (app-db-<app>), and let
# compute_ctl re-apply it from spec on the compute's NEXT boot. The DSN CONTRACT is unchanged
# (same role app_<app>, same host/db) — only the password VALUE rotates. A running
# compute keeps the OLD password valid until it is bounced; --bounce applies the new
# password immediately (Recreate = single-writer-safe), a compute at 0 picks it up on
# its next wake. See docs/operations.md 'Rotating an app credential'.
cmd_rotate_cred() {
  local app="${1:-}"; shift || true
  local bounce=0
  while [ $# -gt 0 ]; do case "$1" in --bounce) bounce=1; shift;; *) die "unknown flag $1";; esac; done
  validate_app_name "$app"
  K get secret "app-db-$app" >/dev/null 2>&1 || die "app '$app' has no credential Secret (app-db-$app) — run 'create' first"
  local role="${APP_ROLE_PREFIX}$app"
  local pw verifier dsn
  pw="$(python3 -c 'import os;print(os.urandom(18).hex())')"
  verifier="$(app_scram_verifier "$pw")"
  dsn="postgres://$role:$pw@pggw-apps.$NS.svc:55432/$app?sslmode=disable"
  log "rotating credential for '$app' (role $role): new SCRAM verifier -> Secret app-db-$app"
  # In-place update (apply, not delete+create) so the Secret never briefly vanishes.
  K create secret generic "app-db-$app" \
    --from-literal=PGUSER="$role" \
    --from-literal=PGPASSWORD="$pw" \
    --from-literal=APP_ROLE_VERIFIER="$verifier" \
    --from-literal=DATABASE_URL="$dsn" \
    --dry-run=client -o yaml | K apply -f - >/dev/null
  K label secret "app-db-$app" app="compute-$app" tier=apps --overwrite >/dev/null 2>&1 || true
  local reps; reps="$(K get deploy "compute-$app" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
  if [ "$bounce" = 1 ] && [ "${reps:-0}" != "0" ]; then
    log "bouncing compute-$app to apply the new credential now (Recreate, single-writer-safe)"
    K rollout restart deploy/compute-"$app" >/dev/null
    K rollout status deploy/compute-"$app" --timeout=120s
    log "compute-$app bounced: the new password is live; the old one no longer authenticates."
  elif [ "${reps:-0}" != "0" ]; then
    log "compute-$app is running; the OLD password stays valid until its next bounce."
    log "apply now with: provision-app.sh rotate-cred $app --bounce   (or bounce the compute yourself)."
  else
    log "compute-$app is at 0; the new password applies on its next wake."
  fi
  log "rotation done. Consumers must re-read Secret app-db-$app (new PGPASSWORD/DATABASE_URL)."
}

# cmd_render prints the rendered per-app compute manifest to stdout WITHOUT touching
# the cluster (no ConfigMap readback) — the testable seam for the quota substitution
# (issue #89, test_provision-app.sh). Quota flags resolve to their command-line value
# or the DEF_* default; the timeline is a visible placeholder.
cmd_render() {
  local app="${1:-}"; shift || true
  parse_quota_flags "$@"
  # shellcheck disable=SC2086
  set -- $Q_REST
  [ $# -eq 0 ] || die "unknown flag $1"
  validate_app_name "$app"
  render_app_compute "$app" "00000000000000000000000000000000" 0 \
    "${Q_CPU_REQ:-$DEF_CPU_REQUEST}" "${Q_CPU_LIM:-$DEF_CPU_LIMIT}" \
    "${Q_MEM_REQ:-$DEF_MEM_REQUEST}" "${Q_MEM_LIM:-$DEF_MEM_LIMIT}" \
    "${Q_MAX_CONNS:-$DEF_MAX_CONNS}"
}

case "${1:-}" in
  init-plane)      shift; cmd_init_plane "$@";;
  create)          shift; cmd_create "$@";;
  render)          shift; cmd_render "$@";;
  destroy)         shift; cmd_destroy "$@";;
  reclaim-orphans) shift; cmd_reclaim_orphans "$@";;
  list)            shift; cmd_list "$@";;
  fsck)            shift; cmd_fsck "$@";;
  rotate-cred)     shift; cmd_rotate_cred "$@";;
  *) die "usage: provision-app.sh {init-plane|create <app> [--replicas N] [--cpu-request R] [--cpu-limit L] [--mem-request R] [--mem-limit L] [--max-conns N]|render <app> [quota flags]|destroy <app> [--keep-timeline]|reclaim-orphans|list|fsck [--converge]|rotate-cred <app> [--bounce]}";;
esac
