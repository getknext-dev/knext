#!/bin/sh
# Idempotently ensure the platform's S3 Secrets exist in scale-zero-pg:
#   * storage-s3-creds  — MinIO root identity for the in-cluster object store.
#   * backup-s3-target  — OFF-CLUSTER backup destination (OCI Object Storage,
#                         S3-compatible). See "backup-s3-target" below.
#
# ---------------------------------------------------------------------------
# storage-s3-creds
# ---------------------------------------------------------------------------
#
# This Secret carries the MinIO root identity, which doubles as the S3 access
# key the safekeepers + pageserver use to reach the object store. Two keys:
#   user      -> MINIO_ROOT_USER / AWS_ACCESS_KEY_ID
#   password  -> MINIO_ROOT_PASSWORD / AWS_SECRET_ACCESS_KEY
#
# NEVER ROTATES SILENTLY. MinIO root credentials are the identity the object
# store was initialized with; changing them out from under a running MinIO can
# lock it out of its own IAM/config. So:
#   * If the Secret already exists  -> no-op (leave it; rotation is deliberate).
#   * Else if a minio Deployment already exists (live cluster, initialized PVC)
#     -> ADOPT the current live MINIO_ROOT_USER/PASSWORD so nothing breaks on
#        migration. (Run this BEFORE applying the secretKeyRef manifests, while
#        the old plaintext env is still on the Deployment.)
#   * Else (fresh cluster) -> generate user=minio-admin + a random 32-char
#     password.
# Override for fresh clusters: STORAGE_S3_USER / STORAGE_S3_PASSWORD env.
#
# To ROTATE properly (deliberate, planned): use MinIO's root-rotation flow
# (start MinIO with MINIO_ROOT_USER_OLD/MINIO_ROOT_PASSWORD_OLD set to the
# current values and the new MINIO_ROOT_USER/PASSWORD, let it re-encrypt config),
# THEN update this Secret. Do not just edit the Secret and restart.
set -eu
NS=scale-zero-pg
NAME=storage-s3-creds
K="kubectl -n $NS"

fail() { echo "FAIL: $*" >&2; exit 1; }
command -v kubectl >/dev/null || fail "kubectl not found"

# NOTE: do NOT `exit 0` on the already-exists path — the backup-s3-target
# section below must still run. Each Secret is guarded independently.
if $K get secret "$NAME" >/dev/null 2>&1; then
  echo "ok - Secret $NAME already exists; leaving untouched (no silent rotation)"
else
  USER="${STORAGE_S3_USER:-}"
  PASS="${STORAGE_S3_PASSWORD:-}"

  # Adopt live creds if minio is already running (migration path).
  if [ -z "$USER" ] && $K get deploy minio >/dev/null 2>&1; then
    USER=$($K get deploy minio -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MINIO_ROOT_USER")].value}' 2>/dev/null || true)
    PASS=$($K get deploy minio -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MINIO_ROOT_PASSWORD")].value}' 2>/dev/null || true)
    [ -n "$USER" ] && echo "adopting current live MinIO credentials (PVC already initialized)"
  fi

  # Fresh cluster: generate.
  if [ -z "$USER" ]; then
    USER=minio-admin
    echo "fresh cluster: generating new MinIO credentials"
  fi
  if [ -z "$PASS" ]; then
    if command -v openssl >/dev/null 2>&1; then
      PASS=$(openssl rand -hex 16) # 32 hex chars
    else
      PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
    fi
  fi

  $K create secret generic "$NAME" \
    --from-literal=user="$USER" \
    --from-literal=password="$PASS" >/dev/null \
    || fail "could not create Secret $NAME"
  echo "ok - created Secret $NAME (user=$USER, password hidden)"
fi

# ---------------------------------------------------------------------------
# storage-objstore — the object-storage BACKEND target (issue #105)
# ---------------------------------------------------------------------------
# The pageserver (page offload) + safekeepers (WAL offload) read their S3
# endpoint/bucket/region from THIS ConfigMap (52/53/57 envFrom it); the S3
# access/secret stay in storage-s3-creds above. Decoupling these from bundled
# MinIO is the whole point of #105: MinIO archived its community repos, so the
# backend must be swappable at the (S3) protocol level.
#
#   OBJSTORE_ENDPOINT -> S3 endpoint URL (custom endpoint => neon uses PATH-STYLE
#                        automatically; no separate force-path-style flag exists)
#   OBJSTORE_BUCKET   -> bucket name (default: neon)
#   OBJSTORE_REGION   -> region (default: eu-north-1; set to your S3 region)
#
# DEFAULT (no override) = the in-cluster MinIO of deploy/50-minio.yaml —
# BACKWARD COMPATIBLE, nothing changes for an existing plane. Override via env
# for an EXTERNAL backend (managed cloud S3, or a maintained on-prem alternative
# — SeaweedFS / Ceph RADOS Gateway / Garage):
#
#   # OCI Object Storage S3 Compatibility API (proven in _verify-objstore.sh).
#   # Mint a Customer Secret Key (SigV4 access/secret) for the api-key user and
#   # supply it AS the storage creds (STORAGE_S3_USER/PASSWORD above), plus:
#   STORAGE_OBJSTORE_ENDPOINT=https://<ns>.compat.objectstorage.<region>.oraclecloud.com \
#   STORAGE_OBJSTORE_BUCKET=ks-pg-pages STORAGE_OBJSTORE_REGION=me-abudhabi-1 \
#   STORAGE_S3_USER=<access> STORAGE_S3_PASSWORD=<secret> \
#     sh deploy/gen-secrets.sh
#   # ...then apply everything EXCEPT deploy/50-minio.yaml (see docs/operations.md
#   #    "Object-storage backend").
#
# No-silent-repoint: if the ConfigMap already exists, leave it (re-pointing an
# object store under a live plane is deliberate — delete + re-run to change it).
CMNAME=storage-objstore
OBJ_ENDPOINT="${STORAGE_OBJSTORE_ENDPOINT:-http://minio:9000}"
OBJ_BUCKET="${STORAGE_OBJSTORE_BUCKET:-neon}"
OBJ_REGION="${STORAGE_OBJSTORE_REGION:-eu-north-1}"
if $K get configmap "$CMNAME" >/dev/null 2>&1; then
  echo "ok - ConfigMap $CMNAME already exists; leaving untouched (re-point deliberately: kubectl -n $NS delete configmap $CMNAME, then re-run)"
else
  $K create configmap "$CMNAME" \
    --from-literal=OBJSTORE_ENDPOINT="$OBJ_ENDPOINT" \
    --from-literal=OBJSTORE_BUCKET="$OBJ_BUCKET" \
    --from-literal=OBJSTORE_REGION="$OBJ_REGION" >/dev/null \
    || fail "could not create ConfigMap $CMNAME"
  echo "ok - created ConfigMap $CMNAME (endpoint=$OBJ_ENDPOINT bucket=$OBJ_BUCKET region=$OBJ_REGION)"
  case "$OBJ_ENDPOINT" in
    *minio*) : ;;
    *) echo "    -> EXTERNAL object store configured: do NOT apply deploy/50-minio.yaml"
       echo "       (see docs/operations.md 'Object-storage backend')" ;;
  esac
fi

# ---------------------------------------------------------------------------
# alertmanager-receiver — REAL on-call pager (optional; Slack-compatible)
# ---------------------------------------------------------------------------
# Alertmanager (deploy/61) ships a default in-cluster logging sink so the pager
# path is testable with no external creds. To page a human, mount a Slack
# incoming-webhook URL here (Alertmanager reads it at send time via
# `api_url_file`, so the URL never lands in a ConfigMap or in git), then flip
# `route.receiver` to `slack` in the alertmanager-config ConfigMap.
#
# Two keys, both optional:
#   slack-webhook    -> the Slack (or compat) incoming-webhook URL (real pager).
#                       Provide via env ALERT_SLACK_WEBHOOK_URL.
#   watchdog-webhook -> the EXTERNAL dead-man's-switch URL (issue #60): a
#                       healthchecks.io / Dead Man's Snitch / cronitor "ping" URL
#                       that the always-firing Watchdog alert POSTs to on a short
#                       repeat_interval. The external side ALARMS when the ping
#                       STOPS — the only way to catch Prometheus/Alertmanager
#                       themselves being down (they cannot page for their own death).
#                       Provide via env WATCHDOG_HEARTBEAT_URL.
# Both read at send time from the mounted Secret (never in a ConfigMap or git).
# No-silent-rotation: if the Secret exists, leave it. If MISSING and no URL
# supplied, NO-OP with a hint (the default sink keeps working) — never fails the run.
RNAME=alertmanager-receiver
if $K get secret "$RNAME" >/dev/null 2>&1; then
  echo "ok - Secret $RNAME already exists; leaving untouched (no silent rotation)"
elif [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ] || [ -n "${WATCHDOG_HEARTBEAT_URL:-}" ]; then
  set -- create secret generic "$RNAME"
  [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ] && set -- "$@" --from-literal=slack-webhook="$ALERT_SLACK_WEBHOOK_URL"
  [ -n "${WATCHDOG_HEARTBEAT_URL:-}" ] && set -- "$@" --from-literal=watchdog-webhook="$WATCHDOG_HEARTBEAT_URL"
  $K "$@" >/dev/null || fail "could not create Secret $RNAME"
  echo "ok - created Secret $RNAME (webhook URL(s) hidden)"
  [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ] && {
    echo "    -> set route.receiver: slack in the alertmanager-config ConfigMap and:"
    echo "       kubectl -n $NS rollout restart deploy/alertmanager"; }
  [ -n "${WATCHDOG_HEARTBEAT_URL:-}" ] && {
    echo "    -> Watchdog dead-man's-switch armed: point your external monitor's"
    echo "       expected-ping period to ~5m and rollout-restart alertmanager."; }
else
  echo "note - Secret $RNAME not set; alerts route to the in-cluster logging sink and"
  echo "       the Watchdog dead-man's-switch is disarmed (no external heartbeat sink)."
  echo "       To page a human + arm the dead-man's-switch, re-run with either/both:"
  echo "         ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX \\"
  echo "         WATCHDOG_HEARTBEAT_URL=https://hc-ping.com/<uuid> sh deploy/gen-secrets.sh"
fi

# ---------------------------------------------------------------------------
# backup-s3-target — OFF-CLUSTER backup destination (OCI Object Storage)
# ---------------------------------------------------------------------------
# The daily backup CronJob (deploy/62-backup.yaml) mirrors the `neon` bucket to
# OCI Object Storage over its native S3-compatible endpoint. Three keys the
# mirror needs:
#   endpoint -> https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
#   access   -> the Customer Secret Key ACCESS key id  (AWS_ACCESS_KEY_ID)
#   secret   -> the Customer Secret Key SECRET          (AWS_SECRET_ACCESS_KEY)
#   bucket   -> the destination bucket (default: ks-pg-backup)
#
# THE ACCESS/SECRET PAIR IS NOT AN OCI API KEY. It is a "Customer Secret Key"
# minted ONCE PER TENANCY for the API-key user, and shown only at creation time:
#
#   oci --profile DEFAULT iam customer-secret-key create \
#       --user-id <the api-key user OCID> --display-name ks-pg-backup-s3 \
#       --query 'data.{access:id,secret:key}'
#
# The destination bucket must exist first, with versioning + a lifecycle policy:
#   oci --profile DEFAULT os bucket create -ns <namespace> --name ks-pg-backup \
#       --compartment-id <compartment> --versioning Enabled
#   oci --profile DEFAULT os object-lifecycle-policy put -ns <namespace> \
#       --bucket-name ks-pg-backup --from-json file://lifecycle.json --force
# (lifecycle.json: DELETE previous-object-versions after 30 DAYS.)
#
# Provide the values via env (BACKUP_S3_ENDPOINT / BACKUP_S3_ACCESS /
# BACKUP_S3_SECRET / BACKUP_S3_BUCKET) or positional args 1..4. Same no-silent-
# rotation rule: if the Secret already exists, leave it. If it is MISSING and no
# credentials were supplied, PRINT the provisioning instructions and fail loudly
# (never create a half-empty Secret silently).
BNAME=backup-s3-target
DEFAULT_BUCKET=ks-pg-backup

if $K get secret "$BNAME" >/dev/null 2>&1; then
  echo "ok - Secret $BNAME already exists; leaving untouched (no silent rotation)"
  exit 0
fi

BK_ENDPOINT="${BACKUP_S3_ENDPOINT:-${1:-}}"
BK_ACCESS="${BACKUP_S3_ACCESS:-${2:-}}"
BK_SECRET="${BACKUP_S3_SECRET:-${3:-}}"
BK_BUCKET="${BACKUP_S3_BUCKET:-${4:-$DEFAULT_BUCKET}}"

if [ -z "$BK_ENDPOINT" ] || [ -z "$BK_ACCESS" ] || [ -z "$BK_SECRET" ]; then
  cat >&2 <<'MSG'
FAIL: Secret backup-s3-target is MISSING and no credentials were supplied.

The off-cluster backup destination needs an OCI Customer Secret Key (one per
tenancy). Provision it once, then re-run with the values:

  # 1. destination bucket (versioning + 30d lifecycle) — once per tenancy:
  oci --profile DEFAULT os bucket create -ns <NAMESPACE> --name ks-pg-backup \
      --compartment-id <COMPARTMENT_OCID> --versioning Enabled

  # 2. Customer Secret Key for the api-key user (the S3 access/secret pair):
  oci --profile DEFAULT iam customer-secret-key create \
      --user-id <USER_OCID> --display-name ks-pg-backup-s3 \
      --query 'data.{access:id,secret:key}'

  # 3. create the Secret (endpoint has the namespace + region baked in):
  BACKUP_S3_ENDPOINT=https://<NAMESPACE>.compat.objectstorage.<REGION>.oraclecloud.com \
  BACKUP_S3_ACCESS=<access> BACKUP_S3_SECRET=<secret> \
  BACKUP_S3_BUCKET=ks-pg-backup \
    sh deploy/gen-secrets.sh

  # ...or positionally:
  sh deploy/gen-secrets.sh <endpoint> <access> <secret> [bucket]
MSG
  exit 1
fi

$K create secret generic "$BNAME" \
  --from-literal=endpoint="$BK_ENDPOINT" \
  --from-literal=access="$BK_ACCESS" \
  --from-literal=secret="$BK_SECRET" \
  --from-literal=bucket="$BK_BUCKET" >/dev/null \
  || fail "could not create Secret $BNAME"
echo "ok - created Secret $BNAME (endpoint=$BK_ENDPOINT, bucket=$BK_BUCKET, access/secret hidden)"
