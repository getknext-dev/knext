import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * POC-ADAPTER-P1: vinext/vite removed; plain `next build` → standalone.
 * Node 20+ cold-start optimisation: run server.js with NODE_COMPILE_CACHE.
 */
const nextConfig: NextConfig = {
  // Asset prefix is injected by kn-next deploy from kn-next.config.ts storage settings.
  // In dev mode (next dev), ASSET_PREFIX is unset → assets serve locally.
  assetPrefix: process.env.ASSET_PREFIX || '',
  output: 'standalone',
  // Ensure native node modules are traced into standalone output (not bundled).
  // pino-elasticsearch and thread-stream are excluded here to avoid Turbopack
  // bundling their test files (pre-existing upstream issue).
  serverExternalPackages: ['ioredis', 'pino', 'pino-pretty', 'thread-stream', 'pino-elasticsearch'],
  // Redis-backed cache handler for Knative (multi-pod consistency).
  // Handler gracefully falls back to in-memory when REDIS_URL is not set.
  cacheHandler: path.resolve(import.meta.dirname, 'cache-handler.js'),
  cacheMaxMemorySize: 0, // disable default in-memory cache, use Redis
  experimental: {
    // NextAdapter wired in P0; kept here for onBuildComplete reporting.
    adapterPath: path.resolve(import.meta.dirname, 'next-adapter.ts'),
    serverActions: {
      allowedOrigins: ['localhost:8080', 'next-home.default.136.111.227.195.sslip.io'],
    },
  },
  // NOTE (POC-ADAPTER-P1): Turbopack (Next 16 default) has an upstream bug where
  // it processes test files inside packages listed in serverExternalPackages
  // (specifically thread-stream/test/*.{js,mjs} and pino-elasticsearch's transitive
  // deps). The build script uses `next build --webpack` to bypass this until the
  // Turbopack issue is resolved upstream. Turbopack aliases were attempted but do
  // not prevent the root cause (Turbopack entering node_modules even for externals).
  // Track: github.com/vercel/next.js Turbopack + serverExternalPackages.
};

export default nextConfig;
