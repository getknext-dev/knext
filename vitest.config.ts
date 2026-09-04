import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { COVERAGE_EXCLUDE, COVERAGE_INCLUDE } from './scripts/lib/coverage-policy.mjs';
import { importsFrom } from './scripts/lib/test-framework-import.mjs';

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

/**
 * Every test file that has been ported to `bun:test`, DERIVED by reading them.
 *
 * A file importing `bun:test` cannot run under vitest, and one importing
 * `vitest` cannot run under bun — so during the migration (#871) the two runners
 * must partition the suite exactly. That partition used to be a hand-maintained
 * list of package globs, which forced an all-or-nothing move: a package with
 * fourteen converted files and two hard ones was green under neither runner,
 * because the glob could only include or exclude the whole directory.
 *
 * Scanning removes the list and the constraint together. A file excludes itself
 * the moment it is converted, so a package can migrate one file at a time, and
 * there is no second place to update — which is where an enumerated list drifts.
 * When the migration finishes this returns every test file and the config goes
 * away entirely.
 *
 * `git ls-files` rather than a directory walk: it already ignores build output
 * and stray worktrees, which is what a walk would have to re-learn.
 */
function portedToBun(): string[] {
  const files = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  return files.filter((f) => {
    try {
      // ONE definition of the partition, shared with `scripts/bun-test.mjs` and
      // `tests/runner-partition.test.ts`. Neither a raw scan nor a blanked scan
      // works — see the note in `test-framework-import.mjs`; the first lets a
      // fixture string orphan a file, the second never matches at all because a
      // module specifier IS a string.
      return importsFrom(readFileSync(f, 'utf8'), 'bun:test');
    } catch {
      // Unreadable means we cannot tell which runner owns it. Leaving it IN
      // vitest fails loudly if it is a bun file; excluding it would drop the
      // file from both runners silently, which is the worse error.
      return false;
    }
  });
}

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
      ...portedToBun(),
    ],
    coverage: {
      provider: 'v8',
      // `lcov` is what the merged gate reads. This run supplies the honest
      // DENOMINATOR — every `include` match enumerated, untouched files at 0% —
      // while `scripts/bun-test.mjs` supplies almost all of the numerator.
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'html', 'lcov'],
      // Honest denominator: an explicit `include` makes Vitest count every
      // matching source file, not only the ones a test happens to import — so
      // adding an untested file can no longer silently RAISE the percentage.
      // (Vitest 4 measures all `include` matches by default; the v3 `all` flag
      // was removed.)
      //
      // Shared with `scripts/check-coverage.mjs` so the two halves of the gate
      // cannot drift into two different denominators.
      include: COVERAGE_INCLUDE,
      exclude: [...(configDefaults.coverage.exclude ?? []), ...COVERAGE_EXCLUDE],
      // NO `thresholds:` here — deliberately (#884).
      //
      // After the bun migration this run collects 3 test files out of 338, so
      // its numerator is a rounding error while its denominator is the whole
      // tree: the floors were being checked against 1.37%. They now live in
      // `scripts/lib/coverage-policy.mjs` and are enforced by
      // `node scripts/check-coverage.mjs`, over the MERGE of this report and the
      // ~338 per-file reports from `scripts/bun-test.mjs --coverage`.
      //
      // `tests/coverage-gate.test.ts` fails if a `thresholds:` block reappears
      // here — two copies of a floor means one is wrong and nothing says which.
    },
  },
});
