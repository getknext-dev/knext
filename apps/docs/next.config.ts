import path from 'node:path';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

/**
 * knext-docs build config.
 *
 * Build-target switch: the site is BUILT to run on knext (the dogfood target),
 * but it must also build as a plain Next.js app on a managed host (e.g. Vercel)
 * while the self-host cluster + the @knext/core npm publish (#53) are pending.
 *
 *   KNEXT_ADAPTER=1 → standalone output + the official knext adapter (self-host)
 *   unset (default, incl. Vercel) → a vanilla Next.js build the platform handles
 *
 * No `cacheHandler` — the docs site is fully static/SSG (no Redis / ISR needs).
 */
const useKnextAdapter = process.env.KNEXT_ADAPTER === '1';

// Self-host-only additions. `experimental.adapterPath` is the official-adapter hook
// in the knext-target Next (16.0.x); the docs build pins a newer patched Next (for
// the Vercel CVE gate) whose published types drop that key, so this dead-on-Vercel
// branch is cast. When actually dogfooding on knext, align the Next version with the
// adapter API.
const knextAdapterConfig = {
  // Asset prefix is injected by `kn-next deploy` from kn-next.config.ts.
  assetPrefix: process.env.ASSET_PREFIX || '',
  output: 'standalone',
  experimental: {
    adapterPath: path.resolve(import.meta.dirname, 'next-adapter.ts'),
  },
} as unknown as NextConfig;

const nextConfig: NextConfig = {
  // #93 skew protection (ADR-0011): pin every client to the build it loaded.
  // Harmless on a managed host (env unset → undefined / Next's default build id).
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
  generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null,
  ...(useKnextAdapter ? knextAdapterConfig : {}),
};

const withMDX = createMDX();

export default withMDX(nextConfig);
