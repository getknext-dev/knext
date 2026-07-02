#!/bin/sh
# Warm-tier drill (iteration-3, 5C). Proves the productized warm-standby tier
# works END TO END through a real gateway in warmpool mode — retiring the
# warmstandby/ shell harness whose single-writer gate the reviews flagged.
#
# It deploys a SEPARATE test gateway (pggw-warm) so the live cold path (pggw,
# kubectl mode) is never touched, then asserts:
#   (1) a cold connect through the warmpool gateway wakes the parked warm pod
#       with p50 wake latency < 1500ms over 5 samples (prototype hit 413ms);
#   (2) NEGATIVE: the single-writer gate REFUSES to open while the cold `compute`
#       deployment is up — the sacred invariant, now enforced in Go;
#   (3) re-park works: idle -> gate closes -> warm pod deleted -> fresh gated pod;
#   (4) the live cold path is still green afterward (deploy/_verify-wake.sh).
# Everything is restored: warm replicas 0, test gateway deleted.
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg
K="kubectl -n $NS"
# Canonical image (override with KSPG_GATEWAY_IMAGE for local clusters)
IMAGE="${KSPG_GATEWAY_IMAGE:-me-abudhabi-1.ocir.io/axfqznklsd2t/ks-pg/gateway:v0.3.1}"
WARM_DSN="postgres://cloud_admin:cloud_admin@pggw-warm:55432/postgres?sslmode=disable"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# --- restore on any exit -----------------------------------------------------
cleanup() {
  echo "    restoring resting state..."
  $K scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
  $K scale deploy/compute-warm --replicas=0 >/dev/null 2>&1 || true
  $K delete -f _tmp-pggw-warm.yaml --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -f _tmp-pggw-warm.yaml
}
trap cleanup EXIT

# one-shot in-cluster psql (create/wait/logs/delete — no attach race).
CLIENT_WARM() {
  P=warmcli-$$-$1
  $K run "$P" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- psql "$WARM_DSN" -tA -c "$2" >/dev/null 2>&1 || true
  $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/"$P" --timeout=120s >/dev/null 2>&1 || true
  OUT=$($K logs "$P" 2>&1 || true)
  PHASE=$($K get pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  $K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  [ "$PHASE" = "Succeeded" ] || { echo "$OUT"; return 1; }
  echo "$OUT"
}

# read one metrics.json field from the single test-gateway pod.
MC=0
WARM_METRIC() { # $1 field
  MC=$((MC + 1))
  IP=$($K get pods -l app=pggw-warm -o jsonpath='{.items[0].status.podIP}' 2>/dev/null)
  $K run "wmetric-$$-$MC" --image=curlimages/curl:8.11.1 --restart=Never --rm -i --quiet \
    --command -- sh -c "curl -s http://$IP:9090/metrics.json | grep -o '\"$1\": *[0-9.]*' | head -1 | grep -o '[0-9.]*\$'" 2>/dev/null | tr -d '\r'
}

COMPUTE_PODS() { $K get pods -l app=compute --no-headers 2>/dev/null | grep -c . || true; }

# wait until a warm pod exists that is GATED (WARM_GATE_WAITING, not yet OPEN)
# and echo its name. That is the parked state a warm wake is measured from.
wait_parked() {
  i=0
  while :; do
    POD=$($K get pods -l app=compute-warm -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [ -n "$POD" ]; then
      L=$($K logs "$POD" 2>/dev/null || true)
      case "$L" in
        *WARM_GATE_OPEN*) : ;;                       # already booted, not parked
        *WARM_GATE_WAITING*) echo "$POD"; return 0 ;; # freshly gated = parked
      esac
    fi
    i=$((i + 1)); [ "$i" -gt 150 ] && return 1
    sleep 1
  done
}

# --- 0. build + deploy the test gateway (warmpool mode) ----------------------
echo "== building gateway image ($IMAGE) =="
( cd ../gateway && docker build -q -t "$IMAGE" . >/dev/null ) || fail "gateway image build failed"
ok "gateway image built"

# The test gateway reuses the pggw ServiceAccount; ensure its Role can delete
# pods (warmpool re-park). Source of truth: 10-gateway.yaml — applied here as the
# Role ONLY, so the live pggw Deployment is never touched/rolled.
$K apply -f - >/dev/null <<'RBAC' || fail "warmpool RBAC apply failed"
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: pggw-scaler, namespace: scale-zero-pg }
rules:
  - { apiGroups: ["apps"], resources: ["deployments/scale"], verbs: ["get", "patch", "update"] }
  - { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list"] }
  - { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "delete"] }
RBAC
ok "warmpool RBAC (pods:delete) ensured on the pggw Role"

cat > _tmp-pggw-warm.yaml <<'YAML'
# EPHEMERAL test gateway for the warm-tier drill. Reuses the pggw ServiceAccount
# (which now carries pods:delete for warmpool re-park). Deleted on drill exit.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pggw-warm
  namespace: scale-zero-pg
  labels: { app: pggw-warm }
spec:
  replicas: 1
  selector: { matchLabels: { app: pggw-warm } }
  template:
    metadata: { labels: { app: pggw-warm } }
    spec:
      serviceAccountName: pggw
      imagePullSecrets:
        - name: ocir-pull # no-op where the Secret doesn't exist
      containers:
        - name: gateway
          image: ${IMAGE}
          imagePullPolicy: IfNotPresent
          env:
            - { name: GW_PORT, value: "55432" }
            - { name: GW_METRICS_PORT, value: "9090" }
            - { name: GW_COMPUTE_MODE, value: "warmpool" }
            - { name: GW_GATE_PORT, value: "9091" }
            - { name: GW_K8S_NAMESPACE, value: "scale-zero-pg" }
            - { name: GW_WARM_DEPLOYMENT, value: "compute-warm" }
            - { name: GW_WARM_COLD_DEPLOYMENT, value: "compute" }
            - { name: GW_TARGET, value: "compute-warm.scale-zero-pg.svc:55433" }
            - { name: GW_IDLE_MS, value: "8000" }        # short: drives re-park between samples
            - { name: GW_WAKE_TIMEOUT_MS, value: "60000" }
            - { name: GW_RETRY_MS, value: "100" }
          ports:
            - { name: pg, containerPort: 55432 }
            - { name: gate, containerPort: 9091 }
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
  name: pggw-warm
  namespace: scale-zero-pg
  labels: { app: pggw-warm }
spec:
  type: ClusterIP
  selector: { app: pggw-warm }
  ports:
    - { name: pg, port: 55432, targetPort: pg }
    - { name: gate, port: 9091, targetPort: gate }   # warm pod polls this
    - { name: metrics, port: 9090, targetPort: metrics }
YAML
sed -i.sedbak \"s|\${IMAGE}|${IMAGE}|\" _tmp-pggw-warm.yaml && rm -f _tmp-pggw-warm.yaml.sedbak
$K apply -f _tmp-pggw-warm.yaml >/dev/null || fail "test gateway apply failed"
$K rollout status deploy/pggw-warm --timeout=120s >/dev/null || fail "test gateway not ready"
ok "test gateway pggw-warm (warmpool mode) ready"

# --- 1. enable the warm deployment, point it at the test gateway's gate -------
# 54 carries the gated warm entrypoint (entrypoint-warm.sh) in the compute-files
# ConfigMap; apply it so the warm pod can find it (config.json/cold entrypoint
# are unchanged, so the cold compute is unaffected).
$K apply -f 54-compute-files.yaml >/dev/null || fail "54-compute-files apply failed"
$K apply -f 25-compute-warm.yaml >/dev/null || fail "25-compute-warm apply failed"
$K set env deploy/compute-warm WARM_GATE_ADDR=pggw-warm.scale-zero-pg.svc:9091 >/dev/null
$K scale deploy/compute --replicas=0 >/dev/null
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i + 1)); [ "$i" -gt 60 ] && fail "cold compute did not drain"; sleep 1; done
$K scale deploy/compute-warm --replicas=1 >/dev/null
wait_parked >/dev/null || fail "warm pod never reached the gate (parked state)"
ok "warm pod parked at the gate; cold compute drained (single-writer safe)"

# --- 2. seed the shared timeline through the warm path ------------------------
CLIENT_WARM seed "drop table if exists t; create table t(id int); insert into t select generate_series(1,3)" >/dev/null \
  || fail "seed through warm gateway failed"
[ "$(CLIENT_WARM seedv 'select count(*) from t' | tail -1)" = "3" ] || fail "seed verify != 3 rows"
ok "one-table test db seeded through the warm gateway (3 rows)"

# --- 3. wake latency: 5 samples, each from a freshly re-parked pod ------------
echo "== measuring warm wake latency (5 samples, re-park between each) =="
SAMPLES=""
n=1
while [ "$n" -le 5 ]; do
  wait_parked >/dev/null || fail "warm pod never re-parked before sample $n (phantom keepalive?)"
  OUT=$(CLIENT_WARM "s$n" 'select count(*) from t' | tail -1) || fail "warm wake sample $n failed"
  [ "$OUT" = "3" ] || fail "warm wake sample $n returned '$OUT', want 3 (real page-fetch attach)"
  LAT=$(WARM_METRIC wake_latency_ms_last); LAT=${LAT%.*}
  [ -n "$LAT" ] || fail "could not read wake latency for sample $n"
  echo "  sample $n: ${LAT}ms"
  SAMPLES="$SAMPLES $LAT"
  n=$((n + 1))
done
# p50 = median of 5 = 3rd smallest
P50=$(printf '%s\n' $SAMPLES | sort -n | sed -n '3p')
echo "  wake latency samples:${SAMPLES}  ->  p50=${P50}ms"
[ "$P50" -lt 1500 ] || fail "warm wake p50 ${P50}ms exceeds the 1500ms bound"
ok "warm wake p50 ${P50}ms < 1500ms (5 samples, gateway-measured)"

# --- 4. NEGATIVE: single-writer gate refuses while cold compute is up ---------
echo "== negative test: gate must refuse while cold compute holds the timeline =="
wait_parked >/dev/null || fail "warm pod not parked before negative test"
$K scale deploy/compute --replicas=1 >/dev/null
$K rollout status deploy/compute --timeout=120s >/dev/null || fail "cold compute did not come up for the negative test"
if CLIENT_WARM neg 'select 1' >/dev/null 2>&1; then
  fail "SINGLE-WRITER BREACH: warm wake succeeded while cold compute was up"
fi
G=$(WARM_METRIC gate_open); G=${G%.*}
[ "${G:-0}" = "0" ] || fail "gate reported open ($G) during single-writer refusal"
$K logs deploy/pggw-warm 2>/dev/null | grep -q 'single-writer' || fail "gateway did not log a single-writer refusal"
ok "gate REFUSED to open while cold compute was up (single-writer enforced in Go, gate_open=0)"
$K scale deploy/compute --replicas=0 >/dev/null
i=0; while [ "$(COMPUTE_PODS)" != "0" ]; do i=$((i + 1)); [ "$i" -gt 60 ] && fail "cold compute did not re-drain"; sleep 1; done
ok "cold compute re-drained"

# --- 5. explicit re-park proof: idle -> pod deleted -> fresh gated pod --------
echo "== re-park proof =="
OLD=$(wait_parked) || fail "no parked warm pod for re-park proof"
OLDUID=$($K get pod "$OLD" -o jsonpath='{.metadata.uid}' 2>/dev/null)
CLIENT_WARM rp 'select 1' >/dev/null || fail "re-park wake failed"
NEW=$(wait_parked) || fail "warm pod never re-parked after idle"
NEWUID=$($K get pod "$NEW" -o jsonpath='{.metadata.uid}' 2>/dev/null)
[ "$OLDUID" != "$NEWUID" ] || fail "warm pod not re-parked (same pod uid) — Sleep did not delete it"
ok "idle -> gate closed -> warm pod deleted -> fresh gated pod ($OLD -> $NEW)"

# --- 6. restore, then prove the live cold path is still green -----------------
$K scale deploy/compute-warm --replicas=0 >/dev/null
$K delete -f _tmp-pggw-warm.yaml --ignore-not-found --wait=false >/dev/null 2>&1 || true
rm -f _tmp-pggw-warm.yaml
trap - EXIT
ok "warm tier restored to resting state (replicas 0, test gateway deleted)"

echo "== verifying the live cold path is unaffected =="
sh ./_verify-wake.sh || fail "live cold wake path regressed after the warm-tier drill"

echo "warm-tier verification: gate + single-writer + re-park + latency all passed; cold path intact"
