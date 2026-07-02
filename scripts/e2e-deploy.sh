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
  # `|| true`: under `set -euo pipefail` a failing pipeline (ls: no match) would
  # otherwise kill the script AT the caller's `VAR="$(find_tarball ...)"`
  # assignment -- making the explicit "adapter tarballs missing" diagnostic
  # below unreachable (review finding on #171). Empty output IS the
  # not-found signal; the caller checks it and fails LOUD.
  ls -1 "$1/$2"-*.tgz 2>/dev/null | sort | tail -n1 || true
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

  # ── B1 (#147 round 2, triage of run 28564443662 — 282/327 failures): pin the
  # TypeScript that `next build`'s auto type-check resolves. The harness
  # (vercel/next.js@v16.2.0 test/lib/next-modes/base.ts:248) installs
  # `typescript: 'latest'` into EVERY fixture; `latest` now resolves to
  # TypeScript 6.x, which turns the auto-generated tsconfig defaults
  # (`moduleResolution=node10`, `baseUrl`) into hard deprecation ERRORS and
  # aborts the build ("Failed to type check."). Upstream's own repo pins
  # `typescript: 5.9.2` in its root package.json devDependencies (v16.2.0), so
  # Next's own CI type-checks fixtures with TS 5 — MIRROR that exact pin.
  # Conditional on purpose: a fixture that deliberately pins its own
  # (non-"latest") typescript keeps it; pure-JS fixtures (no typescript
  # requested or installed) skip the extra registry fetch entirely.
  TS_SPEC="$(node -e 'try{const p=require(process.cwd()+"/package.json");const d=(p.dependencies&&p.dependencies.typescript)||(p.devDependencies&&p.devDependencies.typescript)||"";process.stdout.write(String(d))}catch(_){}')"
  TS_PIN=""
  if [ "${TS_SPEC}" = "latest" ]; then
    TS_PIN="typescript@5.9.2"
  elif [ -z "${TS_SPEC}" ] && [ -e "${APP_DIR}/node_modules/typescript" ]; then
    TS_PIN="typescript@5.9.2"
  fi
  if [ -n "${TS_PIN}" ]; then
    log "fixture requested typescript '${TS_SPEC:-<none, but installed>}' — pinning ${TS_PIN} (mirrors vercel/next.js@v16.2.0 devDependencies; TS 6.x aborts next build's type-check)"
  fi

  # ── B3 (#147 round 2, 12 files): fixtures ship hand-made packages inside
  # their own node_modules/ (`node_modules/example`, scoped ones, …) as test
  # material; npm's reify PRUNES every package not in its ideal tree — with
  # --no-save, --no-package-lock, --install-links=false and every
  # --install-strategy (verified empirically; scoped CHILDREN are pruned even
  # when the scope dir survives, `.bin` entries survive). No install flag
  # avoids it, so: snapshot package-level node_modules entries before the
  # install and restore whatever the reify removed.
  NM_DIR="${APP_DIR}/node_modules"
  NM_SNAP=""
  NM_ENTRIES=""
  nm_package_entries() { # <node_modules dir> → package-level entries, one per line
    (
      cd "$1" 2>/dev/null || exit 0
      for e in * @*/*; do
        if [ -e "${e}" ] || [ -L "${e}" ]; then
          case "${e}" in
            @*/*) echo "${e}" ;; # scoped package (scope children get pruned individually)
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
      # -RP: preserve symlinks (pnpm layout) instead of dereferencing them.
      cp -RP "${NM_DIR}/${entry}" "${NM_SNAP}/${entry}"
    done <<EOF
${NM_ENTRIES}
EOF
  fi

  log "installing adapter tarballs ${LIB_TGZ} + ${CORE_TGZ}${TS_PIN:+ + ${TS_PIN}} into ${APP_DIR}"
  # ONE install with BOTH tarballs (+ the TS pin when needed): npm resolves
  # @knext/core's @knext/lib dep from the local lib tarball instead of the
  # (not-yet-published) registry, and a single reify keeps the snapshot/restore
  # window minimal.
  # shellcheck disable=SC2086
  npm install --no-save --no-audit --no-fund "${LIB_TGZ}" "${CORE_TGZ}" ${TS_PIN} >&2

  # Restore fixture-shipped packages the reify pruned (B3).
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

# ── B5 (#147 round 2): generate the deployment id BEFORE the build and export
# NEXT_DEPLOYMENT_ID into the build env. Next stamps `dpl=` into image/asset
# URLs and skew headers AT BUILD TIME (next-image asserted `…&dpl=knext-…` and
# got no dpl; segment-cache/deployment-skew aborted with "Neither
# NEXT_PUBLIC_BUILD_ID nor NEXT_DEPLOYMENT_ID is set"). The SAME id is handed
# to the runtime server below so build-stamped URLs and the served deployment
# never skew apart.
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-knext-$(date +%s)-$$}"
export NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}"

# ── B4 (#147 round 2): persist the FULL `next build` output. Harness tests
# assert on build warnings via fetchCliOutputs() → scripts/e2e-logs.sh, which
# could only show metadata + the server log; capture the build stream here and
# let e2e-logs.sh print it. tee's stdout is redirected to STDERR — deploy
# stdout stays the single URL line. set -o pipefail (top of file) still fails
# the script when `next build` fails.
BUILD_LOG="${APP_DIR}/.adapter-next-build.log"

# ── B2 (#173, round 3): enable Node-native TS resolution for next.config.ts/.mts.
# The 18 `next-config-ts-native-ts`/`-native-mts` failures were NOT adapter
# packaging (the @knext/core adapter dist is require()-safe — gated by
# packages/kn-next/src/__tests__/adapter-require-safe.test.ts): every fixture in
# those families carries a DELIBERATE top-level await in its own next.config.ts,
# and without native TS resolution `next build` falls back to the legacy
# swc-transpile path, which requireFromString()s the config → Node throws
# `require() cannot be used on an ESM graph with top-level await`
# (ERR_REQUIRE_ASYNC_MODULE) before anything is built. Upstream CI runs those
# families in dedicated jobs with __NEXT_NODE_NATIVE_TS_LOADER_ENABLED=true
# exported (next.js build_and_test.yml, test-next-config-ts-native-ts-*); knext's
# aggregate run has no per-family env, so enable it here via the public CLI flag
# whenever the fixture's config is TS. Safe for legacy TS-config fixtures: when
# native import() can't load the config (tsconfig paths aliases, extensionless
# imports, JSON without attributes) Next warns and falls back to legacy
# resolution in the same call — verified against next@16.2.0
# dist/build/next-config-ts/transpile-config.js and reproduced with the
# import-alias-paths-only fixture (builds green either way).
NEXT_BUILD_ARGS=""
if [ -f "${APP_DIR}/next.config.ts" ] || [ -f "${APP_DIR}/next.config.mts" ]; then
  NEXT_BUILD_ARGS="--experimental-next-config-strip-types"
  log "next.config.(m)ts detected — passing ${NEXT_BUILD_ARGS} (B2 #173: native TS resolution; TLA-in-config fixtures cannot load via the legacy require path)"
fi

log "running next build (output:'standalone') via ${NEXT_BIN} (deployment=${DEPLOYMENT_ID}, build log → ${BUILD_LOG})"
# NEXT_BUILD_ARGS is deliberately unquoted: empty ⇒ no extra argv entry.
# shellcheck disable=SC2086
"${NEXT_BIN}" build ${NEXT_BUILD_ARGS} 2>&1 | tee "${BUILD_LOG}" >&2

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
# DEPLOYMENT_ID identifies this deployment to the harness (asset versioning /
# skew). Generated BEFORE the build (B5) — reused verbatim here.

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
  echo "BUILD_LOG=${BUILD_LOG}"
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
