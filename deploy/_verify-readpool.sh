#!/bin/sh
# Read-only pool drill (read-replica pool, issue #66). Proves the RO lane works
# END TO END through a real gateway configured with GW_RO_PORT, asserting:
#   (1) with the PRIMARY (compute) ASLEEP, a read on the RO DSN wakes ONLY the
#       RO pool (compute-ro 0->1) — the writer stays at 0;
#   (2) the RO pool reflects the primary's committed data;
#   (3) NEGATIVE: a write on the RO DSN is cleanly REJECTED (read-only txn);
#   (4) staleness: if the pool is tip-following (RO_MODE=Replica), a fresh writer
#       commit propagates to the RO pool — measured in ms. If static, that is
#       reported honestly (reads frozen at attach LSN).
# A SEPARATE test gateway (pggw-ro) is used so the live pggw is never touched.
# Everything is restored: compute/compute-ro replicas 0, test gateway deleted.
#
# Env: RO_MODE=Replica|Static (default Replica).
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg
K="kubectl -n $NS"
IMAGE="${KSPG_GATEWAY_IMAGE:-me-abudhabi-1.ocir.io/axfqznklsd2t/ks-pg/gateway:v0.3.1}"
RO_MODE="${RO_MODE:-Replica}"
W_DSN="postgres://cloud_admin:cloud_admin@pggw-ro:55432/postgres?sslmode=disable"
RO_DSN="postgres://cloud_admin:cloud_admin@pggw-ro:55434/postgres?sslmode=disable"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

cleanup() {
  echo "    restoring resting state..."
  $K scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
  $K scale deploy/compute-ro --replicas=0 >/dev/null 2>&1 || true
  $K delete -f _tmp-pggw-ro.yaml --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -f _tmp-pggw-ro.yaml
}
trap cleanup EXIT

# one-shot in-cluster psql against DSN $1, sql $2, label $3.
PSQL() { # $1 dsn  $2 sql  $3 label
  P=rocli-$$-$3
  $K run "$P" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=IfNotPresent \
    --restart=Never --quiet --command -- psql "$1" -tA -c "$2" >/dev/null 2>&1 || true
  $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/"$P" --timeout=120s >/dev/null 2>&1 || true
  OUT=$($K logs "$P" 2>&1 || true)
  PHASE=$($K get pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  $K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  echo "$OUT"
  [ "$PHASE" = "Succeeded" ]
}

COMPUTE_PODS() { $K get pods -l app=compute --no-headers 2>/dev/null | grep -c . || true; }
RO_REPLICAS() { $K get deploy compute-ro -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0; }
RO_MODE_SEEN() { $K logs deploy/compute-ro 2>/dev/null | grep -o 'mode=[A-Za-z]*' | head -1 || true; }

# --- 0. build + deploy the test gateway (writer + RO lanes) -------------------
# KSPG_SKIP_BUILD=1 when $IMAGE is already published to OCIR (the OKE nodes pull
# it); otherwise build locally (local clusters that load the image directly).
if [ "${KSPG_SKIP_BUILD:-0}" = "1" ]; then
  ok "using pre-published gateway image ($IMAGE) — skipping local build"
else
  echo "== building gateway image ($IMAGE) =="
  ( cd ../gateway && docker build -q -t "$IMAGE" . >/dev/null ) || fail "gateway image build failed"
  ok "gateway image built"
fi

cat > _tmp-pggw-ro.yaml <<'YAML'
# EPHEMERAL test gateway for the read-pool drill (writer lane -> compute,
# RO lane -> compute-ro). Reuses the pggw ServiceAccount. Deleted on exit.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pggw-ro
  namespace: scale-zero-pg
  labels: { app: pggw-ro }
spec:
  replicas: 1
  selector: { matchLabels: { app: pggw-ro } }
  template:
    metadata: { labels: { app: pggw-ro } }
    spec:
      serviceAccountName: pggw
      imagePullSecrets:
        - name: ocir-pull
      containers:
        - name: gateway
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          env:
            - { name: GW_PORT, value: "55432" }
            - { name: GW_METRICS_PORT, value: "9090" }
            - { name: GW_COMPUTE_MODE, value: "kubectl" }
            - { name: GW_K8S_NAMESPACE, value: "scale-zero-pg" }
            - { name: GW_K8S_DEPLOYMENT, value: "compute" }
            - { name: GW_TARGET, value: "compute.scale-zero-pg.svc:55433" }
            - { name: GW_RO_PORT, value: "55434" }
            - { name: GW_RO_DEPLOYMENT, value: "compute-ro" }
            - { name: GW_RO_TARGET, value: "compute-ro.scale-zero-pg.svc:55433" }
            - { name: GW_RO_WAKE_REPLICAS, value: "1" }
            - { name: GW_RO_IDLE_MS, value: "8000" }
            - { name: GW_IDLE_MS, value: "8000" }
            - { name: GW_WAKE_TIMEOUT_MS, value: "120000" }
            - { name: GW_RETRY_MS, value: "100" }
          ports:
            - { name: pg, containerPort: 55432 }
            - { name: ro-pg, containerPort: 55434 }
            - { name: metrics, containerPort: 9090 }
          readinessProbe:
            httpGet: { path: /healthz, port: metrics }
            initialDelaySeconds: 1
            periodSeconds: 3
          resources:
            requests: { cpu: 50m, memory: 32Mi }
            limits: { memory: 128Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: pggw-ro
  namespace: scale-zero-pg
  labels: { app: pggw-ro }
spec:
  type: ClusterIP
  selector: { app: pggw-ro }
  ports:
    - { name: pg, port: 55432, targetPort: pg }
    - { name: ro-pg, port: 55434, targetPort: ro-pg }
    - { name: metrics, port: 9090, targetPort: metrics }
YAML
sed -i.sedbak "s|\${IMAGE}|${IMAGE}|" _tmp-pggw-ro.yaml && rm -f _tmp-pggw-ro.yaml.sedbak
$K apply -f _tmp-pggw-ro.yaml >/dev/null || fail "test gateway apply failed"
$K rollout status deploy/pggw-ro --timeout=120s >/dev/null || fail "test gateway not ready"
ok "test gateway pggw-ro (writer + RO lanes) ready"

# --- 1. apply the RO pool manifests + seed via the WRITER --------------------
$K apply -f 54-compute-files.yaml >/dev/null || fail "54-compute-files apply failed"
$K apply -f 26-compute-ro.yaml >/dev/null || fail "26-compute-ro apply failed"
$K set env deploy/compute-ro RO_MODE="$RO_MODE" >/dev/null
ok "RO pool manifests applied (RO_MODE=$RO_MODE)"

PSQL "$W_DSN" "drop table if exists t; create table t(id int); insert into t select generate_series(1,3)" seed >/dev/null \
  || fail "seed through the writer failed"
[ "$(PSQL "$W_DSN" 'select count(*) from t' seedv | tail -1)" = "3" ] || fail "seed verify != 3 rows"
ok "one-table test db seeded through the writer (3 rows)"

# --- 2. primary asleep -> RO read wakes ONLY the RO pool ----------------------
echo "== primary asleep; RO read must wake only the RO pool =="
$K scale deploy/compute --replicas=0 >/dev/null
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i + 1)); [ "$i" -gt 60 ] && fail "primary did not drain"; sleep 1; done
ok "primary (compute) asleep (0 pods)"

OUT=$(PSQL "$RO_DSN" 'select count(*) from t' roread | tail -1) || fail "RO read failed"
[ "$OUT" = "3" ] || fail "RO read returned '$OUT', want 3 (RO pool reflects committed data)"
ok "RO read wakes the RO pool and returns committed data (3 rows)"
[ "$(COMPUTE_PODS)" = "0" ] || fail "PRIMARY WOKE on an RO read — routing leaked to the writer"
ok "primary stayed asleep during the RO read (compute pods still 0)"
[ "$(RO_REPLICAS)" -ge 1 ] || fail "RO pool did not scale up (compute-ro replicas < 1)"
MODE_SEEN=$(RO_MODE_SEEN)
ok "RO pool scaled 0->$(RO_REPLICAS) (${MODE_SEEN:-mode=?})"

# --- 3. NEGATIVE: writes on the RO DSN are rejected --------------------------
echo "== negative: a write on the RO DSN must be rejected =="
WOUT=$(PSQL "$RO_DSN" "insert into t values (99)" rowrite 2>&1 || true)
echo "$WOUT" | grep -qi "read-only" || fail "RO write was NOT rejected as read-only: $WOUT"
ok "RO write cleanly rejected (read-only transaction)"
[ "$(PSQL "$W_DSN" 'select count(*) from t' negv | tail -1)" = "3" ] || fail "reject leaked a row (count != 3)"
ok "no row leaked past the RO reject (still 3)"

# --- 4. staleness (tip-following only) ---------------------------------------
echo "== staleness: fresh writer commit -> RO catch-up =="
PSQL "$W_DSN" "insert into t values (4)" write4 >/dev/null || fail "writer insert(4) failed"
# poll the RO pool for the new row; measure catch-up.
START=$(date +%s)
SAW=no
i=0
while [ "$i" -lt 30 ]; do
  C=$(PSQL "$RO_DSN" 'select count(*) from t' "poll$i" | tail -1 || true)
  if [ "$C" = "4" ]; then SAW=yes; break; fi
  i=$((i + 1)); sleep 1
done
END=$(date +%s); LAG=$((END - START))
if [ "$SAW" = "yes" ]; then
  ok "TIP-FOLLOWING confirmed: RO saw the fresh commit in ~${LAG}s (replication lag)"
  echo "READPOOL_STALENESS ${MODE_SEEN:-mode=Replica} tip_following=yes lag_s=${LAG}"
else
  echo "note - RO did NOT catch up within 30s: pool is STATIC (frozen at attach LSN)."
  echo "       This is the honest fallback — advance by re-rolling / HPA scale-up."
  echo "READPOOL_STALENESS ${MODE_SEEN:-mode=Static} tip_following=no lag_s=inf"
fi

# --- 5. restore --------------------------------------------------------------
$K scale deploy/compute-ro --replicas=0 >/dev/null
$K delete -f _tmp-pggw-ro.yaml --ignore-not-found --wait=false >/dev/null 2>&1 || true
rm -f _tmp-pggw-ro.yaml
trap - EXIT
ok "read pool restored to resting state (replicas 0, test gateway deleted)"

echo "read-pool verification: RO wakes only the pool + reflects committed data + rejects writes; staleness reported"
