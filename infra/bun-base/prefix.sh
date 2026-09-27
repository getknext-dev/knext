#!/usr/bin/env bash
# Run it as `bash prefix.sh` (never sourced: $0 must be this file's path).
# Prints the artifact prefix `<upstream-sha>-<patchset-hash>` for this directory.
# Shared by build.sh (Cloud Build) and the GitHub workflow so both agree on where the artifacts live.
# patchset-hash = first 12 hex of sha256 over `sha256sum` of every patches/*.patch in C-locale order
# (name + content), so renaming, reordering or editing a patch changes the prefix. An empty patchset
# hashes the empty string (e3b0c44298fc).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sha="$(awk '!/^#/ && NF { print $1; exit }' "$here/UPSTREAM_SHA")"
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "UPSTREAM_SHA: expected a 40-hex commit, got '$sha'" >&2
  exit 1
fi
cd "$here/patches"
shopt -s nullglob
export LC_ALL=C
# One `sha256sum <file>` line per patch (the same lines `sha256sum a b …` prints), hashed again; with
# no patches the loop prints nothing, which hashes to the empty-string digest. No array, no arithmetic.
ph="$(for p in *.patch; do sha256sum "$p"; done | sha256sum | cut -c1-12)"
echo "${sha}-${ph}"
