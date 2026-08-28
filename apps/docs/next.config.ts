import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

/**
 * knext-docs build config.
 *
 * The site builds with **vinext** (see `vite.config.ts`), which reads this file
 * for app-level Next options but runs neither webpack nor turbopack.
 *
 * Three things were removed with the migration off `next build --webpack`, and
 * they are named here so nobody re-adds them expecting an effect:
 *
 *   - `output: 'standalone'` — there is no standalone server any more. The
 *     build emits a Nitro `.output` and `NODE_COMPILE_CACHE` goes with it: the
 *     shared bytecode-cache volume this site was the last consumer of is gone.
 *   - `experimental.adapterPath` — the official Deployment Adapter hooks are a
 *     webpack/turbopack mechanism. vinext never calls them, so pointing at an
 *     adapter here would silently do nothing.
 *   - the `KNEXT_ADAPTER=1` build-target switch — it existed to choose between
 *     a self-host standalone build and a vanilla managed-host build. There is
 *     one build now, so the branch had nothing left to select.
 *
 * `createMDX()` stays. It is fumadocs' own config wrapper; the MDX *loader* for
 * this bundler comes from `fumadocs-mdx/vite` in `vite.config.ts`.
 */
const nextConfig: NextConfig = {
  // Asset prefix is injected by `kn-next deploy` from kn-next.config.ts. Without
  // it a no-storage deployment 404s every static chunk.
  assetPrefix: process.env.ASSET_PREFIX || '',
  // #93 skew protection (ADR-0011): pin every client to the build it loaded.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
  generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null,
};

const withMDX = createMDX();

export default withMDX(nextConfig);
