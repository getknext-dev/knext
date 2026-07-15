#!/usr/bin/env bash
# migrate-to-perapp.sh — move the pg-demo NextApp OFF the shared primary onto its
# OWN provisioned per-app database (branch-per-app, ADR-0003 / issues #6, #99 KC5).
#
# This is the "capability in real use" evidence for ADR-0002 kill-criterion 5
# (#65/#73): a real knext app, on its own Neon branch (own timeline, own
# credential, own 0<->1 compute), sleeping and waking end-to-end — not a synthetic
# drill. It:
#   1. provisions a per-app DB by INVOKING deploy/provision-app.sh (read-only use;
#      the app becomes a Neon branch off the shared template with role app_<app>),
#   2. rewrites the demo's DATABASE_URL Secret (knext-demo/pg-demo-db) to the
#      minted per-app DSN through the apps-gateway (pggw-apps), and
#   3. because the operator injects DATABASE_URL via secretKeyRef, the NextApp's
#      NEXT cold start reads the new DSN — no image/revision change.
#
# The per-app password is minted at provision time (random), so it CANNOT live in
# a committed manifest — this script wires it at runtime. `restore` points the demo
# back at the shared primary (deploy/manifests/10-database-secret.yaml).
#
# Usage:
#   demo/migrate-to-perapp.sh migrate [<app>]   # default app name: pgdemo
#   demo/migrate-to-perapp.sh restore           # revert to the shared primary DSN
#   demo/migrate-to-perapp.sh show   [<app>]    # print the demo's current + per-app DSN (password redacted)
#
# Env: KCTX (default context-ckmva7v7zvq), NS (db plane, default scale-zero-pg),
#      APP_NS (the app's ns, default knext-demo), APP (default pgdemo).
set -euo pipefail

KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
APP_NS="${APP_NS:-knext-demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROVISION="$HERE/../deploy/provision-app.sh"
DEMO_SECRET="pg-demo-db"

K()  { kubectl --context "$KCTX" "$@"; }
log(){ printf '\033[36m[migrate]\033[0m %s\n' "$*"; }
die(){ printf '\033[31m[migrate] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
redact(){ sed -E 's#(://[^:]+:)[^@]+(@)#\1****\2#'; }

cmd_migrate() {
  local app="${1:-pgdemo}"
  [ -x "$PROVISION" ] || die "provision-app.sh not found/executable at $PROVISION"

  # 1. Provision the per-app database (idempotent). We INVOKE provision-app.sh,
  #    never edit it — another lane owns that script.
  log "provisioning per-app database '$app' via provision-app.sh (branch-per-app)"
  KCTX="$KCTX" NS="$NS" bash "$PROVISION" create "$app"

  # 2. Read the minted per-app DSN from the app's Secret (app-db-<app>).
  local dsn
  dsn="$(K -n "$NS" get secret "app-db-$app" -o jsonpath='{.data.DATABASE_URL}' | base64 -d)"
  [ -n "$dsn" ] || die "could not read per-app DSN from secret app-db-$app"
  log "per-app DSN: $(printf '%s' "$dsn" | redact)"

  # 3. Rewrite the demo Secret to the per-app DSN (in-place apply so it never
  #    briefly vanishes). The operator injects it via secretKeyRef, so the app's
  #    NEXT cold start uses it.
  K -n "$APP_NS" create secret generic "$DEMO_SECRET" \
    --from-literal=DATABASE_URL="$dsn" \
    --dry-run=client -o yaml | K -n "$APP_NS" apply -f - >/dev/null
  log "demo Secret $APP_NS/$DEMO_SECRET now points at per-app DB '$app' (role app_$app)"
  log "the pg-demo NextApp is OFF the shared primary. Next cold request wakes app + compute-$app (0->1)."
  log "verify end-to-end with:  ITERS=3 bash $HERE/_verify.sh"
}

cmd_restore() {
  log "restoring the demo Secret to the SHARED primary (deploy/manifests/10-database-secret.yaml)"
  K apply -f "$HERE/manifests/10-database-secret.yaml" >/dev/null
  log "done. Next cold request wakes the shared primary again."
}

cmd_show() {
  local app="${1:-pgdemo}"
  printf 'demo Secret (%s/%s):\n  ' "$APP_NS" "$DEMO_SECRET"
  K -n "$APP_NS" get secret "$DEMO_SECRET" -o jsonpath='{.data.DATABASE_URL}' 2>/dev/null | base64 -d | redact; echo
  if K -n "$NS" get secret "app-db-$app" >/dev/null 2>&1; then
    printf 'per-app Secret (%s/app-db-%s):\n  ' "$NS" "$app"
    K -n "$NS" get secret "app-db-$app" -o jsonpath='{.data.DATABASE_URL}' | base64 -d | redact; echo
  else
    printf 'per-app Secret app-db-%s: (not provisioned yet)\n' "$app"
  fi
}

case "${1:-}" in
  migrate) shift; cmd_migrate "$@";;
  restore) shift; cmd_restore "$@";;
  show)    shift; cmd_show "$@";;
  *) die "usage: migrate-to-perapp.sh {migrate [<app>]|restore|show [<app>]}";;
esac
