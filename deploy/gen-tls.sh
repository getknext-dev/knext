#!/bin/sh
# Idempotently ensure the `pggw-tls` Secret exists in scale-zero-pg.
#
# This Secret carries the gateway's front-door TLS keypair. The gateway reads it
# via GW_TLS_CERT_FILE / GW_TLS_KEY_FILE (mounted from this Secret) and answers
# the Postgres SSLRequest with 'S', wrapping the wire in TLS. Closes the
# "plaintext Postgres on an external LoadBalancer" review finding.
#
# NEVER ROTATES SILENTLY.
#   * If the Secret already exists -> no-op (rotation is deliberate; see
#     docs/operations.md#tls-certificate-rotation).
#   * Else -> generate a self-signed cert (CN + SANs below) and create it.
#
# Self-signed on purpose: this is cluster-local infra. Clients connect with
# sslmode=require (encryption without CA verification). Front it with a real CA
# / cert-manager and clients can move to verify-full — see operations.md.
#
# SANs cover every name a client might use:
#   pggw, pggw.scale-zero-pg, pggw.scale-zero-pg.svc  (in-cluster Service)
#   pggw-lb                                            (external LoadBalancer)
#   localhost, 127.0.0.1                               (OrbStack port-forward)
set -eu
NS=scale-zero-pg
NAME=pggw-tls
CN=pggw.scale-zero-pg.svc
K="kubectl -n $NS"

fail() { echo "FAIL: $*" >&2; exit 1; }
command -v kubectl >/dev/null || fail "kubectl not found"
command -v openssl >/dev/null || fail "openssl not found (needed to self-sign the gateway cert)"

if $K get secret "$NAME" >/dev/null 2>&1; then
  echo "ok - Secret $NAME already exists; leaving untouched (no silent rotation)"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# One-shot self-signed cert with SANs (openssl >=1.1.1 supports -addext).
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TMP/tls.key" -out "$TMP/tls.crt" \
  -days 825 -subj "/CN=$CN" \
  -addext "subjectAltName=DNS:pggw,DNS:pggw.scale-zero-pg,DNS:pggw.scale-zero-pg.svc,DNS:pggw-lb,DNS:pggw-lb.scale-zero-pg,DNS:pggw-lb.scale-zero-pg.svc,DNS:localhost,IP:127.0.0.1" \
  >/dev/null 2>&1 || fail "openssl could not generate the self-signed cert"

$K create secret tls "$NAME" \
  --cert="$TMP/tls.crt" --key="$TMP/tls.key" >/dev/null \
  || fail "could not create Secret $NAME"
echo "ok - created Secret $NAME (self-signed, CN=$CN, 825d); mount it in deploy/10-gateway.yaml"
