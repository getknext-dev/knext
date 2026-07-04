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
#   provision-app.sh create  <app> [--replicas N]        # branch the template -> per-app compute (default replicas 0)
#   provision-app.sh destroy <app> [--delete-timeline]   # remove the app's k8s objects (+ optional timeline)
#   provision-app.sh list                                # list apps tenant timelines
#   provision-app.sh fsck                                # surface orphan timelines (branch with no owning ConfigMap)
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

SK_REPLICAS="${SK_REPLICAS:-3}" # safekeeper StatefulSet size (52-safekeeper.yaml)

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

# app_md5 computes the compute_ctl encrypted_password: the RAW 32-hex
# md5(password||rolename), WITHOUT a "md5" prefix — the exact format Neon's
# compute_ctl expects (matches the cloud_admin CLOUD_ADMIN_MD5 verifier).
app_md5() { python3 -c "import hashlib,sys;print(hashlib.md5((sys.argv[1]+sys.argv[2]).encode()).hexdigest())" "$1" "$2"; }

# mint_credential ensures the per-app Secret app-db-<app> exists (idempotent:
# re-provisioning keeps the SAME password so live apps are not locked out). Echoes
# the app role name. The Secret mirrors the knext DATABASE_URL contract: PGUSER,
# PGPASSWORD, DATABASE_URL (through the apps-gateway) + APP_ROLE_MD5 (consumed by
# the compute spec). Written BEFORE the branch so credentials survive a crash.
mint_credential() {
  local app="$1" role="${APP_ROLE_PREFIX}$1"
  if K get secret "app-db-$app" >/dev/null 2>&1; then
    echo "$role"; return 0
  fi
  local pw md5 dsn
  pw="$(python3 -c 'import os;print(os.urandom(18).hex())')"
  md5="$(app_md5 "$pw" "$role")"
  dsn="postgres://$role:$pw@pggw-apps.$NS.svc:55432/$app?sslmode=disable"
  K create secret generic "app-db-$app" \
    --from-literal=PGUSER="$role" \
    --from-literal=PGPASSWORD="$pw" \
    --from-literal=APP_ROLE_MD5="$md5" \
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

# Render + apply a per-app compute (ConfigMap + Deployment + Service).
apply_app_compute() {
  local app="$1" tl="$2" replicas="$3"
  sed -e "s/__APP__/$app/g" -e "s/__TENANT_ID__/$APPS_TENANT/g" \
      -e "s/__TIMELINE_ID__/$tl/g" -e "s/__REPLICAS__/$replicas/g" \
      "$HERE/compute-app.template.yaml" | K apply -f -
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
  while [ $# -gt 0 ]; do case "$1" in --replicas) replicas="$2"; shift 2;; *) die "unknown flag $1";; esac; done
  validate_app_name "$app"                # issue #79: fail fast on bad/reserved names
  tl_exists "$TEMPLATE_TL" || die "template timeline missing — run 'init-plane' first"
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
  log "recording intent: compute-config-$app (timeline $tl, role $role) before branch"
  apply_app_compute "$app" "$tl" 0 >/dev/null

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

cmd_destroy() {
  local app="${1:-}"; shift || true
  local del_tl=0
  while [ $# -gt 0 ]; do case "$1" in --delete-timeline) del_tl=1; shift;; *) die "unknown flag $1";; esac; done
  validate_app_name "$app"
  # Read the timeline id from the ConfigMap BEFORE deleting it.
  local tl; tl="$(app_timeline "$app")"
  log "deleting k8s objects for '$app'"
  K delete deploy/compute-"$app" svc/compute-"$app" configmap/compute-config-"$app" \
    secret/app-db-"$app" --ignore-not-found
  if [ "$del_tl" = 1 ]; then
    [ -n "$tl" ] || { log "no timeline recorded for '$app' (nothing to delete)"; log "destroy done"; return; }
    log "deleting timeline $tl (pageserver + all $SK_REPLICAS safekeepers)"
    PS -X DELETE "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline/$tl" >/dev/null 2>&1 || true
    # Delete the safekeeper-side timeline on every safekeeper too — the pageserver
    # DELETE alone leaves per-timeline WAL dirs on the safekeepers (a slow leak as
    # apps churn). The safekeepers tombstone the id, which is why `create` mints a
    # FRESH random timeline id rather than reusing the app-name-derived one.
    local ord=0
    while [ "$ord" -lt "$SK_REPLICAS" ]; do
      SK "$ord" -X DELETE "http://localhost:7676/v1/tenant/$APPS_TENANT/timeline/$tl" >/dev/null 2>&1 || true
      ord=$((ord+1))
    done
  fi
  log "destroy done"
}

cmd_list() {
  PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" \
    | python3 -c 'import sys,json;[print(t["timeline_id"],"ancestor="+str(t.get("ancestor_timeline_id")),"@"+str(t.get("ancestor_lsn"))) for t in json.load(sys.stdin)]'
}

# cmd_fsck surfaces ORPHAN timelines (issue #76): a branch on the pageserver with
# NO owning compute-config ConfigMap. With intent-first `create` these can no
# longer be produced, but a branch left by an OLD (pre-fix) interrupted create, or
# a hand-deleted ConfigMap, is detectable and cleanable here. Exit 1 if any found
# (so CI/drills can assert a clean plane).
cmd_fsck() {
  log "scanning apps tenant $APPS_TENANT for orphan timelines (branch with no owning ConfigMap)"
  local owned; owned="$(K get configmap -l tier=apps \
    -o jsonpath='{range .items[*]}{.data.TIMELINE_ID}{"\n"}{end}' 2>/dev/null | grep -v '^$' | sort -u || true)"
  local all; all="$(PS "http://localhost:9898/v1/tenant/$APPS_TENANT/timeline" \
    | python3 -c 'import sys,json;[print(t["timeline_id"]) for t in json.load(sys.stdin)]')"
  local orphans=0 tl
  for tl in $all; do
    [ "$tl" = "$TEMPLATE_TL" ] && continue                 # the shared template is not an app
    if printf '%s\n' "$owned" | grep -qx "$tl"; then continue; fi
    printf '\033[31m[provision] ORPHAN timeline (no owning ConfigMap): %s\033[0m\n' "$tl"
    orphans=$((orphans+1))
  done
  if [ "$orphans" -eq 0 ]; then
    log "no orphan timelines — plane is clean"
  else
    log "$orphans orphan timeline(s). Clean with: PS DELETE .../timeline/<id> on pageserver + all safekeepers,"
    log "or destroy the owning app if you can recreate the ConfigMap. See docs/operations.md 'Orphan timelines'."
    return 1
  fi
}

case "${1:-}" in
  init-plane) shift; cmd_init_plane "$@";;
  create)     shift; cmd_create "$@";;
  destroy)    shift; cmd_destroy "$@";;
  list)       shift; cmd_list "$@";;
  fsck)       shift; cmd_fsck "$@";;
  *) die "usage: provision-app.sh {init-plane|create <app>|destroy <app>|list|fsck}";;
esac
