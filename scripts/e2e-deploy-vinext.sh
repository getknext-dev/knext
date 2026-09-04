#!/usr/bin/env bash
#
# scripts/e2e-deploy-vinext.sh — knext deploy-script for the official Next.js
# compatibility harness on the **vinext single-executable axis** (#608, ADR-0048).
#
# Same harness contract as scripts/e2e-deploy.sh (the node-standalone lane): the
# harness invokes this once per fixture with cwd = the app's temp dir and reads
# EXACTLY ONE stdout line — the deployment URL. Everything else goes to stderr.
#
# WHAT IS DIFFERENT, and it is only one thing: the AXIS.
#
#   node lane:   next build → .next/standalone/server.js → boot on node
#   THIS lane:   vite build (vinext → nitro bun preset) → `bun build --compile
#                --bytecode` via knext's SHIPPED vinext-compile → boot the BINARY
#
# The corpus, the manifest, the shard count, the summary and the ledger are the
# node lane's, unchanged. That is the whole point: a number produced here is
# comparable to the node lane's 778/0 because only the artifact under test moved.
#
# ## Why the BINARY and not `.output/server/index.mjs`
#
# Booting the uncompiled nitro output under bun would be easier and would measure
# the wrong thing. Two divergences exist ONLY in the compiled artifact, and both
# are load-bearing for a real deployment:
#
#   * sharp's native addon cannot be `dlopen`ed from inside the binary's virtual
#     filesystem, so vinext-compile.mjs swaps sharp's loader for a shim that opens
#     a real file staged beside the executable (`native/`). Uncompiled, sharp
#     resolves normally and the shim is never exercised.
#   * the asset root baked into the binary is the BUILD machine's tree, so the
#     runtime has to re-derive it. Uncompiled, the baked root is simply correct.
#
# compat-smoke boots the uncompiled entry today, which is exactly the gap this
# lane exists to close. tests/compat-vinext-lane.test.ts fails if this script
# stops booting the binary.
#
# ## Honesty about what the first runs will show
#
# Most fixtures were never built by anything but `next build`. A fixture whose
# vite build or compile step fails is a REAL red on this axis — it is what "the
# compiled path is not corpus-verified" means concretely — and it is reported as
# a failure, never skipped. The first number is expected to be low. That is the
# deliverable: an honest number, not a green one.
set -euo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SERVER_LOG="${APP_DIR}/.adapter-server.log"
BUILD_LOG="${APP_DIR}/.adapter-vite-build.log"
BUILDER="vinext"

log() { echo "[e2e-deploy-vinext] $*" >&2; }

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
VINEXT_VERSION="${KNEXT_VINEXT_VERSION:-1.0.0-beta.8}"
VITE_VERSION="${KNEXT_VITE_VERSION:-8.2.2}"
NITRO_VERSION="${KNEXT_NITRO_VERSION:-3.0.260610-beta}"
PLUGIN_RSC_VERSION="${KNEXT_PLUGIN_RSC_VERSION:-0.5.26}"
RSD_WEBPACK_VERSION="${KNEXT_RSD_WEBPACK_VERSION:-19.2.6}"

log "installing knext tarballs + the pinned vinext toolchain (vinext@${VINEXT_VERSION}, vite@${VITE_VERSION}, nitro@${NITRO_VERSION})"
npm install --no-audit --no-fund --loglevel=error \
  "${LIB_TGZ}" "${DB_TGZ}" "${CORE_TGZ}" \
  "vinext@${VINEXT_VERSION}" \
  "vite@${VITE_VERSION}" \
  "nitro@${NITRO_VERSION}" \
  "@vitejs/plugin-rsc@${PLUGIN_RSC_VERSION}" \
  "react-server-dom-webpack@${RSD_WEBPACK_VERSION}" >&2

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
  cat >"${VITE_CONFIG}" <<'VITECONFIG'
import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    vinext(),
    nitro({
      preset: 'bun',
      rollupConfig: { output: { inlineDynamicImports: true } },
    }),
  ],
});
VITECONFIG
  log "wrote ${VITE_CONFIG} (vinext + nitro bun preset)"
fi

# The deployment identity the harness's skew/asset tests key on. Generated
# BEFORE the build so the build and the runtime agree.
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-knext-vinext-$(date +%s)-$$}"
export NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}"

# ── 4. vite build → the nitro bun-preset .output ──────────────────────────────
log "running vite build (vinext → nitro bun preset; log → ${BUILD_LOG})"
if ! NODE_ENV=production npx --no-install vite build >"${BUILD_LOG}" 2>&1; then
  log "ERROR: vite build failed — the vinext axis cannot produce an artifact for this fixture"
  tail -n 120 "${BUILD_LOG}" >&2 || true
  exit 1
fi

NITRO_ENTRY="${APP_DIR}/.output/server/index.mjs"
if [ ! -f "${NITRO_ENTRY}" ]; then
  log "ERROR: vite build finished but ${NITRO_ENTRY} is absent — nothing to compile"
  tail -n 120 "${BUILD_LOG}" >&2 || true
  exit 1
fi

# ── 5. compile the single executable — knext's SHIPPED script ─────────────────
# Resolved out of the INSTALLED @getknext/core so this lane exercises the same
# compile a `kn-next build --target=vinext` user gets. No repo-source fallback:
# silently compiling with an uninstalled copy would make the number describe an
# artifact nobody ships.
COMPILE_SCRIPT="${APP_DIR}/node_modules/@getknext/core/dist/adapters/vinext-compile.js"
if [ ! -f "${COMPILE_SCRIPT}" ]; then
  log "ERROR: the installed @getknext/core ships no dist/adapters/vinext-compile.js (${COMPILE_SCRIPT}) — the packed tarball is not the shipped shape"
  exit 1
fi

KNEXT_EXEC="${APP_DIR}/knext-exec-e2e"
log "compiling the single executable (bun, bytecode, minified) → ${KNEXT_EXEC}"
if ! bun run "${COMPILE_SCRIPT}" --entry "${NITRO_ENTRY}" --outfile "${KNEXT_EXEC}" >&2; then
  log "ERROR: the single-executable compile failed for this fixture"
  exit 1
fi
if [ ! -x "${KNEXT_EXEC}" ]; then
  log "ERROR: ${KNEXT_EXEC} was not produced (or is not executable)"
  exit 1
fi

# ── 6. stage sharp's addon beside the binary ──────────────────────────────────
# The compiled binary cannot dlopen a path inside its own virtual filesystem, so
# the addon has to be a real file next to the executable. Absent sharp is fine
# and silent — a fixture that never touches next/image pulls no @img packages.
for candidate in \
  "${APP_DIR}/node_modules/@img" \
  "${APP_DIR}/node_modules/.bun/node_modules/@img"; do
  if [ -d "${candidate}" ]; then
    mkdir -p "${APP_DIR}/native"
    cp -RL "${candidate}"/* "${APP_DIR}/native/" 2>/dev/null || true
    log "staged sharp native packages from ${candidate} → ${APP_DIR}/native"
    break
  fi
done

# ── 7. boot THE BINARY on a free port ─────────────────────────────────────────
# HOSTNAME is emptied rather than pinned (the node lane's B7a finding: a pinned
# 127.0.0.1 misclassifies same-origin middleware rewrites as external).
PORT="$(free_port)"
BUILD_ID="$(cat "${APP_DIR}/.next/BUILD_ID" 2>/dev/null || echo "${DEPLOYMENT_ID}")"

log "booting the compiled binary ${KNEXT_EXEC} on 0.0.0.0:${PORT}"
(
  cd "${APP_DIR}"
  PORT="${PORT}" HOSTNAME="" NODE_ENV="production" \
    NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
    exec "${KNEXT_EXEC}"
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

# ── 8. persist metadata BEFORE probing, so cleanup can always find it ─────────
# Same keys scripts/e2e-cleanup.sh + scripts/e2e-logs.sh read on the node lane,
# plus BUILDER/EXEC so a run's evidence names the axis it measured.
{
  echo "BUILD_ID=${BUILD_ID}"
  echo "DEPLOYMENT_ID=${DEPLOYMENT_ID}"
  echo "PORT=${PORT}"
  echo "PID=${SERVER_PID}"
  echo "RUNTIME=bun"
  echo "RUNTIME_VERSION=$(bun --version 2>/dev/null || echo unknown)"
  echo "BUILDER=${BUILDER}"
  echo "KNEXT_EXEC=${KNEXT_EXEC}"
  echo "SERVER_LOG=${SERVER_LOG}"
  echo "BUILD_LOG=${BUILD_LOG}"
} >"${LOG_FILE}"

# ── 9. readiness: pid-liveness first, TCP probe second ────────────────────────
server_died() {
  log "ERROR: the binary (pid ${SERVER_PID}) exited before becoming ready"
  log "---- server log ----"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
}

READY=0
for _ in $(seq 1 100); do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    server_died
  fi
  if node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.3
done

if [ "${READY}" != "1" ]; then
  log "ERROR: the binary never became ready on port ${PORT}"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
fi

if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
  server_died
fi

log "deployment ready (vinext single executable): build=${BUILD_ID} deployment=${DEPLOYMENT_ID} pid=${SERVER_PID}"

# ── 10. the ONLY stdout line: the deployment URL ──────────────────────────────
echo "http://localhost:${PORT}"
