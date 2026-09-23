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
# The REAL shipped image does not hit this: its Dockerfile installs the app's
# deps INSIDE the alpine build stage, so native addons are musl-linked from
# the start. This script makes the harness match that.
#
# ROUND 2 (review finding on the round-1 fix): round 1 ran `npm run install
# --if-present` INSIDE the TRACED package directory
# (`.next/standalone/node_modules/<pkg>`). Next's output-file tracing keeps
# only what the RUNTIME require() graph reaches — sqlite3's own JS never
# requires `node-pre-gyp` (that is install-time-only, invoked by npm's
# lifecycle script), so the traced tree never carries it, and the "rebuild"
# died immediately: `sh: node-pre-gyp: not found`. The dlopen error then
# resurfaced unchanged. Reproduced directly against a TRACED tree (not a
# full install, which is what round 1's repro used and why it missed this).
#
# FIX: for each *.node-owning package, read its {name, version} from the
# TRACED copy's own package.json, then do a FRESH `npm install` of that exact
# spec into a scratch prefix. A fresh install brings its own install-time
# tooling (node-pre-gyp and friends) along as real dependencies, so it can
# fetch a musl prebuild if one exists or fall back to building from source —
# same as a real `npm install` on a musl host would. The resulting
# node_modules/<pkg> directory then REPLACES the traced copy wholesale (not
# just the .node file) — whatever the fresh musl install produced is what
# ships to the running server, consistent with how the standalone tree
# already treats native modules as pure on-disk files (never bundled).
#
# Toolchain tradeoff, stated rather than hidden: sqlite3@5.0.2 (and likely
# other npm-native-addon packages of its era) ships NO musl prebuild, so the
# fresh install falls back to compiling from source — which needs
# python3/make/g++ INSIDE this image. `apk add` costs a few seconds and the
# alpine repo carries a real gcc/musl toolchain, so that is the option taken
# here (over a second install into a throwaway node:22-alpine container and
# copying the result across, which would need docker-in-docker or a sibling
# container + volume dance for no correctness gain — same toolchain, same
# alpine base, just relocated).
#
# Usage (run INSIDE the alpine container, e.g. via `docker run ... sh
# e2e-native-rebuild-musl.sh <root>`):
#   sh e2e-native-rebuild-musl.sh <standalone-root>
#
# Best-effort per package: a rebuild failure (e.g. no source available, no
# musl prebuilt, a toolchain gap, a registry fetch failure) WARNS and
# continues — it must not brick the whole bun lane for fixtures unrelated to
# the addon that failed. The original dlopen error simply resurfaces for
# that one fixture, same as before this script existed; nothing is masked.
set -eu

ROOT="${1:?usage: e2e-native-rebuild-musl.sh <standalone-root>}"

HITS="$(find "${ROOT}" -name '*.node' -type f 2>/dev/null || true)"
if [ -z "${HITS}" ]; then
  echo "[native-rebuild] no *.node files under ${ROOT} — nothing to rebuild"
  exit 0
fi

echo "[native-rebuild] found native addon(s):"
echo "${HITS}"

# python3/make/g++: the node-gyp toolchain a from-source rebuild needs (see
# the header's toolchain tradeoff note). npm: the pinned alpine base ships
# bun only (no npm) — see Dockerfile.standalone.hbs's "oven/bun ships bun
# ONLY" note.
apk add --no-cache python3 make g++ npm >/dev/null 2>&1

SCRATCH_ROOT="$(mktemp -d)"
DONE=""

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
  # A package can own more than one .node file (multiple napi targets) —
  # rebuild it once.
  case " ${DONE} " in
  *" ${d} "*)
    continue
    ;;
  esac
  DONE="${DONE} ${d}"

  NAME="$(node -e '
    try {
      process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).name || "");
    } catch { /* leave empty */ }
  ' "${d}/package.json" 2>/dev/null || true)"
  VERSION="$(node -e '
    try {
      process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version || "");
    } catch { /* leave empty */ }
  ' "${d}/package.json" 2>/dev/null || true)"
  if [ -z "${NAME}" ] || [ -z "${VERSION}" ]; then
    echo "[native-rebuild] WARNING: could not read name/version from ${d}/package.json — skipping"
    continue
  fi

  echo "[native-rebuild] fresh-installing ${NAME}@${VERSION} for musl (the traced tree at ${d} lacks install-time tooling like node-pre-gyp — a rebuild IN PLACE cannot run its own install script)"
  PKG_SCRATCH="$(mktemp -d "${SCRATCH_ROOT}/pkg.XXXXXX")"
  # npm_config_build_from_source=true (review finding, round 4 — live CI
  # evidence, run 35862123588): WITHOUT this, `npm install` runs sqlite3's
  # own `node-pre-gyp install --fallback-to-build`, which tries a PREBUILT
  # download FIRST. That old node-pre-gyp does not check libc at all when
  # picking a prebuilt — it only matches platform+arch (e.g.
  # "linux-x64") — so on a network-connected runner it happily downloads
  # the (only ever published) GLIBC prebuilt, "succeeds" with no warning,
  # and the exact same ERR_DLOPEN_FAILED resurfaces. `--fallback-to-build`
  # only triggers when the prebuilt fetch itself FAILS, which is what
  # happened in every local repro here (this sandbox's network could not
  # reach the prebuilt host) — that let round 2/3's local proof pass while
  # the identical fix still failed on CI's well-connected runner. Forcing
  # build-from-source removes the prebuilt-fetch path entirely, so the
  # result is never network-dependent.
  if ! (cd "${PKG_SCRATCH}" && npm_config_build_from_source=true npm install --no-save --no-audit --no-fund "${NAME}@${VERSION}" >"${PKG_SCRATCH}.log" 2>&1); then
    echo "[native-rebuild] WARNING: fresh musl install of ${NAME}@${VERSION} failed — this addon may still fail to dlopen under musl at runtime (original error will resurface, not masked)"
    tail -c 4096 "${PKG_SCRATCH}.log" 2>/dev/null || true
    continue
  fi
  FRESH_PKG_DIR="${PKG_SCRATCH}/node_modules/${NAME}"
  if [ ! -d "${FRESH_PKG_DIR}" ]; then
    echo "[native-rebuild] WARNING: fresh install of ${NAME}@${VERSION} produced no node_modules/${NAME} — skipping"
    continue
  fi
  FRESH_NODE_COUNT="$(find "${FRESH_PKG_DIR}" -name '*.node' -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${FRESH_NODE_COUNT}" = "0" ]; then
    echo "[native-rebuild] WARNING: fresh install of ${NAME}@${VERSION} produced NO *.node file — skipping (the traced copy is left as-is; it will still fail to dlopen)"
    continue
  fi
  echo "[native-rebuild] replacing the traced copy at ${d} with the freshly musl-built ${NAME}@${VERSION} (${FRESH_NODE_COUNT} *.node file(s))"
  rm -rf "${d}"
  cp -a "${FRESH_PKG_DIR}" "${d}"

  # Not just ${NAME} itself: sqlite3's OWN lib/sqlite3-binding.js does
  # `require('node-pre-gyp')` at RUNTIME (not merely install-time) to
  # locate its binding path — that dependency is a real, statically-visible
  # require(), so Next's output tracer DOES keep it in the traced tree, but
  # WITHOUT its `.bin/` shim (tracing follows require() calls, not npm's
  # lifecycle-script PATH setup — see the round-1 postmortem in the header).
  # ${NAME} alone therefore is not enough: a fresh install's OTHER
  # node_modules entries (node-pre-gyp and ITS transitive deps) must land
  # too, or a require() chain like this one 404s on the very dependency
  # `npm install` just proved musl-installable.
  #
  # ONLY if ABSENT from the traced tree (review finding, round 3): a bare
  # unconditional overwrite would replace whatever version the APP actually
  # built with — semver, tar, rc, minimist and friends are common hoisted
  # deps a real fixture ships too, at whatever version ITS OWN dependency
  # resolution chose. Overwriting those would test a dependency tree the app
  # never built, so a pass or fail would no longer reflect the product. A
  # sibling already present in ${ROOT}/node_modules is the app's own choice
  # and is left untouched; it is pure JS (no *.node file of its own, or the
  # outer loop already handles it on its own iteration) and needs no musl
  # rebuild regardless of version. Only a sibling genuinely ABSENT from the
  # traced tree (like node-pre-gyp usually is, being install-time-only from
  # the tracer's point of view) gets copied in.
  for sibling in "${PKG_SCRATCH}/node_modules"/*; do
    [ -e "${sibling}" ] || continue
    sibling_name="$(basename "${sibling}")"
    [ "${sibling_name}" = "${NAME}" ] && continue
    if [ -e "${ROOT}/node_modules/${sibling_name}" ]; then
      echo "[native-rebuild]   - keeping the traced copy of ${sibling_name} (already present — that is the app's own resolved version, not overwritten)"
      continue
    fi
    echo "[native-rebuild]   + carrying along runtime dependency ${sibling_name} (needed by ${NAME}'s require() graph, absent from the traced tree)"
    cp -a "${sibling}" "${ROOT}/node_modules/${sibling_name}"
  done
done
