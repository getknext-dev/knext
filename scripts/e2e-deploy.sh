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
  # #175 (B7b): resolve the deployed-platform Cache-Control preload from the
  # SAME installed package, so the serve below patches exactly what ships.
  KNEXT_CC_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@knext/core/internal/cache-control-normalize"))')"
  # #188 — Bun ≤1.3.x keep-alive mitigation preload, resolved from the SAME
  # installed package (only booted with it when RUNTIME=bun, see step 4).
  KNEXT_BUN_GUARD_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@knext/core/internal/bun-keepalive-guard"))')"
  # #188 round 3 — the bun-condition export heal (ESM dist), resolved from the
  # SAME installed package. Tolerant resolve: an older tarball without the
  # export must not kill Node-lane deploys (the heal is only INVOKED on
  # RUNTIME=bun, post-build — see step 3).
  KNEXT_BUN_EXPORTS_HEAL="$(node -e 'process.stdout.write(require.resolve("@knext/core/internal/standalone-bun-exports"))' 2>/dev/null || true)"
  # #188 path 2 — opt-in edge-sandbox fetch instrumentation preload (inert
  # unless KNEXT_SANDBOX_FETCH_DEBUG=1; only appended under that gate below).
  # Tolerant resolve: an older tarball without the export must not kill deploys.
  KNEXT_SANDBOX_FETCH_DEBUG_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@knext/core/internal/sandbox-fetch-debug"))' 2>/dev/null || true)"
  # #188 path 3 — the IN-REALM instrumentation module e2e-deploy patches into
  # the fixture next's sandbox context.js (only under the same debug gate;
  # tolerant resolve for older tarballs).
  KNEXT_SANDBOX_FETCH_REALM_DEBUG_PRELOAD="$(node -e 'process.stdout.write(require.resolve("@knext/core/internal/sandbox-fetch-realm-debug"))' 2>/dev/null || true)"
else
  log "KNEXT_E2E_SKIP_PACK=1 — skipping tarball install (contract-test mode)"
  NEXT_ADAPTER_PATH="${NEXT_ADAPTER_PATH:-}"
  # Contract-test mode has no installed @knext/core; the preloads are plain
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
log "booting (${RUNTIME}) ${SERVER_BOOT_TARGET} on 0.0.0.0:${PORT} (HOSTNAME emptied — see B7a note; preloads ${SERVER_PRELOAD_ARGS[*]})"
(
  cd "${STANDALONE_APP_DIR}"
  PORT="${PORT}" HOSTNAME="" NODE_ENV="production" \
    NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
    exec "${SERVER_CMD}" "${SERVER_PRELOAD_ARGS[@]}" "${SERVER_BOOT_TARGET}"
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

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
  fi
  echo "SERVER_JS=${SERVER_JS}"
  echo "SERVER_LOG=${SERVER_LOG}"
  echo "BUILD_LOG=${BUILD_LOG}"
} >"${LOG_FILE}"

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

# Returns 0 when SERVER_PID owns a LISTEN socket on PORT, 1 when the port is
# PROVABLY owned by a different pid, 2 when ownership cannot be determined.
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
      if printf '%s\n' "${listeners}" | grep -q "pid=${SERVER_PID},"; then
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
    if lsof -nP -a -p "${SERVER_PID}" -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    # Only trust the negative when the GLOBAL port query positively names a
    # different owner (lsof may be blind to our pid entirely — see above).
    listeners="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -Fp 2>/dev/null | grep '^p' || true)"
    if [ -n "${listeners}" ] && ! printf '%s\n' "${listeners}" | grep -qx "p${SERVER_PID}"; then
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
set +e
port_owned_by_server
OWNS=$?
set -e
if [ "${OWNS}" = "1" ]; then
  log "ERROR: port ${PORT} answers but is NOT owned by server pid ${SERVER_PID} — a sibling process grabbed the freed port (free_port TOCTOU); refusing to advertise it"
  log "---- server log ----"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
elif [ "${OWNS}" = "2" ]; then
  log "WARNING: cannot verify pid ${SERVER_PID} owns port ${PORT} (no tooling, or no positive attribution either way) — proceeding; pid-liveness checks still applied"
fi

log "deployment ready: build=${BUILD_ID} deployment=${DEPLOYMENT_ID} pid=${SERVER_PID}"

# ── 7. the ONLY stdout line: the deployment URL ───────────────────────────────
echo "http://localhost:${PORT}"
