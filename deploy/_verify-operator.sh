#!/usr/bin/env bash
# _verify-operator.sh — AppDatabase CRD operator lifecycle drill (ADR-0004, #96).
#
# Proves the v1.0 DECLARATIVE provisioning interface on the live plane: a single
# `kubectl apply` of an AppDatabase custom resource drives the appdb-operator to
# provision a full per-app database (branch + compute + Secret + apps-gateway
# routing), it serves data through the apps-gateway, drift self-heals, and
# `kubectl delete appdatabase` runs the finalizer's safe two-sided deprovision so no
# orphan timeline is left — the same guarantees provision-app.sh carries, now
# reconciled continuously by a controller instead of invoked by hand.
#
# Asserts:
#   1. apply CR      -> status.phase Ready, status.timelineId set, branch on pageserver
#   2. child objects -> Deployment + Service + ConfigMap + per-app Secret created,
#                       finalizer present (delete will run safe deprovision)
#   2b. ext-driver     -> status.secretName published; DATABASE_URL_RO emission
#                       lifecycle (absent when roPool off, correct per-app RO DSN
#                       on port 55434 when toggled on, removed when off; #119)
#   3. serves data   -> a per-app-role connect THROUGH the apps-gateway wakes the
#                       compute 0->1 and reads/writes the app's own branch
#   4. drift heal    -> hand-delete the Deployment; the operator re-creates it
#   5. delete CR     -> finalizer removes k8s objects AND reclaims the timeline
#                       (pageserver + all safekeepers); CR object disappears; NO orphan
#   6. provision time-> record CR->Ready wall-clock (BENCHMARKS operator-provision row)
#
# Self-contained + idempotent: uses throwaway app "opdrill"; cleans up on exit.
# Requires the appdb-operator running from an image built WITH cmd/appdb-operator
# (deploy/83-appdb-operator.yaml, digest-pinned) and the plane initialized
# (provision-app.sh init-plane). Env: KCTX (default context-ckmva7v7zvq), NS.
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
APP="${APP:-opdrill}"

K() { kubectl --context "$KCTX" -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
app_pw() { K get secret "app-db-$1" -o jsonpath='{.data.PGPASSWORD}' | base64 -d; }

cleanup() {
  echo "    cleanup: deleting AppDatabase/$APP + reclaiming any residue"
  K delete appdatabase "$APP" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # give the finalizer a moment; then force-remove residue via the break-glass script
  local i=0; while K get appdatabase "$APP" >/dev/null 2>&1 && [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done
  KCTX="$KCTX" NS="$NS" "$PROV" destroy "$APP" >/dev/null 2>&1 || true
  KCTX="$KCTX" NS="$NS" "$PROV" reclaim-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# cr_status <jsonpath> — read a status field from the CR (empty if absent).
cr_status() { K get appdatabase "$APP" -o jsonpath="{.status.$1}" 2>/dev/null || true; }

# GCLIENT — one-shot psql THROUGH the apps-gateway as the per-app role app_<app>.
GCLIENT() { # $1 tag  $2 sql
  local p="opgw-$$-$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local pw; pw="$(app_pw "$APP")"
  local dsn="postgres://app_$APP:$pw@pggw-apps:55432/$APP?sslmode=disable"
  K run "$p" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- psql "$dsn" -tA -w -c "$2" >/dev/null
  local phase="" i=0
  while [ $i -lt 120 ]; do
    phase=$(K get pod "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
  done
  local out; out=$(K logs "$p" 2>&1)
  K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1
  [ "$phase" = "Succeeded" ] || { echo "gateway client $1 (db=$APP) failed ($phase): $out" >&2; return 1; }
  echo "$out"
}

# 0. preconditions
K get crd appdatabases.apps.scale-zero-pg.dev >/dev/null 2>&1 || fail "AppDatabase CRD not installed (kubectl apply -f deploy/82-appdb-crd.yaml)"
ok "AppDatabase CRD installed"
K rollout status deploy/appdb-operator --timeout=120s >/dev/null || fail "appdb-operator not ready"
ok "appdb-operator ready"
K rollout status deploy/pggw-apps --timeout=120s >/dev/null || fail "apps-gateway not ready"
KCTX="$KCTX" NS="$NS" "$PROV" init-plane >/dev/null || fail "init-plane failed (template timeline)"
ok "plane initialized (apps tenant + template timeline)"
# fresh start: no stale CR/objects for this app
K delete appdatabase "$APP" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
KCTX="$KCTX" NS="$NS" "$PROV" destroy "$APP" >/dev/null 2>&1 || true

# 1. apply the AppDatabase CR (cold tier, custom quota to prove quota apply too)
echo "==> applying AppDatabase/$APP"
T0=$(python3 -c 'import time;print(time.time())')
K apply -f - >/dev/null <<EOF
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata:
  name: $APP
  namespace: $NS
spec:
  appName: $APP
  tier: cold
  quotas: { cpu: "1500m", mem: "768Mi", maxConnections: 80 }
EOF
# wait for phase Ready (operator resync ~15s; allow generous slack)
PHASE=""; i=0
while [ $i -lt 90 ]; do
  PHASE="$(cr_status phase)"
  [ "$PHASE" = "Ready" ] && break
  [ "$PHASE" = "Failed" ] && fail "AppDatabase went Failed: $(cr_status message)"
  i=$((i+1)); sleep 1
done
[ "$PHASE" = "Ready" ] || fail "AppDatabase did not reach Ready (phase=$PHASE) in time"
T1=$(python3 -c 'import time;print(time.time())')
PROV_SECS=$(python3 -c "print(f'{$T1-$T0:.1f}')")
TL="$(cr_status timelineId)"
[ -n "$TL" ] || fail "status.timelineId not set"
ok "CR -> Ready in ${PROV_SECS}s (timeline $TL)"

# 1b. the branch actually exists on the pageserver
KCTX="$KCTX" NS="$NS" "$PROV" list | grep -q "$TL" || fail "operator reported Ready but timeline $TL is not on the pageserver"
ok "branch $TL exists on the pageserver"

# 2. child objects + finalizer
K get deploy "compute-$APP" >/dev/null 2>&1 || fail "compute Deployment not created"
K get svc "compute-$APP" >/dev/null 2>&1 || fail "compute Service not created"
K get configmap "compute-config-$APP" >/dev/null 2>&1 || fail "compute ConfigMap not created"
K get secret "app-db-$APP" >/dev/null 2>&1 || fail "per-app Secret not created"
K get appdatabase "$APP" -o jsonpath='{.metadata.finalizers}' | grep -q 'deprovision' \
  || fail "deprovision finalizer not set (delete would leak the timeline)"
# quota applied to the Deployment
CPULIM="$(K get deploy "compute-$APP" -o jsonpath='{.spec.template.spec.containers[0].resources.limits.cpu}')"
[ "$CPULIM" = "1500m" ] || fail "quota not applied: cpu limit=$CPULIM want 1500m"
ok "Deployment+Service+ConfigMap+Secret created, finalizer set, quota applied (cpu=$CPULIM)"

# 2b. external-driver status contract (#119): status.secretName names the output
#     Secret so a driver reads it instead of reconstructing "app-db-<app>".
SECNAME="$(cr_status secretName)"
[ "$SECNAME" = "app-db-$APP" ] || fail "status.secretName=$SECNAME want app-db-$APP"
ok "status.secretName published (app-db-$APP) — external-driver contract"

# 2c. DATABASE_URL_RO emission lifecycle (#119). roPool is OFF above, so the output
#     Secret must NOT carry a DATABASE_URL_RO key (writer-only contract).
sec_key() { K get secret "app-db-$APP" -o jsonpath="{.data.$1}" 2>/dev/null || true; }
[ -z "$(sec_key DATABASE_URL_RO)" ] || fail "DATABASE_URL_RO present with roPool OFF (must be omitted)"
ok "no DATABASE_URL_RO key while roPool is off"

# Turn roPool ON via the spec and wait for the operator to reconcile the key in.
K patch appdatabase "$APP" --type=merge -p '{"spec":{"roPool":{"enabled":true}}}' >/dev/null
RO=""; i=0
while [ $i -lt 60 ]; do
  RO="$(sec_key DATABASE_URL_RO | base64 -d 2>/dev/null || true)"
  [ -n "$RO" ] && break
  i=$((i+1)); sleep 1
done
[ -n "$RO" ] || fail "operator did not emit DATABASE_URL_RO after enabling roPool"
# Contract: same per-app role + db as the writer, on the RO port 55434.
case "$RO" in
  postgres://app_$APP:*@*:55434/$APP\?sslmode=disable) ;;
  *) fail "DATABASE_URL_RO wrong shape: $RO (want postgres://app_$APP:<pw>@<host>:55434/$APP?sslmode=disable)" ;;
esac
# It must differ from the writer DSN by exactly the port (55432 -> 55434).
WRITER="$(sec_key DATABASE_URL | base64 -d)"
[ "$RO" = "${WRITER/:55432\//:55434/}" ] || fail "DATABASE_URL_RO is not the writer DSN with the RO port: ro=$RO writer=$WRITER"
ok "roPool ON -> DATABASE_URL_RO emitted (app_$APP creds, RO port 55434, port-swap of writer DSN)"
echo "    note: per-app RO SERVING endpoint is a tracked read-scaling/gateway follow-up;"
echo "          this asserts the contract KEY, not a live RO connection (docs/appdatabase-api.md)."

# SAFETY (hard rule): the RO DSN must FAIL CLOSED — refuse to connect — and must
# NEVER resolve to the shared primary compute-ro pool (cross-tenant exposure). It
# targets the app's own apps-gateway on the RO port, which runs no RO listener yet,
# so a connect attempt must NOT succeed. Prove it refuses rather than returns data.
# First: the host is the app's OWN apps-gateway, never the primary pggw where the
# shared compute-ro pool lives.
case "$RO" in
  *@pggw-apps*:55434/$APP\?*) ;;
  *) fail "SECURITY: RO DSN host is not the per-app apps-gateway (could reach the shared pool): $RO" ;;
esac
ROTRY="opgwro-$$"
# PGCONNECT_TIMEOUT bounds the connect so a dropped/refused RO port fails fast
# (pod -> Failed) instead of hanging on TCP retries.
kubectl --context "$KCTX" -n "$NS" run "$ROTRY" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
  --env=PGCONNECT_TIMEOUT=5 --restart=Never --quiet --command -- psql "$RO" -tAw -c 'select current_database()' >/dev/null 2>&1 || true
rphase=""; i=0
while [ $i -lt 60 ]; do
  rphase=$(K get pod "$ROTRY" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$rphase" in Succeeded|Failed) break;; esac; i=$((i+1)); sleep 1
done
rout="$(K logs "$ROTRY" 2>&1 || true)"
K delete pod "$ROTRY" --ignore-not-found --wait=false >/dev/null 2>&1 || true
[ "$rphase" != "Succeeded" ] || fail "SECURITY: RO DSN CONNECTED (must fail closed until the per-app RO endpoint exists): $rout"
ok "RO DSN fails closed (did not connect, phase=$rphase) — never reaches the shared compute-ro pool"

# Turn roPool OFF again -> the key is removed (idempotent toggle, password untouched).
PW_BEFORE="$(app_pw "$APP")"
K patch appdatabase "$APP" --type=merge -p '{"spec":{"roPool":{"enabled":false}}}' >/dev/null
i=0
while [ $i -lt 60 ]; do
  [ -z "$(sec_key DATABASE_URL_RO)" ] && break
  i=$((i+1)); sleep 1
done
[ -z "$(sec_key DATABASE_URL_RO)" ] || fail "DATABASE_URL_RO not removed after disabling roPool"
[ "$(app_pw "$APP")" = "$PW_BEFORE" ] || fail "PGPASSWORD changed during RO toggle (live app would be locked out)"
ok "roPool OFF -> DATABASE_URL_RO removed; PGPASSWORD unchanged (no lockout)"

# 3. serves data through the apps-gateway (wakes 0->1, reads its own branch)
[ "$(GCLIENT seed 'select count(*) from schema_migrations' | tail -1)" -ge 1 ] \
  || fail "app did not inherit the template schema through the gateway"
GCLIENT w "insert into app_items(note) values ('$APP-operator-write')" >/dev/null
[ "$(GCLIENT r "select count(*) from app_items where note='$APP-operator-write'" | tail -1)" = "1" ] \
  || fail "gateway-fronted read did not return the app's own write"
ok "serves data through the apps-gateway (woke 0->1, read/write its own branch)"

# 4. drift heal — hand-delete the Deployment; the operator must re-create it
echo "==> drift heal"
K delete deploy "compute-$APP" --wait=true >/dev/null
i=0; while ! K get deploy "compute-$APP" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 40 ] && fail "operator did not re-create the hand-deleted Deployment (drift heal broken)"; sleep 1
done
ok "operator re-created the hand-deleted Deployment (drift self-heals)"

# 5. delete the CR — finalizer runs safe deprovision (no orphan)
echo "==> delete CR -> finalizer deprovision"
K delete appdatabase "$APP" --wait=true --timeout=120s >/dev/null || fail "delete AppDatabase timed out (finalizer stuck?)"
K get appdatabase "$APP" >/dev/null 2>&1 && fail "AppDatabase object still present after delete"
K get deploy "compute-$APP" >/dev/null 2>&1 && fail "compute Deployment survived deprovision"
K get secret "app-db-$APP" >/dev/null 2>&1 && fail "per-app Secret survived deprovision"
# the timeline must be reclaimed (gone from the pageserver) — no orphan
if KCTX="$KCTX" NS="$NS" "$PROV" list | grep -q "$TL"; then
  fail "ORPHAN: timeline $TL survived CR deletion (deprovision leaked)"
fi
ok "finalizer removed k8s objects AND reclaimed timeline $TL (no orphan)"
# reclaim-orphans must find nothing left to do
KCTX="$KCTX" NS="$NS" "$PROV" reclaim-orphans >/dev/null || fail "reclaim-orphans reported residue after operator deprovision"
ok "reclaim-orphans: plane clean after operator deprovision"

trap - EXIT
echo "operator verification: apply->Ready (${PROV_SECS}s) + serves data + drift-heal + finalizer deprovision (no orphan) — PASSED"
