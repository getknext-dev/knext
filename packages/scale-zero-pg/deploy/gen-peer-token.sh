#!/bin/sh
# Idempotently ensure the `pggw-peer-token` Secret exists in scale-zero-pg.
#
# This Secret carries the shared FLEET bearer token that authenticates the peer
# idle-scrape (F6). Every gateway pod reads it as env GW_PEER_TOKEN and:
#   * as a SERVER, requires `Authorization: Bearer <token>` on GET /metrics.json
#     (401 otherwise) — so an in-namespace pod cannot bias the fleet idle
#     decision by answering on a peer's IP;
#   * as a CLIENT, attaches that header when scraping sibling gateways.
# The token gates ONLY /metrics.json; /metrics (Prometheus text) stays open.
#
# Fail-closed by construction: absent this Secret (and without the explicit dev
# opt-out GW_PEER_AUTH_DISABLED=true) the gateway REFUSES to boot rather than
# serve an unauthenticated /metrics.json. Shipping this Secret is therefore the
# default, and the shipped config is fail-closed.
#
# NEVER ROTATES SILENTLY.
#   * If the Secret already exists -> no-op (rotation is deliberate; see
#     docs/operations.md#peer-token-rotation).
#   * Else -> mint a random 256-bit token and create it.
#
# The fleet is homogeneous: the primary gateway (deploy/10-gateway.yaml) and the
# apps gateway (deploy/81-apps-gateway.yaml) mount the SAME Secret, so a peer
# scrape from either front authenticates against either front.
set -eu
NS=scale-zero-pg
NAME=pggw-peer-token
K="kubectl -n $NS"

fail() { echo "FAIL: $*" >&2; exit 1; }
command -v kubectl >/dev/null || fail "kubectl not found"

if $K get secret "$NAME" >/dev/null 2>&1; then
  echo "ok - Secret $NAME already exists; leaving untouched (no silent rotation)"
  exit 0
fi

# 32 random bytes, hex-encoded (64 chars). openssl if present, else /dev/urandom.
if command -v openssl >/dev/null 2>&1; then
  TOKEN=$(openssl rand -hex 32) || fail "openssl could not generate a token"
else
  TOKEN=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n') || fail "could not read /dev/urandom"
fi
[ -n "$TOKEN" ] || fail "generated an empty token"

$K create secret generic "$NAME" \
  --from-literal=token="$TOKEN" >/dev/null \
  || fail "could not create Secret $NAME"
echo "ok - created Secret $NAME (random 256-bit fleet peer token); mounted as GW_PEER_TOKEN in deploy/10-gateway.yaml and deploy/81-apps-gateway.yaml"
