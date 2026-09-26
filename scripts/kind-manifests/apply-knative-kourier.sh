#!/usr/bin/env bash
# Fetch, checksum-verify, image-digest-pin, then apply the Knative Serving +
# net-kourier release manifests — the shared "fetch + verify + apply" helper
# #1289 asks for, used by every kind-based workflow that installs Knative.
# Knative's own images are already digest-pinned inside these manifests; the
# ONE mutable-tag image left is net-kourier's envoy sidecar
# (docker.io/envoyproxy/envoy:v1.31-latest, a floating branch tag), pinned via
# pin-known-images.sh the same way cert-manager's images are.
#
# Usage: apply-knative-kourier.sh <knative-version>  (e.g. knative-v1.16.0)
set -euo pipefail

KNATIVE_VERSION="${1:?usage: apply-knative-kourier.sh <knative-version>}"

# The three checksums below belong to THIS release. Any other version fails
# fast here, naming the pin, rather than with an unexplained checksum mismatch.
PINNED_KNATIVE_VERSION="knative-v1.16.0"
if [ "$KNATIVE_VERSION" != "$PINNED_KNATIVE_VERSION" ]; then
  echo "apply-knative-kourier.sh: $KNATIVE_VERSION requested, but this script pins $PINNED_KNATIVE_VERSION; update PINNED_KNATIVE_VERSION and the three sha256 values together" >&2
  exit 1
fi

SERVING_CRDS_SHA256="33cc24f96321cd19deea6b85397e53b24e1a7ae61aebc4a92c2bd867e93611ec"
SERVING_CORE_SHA256="1f55c6b02bbea20ffe7c203811ae8dfd238ead7caca1f2e76275b239dfd06206"
KOURIER_SHA256="381efeb83e0f424d7ada19a581ecfa9a8267aae396d9100e836cc131cc7d210f"

TMPDIR="${TMPDIR:-/tmp}"
CRDS_OUT="${TMPDIR}/serving-crds.yaml"
CORE_OUT="${TMPDIR}/serving-core.yaml"
KOURIER_OUT="${TMPDIR}/kourier.yaml"

fetch() { # <url> <sha256> <file>
  curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c -
}

fetch "https://github.com/knative/serving/releases/download/${KNATIVE_VERSION}/serving-crds.yaml" \
  "$SERVING_CRDS_SHA256" "$CRDS_OUT"
fetch "https://github.com/knative/serving/releases/download/${KNATIVE_VERSION}/serving-core.yaml" \
  "$SERVING_CORE_SHA256" "$CORE_OUT"
fetch "https://github.com/knative/net-kourier/releases/download/${KNATIVE_VERSION}/kourier.yaml" \
  "$KOURIER_SHA256" "$KOURIER_OUT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/pin-known-images.sh" "$KOURIER_OUT" --expect 1

kubectl apply -f "$CRDS_OUT"
kubectl apply -f "$CORE_OUT"
kubectl apply -f "$KOURIER_OUT"
