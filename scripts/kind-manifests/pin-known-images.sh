#!/usr/bin/env bash
# Rewrite the small, fixed set of mutable-tag images checked into
# image-digest-pins.json to their pinned digest, in place, in a downloaded
# manifest file. Unrecognized images are left untouched — Knative's own
# release manifests already ship their own images digest-pinned, so this
# only ever needs to cover the third-party manifests that don't (#1289).
#
# Usage: pin-known-images.sh <manifest-file> [--expect N]
#
# --expect N (optional): fail loudly if the number of pins actually applied
# is not exactly N. Catches upstream silently renaming/retagging an image
# this table no longer matches — a 0-pins-applied run would otherwise apply
# an UNPINNED manifest without anyone noticing.
set -euo pipefail

file="$1"
shift || true
expect=""
if [[ "${1:-}" == "--expect" ]]; then
  expect="$2"
fi

table="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/image-digest-pins.json"

escape_sed() {
  # Escapes sed BRE metacharacters for safe use inside a `#`-delimited
  # pattern (image refs contain `/`, which `#` avoids conflicting with).
  printf '%s' "$1" | sed -e 's/[]\/$*.^&[]/\\&/g'
}

pinned=0
while IFS=$'\t' read -r ref digest; do
  [[ "$ref" == _comment ]] && continue
  repo="${ref%%:*}"
  # Match both the bare form (image: repo:tag) and the quoted form
  # (image: "repo:tag") — different manifests render it either way.
  if grep -qF "image: ${ref}" "$file" || grep -qF "image: \"${ref}\"" "$file"; then
    esc_ref="$(escape_sed "$ref")"
    sed -i.bak -E "s#image: \"?${esc_ref}\"?#image: ${repo}@${digest}#g" "$file"
    rm -f "${file}.bak"
    pinned=$((pinned + 1))
  fi
done < <(jq -r 'to_entries[] | select(.key != "_comment") | "\(.key)\t\(.value)"' "$table")

echo "pin-known-images: pinned ${pinned} image reference(s) in ${file}" >&2

if [[ -n "$expect" && "$pinned" != "$expect" ]]; then
  echo "::error::pin-known-images expected exactly ${expect} pin(s) in ${file}, applied ${pinned} — the manifest's image tags no longer match image-digest-pins.json (upstream retag/rename?); re-resolve and update the table deliberately, do not apply an under-pinned manifest" >&2
  exit 1
fi

# Fail closed on ANY remaining mutable-tag image, not just a count mismatch
# against the known table (#1413 review, round-1-1410). --expect only proves
# the KNOWN entries in image-digest-pins.json still match — it says nothing
# about a NEW `image:` line upstream added that this table has never heard
# of, which would sail through with a plain tag and no digest. Scan the
# whole (post-pin) manifest for any `image:` value that isn't `@sha256:`-
# pinned and refuse to hand back an under-pinned manifest.
#
# #1413 review round 2: the earlier regex required the line to START with
# `image:` (after only whitespace), which MISSES the YAML list-item form
# `- image: repo:tag` (e.g. kourier.yaml's containers list) — an optional
# `-[[:space:]]*` prefix is now allowed. It also required end-of-line right
# after the ref, so a trailing `# comment` made the whole line invisible to
# this scan; the anchor now tolerates an optional trailing comment.
unpinned="$(grep -nE '^[[:space:]]*(-[[:space:]]*)?image:[[:space:]]*"?[^"[:space:]]+"?[[:space:]]*(#.*)?$' "$file" | grep -v '@sha256:' || true)"
if [[ -n "$unpinned" ]]; then
  echo "::error::pin-known-images: ${file} still has unpinned (non-@sha256) image reference(s) after pinning — a new/renamed image upstream added is not in image-digest-pins.json:" >&2
  echo "$unpinned" >&2
  exit 1
fi
