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
#   1. (unless KNEXT_E2E_SKIP_PACK=1) install the @getknext/lib + @getknext/db +
#      @getknext/core tarballs into the temp app, so NEXT_ADAPTER_PATH resolves the
#      package-shipped adapter.
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
# `npm pack` @getknext/core PER TEST. That was the ONE bug behind 472/473 failures:
# `npm pack` ships pnpm's raw `workspace:^` dep on @getknext/lib verbatim (only
# `pnpm pack`/`pnpm publish` rewrite the workspace protocol), so every fixture's
# `npm install <tarball>` died with EUNSUPPORTEDPROTOCOL and `next build` ran
# ZERO times. Per-test packing ALSO raced: run-tests.js (concurrency 2, retries)
# packed into the same tarball path simultaneously.
#
# Now: @getknext/lib, @getknext/db AND @getknext/core are packed with `pnpm pack` ONCE —
# in CI by the workflow (handed down via KNEXT_E2E_TARBALLS_DIR, preflight-gated
# by scripts/e2e-preflight.mjs), locally by a lock-guarded pack-once fallback —
# and ALL tarballs are installed in ONE `npm install`, so npm satisfies the
# rewritten `@getknext/lib@^x` + `@getknext/db@^x` deps from the local tarballs (the
# @getknext scope is not on npm yet — #53 is human-blocked). #255/#256: core gained
# a workspace dep on @getknext/db (`kn-next db migrate`); a lib+core-only set 404s
# on the unpublished @getknext/db in EVERY fixture install.
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
      log "ERROR: set KNEXT_E2E_TARBALLS_DIR (pre-packed tarballs) or ADAPTER_DIR (the @getknext/core package dir), or KNEXT_E2E_SKIP_PACK=1"
      exit 1
    fi
    LIB_PKG_DIR="${KNEXT_LIB_DIR:-${ADAPTER_PKG_DIR}/../lib}"
    DB_PKG_DIR="${KNEXT_DB_DIR:-${ADAPTER_PKG_DIR}/../db}"
    TARBALLS_DIR="${ADAPTER_PKG_DIR}/.e2e-tarballs"
    if [ -z "$(find_tarball "${TARBALLS_DIR}" getknext-lib)" ] || [ -z "$(find_tarball "${TARBALLS_DIR}" getknext-db)" ] || [ -z "$(find_tarball "${TARBALLS_DIR}" getknext-core)" ]; then
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
      if [ -z "$(find_tarball "${TARBALLS_DIR}" getknext-lib)" ] || [ -z "$(find_tarball "${TARBALLS_DIR}" getknext-db)" ] || [ -z "$(find_tarball "${TARBALLS_DIR}" getknext-core)" ]; then
        log "packing @getknext/lib + @getknext/db + @getknext/core with pnpm pack (rewrites workspace:^ so npm can install)"
        STAGE_DIR="$(mktemp -d "${ADAPTER_PKG_DIR}/.e2e-pack.XXXXXX")"
        (cd "${LIB_PKG_DIR}" && pnpm pack --pack-destination "${STAGE_DIR}") >&2
        (cd "${DB_PKG_DIR}" && pnpm pack --pack-destination "${STAGE_DIR}") >&2
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
  LIB_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-lib)"
  DB_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-db)"
  CORE_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-core)"
  if [ -z "${LIB_TGZ}" ] || [ -z "${DB_TGZ}" ] || [ -z "${CORE_TGZ}" ]; then
    log "ERROR: adapter tarballs missing in ${TARBALLS_DIR} (need getknext-lib-*.tgz + getknext-db-*.tgz + getknext-core-*.tgz; pack with pnpm pack)"
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

  log "installing adapter tarballs ${LIB_TGZ} + ${DB_TGZ} + ${CORE_TGZ}${TS_PIN:+ + ${TS_PIN}} into ${APP_DIR}"
  # ONE install with ALL tarballs (+ the TS pin when needed): npm resolves
  # @getknext/core's @getknext/lib + @getknext/db deps from the local tarballs instead of
  # the (not-yet-published) registry, and a single reify keeps the
  # snapshot/restore window minimal.
  # shellcheck disable=SC2086
  npm install --no-save --no-audit --no-fund "${LIB_TGZ}" "${DB_TGZ}" "${CORE_TGZ}" ${TS_PIN} >&2

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
  NEXT_ADAPTER_PATH="$(node -e 'process.stdout.write(require.resolve("@getknext/core/adapter"))')"
  # #175 (B7b): resolve the deployed-platform Cache-Control preload from the
  # SAME installed package, so the serve below patches exactly what ships.
  KNEXT_CC_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@getknext/core/internal/cache-control-normalize"))')"
  # #188 — Bun ≤1.3.x keep-alive mitigation preload, resolved from the SAME
  # installed package (only booted with it when RUNTIME=bun, see step 4).
  KNEXT_BUN_GUARD_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@getknext/core/internal/bun-keepalive-guard"))')"
  # #188 round 3 — the bun-condition export heal (ESM dist), resolved from the
  # SAME installed package. Tolerant resolve: an older tarball without the
  # export must not kill Node-lane deploys (the heal is only INVOKED on
  # RUNTIME=bun, post-build — see step 3).
  KNEXT_BUN_EXPORTS_HEAL="$(node -e 'process.stdout.write(require.resolve("@getknext/core/internal/standalone-bun-exports"))' 2>/dev/null || true)"
  # #188 path 2 — opt-in edge-sandbox fetch instrumentation preload (inert
  # unless KNEXT_SANDBOX_FETCH_DEBUG=1; only appended under that gate below).
  # Tolerant resolve: an older tarball without the export must not kill deploys.
  KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@getknext/core/internal/sandbox-fetch-debug"))' 2>/dev/null || true)"
  # #188 path 3 — the IN-REALM instrumentation module e2e-deploy patches into
  # the fixture next's sandbox context.js (only under the same debug gate;
  # tolerant resolve for older tarballs).
  KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@getknext/core/internal/sandbox-fetch-realm-debug"))' 2>/dev/null || true)"
else
  log "KNEXT_E2E_SKIP_PACK=1 — skipping tarball install (contract-test mode)"
  NEXT_ADAPTER_PATH="${NEXT_ADAPTER_PATH:-}"
  # Contract-test mode has no installed @getknext/core; the preloads are plain
  # dependency-free CJS, so the in-repo SOURCE files are directly loadable.
  KNEXT_CC_PRELOAD="${SCRIPT_DIR}/../packages/kn-next/src/adapters/cache-control-normalize.cjs"
  KNEXT_BUN_GUARD_PRELOAD="${SCRIPT_DIR}/../packages/kn-next/src/adapters/bun-keepalive-guard.cjs"
  KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD="${SCRIPT_DIR}/../packages/kn-next/src/adapters/sandbox-fetch-debug.cjs"
  KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD="${SCRIPT_DIR}/../packages/kn-next/src/adapters/sandbox-fetch-realm-debug.cjs"
  # The heal is TS source in-repo (not directly loadable); contract-test mode
  # never boots bun fixtures, so leave it unset — the bun branch warns+skips.
  KNEXT_BUN_EXPORTS_HEAL="${KNEXT_BUN_EXPORTS_HEAL:-}"
fi
if [ ! -f "${KNEXT_CC_PRELOAD}" ]; then
  log "ERROR: cache-control normalization preload not found at ${KNEXT_CC_PRELOAD}"
  exit 1
fi
if [ ! -f "${KNEXT_BUN_GUARD_PRELOAD}" ]; then
  log "ERROR: bun keep-alive guard preload not found at ${KNEXT_BUN_GUARD_PRELOAD}"
  exit 1
fi
export NEXT_ADAPTER_PATH
log "NEXT_ADAPTER_PATH=${NEXT_ADAPTER_PATH:-<unset>}"
log "cache-control preload: ${KNEXT_CC_PRELOAD}"

# ── #175 (B7b, lazy-catchall): mirror the official reference adapter
# (nextjs/adapter-bun scripts/e2e-deploy.sh). Next's deploy harness appends a
# next.config.js snippet that aliases NEXT_PRIVATE_TEST_MODE → __NEXT_TEST_MODE
# ("_" is not a valid env var name on some deploy platforms); define-env then
# inlines __NEXT_TEST_MODE into the CLIENT bundle, which is what emits the
# window.__NEXT_HYDRATED test marker. Without it, every webdriver hydration
# wait falls back to a 10s timeout — long enough for the prerender fixture's
# 3s-delayed lazy fallback to fully resolve, so the suite saw "Hi delayby3s"
# where it asserted the "fallback" shell (run 28578203671). Exported HERE so
# both `next build` (bundle inlining) and the runtime server inherit it.
if [ -z "${NEXT_PRIVATE_TEST_MODE:-}" ] && [ -n "${NEXT_TEST_MODE:-}" ]; then
  export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE}"
fi

# ── B6 (#147 A3-3 final mile — PR #179's deferred note): map the harness's
# jest-process experimental flags to the NEXT_PRIVATE_EXPERIMENTAL_* names the
# harness-appended next.config.js snippet reads at config load. This mirrors
# next-deploy.ts@v16.2.0 (lines 352-364) EXACTLY: its Vercel path forwards
# __NEXT_CACHE_COMPONENTS / __NEXT_EXPERIMENTAL_CACHED_NAVIGATIONS /
# __NEXT_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER into `vercel deploy --build-env
# NEXT_PRIVATE_EXPERIMENTAL_*`; the custom-script path hands us the raw jest
# process.env and leaves the mapping to the script. Without it, a
# cacheComponents-lane run would build every `use cache` fixture without the
# flag and die at build ("To use 'use cache: remote', please enable the
# feature flag"). Exported (not build-local) so the runtime server sees the
# same feature surface the build was stamped with.
if [ -n "${__NEXT_CACHE_COMPONENTS:-}" ]; then
  export NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS="${__NEXT_CACHE_COMPONENTS}"
fi
if [ -n "${__NEXT_EXPERIMENTAL_CACHED_NAVIGATIONS:-}" ]; then
  export NEXT_PRIVATE_EXPERIMENTAL_CACHED_NAVIGATIONS="${__NEXT_EXPERIMENTAL_CACHED_NAVIGATIONS}"
fi
if [ -n "${__NEXT_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER:-}" ]; then
  export NEXT_PRIVATE_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER="${__NEXT_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER}"
fi

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
# packaging (the @getknext/core adapter dist is require()-safe — gated by
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

# ── #147 A3-3 final mile (run 28590478386: trailingslash +
# revalidate-path-with-rewrites): honor the fixture's build-script args. The
# harness synthesizes EVERY deploy fixture's package.json build script as
#   build: "next build <buildArgs> && pnpm post-build"
# (base.ts@v16.2.0:283-298) and Vercel runs that script; those two fixtures use
# buildArgs (`--debug-build-paths '!…/cache-components/…'`) to exclude their
# cacheComponents-only page variant from non-cacheComponents lanes. knext's
# bare `next build` compiled the excluded page and died on the missing feature
# flag. Extract the argv tail of the leading `next build` command (the
# `&& pnpm post-build` tail is the harness's Vercel-log hook — e2e-logs.sh
# already provides those ids) and forward it to the pinned fixture-local
# binary. A build script that does not start with `next build` is logged and
# ignored (the direct pinned-binary invocation stays authoritative).
FIXTURE_BUILD_SCRIPT="$(node -e 'try{const s=((require(process.cwd()+"/package.json").scripts||{}).build)||"";process.stdout.write(String(s))}catch(_){}')"
if [ -n "${FIXTURE_BUILD_SCRIPT}" ]; then
  FIXTURE_BUILD_ARGS="$(node -e '
    const s = process.argv[1] || "";
    const first = s.split("&&")[0].trim();
    const m = first.match(/^next build\s*(.*)$/);
    process.stdout.write(m ? m[1].trim() : "");
  ' "${FIXTURE_BUILD_SCRIPT}")"
  if [ -n "${FIXTURE_BUILD_ARGS}" ]; then
    log "forwarding fixture build-script args: ${FIXTURE_BUILD_ARGS}"
    NEXT_BUILD_ARGS="${NEXT_BUILD_ARGS} ${FIXTURE_BUILD_ARGS}"
  elif ! printf '%s' "${FIXTURE_BUILD_SCRIPT}" | grep -q '^next build'; then
    log "fixture build script does not start with 'next build' — running the pinned binary without its args: ${FIXTURE_BUILD_SCRIPT}"
  fi
fi

log "running next build (output:'standalone') via ${NEXT_BIN} (deployment=${DEPLOYMENT_ID}, build log → ${BUILD_LOG})"
# NEXT_BUILD_ARGS is deliberately unquoted: empty ⇒ no extra argv entry; the
# harness joins buildArgs with spaces (base.ts), so space-splitting is the
# faithful mirror. `set -f` keeps glob-shaped args
# (`!app/[lang]/cache-components/page.js`) VERBATIM — bash pathname expansion
# would otherwise be layout-dependent.
set -f
# shellcheck disable=SC2086
"${NEXT_BIN}" build ${NEXT_BUILD_ARGS} 2>&1 | tee "${BUILD_LOG}" >&2
set +f

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

# ── #188 round 3: heal Bun-condition export targets (bun lane only) ───────────
# Round-2's adapter-side heal never ran in CI: onBuildComplete fires BEFORE
# next emits .next/standalone (run 28616072395 — 'onBuildComplete fired' with
# zero heal logs; the standalone dir does not exist at hook time), so
# getserversideprops/module-layer kept 500ing with
#   ResolveMessage: Cannot find module 'react-dom/server'
# Heal HERE, after the tree exists: copy exports targets behind a "bun"
# condition (react-dom/server → server.bun.js — shipped by the published
# package, never traced by Node-run nft) from the app's node_modules into the
# standalone tree. Node lane: branch never taken, tree untouched.
if [ "${RUNTIME}" = "bun" ]; then
  if [ -n "${KNEXT_BUN_EXPORTS_HEAL:-}" ] && [ -f "${KNEXT_BUN_EXPORTS_HEAL}" ]; then
    log "healing bun-condition export targets (module: ${KNEXT_BUN_EXPORTS_HEAL})"
    node --input-type=module -e '
      const [healPath, projectDir, standaloneDir] = process.argv.slice(1);
      const { pathToFileURL } = await import("node:url");
      const mod = await import(pathToFileURL(healPath).href);
      if (typeof mod.healBunExportTargets !== "function") {
        console.error("[e2e-deploy] bun-exports heal: module exports no healBunExportTargets — skipping");
        process.exit(0);
      }
      const r = mod.healBunExportTargets({ projectDir, standaloneDir, log: (m) => console.error(m) });
      console.error(`[e2e-deploy] bun-exports heal: ${r.copied.length} copied, ${r.skipped.length} skipped`);
      for (const s of r.skipped) console.error(`[e2e-deploy]   skipped: ${s}`);
    ' "${KNEXT_BUN_EXPORTS_HEAL}" "${APP_DIR}" "${APP_DIR}/.next/standalone" >&2 \
      || log "WARNING: bun-exports heal failed (non-fatal) — bun-condition export targets not healed"
  else
    log "WARNING: bun-exports heal module unavailable (${KNEXT_BUN_EXPORTS_HEAL:-unset}) — bun-condition export targets not healed"
  fi
fi

# ── 3b. compile the standalone-on-Bun bytecode executable (bun lane only) ─────
# #1166/#1225 shipped `turbopack × bun` as a `bun build --compile --bytecode`
# executable of the standalone server (adapters/standalone-compile.mjs), not
# `bun server.js` — that is what the image actually boots
# (Dockerfile.standalone.hbs COPYs `knext-standalone-exec-linux-x64`). Until
# now the official compat suite's bun lane still boot-tested the UNCOMPILED
# script, so the 778-test suite had never run against the artifact that ships.
# Compile it here, from the SAME installed-tarball script the CLI's own
# `kn-next build` runs (standaloneCompileArgv in standalone-exec-build.ts) —
# resolved as the file sitting beside the already-resolved adapter entry, not
# reimplemented. The compile script self-verifies the bytecode pragma
# (bytecode-exec-verify.mjs) and exits non-zero (deleting the artifact first)
# if the check fails — `set -euo pipefail` (top of file) then fails THIS
# script, so a bytecode regression fails the deploy rather than silently
# shipping an uncompiled fallback.
#
# FAIL-CLOSED, not a soft fallback (review finding on this PR): once this
# branch decides a compile is due, every downstream failure — the compile
# script missing, docker unavailable, the container never becoming ready —
# is a hard `exit 1`, never a silent boot of `bun server.js`. A silent
# fallback would mean a real regression (the compiled artifact regressing)
# reads as a pass, on the pre-#1166 shape, exactly the failure mode #1166
# exists to catch.
#
# Not entered at all (server.js is the correct, intended boot target, not a
# fallback) when:
#   - KNEXT_E2E_SKIP_PACK=1 (contract-test mode — no installed tarball, so no
#     compile script to resolve; those runs never set RUNTIME=bun today);
#   - KNEXT_SANDBOX_FETCH_DEBUG=1 (#188 path 2/3) — that instrumentation
#     chain-requires server.js AS TEXT and patches the fixture's own sandbox
#     context.js on disk; a compiled executable is a single self-contained
#     binary with no separate context.js to patch, so the two are mutually
#     exclusive. The debug lane stays on the uncompiled script on purpose.
STANDALONE_EXEC=""
STANDALONE_ROOT="${APP_DIR}/.next/standalone"
# The alpine base the compiled exec is booted inside — BYTE-IDENTICAL to
# Dockerfile.standalone.hbs's `standalone-bun` stage FROM line (lockstep
# guard: tests/compat-bun-lane-compiled-exec.test.ts). Booting it bare on the
# ubuntu-latest runner is not an option: `bun-linux-x64-musl` is dynamically
# linked against musl (see vinext-build.ts's LinuxLibc note — "a glibc host
# cannot execute them at all"), so this MUST run inside the same musl base the
# image ships, never a glibc-target twin (that would certify a binary nothing
# ships).
STANDALONE_BUN_IMAGE="oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb"
if [ "${RUNTIME}" = "bun" ] && [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" != "1" ]; then
  if [ -n "${NEXT_ADAPTER_PATH:-}" ]; then
    STANDALONE_COMPILE_JS="$(dirname "${NEXT_ADAPTER_PATH}")/standalone-compile.js"
    if [ ! -f "${STANDALONE_COMPILE_JS}" ]; then
      log "ERROR: standalone-compile script not found beside the adapter (${STANDALONE_COMPILE_JS}) — the bun lane must boot the compiled exec, refusing to silently fall back to server.js"
      exit 1
    fi
    if ! command -v docker >/dev/null 2>&1; then
      log "ERROR: docker is required to boot the compiled standalone-on-Bun exec (a musl binary cannot run on this glibc host) — refusing to silently fall back to server.js"
      exit 1
    fi
    STANDALONE_EXEC="${STANDALONE_APP_DIR}/knext-standalone-exec-linux-x64"
    # unique per-build marker — a stale/foreign binary must never pass the
    # compile script's own bytecode-pragma proof.
    MARKER="knext-standalone-exec:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
    log "compiling the standalone-on-Bun bytecode executable (${STANDALONE_COMPILE_JS})"
    bun run "${STANDALONE_COMPILE_JS}" \
      --server "${SERVER_JS}" \
      --root "${STANDALONE_ROOT}" \
      --outfile "${STANDALONE_EXEC}" \
      --target bun-linux-x64-musl \
      --marker "${MARKER}" >&2
    log "compiled + bytecode-verified: ${STANDALONE_EXEC}"

    # ── 3c. rebuild native (*.node) addons for musl, inside the same pinned
    # image (review finding on this PR, hypothesis A confirmed by
    # reproduction) ──────────────────────────────────────────────────────
    # The harness installs every fixture's deps ONCE, on the glibc
    # ubuntu-latest runner — a fixture with a native module (e.g. sqlite3)
    # gets a GLIBC-linked prebuilt .node there. Booting inside the pinned
    # musl alpine image (this PR) then fails to dlopen that binary
    # ([ERR_DLOPEN_FAILED] "linked against glibc ... but this Bun build uses
    # musl"). The SHIPPED image does not hit this — its Dockerfile installs
    # deps INSIDE the alpine stage. Match that here: best-effort, so a
    # rebuild failure for one fixture's addon does not brick the whole bun
    # lane (see scripts/e2e-native-rebuild-musl.sh's header).
    docker run --rm \
      -v "${STANDALONE_ROOT}:${STANDALONE_ROOT}" \
      -v "${SCRIPT_DIR}/e2e-native-rebuild-musl.sh:/e2e-native-rebuild-musl.sh:ro" \
      "${STANDALONE_BUN_IMAGE}" \
      sh /e2e-native-rebuild-musl.sh "${STANDALONE_ROOT}" >&2
  else
    log "ERROR: KNEXT_E2E_SKIP_PACK=1 has no installed adapter to resolve the compile script from, but RUNTIME=bun was requested — refusing to silently fall back to server.js (contract-test mode is not expected to combine these)"
    exit 1
  fi
fi

# ── 3d. bake the V8 compile cache with KNEXT'S OWN driver (node runtime) ──────
# Bytecode caching is mandatory in every runtime×builder cell, and a cell may
# only credential on nights where KNEXT's caching is proven LIVE at runtime —
# not merely that Node can accept a cache. So the node lane exercises the two
# shipped halves of the standalone-node image's compile-cache path, resolved
# from the SAME installed tarball the deploy already uses:
#
#   * the BAKE: `templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs`
#     — the exact driver Dockerfile.standalone.hbs RUNs at docker build. It
#     imports server.js in-process, waits for it, fetches KNEXT_WARM_PATH
#     (must answer 2xx) and flushes. The template has no Handlebars tokens, so
#     the staged copy is byte-identical to what the image runs;
#   * the BOOT (step 4): the shipped `node-server` supervisor entry — what the
#     image's ENTRYPOINT imports — which spawns server.js with the inherited
#     NODE_COMPILE_CACHE (buildChildEnv).
#
# The cache lives where the image puts it and where the supervisor's own
# diagnostics expect it: `<dir of server.js>/.next/compile-cache`.
#
# WARM PATH. The image warms the app's health route; the upstream fixtures have
# none, and a request to an app route before the test would change its state
# (ISR entries, counters, after() logs). So the harness warms a FRAMEWORK-served
# static chunk (`<basePath>/_next/static/…`): it proves the booted server
# answers, and no app route runs. Middleware may still see that request (as it
# would any static request), which is the one fixture-visible side effect.
#
# A failed bake does NOT fail the deploy — the fixture's own tests are a
# separate verdict — it is RECORDED (compile_cache_bake=failed in the evidence
# line) and graded NOT live, which reds the shard and refuses the night.
NODE_CC_DIR=""
NODE_CC_DEBUG_LOG=""
NODE_CC_BAKE="skipped"
KNEXT_NODE_SUPERVISOR=""
if [ "${RUNTIME}" != "bun" ]; then
  NODE_CC_DIR="${STANDALONE_APP_DIR}/.next/compile-cache"
  NODE_CC_DEBUG_LOG="${APP_DIR}/.adapter-compile-cache.log"
  mkdir -p "${NODE_CC_DIR}"
  : >"${NODE_CC_DEBUG_LOG}"
  if [ "${KNEXT_E2E_SKIP_PACK:-0}" = "1" ]; then
    # Contract-test mode: no installed tarball, so neither shipped half exists.
    # Fail-SAFE, never a bypass — the evidence line records bake=skipped, which
    # grades NOT live. No workflow sets this.
    log "KNEXT_E2E_SKIP_PACK=1 — shipped compile-cache bake + supervisor skipped (contract-test mode; this deploy records NOT-live bytecode evidence)"
  else
    # Tolerant resolve, fail-SAFE: a tarball without the supervisor export (or
    # the bake template) records compile_cache_bake=failed and boots server.js
    # directly — graded NOT live — instead of failing the fixture's deploy.
    KNEXT_NODE_SUPERVISOR="$(node -e 'process.stdout.write(require.resolve("@getknext/core/internal/node-server"))' 2>/dev/null || true)"
    KNEXT_CORE_ROOT="$(dirname "$(dirname "$(dirname "${KNEXT_NODE_SUPERVISOR:-/x/x/x/x}")")")"
    KNEXT_BAKE_TEMPLATE="${KNEXT_CORE_ROOT}/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs"
    KNEXT_BAKE_DRIVER="${APP_DIR}/.knext-compile-cache-bake.mjs"
    if [ -z "${KNEXT_NODE_SUPERVISOR}" ] || [ ! -f "${KNEXT_BAKE_TEMPLATE}" ]; then
      log "ERROR: the installed tarball lacks knext's shipped node supervisor or compile-cache bake driver (supervisor=${KNEXT_NODE_SUPERVISOR:-<unresolved>}, bake=${KNEXT_BAKE_TEMPLATE}) — recorded as compile_cache_bake=failed (NOT live)"
      KNEXT_NODE_SUPERVISOR=""
      NODE_CC_BAKE="failed"
    else
      cp "${KNEXT_BAKE_TEMPLATE}" "${KNEXT_BAKE_DRIVER}"
      # Warm a SERVER route, never a static asset: serving a file compiles no
      # server code, so it is the wrong target for a compile-cache bake. Most
      # fixtures have no `/` page (404), so pick from the build's own route
      # manifests: `/` when it is a page, else the first STATIC page route (no
      # dynamic segment, no api route, no framework-internal `/_x` route). The
      # shipped driver still requires 2xx.
      WARM_PATH="$(node -e '
        const fs = require("node:fs"), path = require("node:path");
        const dir = process.argv[1];
        const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return {}; } };
        const basePath = readJson(".next/required-server-files.json").config?.basePath || "";
        const routes = [
          ...Object.keys(readJson(".next/server/pages-manifest.json")),
          ...Object.keys(readJson(".next/server/app-paths-manifest.json")).map((r) => r.replace(/\/page$/, "") || "/"),
        ];
        const ok = (r) => r.startsWith("/") && !r.includes("[") && !r.startsWith("/api") && !r.startsWith("/_") && !/\.[a-z0-9]+$/i.test(r);
        const pick = routes.includes("/") ? "/" : (routes.filter(ok).sort()[0] ?? "/");
        process.stdout.write(`${basePath}${pick}`);
      ' "${STANDALONE_APP_DIR}")"
      BAKE_PORT="$(free_port)"
      log "baking the V8 compile cache with the SHIPPED driver (warm ${WARM_PATH:-<none>}) into ${NODE_CC_DIR}"
      if [ -n "${WARM_PATH}" ] && (
        cd "${STANDALONE_APP_DIR}"
        PORT="${BAKE_PORT}" HOSTNAME=127.0.0.1 NODE_ENV=production \
          NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
          STANDALONE_SERVER_PATH="${SERVER_JS}" \
          NODE_COMPILE_CACHE="${NODE_CC_DIR}" \
          KNEXT_WARM_PATH="${WARM_PATH}" \
          node "${KNEXT_BAKE_DRIVER}" 2>&1 | tee "${APP_DIR}/.knext-bake.out" >&2
      ); then
        NODE_CC_BAKE="ok"
      else
        log "WARNING: the shipped compile-cache bake FAILED — recorded as compile_cache_bake=failed (NOT live); the deploy proceeds so the fixture's own tests still run"
        NODE_CC_BAKE="failed"
        # Diagnostic sidecar (NOT graded): which fixture, which warm path, why.
        { echo "--- bake FAILED: ${APP_DIR} warm=${WARM_PATH:-<none>} pkg=$(node -p 'require(process.argv[1]).name' "${APP_DIR}/package.json" 2>/dev/null || echo '?') files=$(ls "${APP_DIR}" | head -20 | tr '\n' ' ')"; tail -n 15 "${APP_DIR}/.knext-bake.out" 2>/dev/null || true; } >>"${RUNNER_TEMP:-/tmp}/knext-e2e-bake-failures.log"
      fi
    fi
  fi
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

# ── B7a (#174, triage of run 28564443662): HOSTNAME must be explicitly EMPTIED,
# never pinned to 127.0.0.1. In next@16.2.0's standalone server the
# middleware-visible request origin is ALWAYS http://localhost:<port> (verified
# via the x-middleware-rewrite response header on the rebuilt upstream
# middleware-custom-matchers fixture), while the router's initUrl uses the
# configured hostname VERBATIM (server/lib/router-utils/resolve-routes.js:116).
# With HOSTNAME=127.0.0.1, getRelativeURL(rewrite, initUrl) saw
# localhost !== 127.0.0.1, so every SAME-ORIGIN middleware rewrite
# (NextResponse.rewrite(new URL('/', request.url))) was misclassified as an
# EXTERNAL rewrite and proxied back to the server itself — 500s locally,
# proxy-loop timeouts in CI, exactly the 6 middleware-custom-matchers failures.
# HOSTNAME= (empty) → server.js falls back to 0.0.0.0 and Next normalizes the
# origin to localhost on BOTH sides → rewrites relativize to '/' and stay
# internal. Explicit (not merely dropped) because Docker/CI images export
# HOSTNAME=<container-id>, which would reintroduce the mismatch.
#
# #175 (B7b): boot with the deployed-platform Cache-Control preload (`-r` is
# the require/preload flag on BOTH node and bun). Next's origin emits
# shared-cache directives (s-maxage / the fallback-shell private value) meant
# for the platform cache; deployed clients see `public, max-age=0,
# must-revalidate` — the exact deploy-mode expectation of prerender.test.ts,
# and the exact normalization the reference adapter (nextjs/adapter-bun
# src/runtime/server.ts) performs in its serving layer. Same preload ships in
# the production runtime entry (adapters/node-server.ts), so the suite gates
# the shape users actually get.
#
# Cache-handler decision (#175): NO cacheHandler is wired here on purpose —
# running Next's default file-system incremental cache is the supported
# single-replica knext shape, and the header diffs were serving-layer
# semantics, not cache-handler state (the Redis cacheHandler stays the
# multi-pod production option).
# #188 (bun-lane fix round 1, triage of run 28607626868): Bun ≤1.3.14 resets a
# REUSED keep-alive socket when the next request arrives immediately after the
# previous response completed (plain node:http repro, no Next involved; fixed
# in Bun canary 1.4.0). The harness client (node-fetch@2 over Node's keep-alive
# globalAgent) reuses sockets back-to-back → deterministic per-request
# `socket hang up` on small/fast responses — Bucket 1's 30 files. The
# cache-control preload was exonerated (KNEXT_CACHE_CONTROL_NORMALIZE=0
# reproduced identical hang-ups). Mitigation: on RUNTIME=bun ONLY, preload the
# keep-alive guard (`Connection: close` per response; self-disables on Bun
# ≥1.4.0). The Node boot line is byte-identical to before.
SERVER_PRELOAD_ARGS=(-r "${KNEXT_CC_PRELOAD}")
if [ "${RUNTIME}" = "bun" ]; then
  SERVER_PRELOAD_ARGS+=(-r "${KNEXT_BUN_GUARD_PRELOAD}")
  # #188 round 2 — Bucket 3 (app-static / parallel-routes-root-param 404→500,
  # `invariant: cache entry required but not generated`, run 28612654960) is
  # deterministic in CI but did NOT reproduce locally against the exact
  # upstream fixture (sequential, concurrent, amd64, full CI env). Turn on
  # Next's incremental-cache debug logging in the bun lane ONLY so the next
  # red run's server-log tail (surfaced at teardown by e2e-cleanup.sh) names
  # the cache get/set decisions around the failing keys. Log-only; the Node
  # lane env is untouched.
  export NEXT_PRIVATE_DEBUG_CACHE=1
fi
# ── #188 path 2 — OPT-IN edge-sandbox fetch instrumentation ──────────────────
# Enabled ONLY by the compat workflow's dispatch-only `sandboxFetchDebug`
# input (KNEXT_SANDBOX_FETCH_DEBUG=1); the scheduled lanes and every default
# dispatch never enter this block — the steady-state boot stays byte-identical
# with the flag off (guard-tested). When on:
#   (a) boot the server THROUGH the instrumentation module (it chain-requires
#       the real server.js via KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS). NOT `-r`:
#       under bun, diagnostics_channel subscriptions made from a `-r` preload
#       never register for the main program (verified bun 1.3.x — the
#       require-chain from the main graph works; node works both ways). The
#       sandbox's bundled undici (next/dist/compiled/@edge-runtime/primitives/
#       fetch.js) publishes undici:request:*/undici:client:* through the HOST
#       diagnostics_channel under BOTH runtimes, so the server log records
#       each sandbox fetch's phase transitions + a stalled-request watchdog
#       with an `ss -tnp` socket snapshot;
#   (b) on the bun runtime, also export bun's verbose-fetch env so any
#       bun-NATIVE fetch traffic (which does not publish undici channels) is
#       logged too — the two outputs discriminate which fetch implementation a
#       request actually traversed.
# e2e-cleanup.sh ships the [sandbox-fetch-debug] server-log lines at teardown.
SERVER_BOOT_TARGET="${SERVER_JS}"
# 3b's compiled exec (bun lane, mutually exclusive with sandbox-fetch-debug —
# see the block above) takes over the boot target here. It is a self-contained
# binary: no interpreter, no `-r` preload flags (baked into the entry — see
# standalone-compile.mjs's "Baked-in preloads" section), no argv at all.
if [ -n "${STANDALONE_EXEC}" ]; then
  SERVER_BOOT_TARGET="${STANDALONE_EXEC}"
fi
if [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" = "1" ]; then
  if [ -n "${KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD:-}" ] && [ -f "${KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD}" ]; then
    log "KNEXT_SANDBOX_FETCH_DEBUG=1 — chain-booting through sandbox-fetch instrumentation (${KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD})"
    export KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS="${SERVER_JS}"
    SERVER_BOOT_TARGET="${KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD}"
  else
    log "WARNING: KNEXT_SANDBOX_FETCH_DEBUG=1 but the instrumentation module is unavailable (${KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD:-unset}) — sandbox fetches will NOT be instrumented"
  fi
  if [ "${RUNTIME}" = "bun" ]; then
    export BUN_CONFIG_VERBOSE_FETCH=curl
    log "KNEXT_SANDBOX_FETCH_DEBUG=1 — BUN_CONFIG_VERBOSE_FETCH=curl exported (bun-native fetch verbosity)"
  fi
  # ── #188 path 3 — IN-REALM instrumentation: patch the FIXTURE's staged
  # standalone next sandbox context.js. Path 2's calibrated null proved a
  # host-realm main-graph diagnostics_channel subscriber cannot see the
  # sandbox fetch under bun, so this patch wraps the sandbox fetch wiring
  # from INSIDE next's own extend() (base __fetch + context.fetch wrapper,
  # per-call phase logs + stall watchdog + net/tls socket phases). The hook
  # is double-gated: patched only here (debug lane), and the injected code
  # itself checks KNEXT_SANDBOX_FETCH_DEBUG=1 + the module env below. A
  # patch failure is LOUD but non-fatal — the run stays comparable to the
  # baseline, only without in-realm phases.
  if [ -n "${KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD:-}" ] && [ -f "${KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD}" ]; then
    export KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE="${KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD}"
    if node -e '
      const mod = require(process.argv[1]);
      const r = mod.patchSandboxContext({ appDir: process.argv[2], log: (m) => console.error(m) });
      if (!r.patched) { console.error("[e2e-deploy] sandbox context patch FAILED: " + r.reason); process.exit(1); }
      console.error("[e2e-deploy] sandbox context patched" + (r.already ? " (already)" : "") + ": " + r.contextPath);
    ' "${KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD}" "${STANDALONE_APP_DIR}" >&2; then
      log "KNEXT_SANDBOX_FETCH_DEBUG=1 — in-realm sandbox-fetch instrumentation patched into the fixture next (path 3)"
    else
      log "WARNING: in-realm sandbox context patch failed — this run has host-side (path 2) instrumentation only"
    fi
  else
    log "WARNING: KNEXT_SANDBOX_FETCH_DEBUG=1 but the realm-debug module is unavailable (${KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD:-unset}) — no in-realm instrumentation"
  fi
fi
if [ -n "${STANDALONE_EXEC}" ]; then
  # The exec is `bun-linux-x64-musl` — booted inside STANDALONE_BUN_IMAGE
  # (the SAME alpine base the image ships), never bare on the runner (review
  # finding: a musl binary does not execute on a glibc host at all — this is
  # not a portability nicety, it is the difference between every scheduled
  # bun night booting or crash-looping on every fixture).
  #
  # --network host: the container shares the runner's network namespace, so
  # PORT binds exactly like the uncompiled boot does — no NAT/port-publish
  # layer, no docker-proxy process sitting between the harness's TCP probe
  # and the compiled server. Linux-only, which is exactly what this lane
  # runs on (ubuntu-latest); this script never targets `--network host` on
  # any other boot path.
  #
  # -v mounts the FULL .next/standalone root read-write (Next's filesystem
  # cache handler writes into `.next/cache` under it at request time — a
  # read-only mount would silently break ISR/data-cache tests), at a
  # container path preserving the exec's position relative to that root
  # (REL_SUBPATH) — the SAME relative offset `standalone-compile.mjs` baked
  # into the binary at compile time (RUNTIME_ROOT_FROM_EXEC_DIR), so the
  # exec's own root resolution (relative to its own directory) lands on the
  # mounted root inside the container exactly as it would beside server.js
  # on disk.
  #
  # --user "$(id -u):$(id -g)" (review finding): with no --user, the compiled
  # exec runs as the image's default UID (root). The runner user calling
  # `ss` below to attribute the LISTEN socket (#171 TOCTOU guard) is NOT
  # root, and the kernel's sock_diag permission model only lets an
  # unprivileged caller see PID/process detail for sockets owned by ITS OWN
  # uid — a root-owned socket is invisible to it (confirmed live: shard 7,
  # job 107207528866, "WARNING: cannot verify pid ... proceeding" on every
  # deploy). Running the container as the SAME uid:gid as the host runner
  # user makes the socket visible to `ss` under that user, closing the gap
  # AND matching the mounted volume's ownership (no root-owned files left
  # behind on the host either). The compiled exec itself needs no root
  # privilege to bind a port or serve requests.
  REL_SUBPATH="$(node -e 'const {relative}=require("node:path");process.stdout.write(relative(process.argv[1],process.argv[2]))' "${STANDALONE_ROOT}" "${STANDALONE_APP_DIR}")"
  CONTAINER_ROOT="/knext-standalone-root"
  CONTAINER_WORKDIR="${CONTAINER_ROOT}${REL_SUBPATH:+/${REL_SUBPATH}}"
  CONTAINER_NAME="knext-e2e-${DEPLOYMENT_ID}"
  log "booting the compiled standalone-on-Bun executable ${SERVER_BOOT_TARGET} inside ${STANDALONE_BUN_IMAGE} (container ${CONTAINER_NAME}) on 0.0.0.0:${PORT} (HOSTNAME emptied — see B7a note; preloads baked in)"
elif [ -n "${KNEXT_NODE_SUPERVISOR}" ] && [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" != "1" ]; then
  SUPERVISOR_METRICS_PORT="$(free_port)"
  log "booting (node) ${SERVER_JS} THROUGH the shipped supervisor ${KNEXT_NODE_SUPERVISOR} on 0.0.0.0:${PORT} (metrics :${SUPERVISOR_METRICS_PORT}; V8 compile cache ${NODE_CC_DIR})"
else
  log "booting (${RUNTIME}) ${SERVER_BOOT_TARGET} on 0.0.0.0:${PORT} (HOSTNAME emptied — see B7a note; preloads ${SERVER_PRELOAD_ARGS[*]})"
fi
(
  cd "${STANDALONE_APP_DIR}"
  if [ -n "${STANDALONE_EXEC}" ]; then
    exec docker run --rm --name "${CONTAINER_NAME}" \
      --network host \
      --user "$(id -u):$(id -g)" \
      -e PORT="${PORT}" -e HOSTNAME="" -e NODE_ENV="production" \
      -e NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
      -v "${STANDALONE_ROOT}:${CONTAINER_ROOT}" \
      -w "${CONTAINER_WORKDIR}" \
      "${STANDALONE_BUN_IMAGE}" \
      "./$(basename "${SERVER_BOOT_TARGET}")"
  elif [ -n "${KNEXT_NODE_SUPERVISOR}" ] && [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" != "1" ]; then
    # Node: boot through KNEXT's shipped supervisor — what the standalone-node
    # image's ENTRYPOINT runs. It spawns server.js with the cache-control
    # preload (the same shipped file the uncompiled boot passes with -r) and
    # hands the child NODE_COMPILE_CACHE through buildChildEnv, so a
    # regression in that wiring shows up here as a cold child.
    #   - NODE_COMPILE_CACHE is the image's default location (step 3d).
    #   - NODE_DEBUG_NATIVE=COMPILE_CACHE is V8's own accepted/rejected signal;
    #     its `[compile cache] …` lines go to a side log, never the server log
    #     (the server log is next.cliOutput in deploy mode, which tests assert
    #     on). Every other stderr line passes through unchanged.
    #   - METRICS_PORT is per deploy: two deploys run concurrently, and the
    #     supervisor's :9464 default would collide.
    #   - SHUTDOWN_GRACE_MS stays under e2e-cleanup.sh's 6s SIGTERM wait, so
    #     teardown drains through the supervisor instead of SIGKILLing it.
    #   - LOG_LEVEL=warn keeps the supervisor's info lines out of cliOutput;
    #     its warnings (a refused or shadowed cache among them) still appear.
    PORT="${PORT}" HOSTNAME="" NODE_ENV="production" \
      NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
      STANDALONE_SERVER_PATH="${SERVER_JS}" \
      NODE_COMPILE_CACHE="${NODE_CC_DIR}" NODE_DEBUG_NATIVE=COMPILE_CACHE \
      METRICS_PORT="${SUPERVISOR_METRICS_PORT}" SHUTDOWN_GRACE_MS=5000 LOG_LEVEL=warn \
      exec node "${KNEXT_NODE_SUPERVISOR}" \
      2> >(exec awk -v cc="${NODE_CC_DEBUG_LOG}" 'index($0, "[compile cache] ") == 1 { print >> cc; fflush(cc); next } { print; fflush() }')
  else
    PORT="${PORT}" HOSTNAME="" NODE_ENV="production" \
      NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
      exec "${SERVER_CMD}" "${SERVER_PRELOAD_ARGS[@]}" "${SERVER_BOOT_TARGET}"
  fi
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
# The pid used for port-ownership attribution (#171 guard below). For the
# docker-booted exec, SERVER_PID is the `docker run` CLIENT process — it
# never itself holds the listening socket, `--network host` or not — so
# ownership must be checked against the CONTAINERIZED process's real
# host-visible pid instead. Liveness (`kill -0`) stays on SERVER_PID: a
# foreground, non-detached `docker run` exits when the container exits,
# so SERVER_PID dying still means "the deployment is dead" correctly.
OWNER_PID="${SERVER_PID}"

# ── 5. persist deployment metadata BEFORE probing (so cleanup can always find it) ─
{
  echo "BUILD_ID=${BUILD_ID}"
  echo "DEPLOYMENT_ID=${DEPLOYMENT_ID}"
  echo "PORT=${PORT}"
  echo "PID=${SERVER_PID}"
  echo "RUNTIME=${RUNTIME}"
  # #188 (the bun-version dispatch knob): persist the OBSERVED serving-runtime
  # version so a canary run's evidence is attributable per deployment (RUNTIME=bun
  # alone can't distinguish 1.3.14 from 1.4.0-canary). BUN LANE ONLY — the node
  # lane's metadata stays byte-identical (documented choice: node's version is
  # pinned by CI's setup-node, and existing consumers key on the stable shape).
  if [ "${RUNTIME}" = "bun" ]; then
    echo "RUNTIME_VERSION=$(bun --version 2>/dev/null || echo unknown)"
    # #1166/#1225 — which artifact actually booted. bun lane only, same
    # gating rationale as RUNTIME_VERSION above (node metadata stays
    # byte-identical).
    if [ -n "${STANDALONE_EXEC}" ]; then
      echo "SERVING_MODE=compiled-exec"
      # so e2e-cleanup.sh can `docker rm -f` it as a belt-and-suspenders
      # step: `docker run --rm` only removes the container on ITS OWN exit,
      # and a hard SIGKILL of the `docker run` CLIENT (the timeout fallback
      # below) does not kill the container the client was attached to.
      echo "CONTAINER_NAME=${CONTAINER_NAME}"
    else
      echo "SERVING_MODE=server.js"
    fi
  fi
  echo "SERVER_JS=${SERVER_JS}"
  echo "SERVER_LOG=${SERVER_LOG}"
  echo "BUILD_LOG=${BUILD_LOG}"
} >"${LOG_FILE}"

# ── 5b. boot-mode ledger (#1230 review finding) — POSITIVE proof of what
# actually booted, independent of the harness's own log capture. A passing
# Next.js test never echoes THIS script's stderr, so a fully-green bun-lane
# shard carries not one line proving the compiled exec (vs. bun server.js)
# ever ran — a red-then-fixed lane could go green by silently falling back
# to the uncompiled script, and nothing in the harness's own summary would
# say so. One line per deploy, appended (not overwritten — a shard runs many
# deploys), machine-checkable by the workflow's own step (`if: always()`,
# runs after the tests, fails the job on any non-compiled-exec line when
# KNEXT_RUNTIME=bun). RUNNER_TEMP is the GitHub Actions per-job scratch dir;
# /tmp is the local/off-CI fallback. Every deploy appends (node lane
# included) so the ledger is a complete audit trail, not just a bun-lane one
# — the workflow step decides what it requires, this script only records.
BOOT_MODE_LEDGER="${RUNNER_TEMP:-/tmp}/knext-e2e-boot-modes.log"
if [ -n "${STANDALONE_EXEC}" ]; then
  # Reaching this line means standalone-compile.mjs's own bytecode-pragma
  # check already passed (a failure there is `exit 1` inside the compile
  # step, well before boot) — bytecode_verified=true is therefore a fact
  # already proven above, not merely asserted here.
  echo "mode=compiled-exec runtime=${RUNTIME} image=${STANDALONE_BUN_IMAGE} bytecode_verified=true" >>"${BOOT_MODE_LEDGER}"
elif [ -z "${NODE_CC_DIR}" ]; then
  # bun booting server.js (the dispatch-only sandbox-fetch-debug lane): a
  # non-bytecode boot, recorded as such — scripts/e2e-bytecode-liveness.mjs grades
  # it NOT live.
  echo "mode=server-js runtime=${RUNTIME} image=- bytecode_verified=-" >>"${BOOT_MODE_LEDGER}"
fi
# The node line is appended AFTER readiness (step 6b below): its liveness is a
# count of what V8 actually accepted while the server booted, which only
# exists once it has.

# ── 6. readiness: pid-liveness FIRST, TCP-probe second, port-ownership last ──
# #171 sys-design follow-up (the free_port TOCTOU): free_port() binds :0 and
# CLOSES it, and the server re-binds the number — at run-tests.js concurrency 2
# a SIBLING deploy can grab the freed port in that window. The old loop TCP-
# probed the port BEFORE checking our pid, so "something accepted on the port"
# was advertised as OUR deployment even when our server was dead — the harness
# would then run a whole test file against the WRONG app. Order now:
#   (a) every iteration checks SERVER_PID liveness BEFORE the probe, so a
#       probe result is never trusted on behalf of a dead server;
#   (b) after the probe succeeds, verify SERVER_PID actually OWNS the
#       listening port (lsof, ss fallback) before printing the URL.
server_died() { # surface the server log and abort (single exit path)
  log "ERROR: server process ${SERVER_PID} exited before becoming ready"
  log "---- server log ----"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
}

# Returns 0 when OWNER_PID owns a LISTEN socket on PORT, 1 when the port is
# PROVABLY owned by a different pid, 2 when ownership cannot be determined.
# OWNER_PID equals SERVER_PID except for the docker-booted compiled exec,
# where it is the CONTAINERIZED process's real host pid (see the boot step).
#
# #210 (nightly run 28697744187, 477 RED): ss must be consulted FIRST, and a
# bare lsof negative is NEVER proof of foreign ownership. Next.js retitles the
# standalone server (`process.title = 'next-server (v16.2.0)'`), so the kernel
# comm becomes `next-server (v1` — an embedded space + unbalanced paren that
# Linux lsof 4.95 (the ubuntu-24.04 runner build) cannot parse out of
# /proc/<pid>/stat. lsof then reports NO sockets for the process (even the
# global -iTCP:<port> query comes back empty; verified in a node:24 container
# against a real next@16.2.0 standalone build), so the old lsof-first check
# refused EVERY healthy node-lane deployment. ss reads netlink sock_diag and
# attributes the socket correctly. The bun lane never hit this (comm `bun`).
# Refusal (1) therefore requires POSITIVE attribution of the LISTEN socket to
# a DIFFERENT pid; absence of evidence downgrades to 2 (warn + proceed —
# pre-#194 behavior, with pid-liveness checks still applied).
# Guard-tested: tests/e2e-deploy.port-ownership.test.ts.
port_owned_by_server() {
  local listeners
  if command -v ss >/dev/null 2>&1; then
    listeners="$(ss -ltnp 2>/dev/null | grep -F ":${PORT} " || true)"
    if [ -n "${listeners}" ]; then
      if printf '%s\n' "${listeners}" | grep -q "pid=${OWNER_PID},"; then
        return 0
      fi
      if printf '%s\n' "${listeners}" | grep -q "pid="; then
        return 1 # attributed to someone else — the real TOCTOU
      fi
      return 2 # listener visible but unattributed (no permission for -p info)
    fi
    return 2 # no LISTEN row despite an accepted probe — a snapshot race, not proof
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -a -p "${OWNER_PID}" -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    # Only trust the negative when the GLOBAL port query positively names a
    # different owner (lsof may be blind to our pid entirely — see above).
    listeners="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -Fp 2>/dev/null | grep '^p' || true)"
    if [ -n "${listeners}" ] && ! printf '%s\n' "${listeners}" | grep -qx "p${OWNER_PID}"; then
      return 1
    fi
    return 2
  fi
  return 2
}

READY=0
for _ in $(seq 1 100); do
  # pid FIRST — a dead server invalidates any probe answer (a sibling may be
  # squatting the freed port).
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
  log "ERROR: server never became ready on port ${PORT}"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
fi

# The probe only proves SOMETHING accepted on the port. Re-check liveness and
# verify ownership before advertising the URL as OUR deployment.
if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
  server_died
fi
# For the docker-booted compiled exec, OWNER_PID is the CONTAINERIZED
# process's real host pid — SERVER_PID (the `docker run` client) never holds
# the listening socket itself. Resolve it now: the TCP probe above already
# succeeded, so the container is up and `docker inspect` has a State.Pid.
if [ -n "${STANDALONE_EXEC}" ]; then
  INSPECTED_PID="$(docker inspect -f '{{.State.Pid}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  if [ -n "${INSPECTED_PID}" ] && [ "${INSPECTED_PID}" != "0" ]; then
    OWNER_PID="${INSPECTED_PID}"
  fi
fi
# Supervisor-booted node: SERVER_PID is the supervisor, and the listening
# socket belongs to the Next child it spawned. Resolve that child (its only
# other child is the stderr-filter awk) so ownership is checked against the
# real listener, and record it so e2e-cleanup.sh can reap it if the
# supervisor ever has to be SIGKILLed (which would orphan the child).
if [ -n "${KNEXT_NODE_SUPERVISOR}" ] && [ "${KNEXT_SANDBOX_FETCH_DEBUG:-0}" != "1" ]; then
  CHILD_PID=""
  for p in $(pgrep -P "${SERVER_PID}" 2>/dev/null || true); do
    case "$(ps -o comm= -p "${p}" 2>/dev/null || true)" in
      *awk*) ;;
      *) CHILD_PID="${p}" ;;
    esac
  done
  if [ -n "${CHILD_PID}" ]; then
    OWNER_PID="${CHILD_PID}"
    echo "CHILD_PID=${CHILD_PID}" >>"${LOG_FILE}"
  else
    log "WARNING: could not resolve the supervisor's Next child pid — port ownership is checked against the supervisor"
  fi
fi
set +e
port_owned_by_server
OWNS=$?
set -e
if [ "${OWNS}" = "1" ]; then
  log "ERROR: port ${PORT} answers but is NOT owned by server pid ${OWNER_PID} — a sibling process grabbed the freed port (free_port TOCTOU); refusing to advertise it"
  log "---- server log ----"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
elif [ "${OWNS}" = "2" ]; then
  log "WARNING: cannot verify pid ${OWNER_PID} owns port ${PORT} (no tooling, or no positive attribution either way) — proceeding; pid-liveness checks still applied"
fi

log "deployment ready: build=${BUILD_ID} deployment=${DEPLOYMENT_ID} pid=${SERVER_PID}"

# ── 6b. node bytecode-liveness evidence (the node half of step 5b) ────────────
# Count what V8 accepted from the shipped bake while the supervisor's Next
# child booted, and append it — with the bake's own status — as this deploy's
# boot-ledger line.
#
# WHAT IS GRADED, precisely: modules under the standalone tree (the Next child:
# server.js, Next's framework internals, and whatever app code it loads at
# boot) up to readiness. The supervisor's own modules are EXCLUDED (--under):
# the shipped bake bakes the server, never the entry. App route chunks that
# load on a request are NOT graded — warming them would mean requesting an app
# route before the test does.
#
# The settle loop (≤5s) covers the tail of boot-time loading after the port
# opened; a live deploy exits it on the first pass, and a deploy whose bake did
# not succeed cannot become live, so it does not wait. This RECORDS, it never
# fails the deploy — scripts/e2e-bytecode-liveness.mjs grades the line (the
# shard check fails the job, the credential audit refuses the night).
if [ -n "${NODE_CC_DIR}" ]; then
  if [ "${NODE_CC_BAKE}" = "ok" ]; then
    for _ in $(seq 1 20); do
      if node "${SCRIPT_DIR}/e2e-bytecode-liveness.mjs" --live-node-log "${NODE_CC_DEBUG_LOG}" --under "${STANDALONE_ROOT}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi
  CC_COUNTS="$(node "${SCRIPT_DIR}/e2e-bytecode-liveness.mjs" --count-node-log "${NODE_CC_DEBUG_LOG}" --under "${STANDALONE_ROOT}")"
  echo "mode=server-js runtime=${RUNTIME} image=- bytecode_verified=- compile_cache_bake=${NODE_CC_BAKE} ${CC_COUNTS}" >>"${BOOT_MODE_LEDGER}"
  log "bytecode liveness (node, shipped bake + supervisor): compile_cache_bake=${NODE_CC_BAKE} ${CC_COUNTS}"
fi

# ── 7. the ONLY stdout line: the deployment URL ───────────────────────────────
echo "http://localhost:${PORT}"
