import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Resolve @knext/lib subpaths to source (not dist) in tests.
// CI runs `pnpm install` then `vitest` without building lib first, so dist/ is absent.
// This alias is test-only: `next build` and the standalone runtime still use real dist.
const LIB_SRC = resolve(import.meta.dirname, 'packages/lib/src');
// Same rationale for @knext/db — the apps/db-demo example's unit test imports the
// SDK before any dist exists (clean-from-root run). Test-only; the real build uses dist.
const DB_SRC = resolve(import.meta.dirname, 'packages/db/src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@knext/lib/clients': resolve(LIB_SRC, 'clients.ts'),
      '@knext/lib/context': resolve(LIB_SRC, 'context/index.ts'),
      '@knext/lib/health': resolve(LIB_SRC, 'health/index.ts'),
      '@knext/lib/logger': resolve(LIB_SRC, 'logger/index.ts'),
      '@knext/lib': resolve(LIB_SRC, 'index.ts'),
      '@knext/db/schema': resolve(DB_SRC, 'schema.ts'),
      '@knext/db/migrate': resolve(DB_SRC, 'migrate.ts'),
      '@knext/db': resolve(DB_SRC, 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
