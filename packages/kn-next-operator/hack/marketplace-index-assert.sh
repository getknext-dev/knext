#!/usr/bin/env bash
# hack/marketplace-index-assert.sh — prove, against the REGISTRY, that the
# Marketplace-bound image is the gated image minus attestations (#1954).
#
# Two claims, both asserted (a failure of either is exit 1):
#   1. NO ATTESTATIONS — the Marketplace index has no attestation manifest
#      (no `vnd.docker.reference.type` annotation, no `unknown/unknown`
#      platform) and none of its platform manifests carries an in-toto layer.
#      This is what AWS Marketplace's scan rejects on.
#   2. SAME BITS — the Marketplace index's platform entries are exactly the
#      gated index's non-attestation entries (platform + digest), and for each
#      one the config digest and the ordered layer digests, fetched from both
#      refs, are equal.
#
# Both refs are read from the registry (`crane manifest`), never from local
# files, so this proves what is actually pushed. Pass digest refs.
#
# Usage: marketplace-index-assert.sh <gated-ref@sha256:…> <marketplace-ref@sha256:…>
#   CRANE=<path>  override the crane binary (the unit test points it at a fake)
# Exit:  0 proven · 1 any violation, unreachable registry, or malformed input

set -euo pipefail

GATED="${1:?usage: marketplace-index-assert.sh <gated-ref> <marketplace-ref>}"
MP="${2:?usage: marketplace-index-assert.sh <gated-ref> <marketplace-ref>}"
CRANE="${CRANE:-crane}"

fail() { echo "FAIL: $*" >&2; exit 1; }

# An unreachable registry or missing ref is a failure, never a pass.
manifest() {
  local out
  out="$("${CRANE}" manifest "$1")" || fail "could not fetch manifest $1"
  printf '%s' "${out}"
}

IS_ATTESTATION='((.annotations // {}) | has("vnd.docker.reference.type")) or ((.platform.os // "") == "unknown") or ((.platform.architecture // "") == "unknown")'

GATED_REPO="${GATED%@*}"
MP_REPO="${MP%@*}"

MP_INDEX="$(manifest "${MP}")"
GATED_INDEX="$(manifest "${GATED}")"

# ── 1. the Marketplace index carries no attestation ─────────────────────────
printf '%s' "${MP_INDEX}" | jq -e '(.manifests | type == "array") and (.manifests | length >= 1)' >/dev/null \
  || fail "Marketplace ref ${MP} is not an image index with at least one manifest"
BAD="$(printf '%s' "${MP_INDEX}" | jq -c "[.manifests[] | select(${IS_ATTESTATION})] | length")"
[[ "${BAD}" = "0" ]] || fail "Marketplace index carries ${BAD} attestation manifest(s)"
printf '%s' "${MP_INDEX}" | jq -e '[.manifests[] | select(has("artifactType") or ((.mediaType | test("image.manifest|distribution.manifest.v2")) | not))] | length == 0' >/dev/null \
  || fail "Marketplace index has an entry that is not a plain image manifest"

# In-toto layers inside a platform manifest would be rejected just the same.
for d in $(printf '%s' "${MP_INDEX}" | jq -r '.manifests[].digest'); do
  manifest "${MP_REPO}@${d}" | jq -e '[.layers[]? | select((.mediaType | test("in-toto")) or ((.annotations // {}) | has("in-toto.io/predicate-type")))] | length == 0' >/dev/null \
    || fail "platform manifest ${d} carries an in-toto layer"
done

# ── 2. same platform manifests, same config + layers as the gated image ─────
GATED_PLATFORMS="$(printf '%s' "${GATED_INDEX}" | jq -S -c "[.manifests[] | select((${IS_ATTESTATION}) | not) | {platform, digest}] | sort_by(.digest)")"
MP_PLATFORMS="$(printf '%s' "${MP_INDEX}" | jq -S -c "[.manifests[] | {platform, digest}] | sort_by(.digest)")"
[[ "${GATED_PLATFORMS}" = "${MP_PLATFORMS}" ]] \
  || fail "platform entries differ. gated=${GATED_PLATFORMS} marketplace=${MP_PLATFORMS}"

for d in $(printf '%s' "${MP_INDEX}" | jq -r '.manifests[].digest'); do
  G="$(manifest "${GATED_REPO}@${d}" | jq -S -c '{config: .config.digest, layers: [.layers[].digest]}')"
  M="$(manifest "${MP_REPO}@${d}" | jq -S -c '{config: .config.digest, layers: [.layers[].digest]}')"
  [[ "${G}" = "${M}" ]] || fail "config/layer digests differ for ${d}: gated=${G} marketplace=${M}"
  [[ "$(printf '%s' "${M}" | jq '.layers | length')" -ge 1 ]] || fail "platform manifest ${d} has no layers"
done

echo "OK: ${MP} has no attestation manifests; its $(printf '%s' "${MP_INDEX}" | jq '.manifests | length') platform manifest(s) have config + layer digests identical to ${GATED}"
