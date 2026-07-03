#!/bin/sh
# _verify-pageserver-failover.sh — is the single pageserver still a whole-platform
# read SPOF, or can we bound it with a standby + scripted failover?
#
# The pageserver is the MVP's single read authority: lose it and ALL reads stop
# until it restarts (reviews flagged this as an unbounded-outage SPOF, and there
# is no storage controller here to fail it over). This drill answers, hands-on on
# neon:8464 OSS, in a fully SELF-CONTAINED throwaway namespace (it never touches
# the live scale-zero-pg plane — it builds its own tiny tenant so the result is
# not polluted by, and cannot harm, live data):
#
#   1. Stand up a fresh plane: minio + broker + 1 safekeeper + TWO pageservers
#      (pageserver-a primary, pageserver-b a warm Secondary that pre-downloads
#      layers from the bucket).
#   2. Create a fresh tenant+timeline on pageserver-a, run a normal read-WRITE
#      compute, write a marker row.
#   3. FAILOVER: kill pageserver-a, then PROMOTE pageserver-b to AttachedSingle at
#      generation+1 (the manual re-attach — no storage controller) and re-point the
#      compute at pageserver-b. The safekeeper survives the kill, so pageserver-b
#      streams the WAL forward and the DB stays read-WRITE.
#   4. Assert the marker still reads, and print the measured failover RTO
#      (kill -> reads restored). Converts an "unbounded outage" into a "known RTO".
#
# Verdict (automated secondary vs scripted manual failover) prints at the end and
# is written up in docs/operations.md "Pageserver failover".
#
# Bounded kubectl (--request-timeout). Self-cleaning (trap). Owns ONLY namespace
# $DRILL_NS. No dependency on the live tenant at all.
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="--request-timeout=60s"

DRILL_NS=ps-drill
# Fresh IDs (distinct from the live f0.. tenant) — this drill is self-contained.
TENANT=e0e0e0e0e0e0e0e0e0e0e0e0e0e0e001
TIMELINE=e0e0e0e0e0e0e0e0e0e0e0e0e0e0e002
GEN_PRIMARY=1      # pageserver-a: first attach of a brand-new tenant
GEN_FAILOVER=2     # pageserver-b promoted at gen+1 (fences the dead primary)
PG_VERSION=17
IMG_NEON=neondatabase/neon:8464
IMG_COMPUTE=neondatabase/compute-node-v17:8464
DRILL_STORAGE=3Gi
FAILOVER_BUDGET=90    # seconds allowed for reads to come back after the kill
GW_IMAGE="${GW_IMAGE:-me-abudhabi-1.ocir.io/axfqznklsd2t/ks-pg/gateway:v0.4.0}" # ships /pswatcher

# Default: AUTOMATED failover — deploy the pswatcher (58) into the drill, kill
# the primary, and assert reads recover with NO manual step (RTO measured).
# --manual: the old hand-run path (kept as a fallback / mechanism reference).
MANUAL=0
for a in "$@"; do
  case "$a" in
    --manual) MANUAL=1 ;;
    -h|--help) echo "usage: $0 [--manual]"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

KD="$KUBECTL -n $DRILL_NS $RT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }

cleanup() {
  code=$?
  if [ "${PS_KEEP:-0}" = "1" ]; then
    info "cleanup: PS_KEEP=1 — leaving $DRILL_NS up for inspection"; exit $code
  fi
  info "cleanup: deleting namespace $DRILL_NS (throwaway)"
  $KUBECTL delete ns "$DRILL_NS" --wait=false --ignore-not-found $RT >/dev/null 2>&1 || true
  exit $code
}
trap cleanup EXIT INT TERM

DRILL_PSQL() { $KD exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }
PS_GET() { $KD exec sts/$1 -- curl -s "http://localhost:9898$2" 2>/dev/null; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
# Guard: drills create/destroy namespaces - never run against an unintended
# cluster. Default = the canonical OKE context; override for local clusters.
EXPECTED_CTX="${KSPG_CONTEXT:-context-ckmva7v7zvq}"
[ "$($KUBECTL config current-context 2>/dev/null)" = "$EXPECTED_CTX" ] || fail "expected kube-context '$EXPECTED_CTX' (set KSPG_CONTEXT to override)"
COMPUTE_FILES_SRC="$(dirname "$0")/54-compute-files.yaml"
[ -f "$COMPUTE_FILES_SRC" ] || fail "missing $COMPUTE_FILES_SRC"

# ---------------------------------------------------------------------------
info "STEP 1: stand up the throwaway 2-pageserver plane in $DRILL_NS"
$KUBECTL delete ns "$DRILL_NS" --ignore-not-found $RT >/dev/null 2>&1 || true
j=0; while $KUBECTL get ns "$DRILL_NS" >/dev/null 2>&1; do j=$((j+1)); [ $j -gt 60 ] && fail "old $DRILL_NS stuck terminating"; sleep 2; done
$KUBECTL create ns "$DRILL_NS" >/dev/null
# fresh S3 creds for the drill's own minio (no live dependency)
$KD create secret generic storage-s3-creds --from-literal=user=drilladmin --from-literal=password=drillpasslocal123 >/dev/null

# minio (empty) + compute-config + a pageserver-config per pageserver (distinct ids)
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
          image: quay.io/minio/minio:RELEASE.2022-10-20T00-55-09Z
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
spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: minio, namespace: $DRILL_NS }
spec: { selector: { app: minio }, ports: [ { name: s3, port: 9000, targetPort: s3 } ] }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: compute-config, namespace: $DRILL_NS }
data: { PG_VERSION: "$PG_VERSION", PAGESERVER_HOST: "pageserver-a", TENANT_ID: "$TENANT", TIMELINE_ID: "$TIMELINE" }
YAML
$KD rollout status deploy/minio --timeout=120s >/dev/null || fail "drill minio not ready"
# create the bucket
$KD run mc-mb --restart=Never --image=minio/mc:RELEASE.2023-01-28T20-29-38Z \
  --env=U=drilladmin --env=P=drillpasslocal123 --command -- /bin/sh -c '
  export HOME=/tmp
  n=0; until mc alias set dst http://minio:9000 "$U" "$P"; do n=$((n+1)); [ $n -gt 30 ] && exit 1; sleep 2; done
  mc mb --ignore-existing dst/neon' >/dev/null
o=0; while :; do ph="$($KD get pod mc-mb -o jsonpath='{.status.phase}' 2>/dev/null || echo x)"; [ "$ph" = Succeeded ] && break; [ "$ph" = Failed ] && fail "bucket create failed"; o=$((o+1)); [ $o -gt 40 ] && fail "bucket create timeout"; sleep 2; done
$KD delete pod mc-mb --ignore-not-found >/dev/null 2>&1 || true

for pair in "a 1234" "b 1235"; do
  set -- $pair; NAME=$1; PSID=$2
  $KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata: { name: pageserver-config-$NAME, namespace: $DRILL_NS }
data:
  pageserver.toml: |
    broker_endpoint='http://storage-broker:50051'
    pg_distrib_dir='/usr/local/'
    listen_pg_addr='0.0.0.0:6400'
    listen_http_addr='0.0.0.0:9898'
    remote_storage={ endpoint='http://minio:9000', bucket_name='neon', bucket_region='eu-north-1', prefix_in_bucket='/pageserver' }
    control_plane_api='http://0.0.0.0:6666'
    control_plane_emergency_mode=true
    virtual_file_io_mode="buffered"
  identity.toml: |
    id=$PSID
YAML
done

# broker + 1 safekeeper
$KD apply -f - >/dev/null <<YAML
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
                --remote-storage="{endpoint='http://minio:9000', bucket_name='neon', bucket_region='eu-north-1', prefix_in_bucket='/safekeeper/'}"
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
YAML

# two pageservers a + b (distinct app label + Service each)
for NAME in a b; do
  $KD apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: pageserver-$NAME, namespace: $DRILL_NS, labels: { app: pageserver-$NAME } }
spec:
  serviceName: pageserver-$NAME
  replicas: 1
  selector: { matchLabels: { app: pageserver-$NAME } }
  template:
    metadata: { labels: { app: pageserver-$NAME } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      initContainers:
        - name: seed-config
          image: $IMG_NEON
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          command: ["/bin/sh","-c"]
          args: [ "mkdir -p /data/.neon && cp /config/pageserver.toml /config/identity.toml /data/.neon/" ]
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
      volumes: [ { name: config, configMap: { name: pageserver-config-$NAME } } ]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: $DRILL_STORAGE } } }
---
apiVersion: v1
kind: Service
metadata: { name: pageserver-$NAME, namespace: $DRILL_NS }
spec:
  selector: { app: pageserver-$NAME }
  ports: [ { name: pg, port: 6400, targetPort: pg }, { name: http, port: 9898, targetPort: http } ]
YAML
done

# Client-facing + stable-primary Services (mirror prod 53 + 57 topology):
#   pageserver         — what the compute resolves (host=pageserver); the
#                        watcher FLIPS this selector a -> b on failover.
#   pageserver-primary — stable liveness handle the watcher probes (stays on a).
$KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Service
metadata: { name: pageserver, namespace: $DRILL_NS }
spec:
  selector: { app: pageserver-a }
  ports: [ { name: pg, port: 6400, targetPort: pg }, { name: http, port: 9898, targetPort: http } ]
---
apiVersion: v1
kind: Service
metadata: { name: pageserver-primary, namespace: $DRILL_NS }
spec:
  selector: { app: pageserver-a }
  ports: [ { name: pg, port: 6400, targetPort: pg }, { name: http, port: 9898, targetPort: http } ]
YAML
$KD rollout status statefulset/pageserver-a --timeout=180s >/dev/null || fail "pageserver-a not ready"
$KD rollout status statefulset/pageserver-b --timeout=180s >/dev/null || fail "pageserver-b not ready"
$KD rollout status statefulset/safekeeper --timeout=120s >/dev/null || fail "drill safekeeper not ready"
ok "drill plane up: 2 pageservers + broker + safekeeper (self-contained, empty bucket)"

# ---------------------------------------------------------------------------
info "STEP 2: create a fresh tenant+timeline on pageserver-a (gen $GEN_PRIMARY)"
$KD exec sts/pageserver-a -- /bin/sh -c "
  set -e
  until curl -sf http://localhost:9898/v1/tenant >/dev/null 2>&1; do sleep 1; done
  curl -sf -X PUT -H 'Content-Type: application/json' \
    -d '{\"mode\":\"AttachedSingle\",\"generation\":$GEN_PRIMARY,\"tenant_conf\":{}}' \
    http://localhost:9898/v1/tenant/$TENANT/location_config >/dev/null
  curl -sf -X POST -H 'Content-Type: application/json' \
    -d '{\"new_timeline_id\":\"$TIMELINE\",\"pg_version\":$PG_VERSION}' \
    http://localhost:9898/v1/tenant/$TENANT/timeline/ >/dev/null" >/dev/null || fail "tenant/timeline create failed"
a=0; while [ $a -lt 60 ]; do PS_GET pageserver-a "/v1/tenant/$TENANT/timeline" | grep -q "$TIMELINE" && break; a=$((a+1)); [ $a -ge 60 ] && fail "timeline not created on pageserver-a"; sleep 2; done
ok "tenant+timeline live on pageserver-a"

# ---------------------------------------------------------------------------
info "STEP 3: configure pageserver-b as a warm Secondary"
SECONDARY_OK=1
$KD exec sts/pageserver-b -- /bin/sh -c "
  until curl -sf http://localhost:9898/v1/tenant >/dev/null 2>&1; do sleep 1; done
  curl -sf -X PUT -H 'Content-Type: application/json' \
    -d '{\"mode\":\"Secondary\",\"secondary_conf\":{\"warm\":true},\"tenant_conf\":{}}' \
    http://localhost:9898/v1/tenant/$TENANT/location_config >/dev/null" 2>/dev/null || SECONDARY_OK=0
if [ "$SECONDARY_OK" = "1" ]; then
  ok "pageserver-b accepted Secondary mode (warm standby)"
  $KD exec sts/pageserver-b -- curl -s -X POST "http://localhost:9898/v1/tenant/$TENANT/secondary/download" >/dev/null 2>&1 || true
else
  info "Secondary mode not accepted; pageserver-b will be a COLD standby (attached on failover)"
fi

# ---------------------------------------------------------------------------
info "STEP 4: read-WRITE compute on pageserver-a → write + read marker"
# derive compute-files from deploy/54: single drill safekeeper, ps-drill namespace,
# pageserver connstring pointed at the chosen pageserver host. NO static mode (r/w).
render_compute_files() {
  ps_host=$1
  sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
      -e "s/^  namespace: scale-zero-pg/  namespace: $DRILL_NS/" \
      -e "s#host=pageserver port=6400#host=$ps_host port=6400#g" \
      "$COMPUTE_FILES_SRC" | $KD apply -f - >/dev/null
}
deploy_compute() {
  ps_host=$1
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
      terminationGracePeriodSeconds: 5
      initContainers:
        - name: wait-timeline
          image: $IMG_NEON
          env:
            - { name: PAGESERVER_HOST, value: "$ps_host" }
            - { name: TENANT_ID, value: "$TENANT" }
            - { name: TIMELINE_ID, value: "$TIMELINE" }
          command: ["/bin/sh","-c"]
          args:
            - |
              set -eu
              until curl -sf "http://\${PAGESERVER_HOST}:9898/v1/tenant/\${TENANT_ID}/timeline" | grep -q "\${TIMELINE_ID}"; do
                echo "waiting for timeline on \${PAGESERVER_HOST} ..."; sleep 0.5; done
              echo "timeline ready"
      containers:
        - name: compute
          image: $IMG_COMPUTE
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh","/compute-files/entrypoint.sh"]
          env:
            - { name: TENANT_ID, value: "$TENANT" }
            - { name: TIMELINE_ID, value: "$TIMELINE" }
            - { name: PG_VERSION, value: "$PG_VERSION" }
            - { name: PAGESERVER_HOST, value: "$ps_host" }
          ports: [ { name: pg, containerPort: 55433 } ]
          volumeMounts: [ { name: compute-files, mountPath: /compute-files } ]
          readinessProbe: { tcpSocket: { port: pg }, periodSeconds: 1, failureThreshold: 120 }
      volumes: [ { name: compute-files, configMap: { name: compute-files } } ]
YAML
}
# AUTOMATED failover re-points reads by flipping the `pageserver` Service, so the
# compute must resolve via that Service (host=pageserver), never a fixed a/b host.
# The manual path pins host=pageserver-a and hand-re-points to -b on failover.
if [ "$MANUAL" = 1 ]; then PRIMARY_HOST=pageserver-a; else PRIMARY_HOST=pageserver; fi
render_compute_files "$PRIMARY_HOST"
deploy_compute "$PRIMARY_HOST"
$KD rollout status deploy/compute --timeout=300s >/dev/null || fail "read/write compute did not come up (logs: $($KD logs deploy/compute -c compute --tail=30 2>/dev/null))"
DRILL_PSQL "create table psfo(id int primary key, note text)" >/dev/null || fail "cannot create table (not read-write?)"
DRILL_PSQL "insert into psfo values (1,'pageserver-failover marker')" >/dev/null
DRILL_PSQL "checkpoint" >/dev/null
[ "$(DRILL_PSQL "select note from psfo where id=1")" = "pageserver-failover marker" ] || fail "baseline read failed"
ok "baseline: read-write DB on pageserver-a; marker written + read"

if [ "$MANUAL" = 1 ]; then
  # -------------------------------------------------------------------------
  info "STEP 5 (--manual): FAILOVER — kill pageserver-a, promote pageserver-b, re-point compute"
  KILL_AT=$(date +%s)
  $KD delete statefulset/pageserver-a --cascade=foreground --wait=true --timeout=60s >/dev/null 2>&1 || \
    $KD delete pod pageserver-a-0 --grace-period=0 --force >/dev/null 2>&1 || true
  info "  pageserver-a killed; promoting pageserver-b to AttachedSingle gen $GEN_FAILOVER (gen+1 fences the dead primary)"
  $KD exec sts/pageserver-b -- /bin/sh -c "
    curl -sf -X PUT -H 'Content-Type: application/json' \
      -d '{\"mode\":\"AttachedSingle\",\"generation\":$GEN_FAILOVER,\"tenant_conf\":{}}' \
      http://localhost:9898/v1/tenant/$TENANT/location_config >/dev/null" || fail "promote pageserver-b failed"
  b=0; while [ $b -lt 60 ]; do PS_GET pageserver-b "/v1/tenant/$TENANT/timeline" | grep -q "$TIMELINE" && break; b=$((b+1)); [ $b -ge 60 ] && fail "pageserver-b never loaded timeline after promotion"; sleep 2; done
  info "  re-pointing compute at pageserver-b (cold restart — models a scale-to-zero wake)"
  render_compute_files pageserver-b
  deploy_compute pageserver-b
  $KD delete pod -l app=compute --grace-period=0 --force >/dev/null 2>&1 || true
  MECH="manual re-attach pageserver-b @ gen $GEN_FAILOVER + compute re-point"
else
  # -------------------------------------------------------------------------
  info "STEP 5: deploy the pswatcher (automated failover) into $DRILL_NS"
  # generation ledger (matches prod 57): storage-init used gen 1.
  $KD create configmap pageserver-generation --from-literal=generation=1 >/dev/null
  # let the watcher pull the private OCIR image: copy the pull secret if present.
  DOCKERCFG=$($KUBECTL -n scale-zero-pg get secret ocir-pull -o jsonpath='{.data.\.dockerconfigjson}' $RT 2>/dev/null || true)
  if [ -n "$DOCKERCFG" ]; then
    $KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Secret
metadata: { name: ocir-pull, namespace: $DRILL_NS }
type: kubernetes.io/dockerconfigjson
data: { .dockerconfigjson: "$DOCKERCFG" }
YAML
  fi
  $KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ServiceAccount
metadata: { name: pswatcher, namespace: $DRILL_NS }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: pswatcher, namespace: $DRILL_NS }
rules:
  - { apiGroups: [""], resources: ["services"], verbs: ["get","patch"] }
  - { apiGroups: [""], resources: ["configmaps"], verbs: ["get","update","patch"] }
  - { apiGroups: [""], resources: ["pods"], verbs: ["list","delete"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: pswatcher, namespace: $DRILL_NS }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: pswatcher }
subjects: [ { kind: ServiceAccount, name: pswatcher, namespace: $DRILL_NS } ]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: pswatcher, namespace: $DRILL_NS, labels: { app: pswatcher } }
spec:
  replicas: 1
  selector: { matchLabels: { app: pswatcher } }
  template:
    metadata: { labels: { app: pswatcher } }
    spec:
      imagePullSecrets: [ { name: ocir-pull } ]
      serviceAccountName: pswatcher
      # 65532 = distroless:nonroot numeric uid; runAsNonRoot can't verify the
      # image's non-numeric USER, so pin it (else CreateContainerConfigError).
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: pswatcher
          image: $GW_IMAGE
          imagePullPolicy: IfNotPresent
          command: ["/pswatcher"]
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
          env:
            - { name: PSW_NAMESPACE, value: "$DRILL_NS" }
            - { name: PSW_PRIMARY_STATUS_URL, value: "http://pageserver-primary:9898/v1/status" }
            - { name: PSW_STANDBY_BASE_URL, value: "http://pageserver-b:9898" }
            - { name: PSW_CLIENT_SERVICE, value: "pageserver" }
            - { name: PSW_STANDBY_SELECTOR_APP, value: "pageserver-b" }
            - { name: PSW_GEN_CONFIGMAP, value: "pageserver-generation" }
            - { name: PSW_COMPUTE_SELECTOR, value: "app=compute" }
            - { name: PSW_TENANT_ID, value: "$TENANT" }
            - { name: PSW_POLL_MS, value: "1000" }
            - { name: PSW_FAIL_THRESHOLD, value: "3" }
            - { name: PSW_BASE_GENERATION, value: "1" }
            - { name: PSW_HEALTH_ADDR, value: ":9091" }
          ports: [ { name: metrics, containerPort: 9091 } ]
          readinessProbe: { httpGet: { path: /healthz, port: metrics }, periodSeconds: 2 }
          resources:
            requests: { cpu: 20m, memory: 32Mi, ephemeral-storage: 100Mi }
            limits: { memory: 64Mi, ephemeral-storage: 1Gi }
YAML
  $KD rollout status deploy/pswatcher --timeout=180s >/dev/null || fail "pswatcher did not come up (logs: $($KD logs deploy/pswatcher --tail=20 2>/dev/null))"
  ok "pswatcher healthy and watching pageserver-primary"

  info "STEP 5b: KILL pageserver-a — the watcher must fail over with NO manual step"
  # Capture the live compute pod: the recovery proof must come from the COLD pod
  # the watcher spawns AFTER failover, not from this one's page cache (the marker
  # is already in its shared_buffers, so it would "read" fine even with reads dead).
  OLD_POD=$($KD get pod -l app=compute -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo none)
  KILL_AT=$(date +%s)
  $KD delete statefulset/pageserver-a --cascade=foreground --wait=true --timeout=60s >/dev/null 2>&1 || \
    $KD delete pod pageserver-a-0 --grace-period=0 --force >/dev/null 2>&1 || true
  # from here on: NOTHING manual. The watcher promotes b @ gen+1, flips the
  # `pageserver` Service selector a->b, and bounces the compute on its own.
  # PROOF #1 (the watcher's action): wait for it to flip the client Service a->b.
  SEL=""; w=0
  while [ $w -lt "$FAILOVER_BUDGET" ]; do SEL="$($KD get svc pageserver -o jsonpath='{.spec.selector.app}' 2>/dev/null || echo '?')"; [ "$SEL" = "pageserver-b" ] && break; w=$((w+1)); sleep 1; done
  [ "$SEL" = "pageserver-b" ] || fail "watcher did NOT flip the pageserver Service to pageserver-b within ${FAILOVER_BUDGET}s (selector=$SEL; logs: $($KD logs deploy/pswatcher --tail=30 2>/dev/null))"
  # PROOF #2 (reads truly served by the promoted standby): the watcher bounced the
  # compute, so wait for a NEW cold pod and read the marker through it — a cold
  # compute has empty buffers, so this read must basebackup from pageserver-b.
  got=""; q=0
  while [ $q -lt "$FAILOVER_BUDGET" ]; do
    NEW_POD="$($KD get pod -l app=compute -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [ -n "$NEW_POD" ] && [ "$NEW_POD" != "$OLD_POD" ]; then
      got="$(DRILL_PSQL "select note from psfo where id=1" 2>/dev/null || true)"
      [ "$got" = "pageserver-failover marker" ] && break
    fi
    q=$((q+1)); sleep 1
  done
  RESTORED_AT=$(date +%s)
  [ "$got" = "pageserver-failover marker" ] || fail "reads did NOT auto-recover on the promoted standby within ${FAILOVER_BUDGET}s (watcher logs: $($KD logs deploy/pswatcher --tail=30 2>/dev/null))"
  # PROOF #3 (fencing): the generation ledger advanced 1 -> 2.
  GEN_NOW=$($KD get configmap pageserver-generation -o jsonpath='{.data.generation}' 2>/dev/null || echo '?')
  [ "$GEN_NOW" = "2" ] || fail "generation ledger did not advance to 2 (got '$GEN_NOW')"
  MECH="AUTOMATIC — pswatcher promoted pageserver-b @ gen $GEN_NOW, flipped Service selector, bounced compute (no human step)"
fi

# the surviving safekeeper carries the WAL, so pageserver-b streams forward and the
# DB stays read-WRITE; the cold compute basebackups from pageserver-b.
if [ "$MANUAL" = 1 ]; then
  got=""; q=0
  while [ $q -lt "$FAILOVER_BUDGET" ]; do got="$(DRILL_PSQL "select note from psfo where id=1" 2>/dev/null || true)"; [ "$got" = "pageserver-failover marker" ] && break; q=$((q+1)); sleep 1; done
  RESTORED_AT=$(date +%s)
  [ "$got" = "pageserver-failover marker" ] || fail "reads did NOT recover on pageserver-b within ${FAILOVER_BUDGET}s"
fi
RTO=$((RESTORED_AT - KILL_AT))
DRILL_PSQL "insert into psfo values (2,'post-failover write')" >/dev/null 2>&1 && POSTWRITE=yes || POSTWRITE=no
ok "reads RECOVERED via pageserver-b (still read-write: $POSTWRITE)"

echo ""
echo "=========================================================================="
echo " PAGESERVER FAILOVER DRILL PASSED"
echo "   mode                : $([ "$MANUAL" = 1 ] && echo 'manual (--manual)' || echo 'AUTOMATED (pswatcher)')"
echo "   secondary (warm) mode accepted : $([ "$SECONDARY_OK" = 1 ] && echo yes || echo 'no (cold standby)')"
echo "   failover mechanism  : $MECH"
echo "   read-write after failover : $POSTWRITE"
echo "   FAILOVER RTO (kill -> reads restored): ${RTO}s"
echo "=========================================================================="
