import { defineConfig } from 'vitest/config';

// Dedicated Vitest config with NO plugins. Vitest otherwise auto-loads
// `vite.config.ts` (vinext + nitro), whose RSC/cache-handler transforms fail
// under the test runner ("Expected identifier but found \"typeof\"" from
// vinext/shims/cache-handler) — that is a BUILD-time config, not a test config.
// The RuntimeContract tests exercise pure `runtime-contract.mjs` + a real-sockets
// bun harness; they need no build plugins. Keeping this file plugin-free lets the
// documented `bun run test` / `vitest run` command run green.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The alpine image e2e compiles a ~100 MB binary and builds+runs a
    // container; it belongs to `bun run test:image` (vitest.image.config.ts),
    // not to this fast suite. Excluded here, NOT disabled — it has no skip path
    // and its own CI job runs it.
    exclude: ['test/alpine-image-e2e.test.ts', '**/node_modules/**'],
  },
});
