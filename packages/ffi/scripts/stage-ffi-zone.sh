#!/usr/bin/env bash
# Stages the FFI e2e fixture zone OUTSIDE the repository (ADR-0069 D17, D20):
# apps/file-manager, the reference app the compat-smoke checks assert, with
# the in-process Rust opt-in from packages/ffi/fixtures/ffi-zone laid over it
# (knext.ffi.json, the rust/ crate, the committed generated wrapper and the
# /rust-ffi page whose Server Actions call Rust). apps/file-manager itself is
# never changed.
#
#   stage-ffi-zone.sh <repo-root> <dest>
#
# Only TRACKED files are copied (git archive), so a developer's local build
# output never leaks into the fixture. What is removed from the copy is test
# and tooling scaffolding the app's own `next build` type-check would trip on
# outside the monorepo (bun:test specs, the vinext dev entry, e2e harnesses);
# src/, public/ and the app's configuration stay as they are.
#
# The crate's knext-ffi path dependency is rewritten to this checkout's
# crates/knext-ffi (exactly one occurrence, or this fails). The workspace
# dependencies (@getknext/lib, @getknext/core, the unused @getknext/ui) are
# removed from package.json; the caller installs the packed tarballs instead.
#
# FFI_E2E_OVERLAY=none stages the same copy WITHOUT the opt-in (no overlay,
# no crate): the baseline the workflow smokes only when the opted-in build's
# smoke fails, to say whether the failure is the opt-in's or the cell's.
#
# FFI_E2E_MUTATION=compat-check (workflow_dispatch mutation proof only) also
# deletes the compat-smoke fixture route src/app/knext-smoke/stream, which
# capability checks (i) and (j) assert, so the smoke step must go red.
set -euo pipefail

repo="$(cd "${1:?usage: stage-ffi-zone.sh <repo-root> <dest>}" && pwd)"
dest="${2:?usage: stage-ffi-zone.sh <repo-root> <dest>}"
if [ -e "${dest}" ]; then
  echo "stage-ffi-zone: ${dest} already exists" >&2
  exit 1
fi
mkdir -p "${dest}"

git -C "${repo}" archive --format=tar HEAD:apps/file-manager | tar -x -C "${dest}"
overlay="${FFI_E2E_OVERLAY:-ffi-zone}"
if [ "${overlay}" = ffi-zone ]; then
  git -C "${repo}" archive --format=tar HEAD:packages/ffi/fixtures/ffi-zone | tar -x -C "${dest}"
elif [ "${overlay}" != none ]; then
  echo "stage-ffi-zone: unknown FFI_E2E_OVERLAY '${overlay}'" >&2
  exit 1
fi

cd "${dest}"
# Test and tooling scaffolding (see the header).
find . \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mjs' \) -type f -delete
for p in __fixtures__ e2e-support platform-e2e hack deploy docs scripts \
  vite.config.ts knext-bun-entry.mjs Dockerfile test-rsc.sh; do
  if [ -e "${p}" ]; then rm -r "${p}"; fi
done

# The crate's path dependency -> this checkout's crates/knext-ffi.
if [ "${overlay}" = ffi-zone ]; then
  rel='path = "../../../../../crates/knext-ffi"'
  if [ "$(grep -cF "${rel}" rust/Cargo.toml)" != 1 ]; then
    echo "stage-ffi-zone: expected exactly one '${rel}' in rust/Cargo.toml" >&2
    exit 1
  fi
  abs="path = \"${repo}/crates/knext-ffi\""
  node -e '
    const fs = require("node:fs");
    const [file, from, to] = process.argv.slice(1);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(from, to));
  ' rust/Cargo.toml "${rel}" "${abs}"
  grep -qF "${abs}" rust/Cargo.toml
fi

# package.json: no workspace protocol outside the monorepo; `next build` is the
# default builder's build script (the reference app builds with vinext).
# shellcheck disable=SC2016 # JavaScript, not shell: the template literal is node's.
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  delete pkg.dependencies["@getknext/lib"];
  delete pkg.dependencies["@getknext/ui"];
  delete pkg.devDependencies["@getknext/core"];
  pkg.scripts = { build: "next build" };
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, range] of Object.entries(deps)) {
      if (String(range).startsWith("workspace:")) {
        console.error(`stage-ffi-zone: ${name} still uses ${range}`);
        process.exit(1);
      }
    }
  }
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'

case "${FFI_E2E_MUTATION:-none}" in
  none | wrong-triple | leak) ;;
  compat-check)
    echo "stage-ffi-zone: MUTATION compat-check: deleting src/app/knext-smoke/stream"
    rm -r src/app/knext-smoke/stream
    ;;
  *)
    echo "stage-ffi-zone: unknown FFI_E2E_MUTATION '${FFI_E2E_MUTATION}'" >&2
    exit 1
    ;;
esac

if [ "${overlay}" = ffi-zone ]; then
  test -f knext.ffi.json
  test -f src/generated/ffi/index.ts
  test -f src/app/rust-ffi/actions.ts
else
  test ! -e knext.ffi.json
fi
echo "stage-ffi-zone: staged apps/file-manager (overlay: ${overlay}) at ${dest}"
