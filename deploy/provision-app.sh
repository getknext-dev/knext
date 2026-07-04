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
#
# Env: KCTX (kube context, default context-ckmva7v7zvq), NS (default scale-zero-pg).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"

APPS_TENANT="${APPS_TENANT:-a0000000000000000000000000000001}"
TEMPLATE_TL="${TEMPLATE_TL:-a0000000000000000000000000000010}"
PG_VERSION="${PG_VERSION:-17}"

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
  local app="$1"; shift
  local replicas=0
  while [ $# -gt 0 ]; do case "$1" in --replicas) replicas="$2"; shift 2;; *) die "unknown flag $1";; esac; done
  [ -n "$app" ] || die "usage: create <app>"
  tl_exists "$TEMPLATE_TL" || die "template timeline missing — run 'init-plane' first"
  local tl; tl="$(app_timeline "$app")"   # existing id from the ConfigMap, or empty
  [ -n "$tl" ] || tl="$(fresh_timeline)"  # mint a fresh id on first create
  local t0; t0="$(python3 -c 'import time;print(time.time())')"
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
  log "applying per-app compute compute-$app (replicas=$replicas)"
  apply_app_compute "$app" "$tl" "$replicas" >/dev/null
  local t1; t1="$(python3 -c 'import time;print(time.time())')"
  printf '\033[32m[provision] app "%s" provisioned in %.2fs (timeline %s)\033[0m\n' "$app" "$(python3 -c "print($t1-$t0)")" "$tl"
  cat <<EOF

  DSN (through the apps-gateway, in-cluster):
    postgres://cloud_admin:cloud_admin@pggw-apps.$NS.svc:55432/$app?sslmode=disable
  The database name "$app" routes to compute-$app and is served as the branch's
  postgres DB (GW_SERVED_DATABASE). Wake is on first connect; idle -> back to 0.
EOF
}

cmd_destroy() {
  local app="$1"; shift
  local del_tl=0
  while [ $# -gt 0 ]; do case "$1" in --delete-timeline) del_tl=1; shift;; *) die "unknown flag $1";; esac; done
  [ -n "$app" ] || die "usage: destroy <app>"
  # Read the timeline id from the ConfigMap BEFORE deleting it.
  local tl; tl="$(app_timeline "$app")"
  log "deleting k8s objects for '$app'"
  K delete deploy/compute-"$app" svc/compute-"$app" configmap/compute-config-"$app" --ignore-not-found
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

case "${1:-}" in
  init-plane) shift; cmd_init_plane "$@";;
  create)     shift; cmd_create "$@";;
  destroy)    shift; cmd_destroy "$@";;
  list)       shift; cmd_list "$@";;
  *) die "usage: provision-app.sh {init-plane|create <app>|destroy <app>|list}";;
esac
