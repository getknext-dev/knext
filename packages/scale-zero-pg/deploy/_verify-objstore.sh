#!/bin/sh
# _verify-objstore.sh — prove the pageserver runs against a CONFIGURED object
# store (issue #105), NOT only bundled MinIO.
#
# THE HEADLINE PROOF: stand up a throwaway storage plane whose pageserver +
# safekeeper offload to whatever S3 endpoint the `storage-objstore` ConfigMap
# names — by default the OCI Object Storage S3 Compatibility API with NO
# in-cluster MinIO — then:
#   1. write rows through a writable compute,
#   2. force the pageserver to UPLOAD a layer covering them (checkpoint until
#      remote_consistent_lsn advances) — pages are now in the object store,
#   3. WIPE the pageserver PVC (empty its local layer cache) and re-attach the
#      tenant, so the only place the pages can come from is the object store,
#   4. read the rows back through a STATIC read-only compute — a successful read
#      with an empty-cache pageserver proves GetPage@LSN was served from
#      object-store-fetched layers.
# Also times the offload + read-back so BENCHMARKS can compare OCI vs MinIO.
#
# BACKEND SELECTION (env):
#   OBJSTORE_ENDPOINT   set -> EXTERNAL S3 (e.g. OCI OS); NO in-cluster MinIO.
#                       unset -> BASELINE: deploy an in-drill MinIO (comparison).
#   OBJSTORE_BUCKET     external bucket (default: ks-pg-objstore-drill). Uses a
#                       DEDICATED bucket + a drill-only tenant id so it can NEVER
#                       touch the live primary's page data.
#   OBJSTORE_REGION     S3 region (default: me-abudhabi-1 for OCI AbuDhabi).
#   OBJSTORE_ACCESS/OBJSTORE_SECRET  S3 SigV4 access/secret (external only). If
#                       unset, reuse the live `backup-s3-target` Secret's pair
#                       (the same OCI Customer Secret Key that backs #4).
#
# Self-cleaning (trap): deletes the throwaway namespace and, on the external
# path, best-effort removes the drill tenant's objects from the bucket. Bounded
# kubectl calls. KSPG_CONTEXT-guarded. Owns ONLY namespace `objstore-drill`
# (+ the drill tenant prefix in the drill bucket). NEVER touches scale-zero-pg.
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="--request-timeout=60s"

SRC_NS=scale-zero-pg
DRILL_NS=objstore-drill
# Drill-only tenant/timeline — DISTINCT from the primary (f000…) and apps (a000…)
# so external-bucket page data is fully isolated.
TENANT=0b1ec700000000000000000000000001
TIMELINE=0b1ec700000000000000000000000002
REATTACH_GEN=2
IMG_NEON=neondatabase/neon:8464
IMG_COMPUTE=neondatabase/compute-node-v17:8464
IMG_MC=minio/mc:RELEASE.2023-01-28T20-29-38Z
DRILL_STORAGE=6Gi
DRILL_MINIO_STORAGE=8Gi
# WAL volume to push over the 256MB default checkpoint_distance so the pageserver
# freezes+uploads a layer covering our rows (same mechanism as _verify-restore).
FILL_ROWS="${FILL_ROWS:-300000}"

KD="$KUBECTL -n $DRILL_NS $RT"
KS="$KUBECTL -n $SRC_NS $RT"
WORK="$(mktemp -d)"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }

CLEAN_ENDPOINT=""; CLEAN_ACCESS=""; CLEAN_SECRET=""; CLEAN_BUCKET=""
cleanup() {
  code=$?
  if [ "${KEEP_DRILL:-0}" = "1" ]; then
    info "cleanup: KEEP_DRILL=1 — leaving namespace $DRILL_NS for inspection"
    rm -rf "$WORK" 2>/dev/null || true; exit $code
  fi
  info "cleanup: deleting namespace $DRILL_NS (throwaway)"
  $KUBECTL delete ns "$DRILL_NS" --wait=false --ignore-not-found $RT >/dev/null 2>&1 || true
  # External path: best-effort remove the drill tenant's objects from the bucket
  # so the drill leaves no residue in the external object store.
  if [ -n "$CLEAN_ENDPOINT" ]; then
    info "cleanup: removing drill tenant objects from $CLEAN_BUCKET on the external store"
    $KUBECTL -n "$SRC_NS" run mc-objstore-clean --rm -i --restart=Never --image="$IMG_MC" $RT \
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

DRILL_PSQL() { $KD exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }
RCL() { $KD exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null | tr ',' '\n' | grep '"remote_consistent_lsn"' | head -1 | cut -d'"' -f4; }
LRL() { $KD exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null | tr ',' '\n' | grep '"last_record_lsn"' | head -1 | cut -d'"' -f4; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
EXPECTED_CTX="${KSPG_CONTEXT:-context-ckmva7v7zvq}"
[ "$($KUBECTL config current-context 2>/dev/null)" = "$EXPECTED_CTX" ] || fail "expected kube-context '$EXPECTED_CTX' (set KSPG_CONTEXT to override)"

# ---------------------------------------------------------------------------
# Resolve the backend.
if [ -n "${OBJSTORE_ENDPOINT:-}" ]; then
  MODE=external
  OBJ_ENDPOINT="$OBJSTORE_ENDPOINT"
  OBJ_BUCKET="${OBJSTORE_BUCKET:-ks-pg-objstore-drill}"
  OBJ_REGION="${OBJSTORE_REGION:-me-abudhabi-1}"
  OBJ_ACCESS="${OBJSTORE_ACCESS:-}"
  OBJ_SECRET="${OBJSTORE_SECRET:-}"
  # Fall back to the live backup Customer Secret Key if none supplied.
  if [ -z "$OBJ_ACCESS" ] || [ -z "$OBJ_SECRET" ]; then
    info "no OBJSTORE_ACCESS/SECRET given — reusing the live backup-s3-target Customer Secret Key"
    OBJ_ACCESS="$($KS get secret backup-s3-target -o jsonpath='{.data.access}' 2>/dev/null | base64 -d || true)"
    OBJ_SECRET="$($KS get secret backup-s3-target -o jsonpath='{.data.secret}' 2>/dev/null | base64 -d || true)"
  fi
  [ -n "$OBJ_ACCESS" ] && [ -n "$OBJ_SECRET" ] || fail "external run needs OBJSTORE_ACCESS/OBJSTORE_SECRET (or a live backup-s3-target Secret)"
  [ "$OBJ_BUCKET" = "ks-pg-backup" ] && fail "refusing to run the drill against the live backup bucket ks-pg-backup — use a dedicated OBJSTORE_BUCKET"
  CLEAN_ENDPOINT="$OBJ_ENDPOINT"; CLEAN_ACCESS="$OBJ_ACCESS"; CLEAN_SECRET="$OBJ_SECRET"; CLEAN_BUCKET="$OBJ_BUCKET"
  info "MODE=external endpoint=$OBJ_ENDPOINT bucket=$OBJ_BUCKET region=$OBJ_REGION (NO in-cluster MinIO)"
else
  MODE=baseline
  OBJ_ENDPOINT="http://minio:9000"
  OBJ_BUCKET="neon"
  OBJ_REGION="eu-north-1"
  OBJ_ACCESS="minio-drill"
  OBJ_SECRET="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n' 2>/dev/null || echo minio-drill-secret-000000000000)"
  info "MODE=baseline — in-drill MinIO at $OBJ_ENDPOINT (comparison run)"
fi

# ---------------------------------------------------------------------------
info "STEP 0: (re)create throwaway namespace $DRILL_NS"
$KUBECTL delete ns "$DRILL_NS" --ignore-not-found $RT >/dev/null 2>&1 || true
j=0; while $KUBECTL get ns "$DRILL_NS" >/dev/null 2>&1; do j=$((j+1)); [ $j -gt 60 ] && fail "old $DRILL_NS stuck terminating"; sleep 2; done
$KUBECTL create ns "$DRILL_NS" >/dev/null
ok "namespace $DRILL_NS ready"

# storage-s3-creds (S3 access/secret) + storage-objstore ConfigMap — the exact
# mechanism the shipped manifests use (this is what we are proving works).
$KD create secret generic storage-s3-creds \
  --from-literal=user="$OBJ_ACCESS" --from-literal=password="$OBJ_SECRET" >/dev/null
$KD create configmap storage-objstore \
  --from-literal=OBJSTORE_ENDPOINT="$OBJ_ENDPOINT" \
  --from-literal=OBJSTORE_BUCKET="$OBJ_BUCKET" \
  --from-literal=OBJSTORE_REGION="$OBJ_REGION" >/dev/null
ok "storage-s3-creds + storage-objstore configured (endpoint=$OBJ_ENDPOINT)"

# ---------------------------------------------------------------------------
if [ "$MODE" = baseline ]; then
  info "STEP 1: deploy in-drill MinIO (baseline object store)"
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
  $KD rollout status deploy/minio --timeout=120s >/dev/null || fail "drill minio not ready"
  ok "in-drill MinIO up"
fi

# ---------------------------------------------------------------------------
info "STEP 2: ensure the bucket on the configured endpoint (SigV4 + path-style)"
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
info "STEP 3: broker + 1 safekeeper + pageserver (offload target = $OBJ_ENDPOINT)"
# pageserver-config toml WITHOUT remote_storage — seed-config appends it from the
# storage-objstore ConfigMap, EXACTLY as the shipped 53-pageserver.yaml does.
$KD apply -f - >/dev/null <<YAML
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
          image: $IMG_NEON
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
          image: $IMG_NEON
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
          image: $IMG_NEON
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
          image: $IMG_NEON
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
$KD rollout status deploy/storage-broker --timeout=120s >/dev/null || fail "drill broker not ready"
$KD rollout status statefulset/safekeeper --timeout=180s >/dev/null || fail "drill safekeeper not ready"
$KD rollout status statefulset/pageserver --timeout=180s >/dev/null || fail "drill pageserver not ready (logs: $($KD logs sts/pageserver -c pageserver --tail=25 2>/dev/null))"
# Confirm the pageserver actually rendered the CONFIGURED endpoint into its toml.
$KD exec sts/pageserver -- grep -q "endpoint='$OBJ_ENDPOINT'" /data/.neon/pageserver.toml \
  || fail "pageserver.toml did not pick up the configured endpoint $OBJ_ENDPOINT"
ok "storage plane up; pageserver offload endpoint = $OBJ_ENDPOINT"

# ---------------------------------------------------------------------------
info "STEP 4: create tenant + timeline on the object-store-backed pageserver"
# Retry the whole attach+create: a just-Ready pageserver can transiently 4xx the
# location_config PUT or the immediately-following timeline POST while the tenant
# settles into Active. Idempotent (attach re-asserts; POST skipped if present).
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
  n=$((n+1)); [ $n -gt 20 ] && fail "tenant/timeline create failed after $n tries (object store write path)"
  echo "  tenant/timeline not ready yet — retry $n"; sleep 3
done
ok "tenant $TENANT + timeline created (pageserver wrote initial layers to $OBJ_ENDPOINT)"

# compute-files (single-safekeeper spec) for the drill. NOTE: 54-compute-files.yaml
# ALSO ships a `compute-config` ConfigMap hardcoded to the PRIMARY tenant (f000…),
# so we (re)assert the DRILL compute-config (0b1ec7…) AFTER every 54 apply — else
# the primary IDs clobber ours and the compute waits forever on a foreign timeline.
COMPUTE_FILES_SRC="$(dirname "$0")/54-compute-files.yaml"
[ -f "$COMPUTE_FILES_SRC" ] || fail "missing $COMPUTE_FILES_SRC"
drill_cc() {
  $KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata: { name: compute-config, namespace: $DRILL_NS }
data: { PG_VERSION: "17", PAGESERVER_HOST: "pageserver", TENANT_ID: "$TENANT", TIMELINE_ID: "$TIMELINE" }
YAML
}
sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
    -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/" \
    "$COMPUTE_FILES_SRC" | $KD apply -f - >/dev/null
drill_cc   # re-assert the drill tenant/timeline over 54's primary compute-config
ok "drill compute-config (tenant $TENANT) + compute-files applied (single-safekeeper)"

compute_writable() {
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
          image: $IMG_NEON
          envFrom: [ { configMapRef: { name: compute-config } } ]
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              PS="http://\${PAGESERVER_HOST}:9898"
              until curl -sf "\${PS}/v1/tenant/\${TENANT_ID}/timeline" | grep -q "\${TIMELINE_ID}"; do echo waiting; sleep 0.5; done
      containers:
        - name: compute
          image: $IMG_COMPUTE
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

info "STEP 5: write rows through a writable compute + force a layer upload to the object store"
compute_writable
$KD rollout status deploy/compute --timeout=300s >/dev/null || fail "drill compute did not come up (logs: $($KD logs deploy/compute -c compute --tail=30 2>/dev/null))"
DRILL_PSQL "create table proof(id int primary key, pad text)" >/dev/null || fail "create table failed"
DRILL_PSQL "insert into proof select g, repeat('o',48) from generate_series(1,5000) g" >/dev/null || fail "insert failed"
BEFORE="$(DRILL_PSQL 'select count(*) from proof')"
[ "$BEFORE" = "5000" ] || fail "expected 5000 rows, got '$BEFORE'"
MARKER_LSN="$(DRILL_PSQL 'select pg_current_wal_flush_lsn()')"
ok "wrote 5000 rows; marker LSN=$MARKER_LSN"

info "  pushing WAL past checkpoint_distance so the pageserver uploads a layer covering the rows"
DRILL_PSQL "create table fill(id int, pad text)" >/dev/null
DRILL_PSQL "insert into fill select g, repeat('x',1024) from generate_series(1,$FILL_ROWS) g" >/dev/null || fail "fill insert failed"
DRILL_PSQL "checkpoint" >/dev/null
OFFLOAD_START=$(date +%s)
uploaded=0; i=0
while [ $i -lt 80 ]; do
  cur="$(RCL || true)"
  if [ -n "$cur" ]; then
    diff="$(DRILL_PSQL "select (pg_wal_lsn_diff('$cur'::pg_lsn,'$MARKER_LSN'::pg_lsn) >= 0)" 2>/dev/null || echo f)"
    echo "   t=$((i*3))s remote_consistent_lsn=$cur uploaded=$diff"
    [ "$diff" = "t" ] && { uploaded=1; break; }
  fi
  i=$((i+1)); sleep 3
done
OFFLOAD_END=$(date +%s)
[ "$uploaded" = "1" ] || fail "pageserver never uploaded the marker LSN to $OBJ_ENDPOINT (offload path broken)"
OFFLOAD_S=$((OFFLOAD_END - OFFLOAD_START))
ok "pages OFFLOADED to $OBJ_ENDPOINT (remote_consistent_lsn advanced past marker in ${OFFLOAD_S}s)"

# ---------------------------------------------------------------------------
info "STEP 6: WIPE the pageserver layer cache (delete PVC) so reads MUST come from the object store"
$KD scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
$KD delete pod pageserver-0 --wait=false >/dev/null 2>&1 || true
$KD delete pvc data-pageserver-0 --wait=false >/dev/null 2>&1 || true
# The StatefulSet recreates pod + a FRESH empty PVC.
k=0; while $KD get pvc data-pageserver-0 -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null | grep -q .; do
  $KD delete pod pageserver-0 --wait=false >/dev/null 2>&1 || true
  k=$((k+1)); [ $k -gt 60 ] && fail "old pageserver PVC stuck terminating"; sleep 2
done
$KD rollout status statefulset/pageserver --timeout=180s >/dev/null || fail "fresh (empty-cache) pageserver not ready"
CACHE_SZ="$($KD exec sts/pageserver -- sh -c 'du -sm /data/.neon/tenants 2>/dev/null | cut -f1' 2>/dev/null || echo 0)"
ok "pageserver restarted with an EMPTY layer cache (tenants dir ~${CACHE_SZ}MB)"

info "  re-attach the tenant at generation $REATTACH_GEN (pageserver downloads the index from the object store)"
$KD exec sts/pageserver -- /bin/sh -c "
  set -e
  until curl -sf http://localhost:9898/v1/tenant >/dev/null 2>&1; do sleep 1; done
  curl -sf -X PUT -H 'Content-Type: application/json' \
    -d '{\"mode\":\"AttachedSingle\",\"generation\":$REATTACH_GEN,\"tenant_conf\":{}}' \
    http://localhost:9898/v1/tenant/$TENANT/location_config >/dev/null
" >/dev/null || fail "re-attach failed"
a=0; while [ $a -lt 60 ]; do
  $KD exec sts/pageserver -- curl -sf "http://localhost:9898/v1/tenant/$TENANT/timeline" 2>/dev/null | grep -q "$TIMELINE" && break
  a=$((a+1)); [ $a -ge 60 ] && fail "timeline never loaded from the object store after cache wipe"; sleep 2
done
STATIC_LSN="$(LRL)"
[ -n "$STATIC_LSN" ] || fail "could not read restored LSN"
ok "tenant re-attached; timeline index loaded from $OBJ_ENDPOINT (static read LSN=$STATIC_LSN)"

info "STEP 7: read the rows back through a STATIC read-only compute (pages served from the object store)"
READ_START=$(date +%s)
# Static compute pinned to the restored LSN — reads pages straight from the
# empty-cache pageserver, which can only satisfy them by fetching layers from the
# object store. Inject spec.mode=Static exactly as _verify-restore.sh does.
sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
    -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/" \
    "$COMPUTE_FILES_SRC" \
  | awk -v lsn="$STATIC_LSN" '{print} /"format_version": 1.0,/{print "            \"mode\": {\"Static\": \"" lsn "\"},"}' \
  | $KD apply -f - >/dev/null
drill_cc   # re-assert the drill tenant/timeline over 54's primary compute-config
$KD scale deploy/compute --replicas=0 >/dev/null 2>&1 || true
$KD delete pod -l app=compute --wait=true >/dev/null 2>&1 || true
$KD scale deploy/compute --replicas=1 >/dev/null
$KD rollout status deploy/compute --timeout=300s >/dev/null || fail "static compute did not come up (logs: $($KD logs deploy/compute -c compute --tail=30 2>/dev/null))"
got=""; q=0
while [ $q -lt 90 ]; do
  got="$(DRILL_PSQL 'select count(*) from proof' 2>/dev/null || true)"
  [ -n "$got" ] && break
  q=$((q+1)); sleep 1
done
READ_END=$(date +%s)
[ "$got" = "5000" ] || fail "rows NOT readable from the object-store-backed pageserver (got '$got', want 5000)"
READ_S=$((READ_END - READ_START))
ok "ALL 5000 rows READ BACK from $OBJ_ENDPOINT after a full cache wipe (read-path RTO ${READ_S}s)"

# ---------------------------------------------------------------------------
echo ""
echo "=========================================================================="
echo " OBJECT-STORE DRILL PASSED  (#105)"
echo "   backend mode        : $MODE"
echo "   endpoint            : $OBJ_ENDPOINT"
echo "   bucket / region     : $OBJ_BUCKET / $OBJ_REGION"
echo "   in-cluster MinIO    : $([ "$MODE" = external ] && echo NONE || echo baseline-only)"
echo "   rows proven         : 5000 (offloaded, cache-wiped, read back)"
echo "   OFFLOAD latency     : ${OFFLOAD_S}s (checkpoint -> remote_consistent_lsn past marker)"
echo "   READ-BACK RTO       : ${READ_S}s (empty-cache re-attach -> first successful read)"
echo "=========================================================================="
