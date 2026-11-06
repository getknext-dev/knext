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

# Bounded retries: a transient upstream 5xx (a GitHub 504 on a release asset)
# must not red the whole job. Only the DOWNLOAD retries; the checksum below is
# unchanged and a mismatch is never retried (it is not a curl error).
fetch() { # <url> <sha256> <file>
  # curl's --retry covers timeouts + 408/429/5xx; --retry-connrefused covers
  # refused connections; the bounded loop covers resets (exit 56/52/35).
  # NOT --retry-all-errors: that would also retry a permanent 404.
  local delay="${KIND_MANIFEST_RETRY_DELAY:-5}" attempt=1 rc
  while :; do
    if curl -fsSL --retry 5 --retry-connrefused --retry-delay "$delay" -o "$3" "$1"; then
      break
    else
      rc=$?
    fi
    case "$rc" in
      56 | 52 | 35)
        if [ "$attempt" -ge 5 ]; then return "$rc"; fi
        attempt=$((attempt + 1))
        sleep "$delay"
        ;;
      *) return "$rc" ;;
    esac
  done
  echo "$2  $3" | sha256sum -c -
}

fetch "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml" \
  "$CERT_MANAGER_SHA256" "$OUT"

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pin-known-images.sh" "$OUT" --expect 3

kubectl apply -f "$OUT"
