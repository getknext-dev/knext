#!/usr/bin/env bash
#
# scripts/e2e-deploy.sh — knext deploy-script for the official Next.js compatibility
# harness (#89, ADR-0007 A3-2). The harness (run-tests.js, NEXT_TEST_MODE=deploy)
# invokes THIS script once per fixture app with cwd = the app's temp dir, and reads
# EXACTLY ONE stdout line — the deployment URL — to drive its e2e tests against a
# real, running knext deployment.
#
# Contract (mirrors the reference adapter-bun e2e-deploy.sh, adapted to knext's
# output:'standalone' runtime):
#   1. (unless KNEXT_E2E_SKIP_PACK=1) install the @knext/lib + @knext/core tarballs
#      into the temp app, so NEXT_ADAPTER_PATH resolves the package-shipped adapter.
#   2. NEXT_ADAPTER_PATH = the knext adapter; run `next build` (output:'standalone').
#   3. Stage .next/static + public/ into the standalone tree (standalone does NOT copy
#      them — same as the Dockerfile / compat-smoke.mjs).
#   4. Boot the standalone server.js on a FREE port, on KNEXT_RUNTIME (node|bun).
#   5. TCP-probe readiness.
#   6. Persist BUILD_ID / DEPLOYMENT_ID / PORT / PID to .adapter-build.log so the
#      SEPARATE logs + cleanup processes can find the deployment.
#   7. Echo http://localhost:<port> as the ONLY stdout line; non-zero exit on failure.
#
# All diagnostics go to STDERR — stdout is reserved for the single URL line.
set -euo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SERVER_LOG="${APP_DIR}/.adapter-server.log"
RUNTIME="${KNEXT_RUNTIME:-node}"   # node (default) | bun  (bun = fast-follow target)

log() { echo "[e2e-deploy] $*" >&2; }

# ── pick a free TCP port ──────────────────────────────────────────────────────
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}

# ── 1. install the knext adapter tarballs (skippable for the contract test) ──
#
# #147 A3-3 fix round 1 (triage of baseline run 28558576615): this step used to
# `npm pack` @knext/core PER TEST. That was the ONE bug behind 472/473 failures:
# `npm pack` ships pnpm's raw `workspace:^` dep on @knext/lib verbatim (only
# `pnpm pack`/`pnpm publish` rewrite the workspace protocol), so every fixture's
# `npm install <tarball>` died with EUNSUPPORTEDPROTOCOL and `next build` ran
# ZERO times. Per-test packing ALSO raced: run-tests.js (concurrency 2, retries)
# packed into the same tarball path simultaneously.
#
# Now: BOTH @knext/lib and @knext/core are packed with `pnpm pack` ONCE — in CI
# by the workflow (handed down via KNEXT_E2E_TARBALLS_DIR, preflight-gated by
# scripts/e2e-preflight.mjs), locally by a lock-guarded pack-once fallback — and
# BOTH tarballs are installed in ONE `npm install`, so npm satisfies the
# rewritten `@knext/lib@^x` dep from the local lib tarball (@knext/lib is not on
# npm yet — #53 is human-blocked).
find_tarball() { # <dir> <name-prefix> → newest matching tarball path (or empty)
  ls -1 "$1/$2"-*.tgz 2>/dev/null | sort | tail -n1
}

if [ "${KNEXT_E2E_SKIP_PACK:-0}" != "1" ]; then
  TARBALLS_DIR="${KNEXT_E2E_TARBALLS_DIR:-}"
  if [ -n "${TARBALLS_DIR}" ]; then
    # CI path: the workflow packed once per shard and preflighted the tarballs.
    log "using pre-packed tarballs from KNEXT_E2E_TARBALLS_DIR=${TARBALLS_DIR}"
  else
    # Local fallback: pack once into a stable dir next to the adapter package,
    # serialized by a mkdir lock (atomic on POSIX) so concurrent deploys never
    # read a half-written tarball.
    ADAPTER_PKG_DIR="${ADAPTER_DIR:-}"
    if [ -z "${ADAPTER_PKG_DIR}" ]; then
      log "ERROR: set KNEXT_E2E_TARBALLS_DIR (pre-packed tarballs) or ADAPTER_DIR (the @knext/core package dir), or KNEXT_E2E_SKIP_PACK=1"
      exit 1
    fi
    LIB_PKG_DIR="${KNEXT_LIB_DIR:-${ADAPTER_PKG_DIR}/../lib}"
    TARBALLS_DIR="${ADAPTER_PKG_DIR}/.e2e-tarballs"
    if [ -z "$(find_tarball "${TARBALLS_DIR}" knext-lib)" ] || [ -z "$(find_tarball "${TARBALLS_DIR}" knext-core)" ]; then
      LOCK_DIR="${TARBALLS_DIR}.lock"
      acquired=0
      for _ in $(seq 1 600); do
        if mkdir "${LOCK_DIR}" 2>/dev/null; then
          acquired=1
          break
        fi
        sleep 0.5
      done
      if [ "${acquired}" != "1" ]; then
        log "ERROR: could not acquire pack lock ${LOCK_DIR} within 5 minutes (stale lock? remove it and retry)"
        exit 1
      fi
      trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT
      # Re-check under the lock — another deploy may have packed while we waited.
      if [ -z "$(find_tarball "${TARBALLS_DIR}" knext-lib)" ] || [ -z "$(find_tarball "${TARBALLS_DIR}" knext-core)" ]; then
        log "packing @knext/lib + @knext/core with pnpm pack (rewrites workspace:^ so npm can install)"
        STAGE_DIR="$(mktemp -d "${ADAPTER_PKG_DIR}/.e2e-pack.XXXXXX")"
        (cd "${LIB_PKG_DIR}" && pnpm pack --pack-destination "${STAGE_DIR}") >&2
        (cd "${ADAPTER_PKG_DIR}" && pnpm pack --pack-destination "${STAGE_DIR}") >&2
        mkdir -p "${TARBALLS_DIR}"
        # Same filesystem as STAGE_DIR → mv is an atomic rename per tarball.
        mv -f "${STAGE_DIR}"/*.tgz "${TARBALLS_DIR}/"
        rmdir "${STAGE_DIR}"
      fi
      rmdir "${LOCK_DIR}" 2>/dev/null || true
      trap - EXIT
    fi
  fi
  LIB_TGZ="$(find_tarball "${TARBALLS_DIR}" knext-lib)"
  CORE_TGZ="$(find_tarball "${TARBALLS_DIR}" knext-core)"
  if [ -z "${LIB_TGZ}" ] || [ -z "${CORE_TGZ}" ]; then
    log "ERROR: adapter tarballs missing in ${TARBALLS_DIR} (need knext-lib-*.tgz + knext-core-*.tgz; pack with pnpm pack)"
    exit 1
  fi
  log "installing adapter tarballs ${LIB_TGZ} + ${CORE_TGZ} into ${APP_DIR}"
  # ONE install with BOTH tarballs: npm resolves @knext/core's @knext/lib dep
  # from the local lib tarball instead of the (not-yet-published) registry.
  npm install --no-save --no-audit --no-fund "${LIB_TGZ}" "${CORE_TGZ}" >&2
  # Resolve the installed adapter entry (package export "./adapter").
  NEXT_ADAPTER_PATH="$(node -e 'process.stdout.write(require.resolve("@knext/core/adapter"))')"
else
  log "KNEXT_E2E_SKIP_PACK=1 — skipping tarball install (contract-test mode)"
  NEXT_ADAPTER_PATH="${NEXT_ADAPTER_PATH:-}"
fi
export NEXT_ADAPTER_PATH
log "NEXT_ADAPTER_PATH=${NEXT_ADAPTER_PATH:-<unset>}"

# ── 2. build the fixture app through the knext adapter ────────────────────────
# #147 A3-3 fix round 1, follow-up (branch run 28561839378): a bare `next build`
# resolved NOTHING in the harness env — the fixture's node_modules/.bin is NOT on
# the deploy script's PATH, so every real test died with `next: command not found`
# (127) right after the tarball install finally succeeded. The harness installs
# `next` INTO the fixture dir it cd's us into (create-next-install via
# NEXT_TEST_PKG_PATHS), so the ONLY correct binary is the app-local one. Invoke
# it by explicit path and fail LOUD if absent — never fall back to a global
# `next`, which would silently build with an arbitrary version instead of the
# pinned prebuilt tarball under test.
NEXT_BIN="${APP_DIR}/node_modules/.bin/next"
if [ ! -x "${NEXT_BIN}" ]; then
  log "ERROR: fixture-local next binary not found/executable at ${NEXT_BIN} — the harness install did not provide next (NEXT_TEST_PKG_PATHS); a global fallback is deliberately refused"
  exit 1
fi
log "running next build (output:'standalone') via ${NEXT_BIN}"
"${NEXT_BIN}" build >&2

# ── 3. locate + stage the standalone server tree ──────────────────────────────
# output:'standalone' emits server.js under .next/standalone (monorepo fixtures may
# nest it under .next/standalone/<app-path>/server.js); find the first one.
SERVER_JS="$(find "${APP_DIR}/.next/standalone" -maxdepth 4 -name server.js 2>/dev/null | head -n1 || true)"
if [ -z "${SERVER_JS}" ]; then
  log "ERROR: standalone server.js not found under .next/standalone"
  exit 1
fi
STANDALONE_APP_DIR="$(dirname "${SERVER_JS}")"
log "standalone server: ${SERVER_JS}"

# standalone does not copy .next/static or public/ — stage them (best-effort).
if [ -d "${APP_DIR}/.next/static" ]; then
  mkdir -p "${STANDALONE_APP_DIR}/.next"
  cp -R "${APP_DIR}/.next/static" "${STANDALONE_APP_DIR}/.next/static"
fi
if [ -d "${APP_DIR}/public" ]; then
  cp -R "${APP_DIR}/public" "${STANDALONE_APP_DIR}/public"
fi

# ── 4. boot the standalone server on a free port ──────────────────────────────
PORT="$(free_port)"
BUILD_ID="$(cat "${APP_DIR}/.next/BUILD_ID" 2>/dev/null || echo "unknown")"
# DEPLOYMENT_ID identifies this deployment to the harness (asset versioning / skew).
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-knext-${BUILD_ID}-$(date +%s)}"

case "${RUNTIME}" in
  bun) SERVER_CMD="bun" ;;
  *)   SERVER_CMD="node" ;;
esac

log "booting (${RUNTIME}) ${SERVER_JS} on 127.0.0.1:${PORT}"
(
  cd "${STANDALONE_APP_DIR}"
  PORT="${PORT}" HOSTNAME="127.0.0.1" NODE_ENV="production" \
    NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
    exec "${SERVER_CMD}" "${SERVER_JS}"
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

# ── 5. persist deployment metadata BEFORE probing (so cleanup can always find it) ─
{
  echo "BUILD_ID=${BUILD_ID}"
  echo "DEPLOYMENT_ID=${DEPLOYMENT_ID}"
  echo "PORT=${PORT}"
  echo "PID=${SERVER_PID}"
  echo "RUNTIME=${RUNTIME}"
  echo "SERVER_JS=${SERVER_JS}"
  echo "SERVER_LOG=${SERVER_LOG}"
} >"${LOG_FILE}"

# ── 6. TCP-probe readiness ────────────────────────────────────────────────────
READY=0
for _ in $(seq 1 100); do
  if node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    READY=1
    break
  fi
  # bail early if the server process already died
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    log "ERROR: server process ${SERVER_PID} exited before becoming ready"
    log "---- server log ----"
    cat "${SERVER_LOG}" >&2 || true
    exit 1
  fi
  sleep 0.3
done

if [ "${READY}" != "1" ]; then
  log "ERROR: server never became ready on port ${PORT}"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
fi

log "deployment ready: build=${BUILD_ID} deployment=${DEPLOYMENT_ID} pid=${SERVER_PID}"

# ── 7. the ONLY stdout line: the deployment URL ───────────────────────────────
echo "http://localhost:${PORT}"
