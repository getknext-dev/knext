#!/usr/bin/env bash
#
# SPIKE ONLY (throwaway, never merged): scripts/e2e-deploy-vinext-standalone-spike.sh
#
# Same harness contract and same pinned toolchain as scripts/e2e-deploy-vinext.sh,
# with ONE axis moved: the single-executable BASE.
#
#   nitro base (shipped):  vite build (vinext -> nitro bun preset) -> vinext-compile -> binary
#   THIS spike:            vinext build --prerender-all (vinext's own Node prod server,
#                          the path cloudflare/vinext's nightly deploy suite runs)
#                          -> bun build --compile --bytecode --format=esm of a ~40-line
#                          knext entry that calls vinext's startProdServer with the app's
#                          server bundle EMBEDDED as a second compile entrypoint.
#
# No knext compile shims: no import.meta rewrite, no require-staticize, no Bun.serve
# keep-alive/cache-control guards (the server is node:http). Deploy-mode Cache-Control
# comes from vinext's own VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1 switch, as upstream sets it.
set -euo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SERVER_LOG="${APP_DIR}/.adapter-server.log"
BUILD_LOG="${APP_DIR}/.adapter-vite-build.log"
BUILDER="vinext-standalone-spike"

log() { echo "[e2e-deploy-vinext-standalone-spike] $*" >&2; }

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}

# ── 1. install the knext tarballs (same set, same source, as the node lane) ────
# @getknext/core is what SHIPS the compile script, so the fixture compiles with
# the artifact a user installs — not with a copy of it out of this repo.
find_tarball() { # <dir> <name-prefix> → newest matching tarball path (or empty)
  ls -1 "$1/$2"-*.tgz 2>/dev/null | sort | tail -n1 || true
}

TARBALLS_DIR="${KNEXT_E2E_TARBALLS_DIR:-}"
if [ -z "${TARBALLS_DIR}" ]; then
  log "ERROR: KNEXT_E2E_TARBALLS_DIR must point at the pre-packed @getknext/* tarballs"
  exit 1
fi
LIB_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-lib)"
DB_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-db)"
CORE_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-core)"
if [ -z "${LIB_TGZ}" ] || [ -z "${DB_TGZ}" ] || [ -z "${CORE_TGZ}" ]; then
  log "ERROR: adapter tarballs missing in ${TARBALLS_DIR} (need getknext-lib/-db/-core)"
  exit 1
fi

# ── 2. install the vinext toolchain into the fixture ──────────────────────────
# PINNED, and pinned to the versions knext's own reference app builds with
# (apps/file-manager/package.json). A floating install would make a red file
# attributable to a vinext release rather than to knext, which is the same
# mistake the bun lane made with `bun-version: latest` and had to undo.
VINEXT_VERSION="${KNEXT_VINEXT_VERSION:-1.0.0-beta.12}"
VITE_VERSION="${KNEXT_VITE_VERSION:-8.2.2}"
NITRO_VERSION="${KNEXT_NITRO_VERSION:-3.0.260610-beta}"
# vinext@1.0.0-beta.12 declares `@vitejs/plugin-rsc@^0.5.34` as an (optional) peer.
# (Unchanged from beta.9 — confirmed via `npm view vinext@1.0.0-beta.12 peerDependencies`.)
# Because the toolchain install pulls this package explicitly, npm enforces that
# range even though the peer is optional — 0.5.26 does NOT satisfy `^0.5.34`, so
# every fixture install still aborts with `npm ERESOLVE` (a SECOND conflict edge
# that only surfaces after the react-family pin is fixed, since npm reports one
# edge at a time). Pinned at 0.5.34 the whole toolchain install resolves cleanly.
PLUGIN_RSC_VERSION="${KNEXT_PLUGIN_RSC_VERSION:-0.5.34}"
# The React family (react, react-dom, react-server-dom-webpack) is versioned in
# lockstep upstream and MUST be pinned together here. vinext@1.0.0-beta.9 declares
# a `react@^19.2.6` peer; the corpus fixtures otherwise pull react@19.2.4
# transitively via next@16.2, which does NOT satisfy that peer — every fixture
# install then aborts with `npm ERESOLVE` before it can build, reddening the whole
# axis for a reason that has nothing to do with the compiled artifact. Pinning the
# whole family at the version vinext's RSC transform was built against keeps the
# runtime coherent, which `--legacy-peer-deps` (accept-and-skew) would not.
REACT_VERSION="${KNEXT_REACT_VERSION:-19.2.6}"
# The `app-dir/scss` fixtures (29 in the v16.2.0 window) ship `sass@1.54.0` —
# Next.js's own pin — but the toolchain's `vite@8.2.2` declares
# `peerOptional sass@^1.70.0`, and 1.54.0 does NOT satisfy it. Without a coherent
# pin, `npm install` aborts with `Conflicting peer dependency: sass` (ERESOLVE)
# before the fixture builds, reddening every scss fixture as an INSTALL artifact
# rather than a real vinext SCSS result. The node lane never hits this (it pulls
# no vite). Pinned at a version satisfying BOTH next@16.2's `^1.3.0` and vite@8's
# `^1.70.0` — same discipline as the React family above, NOT `--legacy-peer-deps`.
SASS_VERSION="${KNEXT_SASS_VERSION:-1.104.0}"
# The `babel` fixture ships `@babel/preset-flow@7.25.9` (peer `@babel/core@^7.0.0-0`).
# The toolchain's `@vitejs/plugin-react` → `@rolldown/plugin-babel@0.2.4` chain pulls
# `@babel/plugin-transform-runtime@8.0.1` (peer `@babel/core@^8.0.0`) as an optional
# peer, so npm cannot satisfy `@babel/core` (7 vs 8) and every fixture install aborts
# with `npm ERESOLVE` (`Conflicting peer dependency: @babel/core@8.0.1`, compat run
# 34473981569 shard 12). `@rolldown/plugin-babel`'s peerOptional range is
# `^7.29.0 || ^8.0.0-rc.1`, so pinning transform-runtime on the 7.x line satisfies
# rolldown AND aligns `@babel/core@7` with preset-flow — same discipline as the
# sass/react pins above, NOT `--legacy-peer-deps`. Verified: `npm install --dry-run`
# resolves `@babel/core@7.29.7` with this pin; without it, ERESOLVE.
BABEL_TRANSFORM_RUNTIME_VERSION="${KNEXT_BABEL_TRANSFORM_RUNTIME_VERSION:-7.29.7}"
# The `postcss-config-ts` fixture ships a `postcss.config.ts`; vite/postcss loads a
# TypeScript config only when a TS loader is resolvable, else the build dies with
# `'tsx' or 'jiti' is required for the TypeScript configuration files` (compat run
# 34473981569 shard 11). The node lane never hits this — next resolves the TS config
# itself — so the vite toolchain has to install the loader.
TSX_VERSION="${KNEXT_TSX_VERSION:-4.23.13}"
# vinext ships no MDX loader: a fixture with `.mdx` modules needs `@mdx-js/rollup`
# registered in the vite config (done in §3 below) AND installed, or the build dies
# with `[vinext] Encountered MDX module … but no MDX plugin is configured` (compat
# run 34473981569 shards 11/12).
MDX_ROLLUP_VERSION="${KNEXT_MDX_ROLLUP_VERSION:-3.1.1}"

# ── the compile toggle (diagnostic opt-in; DEFAULT = 1 = compiled) ─────────────
# The shipped-artifact lane boots the COMPILED single executable, and that is the
# unchanged default (KNEXT_COMPILE=1). `KNEXT_COMPILE=0` is a DIAGNOSTIC opt-in
# ONLY: it skips the `bun build --compile` step (§5-6) and boots the SAME vite
# build UNCOMPILED — the nitro `.output/server/index.mjs` under bun (§7) — so a
# runtime red can be PARTITIONED:
#
#   * fails compiled AND uncompiled → a vite-pipeline / runtime bug (present both ways)
#   * fails compiled ONLY           → a compile-step bug (sharp dlopen / asset-root /
#                                     bytecode — the single-exec-specific bucket)
#
# This is NOT a new default and NOT a softening of the lane: the manifest, corpus,
# shard count, summary and ledger are identical; only the artifact under test moves.
KNEXT_COMPILE="${KNEXT_COMPILE:-1}"

# ── B3 port from the node lane (scripts/e2e-deploy.sh, #147): some fixtures ship
# hand-made packages INSIDE their own node_modules/ as test material — e.g.
# `app-dir/next-config-ts/import-from-node-modules` ships `node_modules/cjs` +
# `node_modules/esm` and its `next.config.ts` imports them. The toolchain
# `npm install` below reifies an ideal tree and PRUNES every fixture package not
# in it (the run log shows "removed N packages"), so the config load then fails
# with `Cannot find module 'cjs'` and the whole fixture reds at build. The node
# lane already snapshots these before its install and restores what the reify
# removed; port the same here. Snapshot package-level entries now; restore after.
NM_DIR="${APP_DIR}/node_modules"
NM_SNAP=""
NM_ENTRIES=""
nm_package_entries() { # <node_modules dir> → package-level entries, one per line
  (
    cd "$1" 2>/dev/null || exit 0
    for e in * @*/*; do
      if [ -e "${e}" ] || [ -L "${e}" ]; then
        case "${e}" in
          @*/*) echo "${e}" ;; # scoped package (scope children pruned individually)
          @*) : ;;             # bare scope dir — children emitted by the @*/* glob
          *) echo "${e}" ;;
        esac
      fi
    done
  )
}
if [ -d "${NM_DIR}" ]; then
  NM_SNAP="$(mktemp -d "${APP_DIR}/.knext-nm-snap.XXXXXX")"
  NM_ENTRIES="$(nm_package_entries "${NM_DIR}")"
  while IFS= read -r entry; do
    [ -n "${entry}" ] || continue
    mkdir -p "${NM_SNAP}/$(dirname "${entry}")"
    cp -RP "${NM_DIR}/${entry}" "${NM_SNAP}/${entry}" # -RP: preserve symlinks
  done <<EOF
${NM_ENTRIES}
EOF
fi

log "installing knext tarballs + the pinned vinext toolchain (vinext@${VINEXT_VERSION}, vite@${VITE_VERSION}, nitro@${NITRO_VERSION}, react@${REACT_VERSION})"
npm install --no-audit --no-fund --loglevel=error \
  "${LIB_TGZ}" "${DB_TGZ}" "${CORE_TGZ}" \
  "vinext@${VINEXT_VERSION}" \
  "vite@${VITE_VERSION}" \
  "@vitejs/plugin-rsc@${PLUGIN_RSC_VERSION}" \
  "react@${REACT_VERSION}" \
  "react-dom@${REACT_VERSION}" \
  "react-server-dom-webpack@${REACT_VERSION}" \
  "sass@${SASS_VERSION}" \
  "@babel/plugin-transform-runtime@${BABEL_TRANSFORM_RUNTIME_VERSION}" \
  "tsx@${TSX_VERSION}" \
  "@mdx-js/rollup@${MDX_ROLLUP_VERSION}" >&2

# Restore fixture-shipped node_modules packages the reify pruned (B3 port; see above).
if [ -n "${NM_SNAP}" ]; then
  while IFS= read -r entry; do
    [ -n "${entry}" ] || continue
    if [ ! -e "${NM_DIR}/${entry}" ] && [ ! -L "${NM_DIR}/${entry}" ]; then
      log "restoring fixture-shipped node_modules/${entry} (pruned by npm install reify)"
      mkdir -p "${NM_DIR}/$(dirname "${entry}")"
      cp -RP "${NM_SNAP}/${entry}" "${NM_DIR}/${entry}"
    fi
  done <<EOF
${NM_ENTRIES}
EOF
  rm -rf "${NM_SNAP}"
fi

# ── 3. the vite config vinext builds through ──────────────────────────────────
# Written only when the fixture has none: a fixture that ships its own vite
# config is telling us how it wants to be built, and overwriting it would test
# our config instead of the fixture.
#
# `preset: 'bun'` is not a preference — the bun-preset entry calls that runtime's
# global `serve()` at module top level, so the artifact is bun-only by
# construction (`node .output/server/index.mjs` exits 1). Code splitting is off
# because nitro-on-rolldown otherwise emits a second chunk re-exporting a
# namespace it never imports (the same finding as the reference app's config).
VITE_CONFIG="${APP_DIR}/vite.config.mjs"
if [ -e "${APP_DIR}/vite.config.ts" ] || [ -e "${APP_DIR}/vite.config.js" ] || [ -e "${VITE_CONFIG}" ]; then
  log "fixture ships its own vite config — using it verbatim"
else
  # vinext ships no built-in MDX loader, so a fixture whose app/pages import `.mdx`
  # modules fails to build with `[vinext] Encountered MDX module … but no MDX plugin
  # is configured` unless `@mdx-js/rollup` is registered here. Gated on the fixture
  # actually shipping `.mdx` files (vinext's own hasMdxFiles heuristic) so non-mdx
  # fixtures are unaffected; `enforce: 'pre'` runs the MDX transform before vinext's
  # RSC pipeline sees the module.
  MDX_IMPORT=""
  MDX_PLUGIN=""
  if find "${APP_DIR}" -type d -name node_modules -prune -o -type f -name '*.mdx' -print 2>/dev/null | grep -q .; then
    MDX_IMPORT="import mdx from '@mdx-js/rollup';"
    MDX_PLUGIN="    { enforce: 'pre', ...mdx() },"
    log "fixture ships .mdx modules — registering @mdx-js/rollup in the vite config"
  fi
  # NOTE: unquoted heredoc so ${MDX_IMPORT}/${MDX_PLUGIN} expand. The config body
  # itself carries no `$`, so nothing else is subject to expansion.
  cat >"${VITE_CONFIG}" <<VITECONFIG
${MDX_IMPORT}
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Strip the webpack/sass-loader '~' CSS-import prefix so vite resolves
    // '~pkg/foo.css' as the bare 'pkg/foo.css' from node_modules. Next's webpack
    // build honours '~'; vite does not, so without this a fixture that does
    // '@import "~nprogress/nprogress.css"' dies with '[postcss] ENOENT open
    // ~nprogress/nprogress.css'. Inert unless an import starts with '~'.
    alias: [{ find: /^~/, replacement: '' }],
  },
  plugins: [
${MDX_PLUGIN}
    vinext(),
  ],
});
VITECONFIG
  log "wrote ${VITE_CONFIG} (vinext only — no nitro; the vinext Node prod-server base)"
fi

# ── 3b. normalize the fixture to knext-vinext's ESM app contract ──────────────
# knext's scaffolder writes `"type":"module"` into the package.json of EVERY app
# it generates (templates/app/package.json.hbs), and the vinext production build
# assumes ESM: without it, vite's rsc↔ssr module graph fails with UNRESOLVED_IMPORT
# on App-Router fixtures (verified by cross-flip on the real corpus). ESM is thus
# knext-vinext's de-facto app contract. The official corpus fixtures are CommonJS,
# so we merge `"type":"module"` into the fixture's package.json here — the SAME
# class of normalization as writing the per-fixture vite.config.mjs above, and
# nothing beyond it.
#
# This is normalization-to-contract, NOT softening: it MERGES one key (preserving
# the fixture's deps/scripts/everything else) and touches no fixture source or
# tests. A CommonJS-app limitation is tracked separately, and this axis's compat
# claim is scoped to ESM apps (see docs/compat-matrix.md, the vinext row).
FIXTURE_PKG="${APP_DIR}/package.json"
if [ -f "${FIXTURE_PKG}" ]; then
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    if (pkg.type !== "module") {
      pkg.type = "module";
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
    }
  ' "${FIXTURE_PKG}"
  log "normalized ${FIXTURE_PKG} to \"type\":\"module\" (knext-vinext ESM app contract)"
else
  log "no package.json in fixture — skipping ESM normalization"
fi

# ── 3b-ii. reconcile a CommonJS next.config.js with the forced ESM app contract ─
# The §3b `"type":"module"` merge makes node treat a `.js` next.config as ESM, so a
# fixture shipping a CommonJS `next.config.js` (`module.exports`, top-level
# `require`) then fails the vite build with `require is not defined in ES module
# scope` (compat run 34473981569 shard 1, app-dir/next-config). vinext's config
# loader resolves `next.config.cjs` (it is in vinext's CONFIG_FILES list) and a
# `.cjs` file is CommonJS regardless of the package `type`, so renaming the CJS
# config to `.cjs` loads it correctly WITHOUT weakening the ESM app contract the
# rest of the corpus relies on. This is config normalization-to-contract, the same
# class as the vite.config.mjs write and the type:module merge — it renames a config
# file, touches no app/test source, and is GATED on a `module.exports` CJS marker so
# an ESM `next.config.js` is never renamed.
NEXT_CONFIG_JS="${APP_DIR}/next.config.js"
# The CJS marker is anchored at statement start (`^[[:space:]]*module.exports =`)
# so an ESM config that merely MENTIONS `module.exports` in a comment/string is not
# matched, and the rename is skipped when the file carries a top-level ESM
# `export`/`import` statement — a genuinely-ESM `next.config.js` is never renamed.
if [ -f "${NEXT_CONFIG_JS}" ] \
  && grep -Eq '^[[:space:]]*module\.exports[[:space:]]*=' "${NEXT_CONFIG_JS}" \
  && ! grep -Eq '^[[:space:]]*(export[[:space:]]|export\{|import[[:space:]]|import\{)' "${NEXT_CONFIG_JS}"; then
  mv "${APP_DIR}/next.config.js" "${APP_DIR}/next.config.cjs"
  log "renamed CommonJS next.config.js → next.config.cjs (loads as CJS under the forced ESM app contract)"
fi


DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-knext-vinext-sa-$(date +%s)-$$}"
export NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}"
export VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1

# ── 4. vinext build (Node prod-server output, prerender as upstream's suite does) ──
log "running vinext build --prerender-all (log -> ${BUILD_LOG})"
if ! NODE_ENV=production npx --no-install vinext build --prerender-all >"${BUILD_LOG}" 2>&1; then
  log "ERROR: vinext build failed"
  tail -n 120 "${BUILD_LOG}" >&2 || true
  exit 1
fi
RSC_ENTRY="${APP_DIR}/dist/server/index.js"
PAGES_ENTRY="${APP_DIR}/dist/server/entry.js"
if [ ! -f "${RSC_ENTRY}" ] && [ ! -f "${PAGES_ENTRY}" ]; then
  log "ERROR: vinext build finished but neither ${RSC_ENTRY} nor ${PAGES_ENTRY} exists"
  tail -n 120 "${BUILD_LOG}" >&2 || true
  exit 1
fi
if ! BUILD_ID="$(tr -d '[:space:]' <"${APP_DIR}/dist/server/BUILD_ID" 2>/dev/null)" || [ -z "${BUILD_ID}" ]; then
  log "ERROR: no dist/server/BUILD_ID"
  exit 1
fi
log "build id ${BUILD_ID}"

# ── 5. the knext entry (relocatable outDir + embedded server bundle + disk fallback) ──
cat >"${APP_DIR}/knext-server.mjs" <<'KNEXTSERVER'
import fs from "node:fs";
import Module from "node:module";
import { dirname, join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const compiled = typeof Bun !== "undefined" && Bun.main?.startsWith("/$bunfs/");
const root = compiled ? dirname(process.execPath) : import.meta.dirname;
const embedded = (rel) => {
  const p = `/$bunfs/root/${rel}`;
  try { return compiled && fs.existsSync(p) ? p : undefined; } catch { return undefined; }
};
if (compiled) {
  // Runtime require()s from an embedded module cannot walk to disk; fall back to
  // the app's node_modules beside the binary.
  const orig = Module._resolveFilename;
  const paths = [join(root, "node_modules")];
  Module._resolveFilename = function (request, parent, isMain, options) {
    try { return orig.call(this, request, parent, isMain, options); }
    catch (e) {
      if (/^(\.|\/|node:)/.test(request)) throw e;
      return orig.call(this, request, parent, isMain, { ...options, paths });
    }
  };
}
const rscEntryPath = embedded("dist/server/index.js");
const serverEntryPath = embedded("dist/server/entry.js");
startProdServer({
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  host: process.env.HOST ?? "0.0.0.0",
  outDir: join(root, "dist"),
  ...(rscEntryPath ? { rscEntryPath } : {}),
  ...(serverEntryPath ? { serverEntryPath } : {}),
}).catch((error) => {
  console.error("[knext] failed to start");
  console.error(error);
  process.exit(1);
});
KNEXTSERVER

ENTRIES=("${APP_DIR}/knext-server.mjs")
[ -f "${RSC_ENTRY}" ] && ENTRIES+=("${RSC_ENTRY}")
[ -f "${PAGES_ENTRY}" ] && ENTRIES+=("${PAGES_ENTRY}")
KNEXT_EXEC="${APP_DIR}/knext-exec-e2e"
log "compiling (bun --compile --bytecode --format=esm) ${ENTRIES[*]} -> ${KNEXT_EXEC}"
if ! bun build --compile --bytecode --format=esm --minify --compile-autoload-package-json \
    "${ENTRIES[@]}" --outfile "${KNEXT_EXEC}" >&2; then
  log "ERROR: compile failed"
  exit 1
fi

# ── 7. boot ────────────────────────────────────────────────────────────────────
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}
PORT="$(free_port)"
log "booting ${KNEXT_EXEC} on 0.0.0.0:${PORT}"
(
  cd "${APP_DIR}"
  PORT="${PORT}" HOST="0.0.0.0" HOSTNAME="" NODE_ENV="production" \
    NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1 \
    exec "${KNEXT_EXEC}"
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

{
  echo "BUILD_ID=${BUILD_ID}"
  echo "DEPLOYMENT_ID=${DEPLOYMENT_ID}"
  echo "PORT=${PORT}"
  echo "PID=${SERVER_PID}"
  echo "RUNTIME=bun"
  echo "RUNTIME_VERSION=$(bun --version 2>/dev/null || echo unknown)"
  echo "BUILDER=${BUILDER}"
  echo "KNEXT_EXEC=${KNEXT_EXEC}"
  echo "COMPILED=true"
  echo "SERVER_LOG=${SERVER_LOG}"
  echo "BUILD_LOG=${BUILD_LOG}"
} >"${LOG_FILE}"

READY=0
for _ in $(seq 1 100); do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    log "ERROR: binary exited before ready"; cat "${SERVER_LOG}" >&2 || true; exit 1
  fi
  if node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    READY=1; break
  fi
  sleep 0.3
done
if [ "${READY}" != "1" ]; then log "ERROR: never ready"; cat "${SERVER_LOG}" >&2 || true; exit 1; fi
log "deployment ready: build=${BUILD_ID} deployment=${DEPLOYMENT_ID} pid=${SERVER_PID}"
echo "http://localhost:${PORT}"
