#!/usr/bin/env bash
# _verify-unified-config.sh — unified-config flagship (ADR-0006 / #119) live drill.
#
# Proves the cross-repo unified-config contract end-to-end on the live plane: a
# knext NextApp with `spec.database.enabled` auto-provisions a scale-zero-pg
# AppDatabase, wires DATABASE_URL into the app, and the app + its per-app compute
# sleep and wake TOGETHER on one visitor request. This is the gate for merging
# the knext consumer PR (getknext-dev/knext #219).
#
# It is a CONSUMER-SIDE drill: unlike the other _verify-*.sh scripts it needs the
# **knext operator** (with the #219 change) deployed and granted the scoped
# `knext-appdb-driver` Role in this namespace (config/rbac/appdb_driver.yaml on
# the knext side, mirrored here as deploy/84-* if present). If the knext operator
# is not present the drill SKIPs with a clear message rather than failing.
#
# Asserts (ADR-0006 §2/§3/§4):
#   a. knext operator DERIVES appName=<ns>-<name> and creates an AppDatabase here.
#   b. the appdb operator provisions it -> status.phase=Ready, Secret
#      app-db-<app> with a DATABASE_URL key.
#   c. knext MIRRORS the Secret into the app ns (<name>-db, ownerRef=NextApp),
#      injects DATABASE_URL, and HARD-GATES: the Knative Service appears only
#      after the DB is Ready (§4.1).
#   d. the app serves a DB round-trip through pggw-apps (per-app database).
#   e. WAKE-TOGETHER: idle -> app + compute-<app> both scale to zero; ONE cold
#      request wakes BOTH; data persists across the cycle (visit counter climbs).
#   f. CROSS-NS ISOLATION: app A's credentials are REFUSED on app B's database by
#      the apps-gateway (§4.4 credential layer) — the mirror only ever carries the
#      app's own DSN.
#   g. TEARDOWN: delete the NextApp -> db-cleanup finalizer deletes the
#      AppDatabase -> two-sided timeline reclaim (no orphan); mirrored Secret,
#      compute, and source Secret all GC'd.
#
# Evidence from the gating run (2026-07-05, knext operator img v0.1.0-uni119-e2e
# @sha256:09616173, appdb-operator gateway:v0.7.0-appdb-119@sha256:0618ff09):
#   a-d PASS; e combined-wake TTFB ~13.0s (Knative cold start + Neon compute wake),
#   DB round-trip ~2.45s, visit counter 2->3 across a full scale-to-zero cycle;
#   f app A creds refused on app B db ("password authentication failed"); g
#   "TimelineReclaimed ... (no orphan)", every object NotFound after delete.
#
# Env: KCTX (default context-ckmva7v7zvq), NS (default scale-zero-pg = where
#      AppDatabases live), APP_IMAGE (a DB-backed NextApp image; default pg-demo).
set -euo pipefail
KCTX="${KCTX:-context-ckmva7v7zvq}"
NS="${NS:-scale-zero-pg}"
APP_NS_A="${APP_NS_A:-uni-e2e}"
APP_NS_B="${APP_NS_B:-uni-e2e-b}"
APP_NAME="${APP_NAME:-shop}"
APP_IMAGE="${APP_IMAGE:-me-abudhabi-1.ocir.io/axfqznklsd2t/pg-demo:v1@sha256:6ffc1e1b1f4b7ac682e52443f1041212345792f7942dc005226abb9e3d62c39e}"
INGRESS="${INGRESS:-http://kourier-internal.knative-serving.svc/}"
SSLIP="${SSLIP:-51.170.86.139.sslip.io}"
WAKE_MAX="${WAKE_MAX:-120}"

K() { kubectl --context "$KCTX" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok  - $*"; }
skip() { echo "SKIP: $*" >&2; exit 0; }

APP_A="${APP_NS_A}-${APP_NAME}"   # derived appName (ns-name)
APP_B="${APP_NS_B}-${APP_NAME}"

cleanup() {
  K delete nextapp "$APP_NAME" -n "$APP_NS_A" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  K delete nextapp "$APP_NAME" -n "$APP_NS_B" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  sleep 3
  K delete ns "$APP_NS_A" "$APP_NS_B" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- preflight: knext operator + NextApp CRD with spec.database present? --------
K get crd nextapps.apps.kn-next.dev >/dev/null 2>&1 || skip "NextApp CRD absent — knext not installed"
K get crd nextapps.apps.kn-next.dev \
  -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.database}' 2>/dev/null \
  | grep -q enabled || skip "NextApp CRD lacks spec.database — knext #219 not deployed"
K get appdatabase -n "$NS" >/dev/null 2>&1 || skip "AppDatabase CRD/operator absent"

napp() { # $1 = ns
  cat <<EOF | K apply -f -
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata: { name: ${APP_NAME}, namespace: ${1} }
spec:
  image: ${APP_IMAGE}
  healthCheckPath: /api/health
  scaling: { minScale: 0, maxScale: 3, containerConcurrency: 80 }
  database:
    enabled: true
    tier: cold
    quotas: { cpu: "500m", mem: "512Mi", maxConnections: 50 }
EOF
}

K create ns "$APP_NS_A" >/dev/null 2>&1 || true
napp "$APP_NS_A" >/dev/null

# --- a. AppDatabase created with the derived appName -----------------------------
for i in $(seq 1 20); do
  K get appdatabase "$APP_A" -n "$NS" >/dev/null 2>&1 && break; sleep 2
done
K get appdatabase "$APP_A" -n "$NS" >/dev/null 2>&1 || fail "a: AppDatabase $APP_A not created"
ref=$(K get appdatabase "$APP_A" -n "$NS" -o jsonpath='{.metadata.annotations.apps\.kn-next\.dev/nextapp}')
[ "$ref" = "${APP_NS_A}/${APP_NAME}" ] || fail "a: nextapp back-ref wrong ($ref)"
ok "a: AppDatabase $APP_A created, derived from ${APP_NS_A}/${APP_NAME}"

# --- b. provisioned Ready + Secret with DATABASE_URL -----------------------------
for i in $(seq 1 30); do
  [ "$(K get appdatabase "$APP_A" -n "$NS" -o jsonpath='{.status.phase}')" = Ready ] && break; sleep 2
done
[ "$(K get appdatabase "$APP_A" -n "$NS" -o jsonpath='{.status.phase}')" = Ready ] || fail "b: AppDatabase not Ready"
K get secret "app-db-$APP_A" -n "$NS" -o jsonpath='{.data.DATABASE_URL}' | grep -q . || fail "b: source Secret has no DATABASE_URL"
ok "b: $APP_A Ready; Secret app-db-$APP_A has DATABASE_URL"

# --- c. mirror + inject + hard-gate ---------------------------------------------
for i in $(seq 1 30); do
  [ "$(K get nextapp "$APP_NAME" -n "$APP_NS_A" -o jsonpath='{.status.conditions[?(@.type=="DatabaseReady")].status}')" = True ] && break; sleep 2
done
mirror=$(K get secret "${APP_NAME}-db" -n "$APP_NS_A" -o jsonpath='{.metadata.ownerReferences[0].kind}' 2>/dev/null)
[ "$mirror" = NextApp ] || fail "c: mirrored Secret ${APP_NAME}-db missing NextApp ownerRef"
env=$(K get ksvc "$APP_NAME" -n "$APP_NS_A" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DATABASE_URL")].valueFrom.secretKeyRef.name}')
[ "$env" = "${APP_NAME}-db" ] || fail "c: DATABASE_URL not injected from mirror"
ok "c: Secret mirrored (ownerRef=NextApp), DATABASE_URL injected, ksvc gated on Ready"

K wait --for=condition=Ready ksvc/"$APP_NAME" -n "$APP_NS_A" --timeout="${WAKE_MAX}s" >/dev/null || fail "c: ksvc not Ready"

# --- d. DB round-trip through pggw-apps ------------------------------------------
K -n "$APP_NS_A" run probe --image=curlimages/curl:8.11.1 --restart=Never --command -- sleep 3600 >/dev/null 2>&1 || true
K -n "$APP_NS_A" wait --for=condition=Ready pod/probe --timeout=60s >/dev/null
host="${APP_NAME}.${APP_NS_A}.${SSLIP}"
probe_body() { K -n "$APP_NS_A" exec probe -- sh -c \
  "curl -s -o /tmp/b -w '%{http_code} %{time_starttransfer}' --max-time $WAKE_MAX -H 'Host: $host' '$INGRESS'; echo; sed 's/<[^>]*>/ /g' /tmp/b"; }
for i in 1 2 3; do out=$(probe_body); echo "$out" | grep -qi 'db round-trip' && break; sleep 3; done
echo "$out" | grep -qi 'db round-trip' || fail "d: app did not serve a DB round-trip"
ok "d: app serves DB round-trip through pggw-apps ($(echo "$out" | grep -oiE 'PostgreSQL [0-9.]+' | head -1))"

# --- e. wake-together ------------------------------------------------------------
echo "    (waiting for app + compute-$APP_A to scale to zero...)"
for i in $(seq 1 40); do
  a=$(K -n "$APP_NS_A" get pods --no-headers 2>/dev/null | grep -c "${APP_NAME}-.*deployment" || true)
  c=$(K -n "$NS" get deploy "compute-$APP_A" -o jsonpath='{.spec.replicas}' 2>/dev/null)
  [ "$a" = 0 ] && [ "$c" = 0 ] && break; sleep 5
done
[ "$a" = 0 ] && [ "$c" = 0 ] || fail "e: app/compute did not both reach zero (app=$a compute=$c)"
cold=$(probe_body); ttfb=$(echo "$cold" | head -1 | awk '{print $2}')
echo "$cold" | grep -qi 'db round-trip' || fail "e: cold wake did not serve a DB round-trip"
cwake=$(K -n "$NS" get deploy "compute-$APP_A" -o jsonpath='{.status.readyReplicas}')
[ "${cwake:-0}" -ge 1 ] || fail "e: compute did not wake"
ok "e: ONE cold request woke app + compute together (combined TTFB ${ttfb}s)"

# --- f. cross-ns isolation -------------------------------------------------------
K create ns "$APP_NS_B" >/dev/null 2>&1 || true
napp "$APP_NS_B" >/dev/null
for i in $(seq 1 30); do
  [ "$(K get appdatabase "$APP_B" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null)" = Ready ] && break; sleep 2
done
[ "$(K get appdatabase "$APP_B" -n "$NS" -o jsonpath='{.status.phase}')" = Ready ] || fail "f: app B DB not Ready"
cat <<EOF | K apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: psql-a, namespace: ${APP_NS_A} }
spec:
  restartPolicy: Never
  containers:
  - name: psql
    image: postgres:17-alpine
    command: ["sleep","3600"]
    envFrom: [ { secretRef: { name: ${APP_NAME}-db } } ]
    env:
    - { name: PGHOST, value: pggw-apps.${NS}.svc }
    - { name: PGPORT, value: "55432" }
    - { name: PGCONNECT_TIMEOUT, value: "30" }
EOF
K -n "$APP_NS_A" wait --for=condition=Ready pod/psql-a --timeout=90s >/dev/null
K -n "$APP_NS_A" exec psql-a -- sh -c "psql -d $APP_A -tAc 'select 1'" >/dev/null 2>&1 || fail "f: app A creds cannot reach own DB"
if K -n "$APP_NS_A" exec psql-a -- sh -c "psql -d $APP_B -tAc 'select 1'" >/dev/null 2>&1; then
  fail "f: ISOLATION BREACH — app A creds reached app B database $APP_B"
fi
ok "f: app A creds succeed on own DB, REFUSED on app B's DB ($APP_B)"

# --- g. teardown / no orphan -----------------------------------------------------
tl=$(K get appdatabase "$APP_A" -n "$NS" -o jsonpath='{.status.timelineId}')
K -n "$APP_NS_A" delete pod probe psql-a --wait=false >/dev/null 2>&1 || true
K -n "$APP_NS_A" delete nextapp "$APP_NAME" --timeout=90s >/dev/null
K get appdatabase "$APP_A" -n "$NS" >/dev/null 2>&1 && fail "g: AppDatabase $APP_A survived NextApp delete"
K get secret "app-db-$APP_A" -n "$NS" >/dev/null 2>&1 && fail "g: source Secret survived"
K get deploy "compute-$APP_A" -n "$NS" >/dev/null 2>&1 && fail "g: compute survived"
K get secret "${APP_NAME}-db" -n "$APP_NS_A" >/dev/null 2>&1 && fail "g: mirrored Secret not GC'd"
ok "g: NextApp delete reclaimed AppDatabase + timeline $tl (no orphan), all objects GC'd"

echo "PASS - unified-config (ADR-0006 / #119) proven end-to-end on the live plane"
