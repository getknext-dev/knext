import path from 'node:path';

/**
 * POC-ADAPTER-P0: register the minimal NextAdapter spike via adapterPath.
 * The adapter fires modifyConfig + onBuildComplete during `next build`.
 * vinext is still present in this phase; it will be removed in P1.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Asset prefix is injected by kn-next deploy from kn-next.config.ts storage settings.
  // In dev mode (next dev), ASSET_PREFIX is unset → assets serve locally.
  assetPrefix: process.env.ASSET_PREFIX || '',
  output: 'standalone',
  // Ensure native node modules are traced into standalone output (not bundled by webpack)
  serverExternalPackages: ['ioredis', 'pino', 'thread-stream', 'pino-elasticsearch'],
  // Redis-backed cache handler for Knative (multi-pod consistency)
  // Handler gracefully falls back to in-memory when REDIS_URL is not set
  cacheHandler: path.resolve(process.cwd(), 'cache-handler.js'),
  cacheMaxMemorySize: 0, // disable default in-memory cache, use Redis
  // POC-ADAPTER-P0 spike: skip type errors that surface with plain `next build`
  // (the app normally builds via vinext/vite which handles types differently).
  // Remove this in P1 once the full migration is done.
  typescript: { ignoreBuildErrors: true },
  // cacheComponents disabled - using unstable_cache for stable tag-based invalidation
  experimental: {
    // POC-ADAPTER-P0: register the minimal NextAdapter spike.
    // adapterPath lives under experimental in Next.js 16.x.
    adapterPath: path.resolve(import.meta.dirname, 'next-adapter.ts'),
    serverActions: {
      allowedOrigins: ['localhost:8080', 'next-home.default.136.111.227.195.sslip.io'],
    },
  },
};

export default nextConfig;
