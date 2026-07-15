#!/bin/sh
# _verify-upgrade.sh — EXECUTE a real storage-plane upgrade, end to end, on a
# THROWAWAY plane (GA criterion #98). This is the executed sibling of the
# rehearsal (`_rehearse-upgrade.sh`, issue #50): where the rehearsal only boots
# the NEW tag clean-slate and probes its control format, THIS drill proves the
# thing an operator actually needs before touching production — that REAL DATA
# written on the OLD tag SURVIVES a rolling image upgrade to the NEW tag and is
# still queryable + writable afterward, and measures the upgrade duration and the
# client-visible downtime window.
#
# WHAT IT DOES (isolated ns `upgrade-exec`, never touches scale-zero-pg)
# ---------------------------------------------------------------------
#   1. Stands up a MINIMAL storage plane at the CURRENT pinned tag (OLD_TAG=8464):
#      storage-broker + 1 safekeeper + pageserver + a writable compute. Durability
#      tier is a CONFIGURED object store (#105): by default the OCI Object Storage
#      S3-compat endpoint (reusing the live backup Customer Secret Key), a
#      DEDICATED drill bucket + a drill-only tenant id — NO second in-cluster
#      MinIO, to spare node resources. `USE_MINIO=1` runs an in-drill MinIO instead.
#   2. Seeds REAL data (a `ledger` table + rows) and DURABLY offloads it: pushes
#      WAL past checkpoint_distance and waits until the pageserver's
#      remote_consistent_lsn advances past the seed marker — the rows are now in
#      the object store, safe even if every PVC is lost.
#   3. EXECUTES THE UPGRADE to NEW_TAG (default 17411840350, the rehearsed pair):
#      rolls storage-broker, safekeeper, pageserver, and compute images together
#      (compute<->storage version PAIR, honored), each timed. Compute is scaled to
#      0 first (downtime window opens) and back to 1 last (window closes when it
#      serves SQL again) — the honest client-visible outage.
#   4. PROVES post-upgrade, on the NEW tag: the seeded rows SURVIVE + are queryable
#      (new-tag pageserver reads old-tag-written layers/index); a NEW write works;
#      `skctl checkver` on the UPGRADED safekeeper's on-disk safekeeper.control
#      confirms the format is still v9 (an independent raw magic+version decode is
#      printed too — if it CHANGED, that is a loud finding: the upgrade becomes an
#      skctl-rewrite / KC1 pivot); and a wake cycle (compute 0->1) still works.
#   5. Reports total upgrade duration + downtime window + per-component roll times.
#
# Self-cleaning (trap): deletes ns `upgrade-exec` and, on the external path,
# best-effort removes the drill tenant's objects from the drill bucket. The MAIN
# manifests + _validate/skctl pins stay at 8464 — this drill does not bump the
# live plane; it proves the walk and records the numbers.
#
# Exit: 0 = upgrade executed, data survived, control still v9 (upgrade = manifest
#           bump; the walk is proven).
#       3 = upgrade executed, data survived, but control format DIVERGED from v9
#           (upgrade is skctl-rewrite / KC1 pivot-class — a major finding).
#       1 = infrastructure/assertion failure (upgrade path not walkable as tested).
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="--request-timeout=90s"
HERE="$(cd "$(dirname "$0")" && pwd)"

SRC_NS=scale-zero-pg
DRILL_NS="${DRILL_NS:-upgrade-exec}"
# Drill-only tenant/timeline — DISTINCT from primary (f000…), apps (a000…) and the
# objstore drill (0b1ec7…), so external-bucket page data can never collide.
TENANT=c0ffee00000000000000000000000001
TIMELINE=c0ffee00000000000000000000000002

OLD_TAG="${OLD_TAG:-8464}"          # the CURRENT pinned live pair
NEW_TAG="${NEW_TAG:-17411840350}"   # the rehearsed newer pair (issue #50 / #98)
IMG_MC=minio/mc:RELEASE.2023-01-28T20-29-38Z
DRILL_STORAGE="${DRILL_STORAGE:-6Gi}"
DRILL_MINIO_STORAGE=8Gi
FILL_ROWS="${FILL_ROWS:-300000}"    # ~300MB WAL -> forces a layer upload (durability gate)
SEED_ROWS="${SEED_ROWS:-5000}"

KD="$KUBECTL -n $DRILL_NS $RT"
KS="$KUBECTL -n $SRC_NS $RT"
WORK="$(mktemp -d)"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }
now()  { date +%s; }

CLEAN_ENDPOINT=""; CLEAN_ACCESS=""; CLEAN_SECRET=""; CLEAN_BUCKET=""
cleanup() {
  code=$?
  if [ "${KEEP_DRILL:-0}" = "1" ]; then
    info "cleanup: KEEP_DRILL=1 — leaving namespace $DRILL_NS for inspection"
    rm -rf "$WORK" 2>/dev/null || true; exit $code
  fi
  info "cleanup: deleting namespace $DRILL_NS (throwaway; PVCs go with it)"
  $KUBECTL delete ns "$DRILL_NS" --wait=false --ignore-not-found $RT >/dev/null 2>&1 || true
  if [ -n "$CLEAN_ENDPOINT" ]; then
    info "cleanup: removing drill tenant objects from $CLEAN_BUCKET on the external store"
    $KUBECTL -n "$SRC_NS" run mc-upgrade-clean --rm -i --restart=Never --image="$IMG_MC" $RT \
      --env=E="$CLEAN_ENDPOINT" --env=A="$CLEAN_ACCESS" --env=S="$CLEAN_SECRET" --env=B="$CLEAN_BUCKET" \
      --env=T="$TENANT" --command -- /bin/sh -c '
        export HOME=/tmp
        mc alias set obj "$E" "$A" "$S" --api S3v4 --path on >/dev/null 2>&1 || exit 0
        mc rm --recursive --force "obj/$B/pageserver/tenants/$T/" >/dev/null 2>&1 || true
        mc rm --recursive --force "obj/$B/safekeeper/$T/" >/dev/null 2>&1 || true
        echo cleaned' >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" 2>/dev/null || true
  exit $code
}
trap cleanup EXIT INT TERM

PSQL() { $KD exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }
RCL()  { $KD exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null | tr ',' '\n' | grep '"remote_consistent_lsn"' | head -1 | cut -d'"' -f4; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
command -v python3    >/dev/null 2>&1 || fail "python3 not found (needed for skctl checkver)"
EXPECTED_CTX="${KSPG_CONTEXT:-context-ckmva7v7zvq}"
[ "$($KUBECTL config current-context 2>/dev/null)" = "$EXPECTED_CTX" ] \
  || fail "expected kube-context '$EXPECTED_CTX' (set KSPG_CONTEXT to override)"
[ "$OLD_TAG" = "$NEW_TAG" ] && fail "OLD_TAG == NEW_TAG ($OLD_TAG) — nothing to upgrade"

echo "==================================================================="
echo " STORAGE-PLANE UPGRADE EXECUTION — issue #98 (throwaway plane)"
echo "   old (pinned) tag : $OLD_TAG"
echo "   new (target) tag : $NEW_TAG"
echo "   namespace        : $DRILL_NS (throwaway, isolated)"
echo "==================================================================="

# ---------------------------------------------------------------------------
# Resolve the durability backend (external OCI by default; USE_MINIO=1 = baseline).
if [ "${USE_MINIO:-0}" = "1" ]; then
  MODE=baseline
  OBJ_ENDPOINT="http://minio:9000"; OBJ_BUCKET="neon"; OBJ_REGION="eu-north-1"
  OBJ_ACCESS="minio-drill"
  OBJ_SECRET="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n' 2>/dev/null || echo minio-drill-secret-000000000000)"
  info "MODE=baseline — in-drill MinIO at $OBJ_ENDPOINT"
else
  MODE=external
  OBJ_ENDPOINT="${OBJSTORE_ENDPOINT:-$($KS get secret backup-s3-target -o jsonpath='{.data.endpoint}' 2>/dev/null | base64 -d || true)}"
  OBJ_BUCKET="${OBJSTORE_BUCKET:-ks-pg-upgrade-drill}"
  OBJ_REGION="${OBJSTORE_REGION:-me-abudhabi-1}"
  OBJ_ACCESS="${OBJSTORE_ACCESS:-$($KS get secret backup-s3-target -o jsonpath='{.data.access}' 2>/dev/null | base64 -d || true)}"
  OBJ_SECRET="${OBJSTORE_SECRET:-$($KS get secret backup-s3-target -o jsonpath='{.data.secret}' 2>/dev/null | base64 -d || true)}"
  [ -n "$OBJ_ENDPOINT" ] || fail "external run needs OBJSTORE_ENDPOINT (or a live backup-s3-target Secret)"
  [ -n "$OBJ_ACCESS" ] && [ -n "$OBJ_SECRET" ] || fail "external run needs OBJSTORE_ACCESS/SECRET (or a live backup-s3-target Secret)"
  [ "$OBJ_BUCKET" = "ks-pg-backup" ] && fail "refusing to run against the live backup bucket ks-pg-backup — use a dedicated OBJSTORE_BUCKET"
  CLEAN_ENDPOINT="$OBJ_ENDPOINT"; CLEAN_ACCESS="$OBJ_ACCESS"; CLEAN_SECRET="$OBJ_SECRET"; CLEAN_BUCKET="$OBJ_BUCKET"
  info "MODE=external endpoint=$OBJ_ENDPOINT bucket=$OBJ_BUCKET region=$OBJ_REGION (NO in-cluster MinIO)"
fi

# render_plane TAG — emit broker + 1 safekeeper + pageserver at image tag TAG.
# The seed-config init container appends remote_storage from the storage-objstore
# ConfigMap, EXACTLY as the shipped 53-pageserver.yaml does (idempotent: cp fresh
# toml, append one line). Called only for the initial OLD_TAG boot; the upgrade
# rolls images with `kubectl set image`, the real in-place mechanism.
render_plane() {
  _TAG="$1"; _NEON="neondatabase/neon:${_TAG}"
  cat <<YAML
apiVersion: v1
kind: ConfigMap
metadata: { name: pageserver-config, namespace: $DRILL_NS }
data:
  pageserver.toml: |
    broker_endpoint='http://storage-broker:50051'
    pg_distrib_dir='/usr/local/'
    listen_pg_addr='0.0.0.0:6400'
    listen_http_addr='0.0.0.0:9898'
    control_plane_api='http://0.0.0.0:6666'
    control_plane_emergency_mode=true
    virtual_file_io_mode="buffered"
  identity.toml: |
    id=1234
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: storage-broker, namespace: $DRILL_NS, labels: { app: storage-broker } }
spec:
  replicas: 1
  selector: { matchLabels: { app: storage-broker } }
  template:
    metadata: { labels: { app: storage-broker } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: storage-broker
          image: $_NEON
          command: ["storage_broker","--listen-addr=0.0.0.0:50051"]
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          ports: [ { name: grpc, containerPort: 50051 } ]
          readinessProbe: { tcpSocket: { port: grpc }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata: { name: storage-broker, namespace: $DRILL_NS }
spec: { selector: { app: storage-broker }, ports: [ { name: grpc, port: 50051, targetPort: grpc } ] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: safekeeper, namespace: $DRILL_NS, labels: { app: safekeeper } }
spec:
  serviceName: safekeeper
  replicas: 1
  selector: { matchLabels: { app: safekeeper } }
  template:
    metadata: { labels: { app: safekeeper } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: safekeeper
          image: $_NEON
          command: ["/bin/sh","-c"]
          args:
            - |
              ORD=\${HOSTNAME##*-}
              exec safekeeper --listen-pg=0.0.0.0:5454 --advertise-pg=\${HOSTNAME}.safekeeper:5454 \
                --listen-http=0.0.0.0:7676 --id=\$((ORD + 1)) \
                --broker-endpoint=http://storage-broker:50051 -D /data \
                --remote-storage="{endpoint='\${OBJSTORE_ENDPOINT}', bucket_name='\${OBJSTORE_BUCKET}', bucket_region='\${OBJSTORE_REGION}', prefix_in_bucket='/safekeeper/'}"
          envFrom: [ { configMapRef: { name: storage-objstore } } ]
          env:
            - { name: AWS_ACCESS_KEY_ID, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: AWS_SECRET_ACCESS_KEY, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
          ports: [ { name: pg, containerPort: 5454 }, { name: http, containerPort: 7676 } ]
          volumeMounts: [ { name: data, mountPath: /data } ]
          readinessProbe: { httpGet: { path: /v1/status, port: http }, periodSeconds: 2 }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: safekeeper, namespace: $DRILL_NS }
spec:
  clusterIP: None
  selector: { app: safekeeper }
  ports: [ { name: pg, port: 5454, targetPort: pg }, { name: http, port: 7676, targetPort: http } ]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: pageserver, namespace: $DRILL_NS, labels: { app: pageserver } }
spec:
  serviceName: pageserver
  replicas: 1
  selector: { matchLabels: { app: pageserver } }
  template:
    metadata: { labels: { app: pageserver } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      initContainers:
        - name: seed-config
          image: $_NEON
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          envFrom: [ { configMapRef: { name: storage-objstore } } ]
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              mkdir -p /data/.neon
              cp /config/pageserver.toml /config/identity.toml /data/.neon/
              printf "remote_storage={ endpoint='%s', bucket_name='%s', bucket_region='%s', prefix_in_bucket='/pageserver' }\n" \
                "\$OBJSTORE_ENDPOINT" "\$OBJSTORE_BUCKET" "\$OBJSTORE_REGION" >> /data/.neon/pageserver.toml
          volumeMounts: [ { name: data, mountPath: /data }, { name: config, mountPath: /config } ]
      containers:
        - name: pageserver
          image: $_NEON
          command: ["/usr/local/bin/pageserver","-D","/data/.neon"]
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          env:
            - { name: AWS_ACCESS_KEY_ID, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: AWS_SECRET_ACCESS_KEY, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
          ports: [ { name: pg, containerPort: 6400 }, { name: http, containerPort: 9898 } ]
          volumeMounts: [ { name: data, mountPath: /data } ]
          readinessProbe: { httpGet: { path: /v1/status, port: http }, periodSeconds: 2 }
      volumes: [ { name: config, configMap: { name: pageserver-config } } ]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: pageserver, namespace: $DRILL_NS }
spec:
  selector: { app: pageserver }
  ports: [ { name: pg, port: 6400, targetPort: pg }, { name: http, port: 9898, targetPort: http } ]
YAML
}

compute_writable() {
  _TAG="$1"
  $KD apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: compute, namespace: $DRILL_NS, labels: { app: compute } }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: compute } }
  template:
    metadata: { labels: { app: compute } }
    spec:
      securityContext: { seccompProfile: { type: RuntimeDefault } }
      terminationGracePeriodSeconds: 10
      initContainers:
        - name: wait-timeline
          image: neondatabase/neon:${_TAG}
          envFrom: [ { configMapRef: { name: compute-config } } ]
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              PS="http://\${PAGESERVER_HOST}:9898"
              until curl -sf "\${PS}/v1/tenant/\${TENANT_ID}/timeline" | grep -q "\${TIMELINE_ID}"; do echo waiting; sleep 0.5; done
      containers:
        - name: compute
          image: neondatabase/compute-node-v17:${_TAG}
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh","/compute-files/entrypoint.sh"]
          envFrom: [ { configMapRef: { name: compute-config } } ]
          ports: [ { name: pg, containerPort: 55433 } ]
          volumeMounts: [ { name: compute-files, mountPath: /compute-files } ]
          readinessProbe: { tcpSocket: { port: pg }, periodSeconds: 1, failureThreshold: 180 }
      volumes: [ { name: compute-files, configMap: { name: compute-files } } ]
---
apiVersion: v1
kind: Service
metadata: { name: compute, namespace: $DRILL_NS }
spec:
  publishNotReadyAddresses: true
  selector: { app: compute }
  ports: [ { name: pg, port: 55433, targetPort: pg } ]
YAML
}

drill_cc() {
  $KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata: { name: compute-config, namespace: $DRILL_NS }
data: { PG_VERSION: "17", PAGESERVER_HOST: "pageserver", TENANT_ID: "$TENANT", TIMELINE_ID: "$TIMELINE" }
YAML
}

dump_checkver() { # dump safekeeper.control off the SK pod, decode + skctl checkver. Sets CTL_VER/CTL_MAGIC/SKCTL_VERDICT.
  _label="$1"
  CTL=""
  n=0; while [ $n -lt 30 ]; do
    CTL="$($KD exec safekeeper-0 -- sh -c 'find /data -name safekeeper.control 2>/dev/null | head -1' 2>/dev/null || true)"
    [ -n "$CTL" ] && break; n=$((n+1)); sleep 2
  done
  [ -n "$CTL" ] || fail "no safekeeper.control on safekeeper-0 ($_label)"
  LOCAL="$WORK/${_label}.control"
  $KD exec safekeeper-0 -- sh -c "base64 < '$CTL'" 2>/dev/null \
    | python3 -c 'import sys,base64; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > "$LOCAL"
  [ -s "$LOCAL" ] || fail "could not read safekeeper.control off the pod ($_label)"
  RAW="$(python3 - "$LOCAL" <<'PY'
import struct, sys
b = open(sys.argv[1], "rb").read()
magic, ver = struct.unpack_from("<II", b, 0)
print("0x%08x %d" % (magic, ver))
PY
)"
  CTL_MAGIC="$(echo "$RAW" | cut -d' ' -f1)"
  CTL_VER="$(echo "$RAW" | cut -d' ' -f2)"
  if python3 "$HERE/skctl.py" checkver --file "$LOCAL" >/dev/null 2>&1; then
    SKCTL_VERDICT="SURVIVES"
  else
    SKCTL_VERDICT="REWRITE_REQUIRED"
  fi
  info "  [$_label] safekeeper.control: magic=$CTL_MAGIC format_version=$CTL_VER skctl=$SKCTL_VERDICT"
}

# ---------------------------------------------------------------------------
info "STEP 0: (re)create throwaway namespace $DRILL_NS + storage config"
$KUBECTL delete ns "$DRILL_NS" --ignore-not-found $RT >/dev/null 2>&1 || true
j=0; while $KUBECTL get ns "$DRILL_NS" >/dev/null 2>&1; do j=$((j+1)); [ $j -gt 60 ] && fail "old $DRILL_NS stuck terminating"; sleep 2; done
$KUBECTL create ns "$DRILL_NS" >/dev/null
$KD create secret generic storage-s3-creds \
  --from-literal=user="$OBJ_ACCESS" --from-literal=password="$OBJ_SECRET" >/dev/null
$KD create configmap storage-objstore \
  --from-literal=OBJSTORE_ENDPOINT="$OBJ_ENDPOINT" \
  --from-literal=OBJSTORE_BUCKET="$OBJ_BUCKET" \
  --from-literal=OBJSTORE_REGION="$OBJ_REGION" >/dev/null
ok "namespace $DRILL_NS + storage-s3-creds + storage-objstore ready (endpoint=$OBJ_ENDPOINT)"

if [ "$MODE" = baseline ]; then
  info "STEP 0b: deploy in-drill MinIO (baseline object store)"
  $KD apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: minio, namespace: $DRILL_NS, labels: { app: minio } }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: minio } }
  template:
    metadata: { labels: { app: minio } }
    spec:
      securityContext: { seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: minio
          image: quay.io/minio/minio:RELEASE.2022-10-20T00-55-09Z@sha256:cc144348ad1e4126766279b042804fa4f130da531cc811e91fdbcb12c6bc8881
          args: ["server","/data","--address",":9000"]
          env:
            - { name: MINIO_ROOT_USER, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
            - { name: MINIO_ROOT_PASSWORD, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          ports: [ { name: s3, containerPort: 9000 } ]
          volumeMounts: [ { name: data, mountPath: /data } ]
          readinessProbe: { httpGet: { path: /minio/health/ready, port: s3 }, periodSeconds: 2 }
      volumes: [ { name: data, persistentVolumeClaim: { claimName: minio-data } } ]
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: minio-data, namespace: $DRILL_NS }
spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_MINIO_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: minio, namespace: $DRILL_NS }
spec: { selector: { app: minio }, ports: [ { name: s3, port: 9000, targetPort: s3 } ] }
YAML
  $KD rollout status deploy/minio --timeout=180s >/dev/null || fail "drill minio not ready"
  ok "in-drill MinIO up"
fi

# ---------------------------------------------------------------------------
info "STEP 1: ensure the drill bucket on the configured endpoint"
$KD delete pod mc-ensure --ignore-not-found >/dev/null 2>&1 || true
$KD run mc-ensure --restart=Never --image="$IMG_MC" \
  --env=E="$OBJ_ENDPOINT" --env=A="$OBJ_ACCESS" --env=S="$OBJ_SECRET" --env=B="$OBJ_BUCKET" --env=R="$OBJ_REGION" \
  --command -- /bin/sh -c '
    set -e; export HOME=/tmp
    n=0; until mc alias set obj "$E" "$A" "$S" --api S3v4 --path on; do n=$((n+1)); [ $n -gt 60 ] && { echo UNREACH; exit 1; }; sleep 2; done
    mc mb --ignore-existing "obj/$B" --region "$R" 2>/dev/null || true
    mc ls "obj/$B" >/dev/null 2>&1 || { echo "bucket $B missing and uncreatable"; exit 1; }
    echo BUCKET_OK' >/dev/null
s=0; while :; do
  ph="$($KD get pod mc-ensure -o jsonpath='{.status.phase}' 2>/dev/null || echo Unknown)"
  [ "$ph" = "Succeeded" ] && break
  [ "$ph" = "Failed" ] && fail "bucket ensure failed: $($KD logs mc-ensure --tail=20 2>/dev/null)"
  s=$((s+1)); [ $s -gt 90 ] && fail "bucket ensure timed out"; sleep 2
done
$KD delete pod mc-ensure --ignore-not-found >/dev/null 2>&1 || true
ok "bucket '$OBJ_BUCKET' present on $OBJ_ENDPOINT"

# ---------------------------------------------------------------------------
info "STEP 2: boot the storage plane at the OLD tag ($OLD_TAG)"
render_plane "$OLD_TAG" | $KD apply -f - >/dev/null || fail "apply old-tag plane"
$KD rollout status deploy/storage-broker --timeout=300s >/dev/null || fail "broker not ready ($OLD_TAG)"
$KD rollout status statefulset/safekeeper --timeout=300s >/dev/null || fail "safekeeper not ready ($OLD_TAG)"
$KD rollout status statefulset/pageserver --timeout=300s >/dev/null || fail "pageserver not ready ($OLD_TAG)"
ok "storage plane Ready at $OLD_TAG (broker + safekeeper + pageserver)"

info "STEP 3: create tenant + timeline on the OLD-tag pageserver"
n=0
until $KD exec sts/pageserver -c pageserver -- /bin/sh -c "
  curl -sf -X PUT -H 'Content-Type: application/json' \
    -d '{\"mode\":\"AttachedSingle\",\"generation\":1,\"tenant_conf\":{}}' \
    http://localhost:9898/v1/tenant/$TENANT/location_config >/dev/null || exit 1
  curl -sf http://localhost:9898/v1/tenant/$TENANT/timeline | grep -q $TIMELINE && exit 0
  curl -sf -X POST -H 'Content-Type: application/json' \
    -d '{\"new_timeline_id\":\"$TIMELINE\",\"pg_version\":17}' \
    http://localhost:9898/v1/tenant/$TENANT/timeline/ >/dev/null || exit 1
  curl -sf http://localhost:9898/v1/tenant/$TENANT/timeline | grep -q $TIMELINE
" 2>/dev/null; do
  n=$((n+1)); [ $n -gt 20 ] && fail "tenant/timeline create failed after $n tries"; echo "  retry $n"; sleep 3
done
ok "tenant $TENANT + timeline created"

# compute-files (single-safekeeper) + drill compute-config on the OLD tag.
COMPUTE_FILES_SRC="$HERE/54-compute-files.yaml"
[ -f "$COMPUTE_FILES_SRC" ] || fail "missing $COMPUTE_FILES_SRC"
sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
    -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/" \
    "$COMPUTE_FILES_SRC" | $KD apply -f - >/dev/null
drill_cc

info "STEP 4: seed REAL data through a writable OLD-tag compute"
compute_writable "$OLD_TAG"
$KD rollout status deploy/compute --timeout=300s >/dev/null || fail "old-tag compute did not come up (logs: $($KD logs deploy/compute -c compute --tail=30 2>/dev/null))"
q=0; until PSQL "select 1" >/dev/null 2>&1; do q=$((q+1)); [ $q -gt 40 ] && fail "old-tag compute never accepted SQL"; sleep 2; done
PSQL "create table ledger(id int primary key, who text, amount int, note text)" >/dev/null || fail "create table failed"
PSQL "insert into ledger select g, 'acct'||(g%100), (g*7)%1000, repeat('L',32) from generate_series(1,$SEED_ROWS) g" >/dev/null || fail "seed insert failed"
SEED_SUM="$(PSQL 'select coalesce(sum(amount),0) from ledger')"
SEED_CNT="$(PSQL 'select count(*) from ledger')"
[ "$SEED_CNT" = "$SEED_ROWS" ] || fail "expected $SEED_ROWS seeded rows, got '$SEED_CNT'"
MARKER_LSN="$(PSQL 'select pg_current_wal_flush_lsn()')"
ok "seeded $SEED_CNT rows into ledger (checksum sum(amount)=$SEED_SUM), marker LSN=$MARKER_LSN"

info "STEP 5: DURABILITY GATE — offload the seeded rows to the object store"
PSQL "create table fill(id int, pad text)" >/dev/null
PSQL "insert into fill select g, repeat('x',1024) from generate_series(1,$FILL_ROWS) g" >/dev/null || fail "fill insert failed"
PSQL "checkpoint" >/dev/null
i=0; uploaded=0
while [ $i -lt 80 ]; do
  cur="$(RCL || true)"
  if [ -n "$cur" ]; then
    diff="$(PSQL "select (pg_wal_lsn_diff('$cur'::pg_lsn,'$MARKER_LSN'::pg_lsn) >= 0)" 2>/dev/null || echo f)"
    echo "   t=$((i*3))s remote_consistent_lsn=$cur past_marker=$diff"
    [ "$diff" = "t" ] && { uploaded=1; break; }
  fi
  i=$((i+1)); sleep 3
done
[ "$uploaded" = "1" ] || fail "pageserver never offloaded the seed marker to $OBJ_ENDPOINT (durability gate failed)"
ok "seeded rows are DURABLE in the object store (remote_consistent_lsn past marker)"

info "STEP 6: baseline the OLD-tag safekeeper.control before the upgrade"
dump_checkver "pre-$OLD_TAG"
PRE_VER="$CTL_VER"

# ===========================================================================
# THE UPGRADE — roll every image to NEW_TAG together (version pair), timed.
# Compute goes to 0 FIRST (downtime opens) and back to 1 LAST (downtime closes
# when it serves SQL). Storage rolls in between. This is the honest, ordered,
# in-place upgrade an operator would run against production.
# ===========================================================================
echo ""
echo "==================================================================="
echo " EXECUTING UPGRADE: $OLD_TAG -> $NEW_TAG"
echo "==================================================================="
UPG_START=$(now)

info "STEP 7a: scale compute to 0 (DOWNTIME WINDOW OPENS)"
DOWN_START=$(now)
$KD scale deploy/compute --replicas=0 >/dev/null
$KD delete pod -l app=compute --wait=true $RT >/dev/null 2>&1 || true
ok "compute at 0"

info "STEP 7b: roll storage-broker -> $NEW_TAG"
t0=$(now)
$KD set image deploy/storage-broker storage-broker="neondatabase/neon:${NEW_TAG}" >/dev/null
$KD rollout status deploy/storage-broker --timeout=420s >/dev/null || fail "broker did not roll to $NEW_TAG"
BROKER_S=$(( $(now) - t0 )); ok "storage-broker on $NEW_TAG (${BROKER_S}s)"

info "STEP 7c: roll safekeeper -> $NEW_TAG"
t0=$(now)
$KD set image statefulset/safekeeper safekeeper="neondatabase/neon:${NEW_TAG}" >/dev/null
$KD rollout status statefulset/safekeeper --timeout=420s >/dev/null || fail "safekeeper did not roll to $NEW_TAG"
SK_S=$(( $(now) - t0 )); ok "safekeeper on $NEW_TAG (${SK_S}s)"

info "STEP 7d: roll pageserver (seed-config + pageserver) -> $NEW_TAG"
t0=$(now)
$KD set image statefulset/pageserver seed-config="neondatabase/neon:${NEW_TAG}" pageserver="neondatabase/neon:${NEW_TAG}" >/dev/null
$KD rollout status statefulset/pageserver --timeout=420s >/dev/null || fail "pageserver did not roll to $NEW_TAG (MANIFEST/FORMAT breakage? logs: $($KD logs sts/pageserver -c pageserver --tail=25 2>/dev/null))"
PS_S=$(( $(now) - t0 )); ok "pageserver on $NEW_TAG (${PS_S}s)"

info "STEP 7e: roll compute -> $NEW_TAG and scale back to 1 (DOWNTIME WINDOW CLOSES on first SQL)"
t0=$(now)
$KD set image deploy/compute wait-timeline="neondatabase/neon:${NEW_TAG}" compute="neondatabase/compute-node-v17:${NEW_TAG}" >/dev/null
$KD scale deploy/compute --replicas=1 >/dev/null
$KD rollout status deploy/compute --timeout=420s >/dev/null || fail "new-tag compute did not come up (logs: $($KD logs deploy/compute -c compute --tail=30 2>/dev/null))"
q=0; until PSQL "select 1" >/dev/null 2>&1; do q=$((q+1)); [ $q -gt 60 ] && fail "new-tag compute never accepted SQL"; sleep 2; done
DOWN_END=$(now)
COMPUTE_S=$(( DOWN_END - t0 ))
DOWNTIME_S=$(( DOWN_END - DOWN_START ))
UPG_S=$(( DOWN_END - UPG_START ))
ok "compute on $NEW_TAG serving SQL (${COMPUTE_S}s)"

# ===========================================================================
# POST-UPGRADE PROOF
# ===========================================================================
echo ""
echo "==================================================================="
echo " POST-UPGRADE PROOF (running on $NEW_TAG)"
echo "==================================================================="

info "PROOF 1: seeded data SURVIVED the upgrade and is queryable"
POST_CNT="$(PSQL 'select count(*) from ledger' 2>/dev/null || echo ERR)"
POST_SUM="$(PSQL 'select coalesce(sum(amount),0) from ledger' 2>/dev/null || echo ERR)"
[ "$POST_CNT" = "$SEED_CNT" ] || fail "row count changed across upgrade: was $SEED_CNT, now $POST_CNT (DATA LOSS)"
[ "$POST_SUM" = "$SEED_SUM" ] || fail "checksum changed across upgrade: was $SEED_SUM, now $POST_SUM (DATA CORRUPTION)"
ok "all $POST_CNT seeded rows intact (checksum $POST_SUM matches pre-upgrade)"

info "PROOF 2: a NEW write works on the upgraded plane"
PSQL "insert into ledger values ($((SEED_ROWS+1)),'post-upgrade',424242,'written on $NEW_TAG')" >/dev/null || fail "post-upgrade INSERT failed"
NEWROW="$(PSQL "select note from ledger where id=$((SEED_ROWS+1))" 2>/dev/null || echo ERR)"
[ "$NEWROW" = "written on $NEW_TAG" ] || fail "post-upgrade row not read back (got '$NEWROW')"
POST_CNT2="$(PSQL 'select count(*) from ledger')"
[ "$POST_CNT2" = "$((SEED_ROWS+1))" ] || fail "post-upgrade count wrong: $POST_CNT2"
ok "new write accepted + read back; ledger now $POST_CNT2 rows"

info "PROOF 3: skctl checkver on the UPGRADED safekeeper.control"
dump_checkver "post-$NEW_TAG"
POST_VER="$CTL_VER"

info "PROOF 4: wake cycle on the upgraded plane (compute 0 -> 1)"
$KD scale deploy/compute --replicas=0 >/dev/null
$KD delete pod -l app=compute --wait=true $RT >/dev/null 2>&1 || true
WAKE_START=$(now)
$KD scale deploy/compute --replicas=1 >/dev/null
$KD rollout status deploy/compute --timeout=300s >/dev/null || fail "wake: compute did not come up"
q=0; until PSQL "select 1" >/dev/null 2>&1; do q=$((q+1)); [ $q -gt 60 ] && fail "wake: compute never served SQL"; sleep 2; done
WAKE_S=$(( $(now) - WAKE_START ))
WAKE_CNT="$(PSQL 'select count(*) from ledger')"
[ "$WAKE_CNT" = "$POST_CNT2" ] || fail "wake: data changed ($WAKE_CNT != $POST_CNT2)"
ok "wake cycle green on $NEW_TAG (${WAKE_S}s; $WAKE_CNT rows still intact)"

info "PROOF 5: the upgrade-relevant _validate contracts (version-pair + skctl coupling) hold"
# These are the two contracts an upgrade must honor (deploy/_validate.sh contract
# 12 + 22), asserted STATICALLY against the repo so the check is deterministic and
# cluster-independent. We deliberately do NOT run the FULL `_validate.sh` here: it
# server-dry-run-applies every manifest against the CURRENT context, and against a
# live cluster that already holds a completed `storage-init` Job that dry-run hits
# a spurious "field is immutable" — an environment artifact of the live plane, not
# an upgrade regression. CI runs the full `_validate.sh` against a clean cluster.
CT="$(grep -o 'neondatabase/compute-node-v[0-9]*:[a-z0-9.]*' "$HERE/20-compute.yaml" | head -1 | cut -d: -f2)"
[ -n "$CT" ] || fail "could not read the pinned compute tag from 20-compute.yaml"
VP_OK=1
for f in "$HERE"/[0-9][0-9]-*.yaml; do
  for st in $(grep -o 'neondatabase/neon:[a-z0-9.]*' "$f" | cut -d: -f2 | sort -u); do
    [ "$st" = "$CT" ] || { echo "  version-pair drift: $(basename "$f") uses neon:$st but compute is :$CT"; VP_OK=0; }
  done
  for ct in $(grep -o 'neondatabase/compute-node-v[0-9]*:[a-z0-9.]*' "$f" | cut -d: -f2 | sort -u); do
    [ "$ct" = "$CT" ] || { echo "  version-pair drift: $(basename "$f") uses compute-node:$ct but writer is :$CT"; VP_OK=0; }
  done
done
[ "$VP_OK" = 1 ] || fail "compute<->storage version-pair contract violated"
SKTAG="$(grep -oE 'SK_COMPAT_NEON_TAG[[:space:]]*=[[:space:]]*"[a-z0-9.]+"' "$HERE/skctl.py" | head -1 | sed -E 's/.*"([a-z0-9.]+)".*/\1/')"
[ "$SKTAG" = "$CT" ] || fail "skctl format-coupling contract violated: skctl targets neon:$SKTAG but plane pins :$CT"
ok "version-pair consistent (:$CT everywhere) + skctl SK_COMPAT_NEON_TAG=$SKTAG matches"
VALIDATE="green (version-pair + skctl-coupling; full _validate in CI)"

# ---------------------------------------------------------------------------
if [ "$SKCTL_VERDICT" = "SURVIVES" ] && [ "$POST_VER" = "9" ]; then
  VERDICT_EXIT=0
else
  VERDICT_EXIT=3
fi

echo ""
echo "=========================================================================="
echo " UPGRADE EXECUTION RESULT (#98)"
echo "   old -> new tag        : $OLD_TAG -> $NEW_TAG"
echo "   backend               : $MODE ($OBJ_ENDPOINT)"
echo "   seeded rows (durable) : $SEED_CNT  checksum=$SEED_SUM"
echo "   data survived         : yes ($POST_CNT rows, checksum $POST_SUM matched)"
echo "   new write post-upgrade: yes (ledger -> $POST_CNT2 rows)"
echo "   control format        : pre v$PRE_VER  ->  post v$POST_VER  (skctl: $SKCTL_VERDICT)"
echo "   -- durations --"
echo "   storage-broker roll   : ${BROKER_S}s"
echo "   safekeeper roll       : ${SK_S}s"
echo "   pageserver roll       : ${PS_S}s"
echo "   compute roll          : ${COMPUTE_S}s"
echo "   TOTAL upgrade         : ${UPG_S}s"
echo "   client DOWNTIME window: ${DOWNTIME_S}s (compute 0 -> serving SQL on $NEW_TAG)"
echo "   post-upgrade wake     : ${WAKE_S}s"
echo "   _validate.sh          : $VALIDATE"
if [ "$VERDICT_EXIT" = "0" ]; then
  echo "   => UPGRADE EXECUTED CLEAN: data survived, control still v9 (manifest bump)."
else
  echo "   => CONTROL FORMAT DIVERGED (v$POST_VER != 9): data survived but this is an"
  echo "      skctl-rewrite / KC1 pivot-class upgrade. See ADR-0002 'Upgrade posture'."
fi
echo "=========================================================================="
exit $VERDICT_EXIT
