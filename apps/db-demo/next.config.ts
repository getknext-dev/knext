import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone output is what `kn-next deploy` packages into the app image.
  output: 'standalone',
};

export default nextConfig;
