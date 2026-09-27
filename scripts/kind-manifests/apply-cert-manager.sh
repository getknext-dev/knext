#!/usr/bin/env bash
# Fetch, checksum-verify, image-digest-pin, then apply the cert-manager
# release manifest — the shared "fetch + verify + apply" helper #1289 asks
# for, used by every kind-based workflow that installs cert-manager (operator
# webhook certs). A moved/edited release asset fails the checksum; a
# retagged/renamed cert-manager image fails the pin-count check — either way
# the workflow dies loud, before anything is applied, rather than installing
# something nobody checksummed.
set -euo pipefail

CERT_MANAGER_VERSION="v1.16.2"
CERT_MANAGER_SHA256="1d51cdecd442f1f5f89783e9e0169b95d372724da203cc75dd7a5c4e50a10ce6"
OUT="${TMPDIR:-/tmp}/cert-manager.yaml"

curl -fsSL -o "$OUT" \
  "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
echo "${CERT_MANAGER_SHA256}  ${OUT}" | sha256sum -c -

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pin-known-images.sh" "$OUT" --expect 3

kubectl apply -f "$OUT"
