#!/bin/sh
# Idempotently ensure the `storage-s3-creds` Secret exists in scale-zero-pg.
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

if $K get secret "$NAME" >/dev/null 2>&1; then
  echo "ok - Secret $NAME already exists; leaving untouched (no silent rotation)"
  exit 0
fi

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
