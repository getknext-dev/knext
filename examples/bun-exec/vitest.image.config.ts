import { defineConfig } from 'vitest/config';

// The docker/image e2e ONLY (`bun run test:image`). Split out of
// `vitest.config.ts` because it compiles a ~100 MB binary and builds+runs a
// container — minutes, not milliseconds — so it must not ride the fast suite
// the `bun-exec-hardcap` CI job runs.
//
// Splitting it out is NOT a way to make it optional: `test/alpine-image-e2e.test.ts`
// has no skip path (a missing docker or bun FAILS), and the
// `bun-exec-alpine-image` CI job runs this config on every push. That job's
// existence is itself guarded by `tests/bun-exec-alpine-image-ci.test.ts`.
//
// Plugin-free for the same reason `vitest.config.ts` is: Vitest would otherwise
// auto-load `vite.config.ts` (vinext + nitro), whose RSC transforms fail under
// the test runner.
export default defineConfig({
  test: {
    // The `*.docker-e2e.test.ts` convention, matched here and EXCLUDED by both
    // the example's fast config and the ROOT config. One pattern, three places,
    // so a new container e2e lands in the right runner by name alone. If the
    // pattern matched nothing, vitest exits 1 — the suite cannot silently
    // vanish, and `tests/bun-exec-alpine-image-ci.test.ts` asserts a file
    // matching it actually exists.
    include: ['test/**/*.docker-e2e.test.ts'],
    // One container, one set of ports, one docker daemon.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 900_000,
  },
});
