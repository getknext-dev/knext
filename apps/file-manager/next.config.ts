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
  cacheHandler: require.resolve('./cache-handler.js'),
  cacheMaxMemorySize: 0, // disable default in-memory cache, use Redis
  eslint: { ignoreDuringBuilds: true },
  // cacheComponents disabled - using unstable_cache for stable tag-based invalidation
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:8080', 'next-home.default.136.111.227.195.sslip.io'],
    },
  },
  turbopack: {
    resolveAlias: {
      'pino-elasticsearch': './src/mocks/empty.js',
      'thread-stream': './src/mocks/empty.js',
    },
  },
  webpack: (config: any, { isServer }: { isServer: boolean }) => {
    // Definitive bypass for Pino native telemetry modules breaking Turbopack AST parsing
    config.externals.push('pino-elasticsearch', 'thread-stream');
    config.resolve.fallback = {
      ...config.resolve.fallback,
      'pino-elasticsearch': false,
      'thread-stream': false,
    };
    return config;
  },
};

export default nextConfig;
