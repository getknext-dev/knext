/**
 * GUARD TEST (#147 A3-3 fix round 1 follow-up): onBuildComplete must tolerate
 * BOTH adapter-API ctx shapes.
 *
 * Ground truth (probed against real `next build` runs):
 *  - next v16.0.3 passes `ctx.routes`   { headers, redirects, rewrites:{beforeFiles,
 *    afterFiles, fallback}, dynamicRoutes }
 *  - next v16.2.0 passes `ctx.routing`  { beforeMiddleware, beforeFiles, afterFiles,
 *    dynamicRoutes, onMatch, fallback, shouldNormalizeNextData, rsc } — and
 *    `ctx.routes` is GONE.
 *
 * The adapter's routing DIAGNOSTICS read `routes.headers.length` unconditionally,
 * so on 16.2.0 every fixture build died at onBuildComplete with
 * `TypeError: Cannot read properties of undefined (reading 'headers')` — killing
 * the whole compat run right after the tarball-install fix finally let builds
 * happen. Diagnostics must NEVER crash the build: count whatever shape is present.
 */
import { describe, expect, it } from 'vitest';
import adapter from '../adapters/next-adapter';

/** Minimal outputs common to both API revisions. */
function makeOutputs() {
  return {
    pages: [{ pathname: '/', filePath: '/tmp/x' }],
    pagesApi: [],
    appPages: [],
    appRoutes: [],
    prerenders: [],
    staticFiles: [],
  };
}

function baseCtx() {
  return {
    buildId: 'test-build',
    distDir: '/tmp/dist',
    nextVersion: '0.0.0-test',
    projectDir: '/tmp/app',
    repoRoot: '/tmp/app',
    config: { output: 'standalone' },
    outputs: makeOutputs(),
  };
}

describe('next-adapter onBuildComplete — ctx shape tolerance (#147)', () => {
  it('does not throw on the v16.2.0 shape (ctx.routing present, ctx.routes ABSENT)', async () => {
    const ctx = {
      ...baseCtx(),
      nextVersion: '16.2.0',
      routing: {
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [{}],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc: {},
      },
    };
    // The exact crash of the first real compat builds:
    // TypeError: Cannot read properties of undefined (reading 'headers')
    // biome-ignore lint/suspicious/noExplicitAny: deliberately shape-testing across API revisions
    await expect(adapter.onBuildComplete?.(ctx as any)).resolves.not.toThrow();
  });

  it('still counts the v16.0.3 shape (ctx.routes present)', async () => {
    const ctx = {
      ...baseCtx(),
      nextVersion: '16.0.3',
      routes: {
        headers: [],
        redirects: [{}],
        rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
        dynamicRoutes: [],
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: deliberately shape-testing across API revisions
    await expect(adapter.onBuildComplete?.(ctx as any)).resolves.not.toThrow();
  });

  it('does not throw even when NEITHER routes nor routing is present (diagnostics never kill a build)', async () => {
    const ctx = baseCtx();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately shape-testing across API revisions
    await expect(adapter.onBuildComplete?.(ctx as any)).resolves.not.toThrow();
  });
});
