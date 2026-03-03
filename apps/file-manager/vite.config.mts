import { defineConfig } from 'vite';
import { vinext } from 'vinext';

export default defineConfig({
  base: process.env.ASSET_PREFIX || '/',
  plugins: [vinext({ cacheHandler: './cache-handler.js' })],
  resolve: {
    alias: {
      'pino-elasticsearch': './src/mocks/empty.js',
      'thread-stream': './src/mocks/empty.js',
    },
  },
});
