#!/usr/bin/env bash
# hack/marketplace-index-build.sh — derive the AWS Marketplace-bound image index
# from the gated OCI layout, WITHOUT rebuilding (#1954).
#
# WHY: AWS Marketplace rejects container images whose index carries attestation
# (in-toto) manifests ("layers with unsupported architectures"). The GHCR image
# is built with `provenance: mode=max`, so its index holds, next to each
# platform manifest, a buildkit attestation manifest. The GHCR image must keep
# them (signed + provenance); the Marketplace copy must not have them.
#
# HOW: the same bytes, a different index. This reads the nested image index out
# of the layout the Trivy gate scanned, drops every attestation entry, and
# writes a NEW index blob that references the SAME platform manifests (same
# digests => same config + layers => same bits). Nothing is rebuilt, so there
# is no second build that could diverge from what Trivy approved and cosign
# signed. The output is itself an OCI layout (all source blobs hard-linked, plus
# the one new index blob) that `crane push` publishes like the gated one.
#
# The result is self-checked here (cheap, local, runs on every ref) and proven
# again against the registry by hack/marketplace-index-assert.sh before it is
# signed or tagged.
#
# Usage: marketplace-index-build.sh <src-oci-layout-dir> <dest-oci-layout-dir>
# Exit:  0 ok · 1 any structural problem (fails loud, never guesses)

set -euo pipefail

SRC="${1:?usage: marketplace-index-build.sh <src-oci-layout-dir> <dest-oci-layout-dir>}"
DEST="${2:?usage: marketplace-index-build.sh <src-oci-layout-dir> <dest-oci-layout-dir>}"

die() { echo "marketplace-index-build: $*" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# An entry is an attestation if it carries buildkit's reference-type annotation
# or an `unknown/unknown` platform (the in-toto convention) — either marks it.
IS_ATTESTATION='((.annotations // {}) | has("vnd.docker.reference.type")) or ((.platform.os // "") == "unknown") or ((.platform.architecture // "") == "unknown")'

[[ -f "${SRC}/index.json" ]] || die "no index.json in ${SRC}"
[[ ! -e "${DEST}" ]] || die "${DEST} already exists"

# index.json holds one entry: the nested multi-platform index buildx emits.
[[ "$(jq '.manifests | length' "${SRC}/index.json")" = "1" ]] || die "expected exactly one top-level manifest in ${SRC}/index.json"
NESTED_DIGEST="$(jq -r '.manifests[0].digest' "${SRC}/index.json")"
NESTED_MT="$(jq -r '.manifests[0].mediaType' "${SRC}/index.json")"
case "${NESTED_MT}" in
  application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json) ;;
  *) die "top-level manifest is ${NESTED_MT}, not an image index" ;;
esac
NESTED_BLOB="${SRC}/blobs/sha256/${NESTED_DIGEST#sha256:}"
[[ -f "${NESTED_BLOB}" ]] || die "nested index blob missing: ${NESTED_BLOB}"

TOTAL="$(jq '.manifests | length' "${NESTED_BLOB}")"
KEPT="$(jq "[.manifests[] | select((${IS_ATTESTATION}) | not)] | length" "${NESTED_BLOB}")"
[[ "${KEPT}" -ge 1 ]] || die "no platform manifests would remain"

mkdir -p "${DEST}/blobs/sha256"
SRC_ABS="$(cd "${SRC}" && pwd)"
for blob in "${SRC_ABS}"/blobs/sha256/*; do
  # Hard link (free, same bytes), copy if the filesystems differ. NOT a
  # symlink: go-containerregistry's layout reader rejects symlinked blobs, so
  # `crane push` of the result would fail ("layout blob … is a symlink").
  ln "${blob}" "${DEST}/blobs/sha256/$(basename "${blob}")" 2>/dev/null \
    || cp "${blob}" "${DEST}/blobs/sha256/$(basename "${blob}")"
done
cp "${SRC}/oci-layout" "${DEST}/oci-layout"

# New index: same schema/mediaType, platform entries copied verbatim (digest,
# size, platform, annotations all untouched), attestation entries removed.
NEW="${DEST}/new-index.json"
jq -c "{schemaVersion: 2, mediaType: .mediaType,
        manifests: [.manifests[] | select((${IS_ATTESTATION}) | not)]}" "${NESTED_BLOB}" > "${NEW}.nl"
printf '%s' "$(cat "${NEW}.nl")" > "${NEW}"
rm "${NEW}.nl"
NEW_HEX="$(sha256_of "${NEW}")"
NEW_SIZE="$(wc -c < "${NEW}" | tr -d ' ')"
mv "${NEW}" "${DEST}/blobs/sha256/${NEW_HEX}"

jq -c -n --arg mt "${NESTED_MT}" --arg d "sha256:${NEW_HEX}" --argjson s "${NEW_SIZE}" \
  '{schemaVersion: 2, manifests: [{mediaType: $mt, digest: $d, size: $s}]}' > "${DEST}/index.json"

# ── Self-check (never trust the transform: re-read what was written) ────────
OUT_BLOB="${DEST}/blobs/sha256/${NEW_HEX}"
[[ "$(jq "[.manifests[] | select(${IS_ATTESTATION})] | length" "${OUT_BLOB}")" = "0" ]] \
  || die "self-check: attestation entries survived in the Marketplace index"
[[ "$(jq '.manifests | length' "${OUT_BLOB}")" = "${KEPT}" ]] || die "self-check: platform entry count changed"
# Every kept entry is byte-identical to the gated index's entry (same digest).
diff <(jq -S -c '.manifests[]' "${OUT_BLOB}") \
     <(jq -S -c ".manifests[] | select((${IS_ATTESTATION}) | not)" "${NESTED_BLOB}") >/dev/null \
  || die "self-check: platform entries differ from the gated index"
for d in $(jq -r '.manifests[].digest' "${OUT_BLOB}"); do
  [[ -e "${DEST}/blobs/sha256/${d#sha256:}" ]] || die "self-check: platform manifest blob ${d} missing from the layout"
done

echo "marketplace index sha256:${NEW_HEX}: kept ${KEPT} platform manifest(s), dropped $((TOTAL - KEPT)) attestation manifest(s) from ${NESTED_DIGEST}"
