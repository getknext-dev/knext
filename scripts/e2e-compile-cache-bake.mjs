#!/usr/bin/env node
/**
 * e2e-compile-cache-bake — populate a V8 compile cache for a standalone
 * server's framework graph BEFORE the official-suite harness boots it (node
 * lane only, called by scripts/e2e-deploy.sh).
 *
 * WHY. Bytecode caching is mandatory in every runtime×builder cell, and a cell
 * may only credential on nights where caching is proven LIVE at runtime. On a
 * node cell "live" means the booted server's V8 accepted cached code — which
 * is impossible on a first boot against an empty cache. The shipped images
 * bake the cache at `docker build`; this is the harness's analog, so the
 * suite's boot is a CACHED boot like the one users get, and
 * `e2e-bytecode-evidence.mjs` can count the hits.
 *
 * WHAT IT LOADS — framework modules only, never the fixture's own code.
 * `server.js` itself is NOT required: requiring it starts the server, which
 * would run the fixture's instrumentation / pages a second time, outside the
 * test's view, and could seed its ISR / data cache before the test ever sends
 * a request. The two modules `server.js` requires (`next`, and
 * `next/dist/server/lib/start-server`) are REQUIRED — failing to load either
 * exits 1 and fails the deploy (fail closed). The rest of the list is the
 * request-path framework graph and is best-effort, so a Next.js refactor that
 * moves one of them degrades the hit count (which the evidence floor then
 * judges) rather than bricking every deploy.
 *
 * Contract: NODE_COMPILE_CACHE must be set (by the caller) to the directory
 * the server will boot with, and this process must run as the SAME uid —
 * Node keys the cache subdirectory by uid.
 *
 * Usage: node scripts/e2e-compile-cache-bake.mjs <path/to/server.js>
 * Exit 0 once the cache is flushed to disk; exit 1 on any required failure.
 */

import { createRequire, flushCompileCache, getCompileCacheDir } from 'node:module';

/** The modules server.js itself requires. A miss is a hard failure. */
export const REQUIRED_MODULES = Object.freeze(['next', 'next/dist/server/lib/start-server']);

/** The request-path framework graph. A miss is logged, not fatal. */
export const BEST_EFFORT_MODULES = Object.freeze([
  'next/dist/server/lib/router-server',
  'next/dist/server/next-server',
  'next/dist/server/base-server',
  'next/dist/server/route-modules/app-page/module.compiled',
  'next/dist/server/route-modules/pages/module.compiled',
]);

function main(argv) {
  const serverJs = argv[0];
  if (!serverJs) {
    console.error('[e2e-compile-cache-bake] usage: e2e-compile-cache-bake.mjs <server.js>');
    return 1;
  }
  if (!process.env.NODE_COMPILE_CACHE) {
    console.error('[e2e-compile-cache-bake] NODE_COMPILE_CACHE is not set — nothing to bake into');
    return 1;
  }
  const dir = getCompileCacheDir?.();
  if (!dir) {
    console.error(
      `[e2e-compile-cache-bake] the runtime refused NODE_COMPILE_CACHE=${process.env.NODE_COMPILE_CACHE} (getCompileCacheDir() is empty) — the cache cannot be live`,
    );
    return 1;
  }
  const req = createRequire(serverJs);
  for (const id of REQUIRED_MODULES) {
    try {
      req(id);
    } catch (err) {
      console.error(
        `[e2e-compile-cache-bake] required module ${id} failed to load from ${serverJs}: ${err?.message ?? err}`,
      );
      return 1;
    }
  }
  let loaded = REQUIRED_MODULES.length;
  for (const id of BEST_EFFORT_MODULES) {
    try {
      req(id);
      loaded += 1;
    } catch (err) {
      console.error(
        `[e2e-compile-cache-bake] (best-effort) ${id} not loaded: ${err?.message ?? err}`,
      );
    }
  }
  flushCompileCache?.();
  console.error(`[e2e-compile-cache-bake] baked ${loaded} entry module graph(s) into ${dir}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // process.exit, not a natural return: an explicit exit is what guarantees the
  // 'exit'-hooked flush even if a loaded module left a handle open.
  process.exit(main(process.argv.slice(2)));
}
