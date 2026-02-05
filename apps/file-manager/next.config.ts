/** @type {import('next').NextConfig} */
const nextConfig = {
  assetPrefix: 'https://storage.googleapis.com/knative-next-assets-banna',
  output: 'standalone',
  // cacheComponents disabled - using unstable_cache for stable tag-based invalidation
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:8080', 'next-home.default.136.111.227.195.sslip.io'],
    },
  },
};

export default nextConfig;
