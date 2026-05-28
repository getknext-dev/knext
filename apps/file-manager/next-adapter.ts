/**
 * POC-ADAPTER-P0 — Minimal NextAdapter spike for apps/file-manager.
 *
 * Purpose: prove the official Next.js Adapter API wiring (adapterPath in
 * next.config) fires end-to-end without touching the vinext pipeline.
 *
 * Scope (this file):
 *  - modifyConfig: guard on phase-production-build, force output:'standalone'
 *  - onBuildComplete: pretty-print output counts and build metadata
 *
 * Out of scope: request routing, bun --compile, operator changes.
 */
import type { NextAdapter } from 'next';

const adapter: NextAdapter = {
  name: 'knext-poc-adapter',

  modifyConfig(config, { phase }) {
    if (phase !== 'phase-production-build') {
      return config;
    }

    console.log('[knext-poc-adapter] modifyConfig fired for phase-production-build');

    // Ensure standalone output is set (already set in next.config.ts but we
    // enforce it here so the adapter is self-contained in later phases).
    return {
      ...config,
      output: 'standalone',
    };
  },

  onBuildComplete(ctx) {
    const { buildId, distDir, nextVersion, outputs } = ctx;

    const counts = {
      pages: outputs.pages.length,
      appPages: outputs.appPages.length,
      appRoutes: outputs.appRoutes.length,
      pagesApi: outputs.pagesApi.length,
      prerenders: outputs.prerenders.length,
      staticFiles: outputs.staticFiles.length,
      middleware: outputs.middleware ? 1 : 0,
    };

    const { routes } = ctx;
    const routingCounts = {
      headers: routes.headers.length,
      redirects: routes.redirects.length,
      rewritesBeforeFiles: routes.rewrites.beforeFiles.length,
      rewritesAfterFiles: routes.rewrites.afterFiles.length,
      rewritesFallback: routes.rewrites.fallback.length,
      dynamicRoutes: routes.dynamicRoutes.length,
    };

    console.log('[knext-poc-adapter] onBuildComplete fired');
    console.log(`  buildId      : ${buildId}`);
    console.log(`  distDir      : ${distDir}`);
    console.log(`  nextVersion  : ${nextVersion}`);
    console.log(`  output.output: ${ctx.config.output ?? 'not set'}`);
    console.log(`  cacheHandler : ${String(ctx.config.cacheHandler ?? 'not set')}`);
    console.log('  output counts:');
    for (const [key, count] of Object.entries(counts)) {
      console.log(`    ${key.padEnd(22)}: ${count}`);
    }
    console.log('  routing counts (ctx.routes):');
    for (const [key, count] of Object.entries(routingCounts)) {
      console.log(`    ${key.padEnd(22)}: ${count}`);
    }
  },
};

export default adapter;
