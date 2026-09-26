#!/usr/bin/env bash
# Prints the artifact prefix `<upstream-sha>-<patchset-hash>` for this directory.
# Shared by build.sh (Cloud Build) and the GitHub workflow so both agree on where the artifacts live.
# patchset-hash = first 12 hex of sha256 over `sha256sum` of every patches/*.patch in C-locale order
# (name + content), so renaming, reordering or editing a patch changes the prefix. An empty patchset
# hashes the empty string (e3b0c44298fc).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sha="$(awk '!/^#/ && NF { print $1; exit }' "$here/UPSTREAM_SHA")"
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "UPSTREAM_SHA: expected a 40-hex commit, got '$sha'" >&2
  exit 1
fi
cd "$here/patches"
shopt -s nullglob
export LC_ALL=C
patches=(*.patch)
if [ ${#patches[@]} -eq 0 ]; then
  ph="$(printf '' | sha256sum | cut -c1-12)"
else
  ph="$(sha256sum "${patches[@]}" | sha256sum | cut -c1-12)"
fi
echo "${sha}-${ph}"
