import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

// Resolve @getknext/lib subpaths to source (not dist) in tests.
// CI runs `pnpm install` then `vitest` without building lib first, so dist/ is absent.
// This alias is test-only: `next build` and the standalone runtime still use real dist.
const LIB_SRC = resolve(import.meta.dirname, 'packages/lib/src');
// Same rationale for @getknext/db — the apps/db-demo example's unit test imports the
// SDK before any dist exists (clean-from-root run). Test-only; the real build uses dist.
const DB_SRC = resolve(import.meta.dirname, 'packages/db/src');
// Same rationale for the pure `@getknext/core/validate` surface — the docs
// config-quality gate (apps/docs/scripts/config.test.ts) imports validateConfig
// before any @getknext/core dist exists on a clean run, so resolve it to source.
// Only the pure validate subpath is aliased (never bare `@getknext/core`, whose
// many dist subpaths must keep resolving normally). The dist-surface contract
// tests read dist by path, so they are unaffected.
const CORE_SRC = resolve(import.meta.dirname, 'packages/kn-next/src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@getknext/lib/clients': resolve(LIB_SRC, 'clients.ts'),
      '@getknext/lib/context': resolve(LIB_SRC, 'context/index.ts'),
      '@getknext/lib/health': resolve(LIB_SRC, 'health/index.ts'),
      '@getknext/lib/logger': resolve(LIB_SRC, 'logger/index.ts'),
      '@getknext/lib': resolve(LIB_SRC, 'index.ts'),
      '@getknext/db/schema': resolve(DB_SRC, 'schema.ts'),
      '@getknext/db/migrate': resolve(DB_SRC, 'migrate.ts'),
      '@getknext/db': resolve(DB_SRC, 'index.ts'),
      '@getknext/core/validate': resolve(CORE_SRC, 'validate-public.ts'),
      // The bare `server-only` specifier is provided by the Next compiler at
      // build time (next/dist/compiled/server-only) and is not resolvable at the
      // repo root. Alias it to a no-op stub so server-only modules (e.g. the
      // observability Prometheus client) can be unit-tested. Test-only; the real
      // server-only guard still applies under `next build`.
      'server-only': resolve(import.meta.dirname, 'vitest.server-only-stub.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    // Absolute so a project run from a sub-directory (e.g. `cd apps/docs &&
    // vitest`) still resolves the setup file, not a non-existent CWD-relative one.
    setupFiles: [resolve(import.meta.dirname, 'vitest.setup.ts')],
    // Never collect tests from throwaway agent git worktrees under .claude/ — they
    // are stale full-repo copies (often without node_modules) that pollute the run
    // with duplicate + resolve-error "failures". Preserve vitest's own defaults.
    //
    // `*.docker-e2e.test.ts` — suites that build and run a CONTAINER, and that
    // deliberately have no skip path (a missing docker or bun FAILS, per #408 /
    // #448). This root run is `Lint & Test`, which installs node+pnpm and no
    // bun/docker, so collecting one here reddens the main gate for a reason that
    // has nothing to do with the change under test. A per-example
    // `vitest.config.ts` exclude does NOT cover this: it only applies when
    // vitest runs with that example as its cwd, and this run collects
    // `examples/**` from the repo root.
    //
    // Excluded by PATTERN, not by filename, so a future container e2e is covered
    // the moment it is named — and the suites this pattern hides still run, in
    // their own jobs (`bun-exec-alpine-image` runs `bun run test:image`).
    // `tests/bun-exec-alpine-image-ci.test.ts` asserts this entry is here.
    // PORTED-TO-BUN exclusions. These packages now import `bun:test`, which
    // vitest cannot run, so they are excluded here and covered by
    // `node scripts/bun-test.mjs` instead. The list shrinks vitest's scope one
    // package at a time and reaches zero when the migration finishes — at which
    // point this config goes away entirely.
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/**',
      '**/*.docker-e2e.test.ts',
      'packages/db/**',
      'packages/ui/**',
      'examples/bun-exec/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'html'],
      // Honest denominator: an explicit `include` makes Vitest count every
      // matching source file, not only the ones a test happens to import — so
      // adding an untested file can no longer silently RAISE the percentage.
      // (Vitest 4 measures all `include` matches by default; the v3 `all` flag
      // was removed.)
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
        // Untracked local cruft (0 tracked files in git) — never repo code.
        '**/packages/admin/**',
        '**/packages/knext/**',
        // Tests, type-only decls, and generated/index barrels carry no logic to cover.
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/__tests__/**',
        '**/__mocks__/**',
        '**/*.config.{ts,js,mjs}',
      ],
      // Regression ratchet: floors set just below the measured baseline
      // (@getknext/core ~78% lines / ~72% branches on 2026-07-24; lib/db/ui already
      // >90%). CI fails if coverage drops below these — they are RAISED toward 90
      // as the @getknext/core coverage push lands. See docs/benchmarks/coverage-baseline.md.
      thresholds: {
        statements: 77,
        branches: 70,
        functions: 74,
        lines: 77,
        // Per-package floor for @getknext/core (packages/kn-next). The @getknext/core
        // coverage push (2026-07) raised its lines to ~90% (from ~78%); this glob
        // threshold pins that per-package so the aggregate ratchet above can no
        // longer mask a regression in this one package (reviewers flagged
        // aggregate-only thresholds). Floors sit at/just below the measured
        // achieved numbers — lines 90.1 / statements 89.4 / functions 87.5 /
        // branches 82.8 — so CI fails on any drop below these without red-lining
        // the current state. node-server.ts (the spawn+sidecar runtime entry) is
        // the remaining 0%-covered residual; see the coverage report.
        'packages/kn-next/src/**': {
          lines: 90,
          statements: 88,
          functions: 87,
          branches: 80,
        },
      },
    },
  },
});
