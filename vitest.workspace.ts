import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      include: ['packages/**/*.{test,spec}.{ts,tsx}'],
      name: 'packages',
      environment: 'happy-dom',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      include: ['apps/**/*.{test,spec}.{ts,tsx}'],
      name: 'apps',
      environment: 'happy-dom',
    },
  },
]);
