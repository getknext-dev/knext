#!/usr/bin/env bash
# hack/cosign-verify.sh — verify the published operator image's keyless signature
# (issue #117). Parameterized by image ref so it works for any published digest.
#
# This is only meaningful POST-publish: the image must exist in GHCR with a
# Sigstore (Fulcio/Rekor) keyless signature produced by operator-supply-chain.yml's
# `cosign sign` step. It is therefore wired into the supply-chain/release flow
# (after sign) and is usable by a client to verify before installing — it is NOT a
# per-PR check (nothing is published on a PR).
#
# Usage:
#   bash hack/cosign-verify.sh <image-ref>
#     <image-ref> is a fully-qualified, DIGEST-PINNED ref, e.g.
#       ghcr.io/getknext-dev/kn-next-operator@sha256:<digest>
#
# Env overrides (defaults match operator-supply-chain.yml's keyless signer):
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
    echo "  verifies the keyless cosign signature of a published operator image" >&2
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
