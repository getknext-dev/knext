#!/usr/bin/env bash
# apps/file-manager/hack/cosign-verify.sh — verify the published APP image's
# keyless cosign signature. Mirrors packages/kn-next-operator/hack/cosign-verify.sh
# so the app (file-manager / gateway) image is verifiable exactly like the operator
# image (security.md "Supply chain": sign + verify, not just sign).
#
# This is only meaningful POST-publish: the image must exist in GHCR with a
# Sigstore (Fulcio/Rekor) keyless signature produced by supply-chain.yml's
# `cosign sign` step. It is wired into the supply-chain flow (after sign, main
# only) and is usable by a client to verify before deploying — it is NOT a
# per-PR check (nothing is published on a PR).
#
# Usage:
#   bash apps/file-manager/hack/cosign-verify.sh <image-ref>
#     <image-ref> is a fully-qualified, DIGEST-PINNED ref, e.g.
#       ghcr.io/getknext-dev/file-manager@sha256:<digest>
#
# Env overrides (defaults match supply-chain.yml's keyless signer):
#   IDENTITY_REGEXP  default: https://github.com/getknext-dev/knext/.*
#   OIDC_ISSUER      default: https://token.actions.githubusercontent.com
#
# Exit codes:
#   0 — signature verified against the pinned identity + issuer
#   1 — bad usage, or signature verification failed

set -euo pipefail

IMAGE_REF="${1:-}"
if [[ -z "$IMAGE_REF" ]]; then
    echo "usage: $0 <image-ref@sha256:digest>" >&2
    echo "  verifies the keyless cosign signature of a published app image" >&2
    exit 1
fi

IDENTITY_REGEXP="${IDENTITY_REGEXP:-https://github.com/getknext-dev/knext/.*}"
OIDC_ISSUER="${OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

if ! command -v cosign >/dev/null 2>&1; then
    echo "ERROR: cosign not found on PATH. Install it: https://docs.sigstore.dev/cosign/installation/" >&2
    exit 1
fi

echo "Verifying signature for: $IMAGE_REF"
echo "  identity-regexp: $IDENTITY_REGEXP"
echo "  oidc-issuer:     $OIDC_ISSUER"

cosign verify "$IMAGE_REF" \
    --certificate-identity-regexp "$IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$OIDC_ISSUER"

echo "OK: signature verified for $IMAGE_REF"
