#!/bin/sh
#
# scripts/e2e-native-rebuild-musl.sh — rebuild native (*.node) addons for musl,
# run INSIDE the pinned standalone-on-Bun alpine image (scripts/e2e-deploy.sh).
#
# Review finding on PR #1230 (hypothesis A, confirmed): the compat harness
# installs every fixture's deps ONCE on the glibc ubuntu-latest runner —
# node-pre-gyp/prebuild-install resolve a GLIBC-linked prebuilt .node binary
# there (e.g. sqlite3's napi-v3-linux-x64 binding). Booting the compiled
# standalone-on-Bun exec inside the pinned musl alpine image (#1230) then
# tries to dlopen that same glibc binary and fails:
#
#   Error [ERR_DLOPEN_FAILED]: .../node_sqlite3.node is linked against glibc
#   (DT_NEEDED libm.so.6), but this Bun build uses musl. glibc-targeted
#   native addons cannot be loaded on Alpine/musl even with gcompat.
#
# (Confirmed by reproduction: installing sqlite3@5.0.2 on a glibc linux/amd64
# host, then requiring it from inside this exact pinned image, reproduces the
# error byte-for-byte; rebuilding it INSIDE the image first fixes it.)
#
# The REAL shipped image does not hit this: its Dockerfile installs the app's
# deps INSIDE the alpine build stage, so native addons are musl-linked from
# the start. This script makes the harness match that — rebuild whatever
# *.node files the standalone tree carries, for musl, before boot — rather
# than leaving it as a harness-only false failure.
#
# Usage (run INSIDE the alpine container, e.g. via `docker run ... sh
# e2e-native-rebuild-musl.sh <root>`):
#   sh e2e-native-rebuild-musl.sh <standalone-root>
#
# Best-effort per package: a rebuild failure (e.g. no source available, no
# musl prebuilt, a toolchain gap) WARNS and continues — it must not brick the
# whole bun lane for fixtures unrelated to the addon that failed. The
# original dlopen error simply resurfaces for that one fixture, same as
# before this script existed; nothing is masked.
set -eu

ROOT="${1:?usage: e2e-native-rebuild-musl.sh <standalone-root>}"

HITS="$(find "${ROOT}" -name '*.node' -type f 2>/dev/null || true)"
if [ -z "${HITS}" ]; then
  echo "[native-rebuild] no *.node files under ${ROOT} — nothing to rebuild"
  exit 0
fi

echo "[native-rebuild] found native addon(s):"
echo "${HITS}"

# python3/make/g++: the node-gyp toolchain a from-source rebuild needs.
# npm: the pinned alpine base ships bun only (no npm) — see
# Dockerfile.standalone.hbs's "oven/bun ships bun ONLY" note.
apk add --no-cache python3 make g++ npm >/dev/null 2>&1

echo "${HITS}" | while IFS= read -r f; do
  [ -z "${f}" ] && continue
  # Walk up from the .node file to the nearest package.json — the addon
  # package's own root, whatever depth node_modules nested it at.
  d="$(dirname "${f}")"
  while [ "${d}" != "/" ] && [ "${d}" != "${ROOT}" ] && [ ! -f "${d}/package.json" ]; do
    d="$(dirname "${d}")"
  done
  if [ ! -f "${d}/package.json" ]; then
    echo "[native-rebuild] WARNING: no package.json found above ${f} — skipping"
    continue
  fi
  echo "[native-rebuild] rebuilding ${d} for musl"
  if ! (cd "${d}" && npm_config_build_from_source=true npm run install --if-present 2>&1); then
    echo "[native-rebuild] WARNING: rebuild failed for ${d} — this addon may still fail to dlopen under musl at runtime (original error will resurface for that fixture, not masked)"
  fi
done
