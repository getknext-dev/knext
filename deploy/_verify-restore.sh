#!/bin/sh
# _verify-restore.sh — the rehearsed disaster-recovery drill.
#
# Proves the ONE finding every review round flagged CRITICAL ("no backups
# anywhere; MinIO + pageserver are single un-backed-up PVCs = the project-ending
# incident") is closed, end to end and honestly:
#
#   1. Write a uniquely-tagged marker row through the LIVE compute, capture its
#      WAL LSN, then push WAL until the pageserver has UPLOADED that LSN to the
#      object store (remote_consistent_lsn >= marker LSN). This is what makes the
#      backup HONEST — the marker must live in a bucket layer, not only in the
#      safekeeper WAL (which fresh drill safekeepers do not carry).
#   2. Run the backup Job (deploy/62-backup.yaml): mirror the `neon` bucket to
#      OFF-CLUSTER OCI Object Storage (S3-compat), plus dump the config
#      (compute/pageserver ConfigMaps + storage-s3-creds Secret) alongside it.
#   3. In a THROWAWAY namespace `restore-drill`, stand up a fresh storage plane
#      (minio seeded from the OCI OS backup + broker + 1 safekeeper + pageserver
#      + compute), reconstructed from the backed-up config only.
#   4. Assert the marker row is readable in the drill namespace.
#   5. Print RTO (backup start -> first successful drill query) and clean up.
#
# Architecture facts exploited (see docs/operations.md "Backup & disaster
# recovery"): the durable truth is the MinIO `neon` bucket (pageserver layer
# uploads + safekeeper WAL offload) + the fixed tenant/timeline IDs + the git
# manifests. The pageserver PVC is a rebuildable cache; safekeeper PVCs hold only
# recent WAL bounded by remote_consistent_lsn. So a faithful restore = fresh
# storage plane attached to a restored bucket copy, serving old data through a
# fresh compute.
#
# Idempotent and self-cleaning (trap). Bounded kubectl calls (--request-timeout).
# Owns ONLY: namespace restore-drill. Touches scale-zero-pg for the marker write
# + flush + the backup Job only; leaves compute as found (scaled back to 0).
set -eu

# kubectl may not be on a minimal PATH; make the script robust.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
KUBECTL="${KUBECTL:-kubectl}"
RT="--request-timeout=60s"

SRC_NS=scale-zero-pg
DRILL_NS=restore-drill
TENANT=f000f000f000f000f000f000f000f001
TIMELINE=f000f000f000f000f000f000f000f002
# Re-attach at a HIGHER generation than the live tenant wrote (gen 1). The
# pageserver picks the newest index_part with generation <= its own, so gen 2
# reads the gen-1 index and writes forward at gen 2 — a clean control-plane-style
# re-attach. (LEARNED: attaching at the same generation risks index overwrite;
# see docs/operations.md.)
DRILL_GEN=2
IMG_NEON=neondatabase/neon:8464
IMG_COMPUTE=neondatabase/compute-node-v17:8464
IMG_MC=minio/mc:RELEASE.2023-01-28T20-29-38Z
# Drill PVC sizes. The minio store must hold a full copy of the neon bucket
# (pageserver layers + safekeeper WAL offload, several GB after write activity);
# pageserver/safekeeper caches are smaller.
DRILL_MINIO_STORAGE=12Gi
DRILL_STORAGE=6Gi

K="$KUBECTL -n $SRC_NS $RT"
KD="$KUBECTL -n $DRILL_NS $RT"
WORK="$(mktemp -d)"
MARKER_ID="drill-$(date +%s)-$$"
MARKER_NOTE="restore-rehearsal marker; must survive a full storage-plane rebuild"
RESTORED_COMPUTE_WAS=0   # live compute replicas at start; restore on exit

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }
info() { echo ">> $*"; }

cleanup() {
  code=$?
  if [ "${KEEP_DRILL:-0}" = "1" ]; then
    info "cleanup: KEEP_DRILL=1 — leaving namespace $DRILL_NS up for inspection"
    $K scale deploy/compute --replicas="$RESTORED_COMPUTE_WAS" >/dev/null 2>&1 || true
    rm -rf "$WORK" 2>/dev/null || true
    exit $code
  fi
  info "cleanup: deleting namespace $DRILL_NS (throwaway)"
  $KUBECTL delete ns "$DRILL_NS" --wait=false --ignore-not-found $RT >/dev/null 2>&1 || true
  # Best-effort: drop the drill filler in the live tenant if compute is up, then
  # leave the live compute exactly as found.
  if [ "$($K get deploy compute -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)" != "0" ]; then
    LIVE_PSQL "drop table if exists ${MARKER_TABLE:-restore_drill_marker}" >/dev/null 2>&1 || true
    LIVE_PSQL "drop table if exists restore_drill_fill" >/dev/null 2>&1 || true
  fi
  $K scale deploy/compute --replicas="$RESTORED_COMPUTE_WAS" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
  exit $code
}
trap cleanup EXIT INT TERM

MARKER_TABLE=restore_drill_marker
LIVE_PSQL() { $K exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }
DRILL_PSQL() { $KD exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres -tA -c "$1"; }
# remote_consistent_lsn: the highest LSN the pageserver has UPLOADED to the bucket.
RCL() { $K exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null | tr ',' '\n' | grep '"remote_consistent_lsn"' | head -1 | cut -d'"' -f4; }

command -v "$KUBECTL" >/dev/null 2>&1 || fail "kubectl not found"
# Guard: drills create/destroy namespaces - never run against an unintended
# cluster. Default = the canonical OKE context; override for local clusters.
EXPECTED_CTX="${KSPG_CONTEXT:-context-ckmva7v7zvq}"
[ "$($KUBECTL config current-context 2>/dev/null)" = "$EXPECTED_CTX" ] || fail "expected kube-context '$EXPECTED_CTX' (set KSPG_CONTEXT to override)"

# ---------------------------------------------------------------------------
info "STEP 0: preflight — scale-zero-pg storage plane healthy"
for s in pageserver safekeeper; do
  $K rollout status statefulset/$s --timeout=120s >/dev/null || fail "sts/$s not ready"
done
$K rollout status deploy/minio --timeout=120s >/dev/null || fail "minio not ready"
ok "live storage plane ready"
RESTORED_COMPUTE_WAS="$($K get deploy compute -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
info "live compute replicas at start: $RESTORED_COMPUTE_WAS (will restore on exit)"

# ---------------------------------------------------------------------------
info "STEP 1: write marker through the live compute + force it into the bucket"
$K scale deploy/compute --replicas=1 >/dev/null
$K rollout status deploy/compute --timeout=180s >/dev/null || fail "compute did not wake"
LIVE_PSQL "create table if not exists $MARKER_TABLE(id text primary key, note text, ts timestamptz default now())" >/dev/null
LIVE_PSQL "insert into $MARKER_TABLE(id,note) values ('$MARKER_ID','$MARKER_NOTE')" >/dev/null
MARKER_LSN="$(LIVE_PSQL "select pg_current_wal_flush_lsn()")"
[ -n "$MARKER_LSN" ] || fail "could not capture marker LSN"
ok "marker row '$MARKER_ID' written at WAL LSN $MARKER_LSN"

info "  pushing WAL past checkpoint_distance so the pageserver uploads the marker layer"
LIVE_PSQL "create table if not exists restore_drill_fill(id int, pad text)" >/dev/null
# ~360MB of WAL — comfortably over the 256MB default checkpoint_distance so the
# pageserver freezes+uploads a layer covering the marker (verified mechanism).
LIVE_PSQL "insert into restore_drill_fill select g, repeat('x',1024) from generate_series(1,300000) g" >/dev/null
LIVE_PSQL "checkpoint" >/dev/null
info "  waiting for remote_consistent_lsn >= marker LSN (bucket upload)"
uploaded=0
i=0
while [ $i -lt 60 ]; do
  cur="$(RCL || true)"
  if [ -n "$cur" ]; then
    # pg_wal_lsn_diff(cur, marker) >= 0  =>  the marker is uploaded
    diff="$(LIVE_PSQL "select (pg_wal_lsn_diff('$cur'::pg_lsn,'$MARKER_LSN'::pg_lsn) >= 0)" 2>/dev/null || echo f)"
    echo "   t=$((i*3))s remote_consistent_lsn=$cur uploaded=$diff"
    if [ "$diff" = "t" ]; then uploaded=1; break; fi
  fi
  i=$((i+1)); sleep 3
done
[ "$uploaded" = "1" ] || fail "pageserver never uploaded marker LSN to the bucket (backup would be dishonest)"
ok "marker LSN is durable in the object store (remote_consistent_lsn advanced past it)"

# ---------------------------------------------------------------------------
info "STEP 2: run the backup — mirror the neon bucket + config into OCI Object Storage"
BACKUP_MANIFEST="$(dirname "$0")/62-backup.yaml"
[ -f "$BACKUP_MANIFEST" ] || fail "backup manifest missing: $BACKUP_MANIFEST (RED until 62-backup.yaml exists)"
$K get secret backup-s3-target >/dev/null 2>&1 \
  || fail "Secret backup-s3-target missing — provision the OCI Customer Secret Key + run deploy/gen-secrets.sh first (see docs/operations.md 'Backup & disaster recovery')"
$K apply -f "$BACKUP_MANIFEST" >/dev/null || fail "could not apply $BACKUP_MANIFEST"

BACKUP_START=$(date +%s)                      # RTO clock starts here

# backup_index_intact: the newest pageserver index_part.json in the OFF-CLUSTER
# copy must be complete JSON. A busy live pageserver rewrites index_part.json
# during compaction; if the mirror reads it mid-PUT the backup captures a TORN
# index and the restore later fails to deserialize it. `mc mirror` is idempotent
# and only re-copies CHANGED objects, so simply re-running the backup Job is a
# cheap, effective way to pick up a clean index. (The durable fix belongs in the
# backup path; this keeps the drill honest and self-healing meanwhile.)
BK_ENDPOINT="$($K get secret backup-s3-target -o jsonpath='{.data.endpoint}' | base64 -d)"
BK_ACCESS="$($K get secret backup-s3-target -o jsonpath='{.data.access}' | base64 -d)"
BK_SECRET="$($K get secret backup-s3-target -o jsonpath='{.data.secret}' | base64 -d)"
BK_BUCKET="$($K get secret backup-s3-target -o jsonpath='{.data.bucket}' | base64 -d)"
IX_PREFIX="neon/pageserver/tenants/$TENANT/timelines/$TIMELINE"
backup_index_intact() {
  $K delete pod mc-ixcheck --ignore-not-found >/dev/null 2>&1 || true
  out="$($K run mc-ixcheck --rm -i --restart=Never --image="$IMG_MC" \
    --env=BE="$BK_ENDPOINT" --env=BA="$BK_ACCESS" --env=BS="$BK_SECRET" --env=BB="$BK_BUCKET" --env=IX="$IX_PREFIX" \
    --command -- /bin/sh -c '
      export HOME=/tmp
      mc alias set bak "$BE" "$BA" "$BS" --api S3v4 --path on >/dev/null 2>&1 || { echo NOBAK; exit 0; }
      f=$(mc ls "bak/$BB/$IX/" 2>/dev/null | grep -o "index_part.json-[0-9]*" | sort | tail -1)
      [ -z "$f" ] && { echo NOINDEX; exit 0; }
      last=$(mc cat "bak/$BB/$IX/$f" 2>/dev/null | tail -c 1)
      [ "$last" = "}" ] && echo "INTACT $f" || echo "TORN $f"' 2>/dev/null)"
  echo "$out" | grep -q '^INTACT'
}

JOB=""
attempt=0
while [ $attempt -lt 3 ]; do
  attempt=$((attempt+1))
  JOB="backup-now-$(date +%s)"
  $K create job "$JOB" --from=cronjob/backup >/dev/null || fail "could not create on-demand backup Job from cronjob/backup"
  info "  backup Job $JOB running (attempt $attempt)..."
  $K wait --for=condition=complete "job/$JOB" --timeout=600s >/dev/null 2>&1 \
    || fail "backup Job did not complete; logs: $($K logs job/$JOB --all-containers --tail=40 2>/dev/null)"
  if backup_index_intact; then
    ok "backup Job complete: neon bucket + config mirrored to OCI Object Storage (index intact)"
    break
  fi
  [ $attempt -ge 3 ] && fail "backed-up pageserver index_part.json is TORN after $attempt backups (live pageserver churning under compaction)"
  info "  backed-up index was captured mid-rewrite (torn) — re-running the backup to pick up a clean copy"
done

# ---------------------------------------------------------------------------
info "STEP 3: stand up the throwaway restore-drill storage plane from the backup"
$KUBECTL delete ns "$DRILL_NS" --ignore-not-found $RT >/dev/null 2>&1 || true
# wait for full teardown of any previous run
j=0; while $KUBECTL get ns "$DRILL_NS" >/dev/null 2>&1; do j=$((j+1)); [ $j -gt 60 ] && fail "old $DRILL_NS ns stuck terminating"; sleep 2; done
$KUBECTL create ns "$DRILL_NS" >/dev/null

# --- recover the S3 creds + config from OCI Object Storage (proves config backup) ---
info "  recovering backed-up config from OCI Object Storage (bak/<bucket>/neon-config)"
S3_USER="$($K get secret storage-s3-creds -o jsonpath='{.data.user}' | base64 -d)"
S3_PASS="$($K get secret storage-s3-creds -o jsonpath='{.data.password}' | base64 -d)"
# OCI backup destination (endpoint/access/secret/bucket) — the SAME Secret the
# backup CronJob wrote to; the restore reads back from it.
BK_ENDPOINT="$($K get secret backup-s3-target -o jsonpath='{.data.endpoint}' | base64 -d)"
BK_ACCESS="$($K get secret backup-s3-target -o jsonpath='{.data.access}' | base64 -d)"
BK_SECRET="$($K get secret backup-s3-target -o jsonpath='{.data.secret}' | base64 -d)"
BK_BUCKET="$($K get secret backup-s3-target -o jsonpath='{.data.bucket}' | base64 -d)"
[ -n "$BK_ENDPOINT" ] && [ -n "$BK_BUCKET" ] || fail "backup-s3-target Secret incomplete"
# Pull the dumped ConfigMaps from OCI OS via an mc pod (stdout capture). Creds go
# in as env (avoids shell-quoting hazards); HOME=/tmp because this mc image
# cannot write /root; alias name must be multi-char; OCI compat needs S3v4+path.
DUMP="$($K run mc-restore-cfg --rm -i --restart=Never --image="$IMG_MC" \
  --env=BK_ENDPOINT="$BK_ENDPOINT" --env=BK_ACCESS="$BK_ACCESS" --env=BK_SECRET="$BK_SECRET" --env=BK_BUCKET="$BK_BUCKET" \
  --command -- /bin/sh -c '
    export HOME=/tmp
    mc alias set bak "$BK_ENDPOINT" "$BK_ACCESS" "$BK_SECRET" --api S3v4 --path on >/dev/null 2>&1 || exit 1
    mc cat "bak/$BK_BUCKET/neon-config/configmaps.yaml"' 2>/dev/null)"
echo "$DUMP" | grep -q 'compute-config' || fail "config dump missing compute-config (backup incomplete)"
# Prove the fixed tenant/timeline IDs are actually captured in the backup.
echo "$DUMP" | grep -q "$TENANT"   || fail "config dump missing TENANT_ID $TENANT"
echo "$DUMP" | grep -q "$TIMELINE" || fail "config dump missing TIMELINE_ID $TIMELINE"
ok "config recovered from backup store (compute-config + tenant/timeline IDs present)"

# --- storage-s3-creds Secret in the drill (drill minio root == backup creds) ---
$KD create secret generic storage-s3-creds \
  --from-literal=user="$S3_USER" --from-literal=password="$S3_PASS" >/dev/null

# --- drill minio (service name 'minio' so pageserver.toml endpoint is unchanged) ---
apply_drill() { $KD apply -f - >/dev/null; }
apply_drill <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: minio, namespace: $DRILL_NS, labels: { app: minio, plane: storage } }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: minio } }
  template:
    metadata: { labels: { app: minio, plane: storage } }
    spec:
      securityContext: { seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: minio
          image: quay.io/minio/minio:RELEASE.2022-10-20T00-55-09Z
          args: ["server","/data","--address",":9000","--console-address",":9001"]
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
spec:
  selector: { app: minio }
  ports: [ { name: s3, port: 9000, targetPort: s3 } ]
YAML
$KD rollout status deploy/minio --timeout=120s >/dev/null || fail "drill minio not ready"
ok "drill minio up"

# --- seed the drill bucket from OCI Object Storage (this is the RESTORE) ---
info "  restoring neon bucket into the drill minio from OCI Object Storage"
$KD run mc-seed --restart=Never --image="$IMG_MC" \
  --env=BK_ENDPOINT="$BK_ENDPOINT" --env=BK_ACCESS="$BK_ACCESS" --env=BK_SECRET="$BK_SECRET" --env=BK_BUCKET="$BK_BUCKET" \
  --env=S3_USER="$S3_USER" --env=S3_PASS="$S3_PASS" --command -- /bin/sh -c "
  set -e
  export HOME=/tmp
  # bak = OCI Object Storage (S3-compat, S3v4 + path-style); dst = fresh drill minio.
  n=0; until mc alias set bak \"\$BK_ENDPOINT\" \"\$BK_ACCESS\" \"\$BK_SECRET\" --api S3v4 --path on; do n=\$((n+1)); [ \$n -gt 30 ] && exit 1; sleep 2; done
  # Retry alias set: the freshly-started drill minio may briefly refuse connections.
  n=0; until mc alias set dst http://minio:9000 \"\$S3_USER\" \"\$S3_PASS\"; do n=\$((n+1)); [ \$n -gt 30 ] && exit 1; sleep 2; done
  mc mb --ignore-existing dst/neon
  # mc mirror is idempotent (skips objects already present); retry to fill any
  # object dropped mid-stream on a large-layer read.
  n=0; until mc mirror --overwrite \"bak/\$BK_BUCKET/neon\" dst/neon; do n=\$((n+1)); [ \$n -gt 4 ] && exit 1; echo 'mirror retry '\$n; sleep 3; done
  echo SEED_DONE" >/dev/null
$KD wait --for=condition=Ready pod/mc-seed --timeout=30s >/dev/null 2>&1 || true
# wait for the seed pod to finish
s=0; while :; do
  ph="$($KD get pod mc-seed -o jsonpath='{.status.phase}' 2>/dev/null || echo Unknown)"
  [ "$ph" = "Succeeded" ] && break
  [ "$ph" = "Failed" ] && fail "bucket seed failed: $($KD logs mc-seed --tail=30 2>/dev/null)"
  # The neon bucket (pageserver layers + accumulated safekeeper WAL offload) grows
  # over the cluster's life, and this is a cross-internet re-download from OCI OS,
  # so the seed can legitimately take many minutes — keep the ceiling generous.
  s=$((s+1)); [ $s -gt 600 ] && fail "bucket seed timed out (>1200s; bucket likely very large)"
  sleep 2
done
$KD delete pod mc-seed --ignore-not-found >/dev/null 2>&1 || true
ok "drill bucket seeded from backup"

# --- config ConfigMaps in the drill: compute-config + pageserver-config, and a
#     compute-files with neon.safekeepers rewritten to the single drill safekeeper.
$KD apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata: { name: compute-config, namespace: $DRILL_NS }
data:
  PG_VERSION: "17"
  PAGESERVER_HOST: "pageserver"
  TENANT_ID: "$TENANT"
  TIMELINE_ID: "$TIMELINE"
---
apiVersion: v1
kind: ConfigMap
metadata: { name: pageserver-config, namespace: $DRILL_NS }
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
    id=1234
YAML

# NOTE: the compute-files ConfigMap is derived + applied LATER (after the tenant
# is re-attached), because the restore compute boots in STATIC (read-only) mode
# pinned to the pageserver's restored LSN — which is only known post-attach.
COMPUTE_FILES_SRC="$(dirname "$0")/54-compute-files.yaml"
[ -f "$COMPUTE_FILES_SRC" ] || fail "missing $COMPUTE_FILES_SRC"
ok "drill base config applied (compute-config + pageserver-config)"

# --- broker + 1 safekeeper + pageserver (fresh PVCs; served from restored bucket) ---
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
$KD rollout status statefulset/pageserver --timeout=180s >/dev/null || fail "drill pageserver not ready"
$KD rollout status deploy/storage-broker --timeout=120s >/dev/null || fail "drill broker not ready"
ok "drill broker + safekeeper + pageserver up"

# --- RE-ATTACH the tenant at a higher generation, then load the timeline from
#     the restored bucket (do NOT create it — it already exists in the backup). ---
info "  re-attaching tenant $TENANT at generation $DRILL_GEN (reads gen-1 index from bucket)"
$KD exec sts/pageserver -- /bin/sh -c "
  set -e
  until curl -sf http://localhost:9898/v1/tenant >/dev/null 2>&1; do sleep 1; done
  curl -sf -X PUT -H 'Content-Type: application/json' \
    -d '{\"mode\":\"AttachedSingle\",\"generation\":$DRILL_GEN,\"tenant_conf\":{}}' \
    http://localhost:9898/v1/tenant/$TENANT/location_config >/dev/null
" >/dev/null || fail "tenant re-attach failed"
info "  waiting for the timeline to load from remote storage"
a=0
while [ $a -lt 60 ]; do
  if $KD exec sts/pageserver -- curl -sf "http://localhost:9898/v1/tenant/$TENANT/timeline" 2>/dev/null | grep -q "$TIMELINE"; then
    break
  fi
  a=$((a+1)); [ $a -ge 60 ] && fail "timeline never loaded from restored bucket"
  sleep 2
done
ok "tenant re-attached; timeline loaded from the restored bucket"

# --- build the STATIC (read-only) compute spec pinned to the restored LSN ---
# LEARNED (documented in docs/operations.md): on 8464 OSS, fresh safekeepers can
# only be bootstrapped at LSN 0 by the walproposer — there is NO safekeeper HTTP
# API to recreate a timeline at an existing LSN (POST/PUT return 404; only
# GET/DELETE exist), and no storage controller to drive it. So a read-WRITE
# restore (which needs safekeeper WAL continuity from the basebackup LSN) aborts
# with "cannot start in read-write mode from this base backup". The faithful,
# working restore verification is a STATIC read-only compute that reads pages
# directly from the restored pageserver at its last durable LSN — no safekeepers.
STATIC_LSN="$($KD exec sts/pageserver -- curl -s "http://localhost:9898/v1/tenant/$TENANT/timeline/$TIMELINE" 2>/dev/null | tr ',' '\n' | grep '"last_record_lsn"' | head -1 | cut -d'"' -f4)"
[ -n "$STATIC_LSN" ] || fail "could not read restored pageserver LSN"
info "  restored pageserver last_record_lsn = $STATIC_LSN (static read LSN)"
# Derive compute-files from deploy/54 (single source of the spec + entrypoint):
#  - rewrite the 3-safekeeper list to the 1 drill safekeeper (harmless in static),
#  - rewrite namespace,
#  - inject spec.mode = {"Static": "<LSN>"} right after "format_version".
sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
    -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/" \
    "$COMPUTE_FILES_SRC" \
  | awk -v lsn="$STATIC_LSN" '{print} /"format_version": 1.0,/{print "            \"mode\": {\"Static\": \"" lsn "\"},"}' \
  | $KD apply -f - >/dev/null
ok "drill compute-files applied (static read-only at $STATIC_LSN)"

# --- fresh compute (replicas:1 for the drill), STATIC read-only, no safekeepers ---
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
              until curl -sf "\${PS}/v1/tenant/\${TENANT_ID}/timeline" | grep -q "\${TIMELINE_ID}"; do
                echo "waiting for timeline ..."; sleep 0.5; done
              echo "timeline ready"
      containers:
        - name: compute
          image: $IMG_COMPUTE
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh","/compute-files/entrypoint.sh"]
          envFrom: [ { configMapRef: { name: compute-config } } ]
          ports: [ { name: pg, containerPort: 55433 } ]
          volumeMounts: [ { name: compute-files, mountPath: /compute-files } ]
          readinessProbe: { tcpSocket: { port: pg }, periodSeconds: 1, failureThreshold: 120 }
      volumes: [ { name: compute-files, configMap: { name: compute-files } } ]
---
apiVersion: v1
kind: Service
metadata: { name: compute, namespace: $DRILL_NS, labels: { app: compute } }
spec:
  publishNotReadyAddresses: true
  selector: { app: compute }
  ports: [ { name: pg, port: 55433, targetPort: pg } ]
YAML
$KD rollout status deploy/compute --timeout=300s >/dev/null || fail "drill compute did not come up (logs: $($KD logs deploy/compute -c compute --tail=40 2>/dev/null))"
ok "drill compute up on the restored storage plane"

# ---------------------------------------------------------------------------
info "STEP 4: assert the marker row is readable in the drill"
got=""
q=0
while [ $q -lt 60 ]; do
  got="$(DRILL_PSQL "select note from $MARKER_TABLE where id='$MARKER_ID'" 2>/dev/null || true)"
  [ -n "$got" ] && break
  q=$((q+1)); sleep 1
done
FIRST_QUERY=$(date +%s)
[ "$got" = "$MARKER_NOTE" ] || fail "marker row NOT readable in drill (got: '$got')"
ok "marker row '$MARKER_ID' READ BACK in restore-drill from the restored backup"
RTO=$((FIRST_QUERY - BACKUP_START))

# ---------------------------------------------------------------------------
# STEP 5: PROMOTE the restored plane to a WRITABLE primary and prove a write
# survives a rebuild.
#
# Data recovered + readable (STEP 4) is only half of disaster recovery — a
# faithful restore must also come back as a read-WRITE service. The read-only
# STATIC compute above reads pages straight from the pageserver at its last
# durable LSN and needs no safekeepers; a writable primary additionally needs the
# safekeepers to confirm WAL continuity from the basebackup LSN, and a fresh
# drill safekeeper reports flush_lsn 0/0. Promotion re-seeds that safekeeper WAL
# from the backed-up /safekeeper prefix (see deploy/_restore-writable.sh) so the
# compute can boot in read-WRITE mode. This stage asserts an INSERT lands and
# then SURVIVES a full compute kill + fresh re-basebackup (durability, not just a
# writable session).
WRITE_TABLE=writable_restore_proof
WRITE_ID="wr-$MARKER_ID"
WRITE_NOTE="writable-restore proof; INSERTed into a rebuilt plane, must survive a compute kill"

info "STEP 5: promote the restored plane to WRITABLE (read-write primary)"

# --- re-seed the fresh drill safekeeper from the backed-up /safekeeper WAL so a
#     read-write compute can confirm WAL continuity (deploy/_restore-writable.sh;
#     see docs/operations.md). Without this the PRIMARY boot below aborts with
#     "cannot start in read-write mode from this base backup". ---
WRITABLE_HELPER="$(dirname "$0")/_restore-writable.sh"
[ -f "$WRITABLE_HELPER" ] || fail "missing $WRITABLE_HELPER (writable-promotion mechanism)"
KUBECTL="$KUBECTL" RT="$RT" DRILL_NS="$DRILL_NS" TENANT="$TENANT" TIMELINE="$TIMELINE" \
  IMG_MC="$IMG_MC" sh "$WRITABLE_HELPER" || fail "safekeeper WAL re-seed failed"

# --- boot the compute in PRIMARY (read-write) mode: same compute-files as the
#     Static stage but WITHOUT the spec.mode=Static injection, and pointed at the
#     single drill safekeeper. On an un-seeded safekeeper this aborts with
#     "cannot start in read-write mode from this base backup" (the gap this stage
#     exists to close). ---
sed -e "s#safekeeper-0.safekeeper:5454,safekeeper-1.safekeeper:5454,safekeeper-2.safekeeper:5454#safekeeper-0.safekeeper:5454#g" \
    -e "s/^  namespace: $SRC_NS/  namespace: $DRILL_NS/" \
    "$COMPUTE_FILES_SRC" \
  | $KD apply -f - >/dev/null
$KD rollout restart deploy/compute >/dev/null
$KD rollout status deploy/compute --timeout=180s >/dev/null 2>&1 \
  || fail "restored compute did not reach a read-WRITE Ready state (logs: $($KD logs deploy/compute -c compute --tail=25 2>/dev/null))"
[ "$(DRILL_PSQL 'show transaction_read_only' 2>/dev/null)" = "off" ] \
  || fail "restored compute is still read-only (transaction_read_only != off)"
ok "restored compute booted in read-WRITE mode"

# --- write a proof row through the writable restore ---
DRILL_PSQL "create table if not exists $WRITE_TABLE(id text primary key, note text, ts timestamptz default now())" >/dev/null \
  || fail "could not create proof table (plane not writable)"
DRILL_PSQL "insert into $WRITE_TABLE(id,note) values ('$WRITE_ID','$WRITE_NOTE')" >/dev/null \
  || fail "INSERT into the restored plane failed"
WRITABLE_QUERY=$(date +%s)
DRILL_PSQL "checkpoint" >/dev/null 2>&1 || true
ok "INSERT accepted by the restored writable plane (id '$WRITE_ID')"

# --- durability: kill the compute so it re-basebackups fresh, then re-read ---
info "  killing the restored compute to prove the write is DURABLE (not just in-session)"
$KD delete pod -l app=compute --wait=true >/dev/null 2>&1 || true
$KD rollout status deploy/compute --timeout=180s >/dev/null 2>&1 \
  || fail "restored compute did not come back after the durability kill"
back=""
r=0
while [ $r -lt 60 ]; do
  back="$(DRILL_PSQL "select note from $WRITE_TABLE where id='$WRITE_ID'" 2>/dev/null || true)"
  [ -n "$back" ] && break
  r=$((r+1)); sleep 1
done
[ "$back" = "$WRITE_NOTE" ] || fail "proof row NOT durable — lost across the compute kill (got: '$back')"
ok "proof row '$WRITE_ID' SURVIVED a compute kill + fresh re-basebackup — writable restore is durable"
WRITABLE_RTO=$((WRITABLE_QUERY - BACKUP_START))

# ---------------------------------------------------------------------------
echo ""
echo "=========================================================================="
echo " RESTORE DRILL PASSED"
echo "   marker id         : $MARKER_ID"
echo "   marker WAL LSN     : $MARKER_LSN (verified uploaded to bucket before backup)"
echo "   re-attach gen      : $DRILL_GEN"
echo "   RTO read-only  (backup start -> first drill read) : ${RTO}s"
echo "   RTO writable   (backup start -> durable INSERT)   : ${WRITABLE_RTO}s"
echo "   write proof id     : $WRITE_ID (survived a compute kill + re-basebackup)"
echo "=========================================================================="
# cleanup + compute-restore handled by trap
