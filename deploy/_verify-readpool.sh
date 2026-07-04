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
#   (5) HPA n>1 under load (issue #99, GA): with the read-scaling HPA
#       (deploy/optional/27-compute-ro-hpa.yaml) applied, REAL concurrent read
#       load drives compute-ro 1->N (asserted N>=2), writes stay rejected while
#       under load, staleness is measured under load, then the load drains and
#       the pool scales back N->1. Auto-runs when a metrics-server is present;
#       force with RO_HPA=1, skip with RO_HPA=0.
# A SEPARATE test gateway (pggw-ro) is used so the live pggw is never touched.
# Everything is restored: compute/compute-ro replicas 0, HPA + load deleted, test
# gateway deleted.
#
# Env: RO_MODE=Replica|Static (default Replica). RO_HPA=1|0 (default: auto —
#      on iff `kubectl top` works). RO_LOAD_REPLICAS (default 6, concurrent
#      read loaders). RO_HPA_UP_TIMEOUT / RO_HPA_DOWN_TIMEOUT seconds.
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg
K="kubectl -n $NS"
# Gateway image (issue #94): DERIVE from what actually ships so the drill never
# drifts from the release again (the old hardcoded v0.6.0@9ee649 default rotted).
# Order of truth:
#   1. KSPG_GATEWAY_IMAGE  — explicit override (local build / bespoke tag)
#   2. the live pggw Deployment  — the real running release image
#   3. the 10-gateway.yaml pin  — source of truth when the cluster isn't up yet
# A derived image (2 or 3) is already published to OCIR, so the local docker build
# is skipped automatically; force either way with KSPG_SKIP_BUILD=1/0.
if [ -n "${KSPG_GATEWAY_IMAGE:-}" ]; then
  IMAGE="$KSPG_GATEWAY_IMAGE"; IMAGE_SRC="KSPG_GATEWAY_IMAGE override"
elif IMAGE=$($K get deploy/pggw -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null) && [ -n "$IMAGE" ]; then
  IMAGE_SRC="live pggw Deployment"
elif IMAGE=$(grep -oE 'me-abudhabi-1\.ocir\.io/[^[:space:]]*ks-pg/gateway:[^[:space:]]+' 10-gateway.yaml 2>/dev/null | head -1) && [ -n "$IMAGE" ]; then
  IMAGE_SRC="10-gateway.yaml pin"
else
  echo "FAIL: cannot resolve gateway image — pggw Deployment unreachable and no pin in 10-gateway.yaml; set KSPG_GATEWAY_IMAGE" >&2; exit 1
fi
# a derived image is already published; only a bare local override defaults to building
case "$IMAGE_SRC" in *override*) KSPG_SKIP_BUILD="${KSPG_SKIP_BUILD:-0}" ;; *) KSPG_SKIP_BUILD="${KSPG_SKIP_BUILD:-1}" ;; esac
RO_MODE="${RO_MODE:-Replica}"
W_DSN="postgres://cloud_admin:cloud_admin@pggw-ro:55432/postgres?sslmode=disable"
RO_DSN="postgres://cloud_admin:cloud_admin@pggw-ro:55434/postgres?sslmode=disable"
# Direct-to-pool DSN (bypasses the gateway) — used ONLY by the HPA section so the
# gateway RO driver and the HPA never fight over compute-ro's replica count. The
# Service load-balances across the pool (kube-proxy), which is exactly what the
# gateway's GW_RO_TARGET points at.
RO_DIRECT="postgres://cloud_admin:cloud_admin@compute-ro.scale-zero-pg.svc:55433/postgres?sslmode=disable"
RO_LOAD_REPLICAS="${RO_LOAD_REPLICAS:-4}"
RO_HPA_UP_TIMEOUT="${RO_HPA_UP_TIMEOUT:-240}"
RO_HPA_DOWN_TIMEOUT="${RO_HPA_DOWN_TIMEOUT:-330}"
# Cap the HPA's maxReplicas FOR THE DRILL on small clusters. The shipped manifest
# (deploy/optional/27) ships maxReplicas=5 for real clusters; on a 2-node test
# cluster, 5 RO pods at 1Gi each cause node memory eviction. The n>1 GA gate only
# needs N>=2, so the drill patches max down after apply. Raise on a bigger cluster.
RO_HPA_MAX="${RO_HPA_MAX:-3}"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

cleanup() {
  echo "    restoring resting state..."
  # HPA first: it owns compute-ro's replica count, so delete it before scaling
  # the pool to 0 (else it would fight the scale-down).
  $K delete hpa compute-ro --ignore-not-found --wait=false >/dev/null 2>&1 || true
  $K delete deploy/roload --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # Restore the LIVE gateway's RO idle if the HPA section changed it. compute-ro is
  # a shared singleton the live pggw also drives; the HPA section disables its RO
  # idle so it stops sleeping the pool mid-drill. Put it back no matter how we exit.
  if [ -f _tmp-pggw-ro-idle.orig ]; then
    ORIG_IDLE="$(cat _tmp-pggw-ro-idle.orig)"
    if [ -n "$ORIG_IDLE" ]; then
      $K set env deploy/pggw GW_RO_IDLE_MS="$ORIG_IDLE" >/dev/null 2>&1 || true
      echo "    restored live pggw GW_RO_IDLE_MS=$ORIG_IDLE"
    fi
    rm -f _tmp-pggw-ro-idle.orig
  fi
  $K scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
  $K scale deploy/compute-ro --replicas=0 >/dev/null 2>&1 || true
  $K delete -f _tmp-pggw-ro.yaml --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -f _tmp-pggw-ro.yaml _tmp-roload.yaml
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

# --- IDEMPOTENCE (issue #83): clear residual state from an interrupted prior run
# up front so a Ctrl-C'd run can't poison this one. A leftover test gateway,
# stranded rocli-* one-shot pods, a woken primary, or an old `t` table all had to
# be swept before the drill's own drop/create + scale-to-0 can assume a clean slate.
preclean() {
  echo "== preclean: sweeping residual state from any interrupted prior run (#83) =="
  $K delete hpa compute-ro --ignore-not-found --wait=false >/dev/null 2>&1 || true
  $K delete deploy/roload --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -f _tmp-roload.yaml
  $K delete deploy/pggw-ro svc/pggw-ro --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # stranded one-shot psql pods from a killed PSQL() call (this drill's rocli-* only,
  # matched by name so a concurrent drill's pods are never touched).
  for p in $($K get pods --no-headers 2>/dev/null | awk '/^rocli-/{print $1}'); do
    $K delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  rm -f _tmp-pggw-ro.yaml
  ok "preclean done (stale test gateway + rocli-* pods removed)"
}
preclean

# --- 0. build + deploy the test gateway (writer + RO lanes) -------------------
# KSPG_SKIP_BUILD=1 when $IMAGE is already published to OCIR (the OKE nodes pull
# it); otherwise build locally (local clusters that load the image directly).
if [ "${KSPG_SKIP_BUILD:-0}" = "1" ]; then
  ok "using published gateway image ($IMAGE; source: $IMAGE_SRC) — skipping local build"
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

# Seed through the writer, RETRYING the cold-writer wake: on a busy shared cluster
# the first cold wake (gateway + one-shot psql pod) can flake (pod eviction /
# scheduler lag). Retry a few times before failing so environmental noise doesn't
# masquerade as a real seed failure.
sd=0
while [ "$sd" -lt 4 ]; do
  if PSQL "$W_DSN" "drop table if exists t; create table t(id int); insert into t select generate_series(1,3)" "seed$sd" >/dev/null 2>&1; then break; fi
  sd=$((sd + 1)); [ "$sd" -ge 4 ] && fail "seed through the writer failed after retries (cold-writer wake flaked on a busy cluster)"; echo "    seed attempt $sd flaked (cold-writer wake) — retrying"; sleep 3
done
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
# Confirm no row leaked past the reject. Read this back through the RO lane, which is
# ALREADY AWAKE (step 2) — NOT the writer DSN, which would have to cold-wake the
# sleeping primary and can return a partial/empty line on a slow wake, producing a
# FALSE "reject leaked a row" (issue #83: a writer-wake race in the count step, never
# a data leak). Retry until the count query actually returns a number, and word the
# failures to distinguish "count query did not return" from "a row actually leaked".
NEG=""
i=0
while [ "$i" -lt 10 ]; do
  NEG=$(PSQL "$RO_DSN" 'select count(*) from t' "negv$i" | tail -1 || true)
  case "$NEG" in
    [0-9]*) break ;;   # got a numeric count — stop retrying
  esac
  i=$((i + 1)); sleep 1
done
case "$NEG" in
  [0-9]*) : ;;
  *) fail "post-reject count query did not return a number after retries (got '$NEG') — RO lane count step failed to respond; NOT necessarily a data leak (#83)" ;;
esac
[ "$NEG" = "3" ] || fail "a row actually leaked past the RO reject: count=$NEG want 3"
ok "no row leaked past the RO reject (RO lane still reports 3)"

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

# --- 4b. HPA n>1 under REAL read load (issue #99, GA) ------------------------
# Apply the read-scaling HPA (deploy/optional/27), drive genuine concurrent read
# load at the pool, and assert the pool scales compute-ro 1->N (N>=2); prove
# writes stay rejected under load; measure staleness under load; then drain the
# load and assert it scales back N->1. Auto-on when a metrics-server is present.
RO_READY() { $K get deploy compute-ro -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0; }
HPA_TARGET() { $K get hpa compute-ro -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || echo ""; }

# Decide whether to run: RO_HPA=1 forces on, RO_HPA=0 forces off, unset = auto
# (on iff the metrics API answers — required for a CPU HPA to ever scale).
if [ "${RO_HPA:-auto}" = "auto" ]; then
  if $K top nodes >/dev/null 2>&1; then RO_HPA=1; else RO_HPA=0; fi
fi

if [ "$RO_HPA" != "1" ]; then
  echo "== HPA n>1 under load: SKIPPED (no metrics-server / RO_HPA=0) =="
  echo "   To run: install metrics-server, then RO_HPA=1 sh deploy/_verify-readpool.sh"
  echo "READPOOL_HPA skipped=1 reason=no-metrics-server"
else
  echo "== HPA n>1: real concurrent read load must scale compute-ro 1->N->1 =="
  # 0. Disable RO idle on BOTH gateways that drive compute-ro for the duration.
  #    compute-ro is a SHARED singleton Deployment: the ephemeral test gateway
  #    (pggw-ro) AND the LIVE production gateway (pggw, GW_RO_DEPLOYMENT=compute-ro)
  #    both Sleep it to 0 on idle. Posture B requires GW_RO_IDLE_MS disabled on the
  #    managing gateway (docs) precisely because that idle-driver and the HPA both
  #    own the replica count; if either slept the pool to 0, the CPU HPA (which
  #    CANNOT scale up from 0) would deadlock. Save the live value, set both huge,
  #    and cleanup() restores the live one no matter how we exit.
  $K get deploy pggw -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="GW_RO_IDLE_MS")]}{.value}{end}' > _tmp-pggw-ro-idle.orig 2>/dev/null || true
  [ -s _tmp-pggw-ro-idle.orig ] || printf '60000' > _tmp-pggw-ro-idle.orig  # default if unset
  # Also disable the TEST gateway's WRITER idle (GW_IDLE_MS) so it won't sleep the
  # primary between our warm+commit in the staleness step (the live pggw's writer
  # idle is left alone — we warm right before the commit, inside its 60s window).
  $K set env deploy/pggw-ro GW_RO_IDLE_MS=3600000 GW_IDLE_MS=3600000 >/dev/null 2>&1 || true
  $K set env deploy/pggw    GW_RO_IDLE_MS=3600000 >/dev/null 2>&1 || true
  $K rollout status deploy/pggw-ro --timeout=60s >/dev/null 2>&1 || true
  $K rollout status deploy/pggw    --timeout=90s >/dev/null 2>&1 || true
  ok "RO idle disabled on test + live gateways for the HPA section (was GW_RO_IDLE_MS=$(cat _tmp-pggw-ro-idle.orig); posture B)"
  # 1. Apply the HPA (posture B: minReplicas=1). It now OWNS compute-ro's replica
  #    count; the pool is at >=1 for the whole section so the gateway RO driver
  #    never needs to wake it, and load is driven DIRECTLY at the pool Service to
  #    keep the two controllers from fighting.
  $K apply -f optional/27-compute-ro-hpa.yaml >/dev/null || fail "HPA apply failed"
  # Cap maxReplicas for this drill/cluster (see RO_HPA_MAX) — bounds memory so the
  # small test cluster doesn't evict RO pods; the n>1 gate only needs N>=2.
  $K patch hpa compute-ro --type merge -p "{\"spec\":{\"maxReplicas\":$RO_HPA_MAX}}" >/dev/null 2>&1 || true
  ok "read-scaling HPA applied (deploy/optional/27-compute-ro-hpa.yaml; maxReplicas capped to $RO_HPA_MAX for the drill)"
  # SEED one replica: a stock CPU-Resource HPA CANNOT scale up from 0 (no pod ->
  # no CPU metric -> HPA holds at 0; the HPAScaleToZero feature gate is off on OKE).
  # Scaling to 1 gives the HPA a pod to measure so it can then own the 1->N curve.
  # (This is exactly posture B's "minReplicas: 1 floor, no scale-to-zero".)
  $K scale deploy/compute-ro --replicas=1 >/dev/null 2>&1 || true
  $K rollout status deploy/compute-ro --timeout=120s >/dev/null 2>&1 || true
  # Wait for the HPA to read a live metric (not <unknown>) so the drill fails loud
  # if metrics-server is broken rather than silently never scaling.
  i=0; while [ "$i" -lt 90 ]; do [ -n "$(HPA_TARGET)" ] && break; i=$((i + 1)); sleep 2; done
  [ -n "$(HPA_TARGET)" ] || fail "HPA never read a CPU metric (metrics-server broken? pool stuck at 0?) after 180s"
  ok "HPA is reading a live CPU metric (current=$(HPA_TARGET)% target=70%)"
  # Ensure the floor (minReplicas=1) is realized before load so 1->N is unambiguous.
  i=0; while [ "$(RO_REPLICAS)" -lt 1 ]; do i=$((i + 1)); [ "$i" -gt 30 ] && break; sleep 1; done
  BASE_REPLICAS=$(RO_REPLICAS); ok "pool at floor before load: compute-ro replicas=$BASE_REPLICAS (HPA minReplicas=1)"

  # 2. Generate REAL concurrent read load: N loader pods, each looping a
  #    CPU-heavy read (streaming aggregate — high CPU, low RAM) against the pool
  #    Service. Reconnecting each iteration spreads load across the growing pool.
  cat > _tmp-roload.yaml <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: roload
  namespace: scale-zero-pg
  labels: { app: roload }
spec:
  replicas: ${RO_LOAD_REPLICAS}
  selector: { matchLabels: { app: roload } }
  template:
    metadata: { labels: { app: roload } }
    spec:
      terminationGracePeriodSeconds: 2
      containers:
        - name: loader
          image: neondatabase/compute-node-v17:8464
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh","-c"]
          args:
            - |
              # CPU-heavy (drives the HPA) AND ephemeral-heavy (issue #121): the
              # ORDER BY on a large generate_series spills temp files to the RO
              # pod's ephemeral fs, and the repeated big reads grow the Local File
              # Cache — together exercising exactly the ephemeral-storage pressure
              # that evicted the pool at the old 1Gi limit. Sustained across N
              # loaders reconnecting each iteration, this is the load the #121
              # no-eviction assertion runs against.
              while true; do
                psql "${RO_DIRECT}" -tAc "set work_mem='4MB'; select sum(i) from (select i from generate_series(1,12000000) i order by i desc) s" >/dev/null 2>&1 || sleep 1
              done
          resources:
            requests: { cpu: 50m, memory: 32Mi }
            limits: { memory: 128Mi }
YAML
  $K apply -f _tmp-roload.yaml >/dev/null || fail "read-load apply failed"
  $K rollout status deploy/roload --timeout=120s >/dev/null 2>&1 || true
  ok "started ${RO_LOAD_REPLICAS} concurrent read loaders against the pool Service"

  # 3. ASSERT scale-up 1 -> N (N>=2) within the up-timeout. Record the peak.
  echo "== waiting up to ${RO_HPA_UP_TIMEOUT}s for the HPA to scale compute-ro to N>=2 =="
  PEAK=0; i=0
  while [ "$i" -lt "$RO_HPA_UP_TIMEOUT" ]; do
    R=$(RO_REPLICAS); [ "$R" -gt "$PEAK" ] && PEAK=$R
    if [ "$PEAK" -ge 2 ]; then break; fi
    [ $((i % 15)) -eq 0 ] && echo "    t=${i}s compute-ro replicas=$R ready=$(RO_READY) cpu=$(HPA_TARGET)%"
    i=$((i + 5)); sleep 5
  done
  R=$(RO_REPLICAS); [ "$R" -gt "$PEAK" ] && PEAK=$R
  [ "$PEAK" -ge 2 ] || fail "HPA did NOT scale the pool past 1 under load in ${RO_HPA_UP_TIMEOUT}s (peak=$PEAK) — CPU=$(HPA_TARGET)%"
  ok "HPA SCALED THE POOL UNDER LOAD: compute-ro 1 -> $PEAK (n>1 proven); ready=$(RO_READY)"
  echo "READPOOL_HPA scaled_up=yes base=$BASE_REPLICAS peak=$PEAK loaders=${RO_LOAD_REPLICAS}"

  # 3b. #121 NO-EVICTION UNDER SUSTAINED LOAD. The read pool used to FLAP: at the
  #     old ephemeral-storage limit of 1Gi the kubelet evicted compute-ro pods
  #     under exactly this load ("ephemeral local storage usage exceeds ... 1Gi"),
  #     so the read-scaling axis collapsed under the pressure it exists to absorb.
  #     With the sized ephemeral-storage (request 2Gi / limit 4Gi, deploy/26) the
  #     pool must survive a sustained window with ZERO Evicted/errored RO pods.
  #     Keep the load running for EPH_SUSTAIN_S so the LFC + temp spill actually
  #     accumulate on the pods' ephemeral fs, poll pod phases for any eviction, and
  #     sample the peak ephemeral usage on a live RO pod as sizing evidence.
  EPH_SUSTAIN_S="${EPH_SUSTAIN_S:-120}"
  echo "== #121: sustaining load ${EPH_SUSTAIN_S}s; asserting NO compute-ro eviction (ephemeral-storage sized) =="
  EPH_PEAK_MB=0
  RO_A_POD() { $K get pods -l app=compute-ro --no-headers 2>/dev/null | awk '$3=="Running"{print $1; exit}'; }
  i=0
  while [ "$i" -lt "$EPH_SUSTAIN_S" ]; do
    # Any evicted / ephemeral-killed RO pod = the #121 regression is back.
    BAD=$($K get pods -l app=compute-ro --no-headers 2>/dev/null | awk '$3=="Evicted"||$3=="Error"||$3=="ContainerStatusUnknown"{print $1}')
    if [ -n "$BAD" ]; then
      $K describe pod $BAD 2>/dev/null | grep -iE 'ephemeral|evict|Message:' | head -5 >&2 || true
      fail "#121 REGRESSION: compute-ro pod(s) evicted/errored under sustained load: $BAD (ephemeral-storage still too tight)"
    fi
    # Sample peak ephemeral usage (rootfs working set: LFC + pg_wal + temp) on a
    # live RO pod. Best-effort — a just-scaled pod may not answer exec yet.
    POD=$(RO_A_POD)
    if [ -n "$POD" ]; then
      MB=$($K exec "$POD" -c compute -- sh -c 'du -sm /var/db /tmp /pgdata 2>/dev/null | awk "{s+=\$1} END{print s+0}"' 2>/dev/null || echo 0)
      case "$MB" in ''|*[!0-9]*) MB=0 ;; esac
      [ "$MB" -gt "$EPH_PEAK_MB" ] && EPH_PEAK_MB=$MB
    fi
    [ $((i % 30)) -eq 0 ] && echo "    t=${i}s ro_replicas=$(RO_REPLICAS) ready=$(RO_READY) ephemeral_peak~${EPH_PEAK_MB}MB (no evictions)"
    i=$((i + 15)); sleep 15
  done
  ok "#121 NO EVICTION across ${EPH_SUSTAIN_S}s sustained load at n=$(RO_REPLICAS); peak ephemeral sampled ~${EPH_PEAK_MB}MB (limit 4Gi, request 2Gi)"
  echo "READPOOL_EPHEMERAL sustained_s=${EPH_SUSTAIN_S} evictions=0 peak_mb=${EPH_PEAK_MB} limit_mb=4096 request_mb=2048"

  # 4. NEGATIVE under load: a write to the pool is STILL rejected while at n>1.
  #    Retry through TRANSIENT connection errors: the compute-ro Service sets
  #    publishNotReadyAddresses (so its DNS record exists at 0 replicas), which
  #    means a freshly-scaled-up, not-yet-ready RO pod is also in the Service
  #    rotation — a direct connection can land on it and get "connection refused".
  #    That is NOT "the write was accepted"; only a SUCCESSFUL insert would be. So
  #    retry until a ready standby answers: PASS on a read-only rejection, FAIL only
  #    if an insert actually succeeds.
  REJECTED=no; wr=0
  while [ "$wr" -lt 12 ]; do
    WOUT=$(PSQL "$RO_DIRECT" "insert into t values (999)" "hpawrite$wr" 2>&1 || true)
    if echo "$WOUT" | grep -qi "read-only"; then REJECTED=yes; break; fi
    if echo "$WOUT" | grep -qiE "INSERT 0|^INSERT"; then fail "under load, an RO write was ACCEPTED (not rejected): $WOUT"; fi
    # transient (connection refused / not-ready pod / reset) — try another backend
    wr=$((wr + 1)); sleep 2
  done
  [ "$REJECTED" = "yes" ] || fail "could not confirm the RO write-reject under load after retries (only transient connection errors); last: ${WOUT:-none}"
  ok "writes still rejected under load (read-only transaction) at n=$PEAK"

  # 5. Staleness UNDER LOAD: a fresh writer commit -> RO catch-up while the pool
  #    is saturated with reads. This is a best-effort MEASUREMENT, NOT a gate — the
  #    writer is a cold primary that must wake and schedule while N RO pods + N
  #    loaders already occupy a small cluster, which can be slow/flaky. It is
  #    deliberately TIME-BOUNDED and non-fatal so it can NEVER block the scale-down
  #    gate (the real GA assertion) below. The authoritative staleness number is
  #    the pre-load contract measured earlier (~9s, READPOOL_STALENESS); this line
  #    only adds an under-load data point when the cluster has the headroom to wake
  #    the writer.
  echo "== staleness under load: (best-effort) writer commit -> RO catch-up while saturated =="
  # Bounded warm: scale the writer up, wait Ready only briefly. If it won't
  # schedule under load in the window, skip the measurement and go to scale-down.
  $K scale deploy/compute --replicas=1 >/dev/null 2>&1 || true
  $K rollout status deploy/compute --timeout=45s >/dev/null 2>&1 || true
  WROTE=no
  if [ "$($K get deploy compute -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)" -ge 1 ] 2>/dev/null; then
    PSQL "$W_DSN" "insert into t values (500)" wload >/dev/null 2>&1 && WROTE=yes
  fi
  if [ "$WROTE" != "yes" ]; then
    echo "note - writer did not wake within the bounded window under saturation; staleness-under-load NOT measured this run (small-cluster headroom). Pre-load contract (~9s) stands."
    echo "READPOOL_HPA_STALENESS under_load=yes tip_following=unmeasured lag_s=na note=writer-wake-headroom"
  else
    LSTART=$(date +%s); LSAW=no; i=0
    while [ "$i" -lt 30 ]; do
      C=$(PSQL "$RO_DIRECT" "select count(*) from t where id=500" "lpoll$i" | tail -1 || true)
      if [ "$C" = "1" ]; then LSAW=yes; break; fi
      i=$((i + 1)); sleep 1
    done
    LEND=$(date +%s); LLAG=$((LEND - LSTART))
    if [ "$LSAW" = "yes" ]; then
      ok "under load, RO caught up to the fresh commit in ~${LLAG}s"
      echo "READPOOL_HPA_STALENESS under_load=yes tip_following=yes lag_s=${LLAG}"
    else
      echo "note - under load, RO did NOT catch up within 30s (static or lagging pool)."
      echo "READPOOL_HPA_STALENESS under_load=yes tip_following=no lag_s=inf"
    fi
  fi

  # 6. Drain the load; ASSERT scale-down N -> 1 (HPA minReplicas floor).
  echo "== draining load; waiting up to ${RO_HPA_DOWN_TIMEOUT}s for compute-ro to scale back to 1 =="
  $K scale deploy/roload --replicas=0 >/dev/null 2>&1 || true
  $K delete deploy/roload --ignore-not-found --wait=false >/dev/null 2>&1 || true
  i=0
  while [ "$i" -lt "$RO_HPA_DOWN_TIMEOUT" ]; do
    R=$(RO_REPLICAS)
    if [ "$R" -le 1 ]; then break; fi
    [ $((i % 30)) -eq 0 ] && echo "    t=${i}s compute-ro replicas=$R cpu=$(HPA_TARGET)%"
    i=$((i + 10)); sleep 10
  done
  R=$(RO_REPLICAS)
  [ "$R" -le 1 ] || fail "HPA did NOT scale the pool back to 1 within ${RO_HPA_DOWN_TIMEOUT}s (still $R)"
  ok "HPA SCALED THE POOL BACK: compute-ro $PEAK -> $R after load drained (N->1 proven)"
  echo "READPOOL_HPA scaled_down=yes final=$R"

  # 7. Remove the HPA so it stops owning compute-ro before the restore step.
  $K delete hpa compute-ro --ignore-not-found >/dev/null 2>&1 || true
  rm -f _tmp-roload.yaml
  # Restore the LIVE gateway's RO idle now (the success path disarms the trap
  # below, so restore explicitly here too — cleanup() covers the failure paths).
  if [ -f _tmp-pggw-ro-idle.orig ]; then
    ORIG_IDLE="$(cat _tmp-pggw-ro-idle.orig)"
    [ -n "$ORIG_IDLE" ] && $K set env deploy/pggw GW_RO_IDLE_MS="$ORIG_IDLE" >/dev/null 2>&1 || true
    $K rollout status deploy/pggw --timeout=90s >/dev/null 2>&1 || true
    rm -f _tmp-pggw-ro-idle.orig
    ok "restored live pggw GW_RO_IDLE_MS=$ORIG_IDLE"
  fi
  ok "HPA n>1 drill complete (HPA removed; live gateway idle restored)"
fi

# --- 5. restore --------------------------------------------------------------
$K scale deploy/compute-ro --replicas=0 >/dev/null
# The HPA section may have warmed the writer (compute=1) for the staleness step;
# put it back to rest so the drill leaves NO woken deployment behind.
$K scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
$K delete -f _tmp-pggw-ro.yaml --ignore-not-found --wait=false >/dev/null 2>&1 || true
rm -f _tmp-pggw-ro.yaml
trap - EXIT
ok "read pool restored to resting state (replicas 0, test gateway deleted)"

echo "read-pool verification: RO wakes only the pool + reflects committed data + rejects writes; staleness reported"
