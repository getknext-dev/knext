import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  images: {
    qualities: [20, 75],
  },
};

export default config;
