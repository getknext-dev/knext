import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `tests/bun-exec-hardcap-ci.test.ts` proves CI RUNS `bun run test` in
 * `examples/bun-exec`. On its own that is half a scan: nothing said the suite
 * that command runs still COLLECTS the guards inside it. The realistic
 * regression is not deleting a test — it is one line of config that quietly
 * stops collecting one, while every job keeps exiting 0.
 *
 * ASKS VITEST WHAT IT COLLECTS rather than parsing config text, and asks it with
 * the SAME arguments `package.json`'s `test` script uses — so a flag added there
 * is covered too, not just a config edit. A first version regexed the first
 * `exclude:` array it found and was fooled by a `coverage: { exclude: [...] }`
 * block placed above `test.exclude`.
 *
 * SCANS rather than enumerates — every `test/*.test.ts` on disk must be
 * collected, so a new guard is covered the moment it exists with no edit here.
 */

const REPO_ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');
const EXAMPLE_DIR = resolve(REPO_ROOT, 'examples/bun-exec');

// The one exclusion that may legitimately hide a file, with the reason it is
// allowed. It compiles a ~100 MB binary and builds a container, and it has its
// own CI job (`bun-exec-alpine-image`) whose existence is asserted by
// tests/bun-exec-alpine-image-ci.test.ts. Anything else must be collected.
const LEGITIMATELY_UNCOLLECTED = /\.docker-e2e\.test\.ts$/;

/**
 * `vitest list` over the whole repo takes ~30 s warm; vitest's 5 s default turned
 * the root check into a timeout rather than a verdict. Budgeted well above that
 * because a CI runner does it cold alongside ~20 parallel suites, and a timeout
 * there would read as a defect rather than as an environment fact.
 *
 * Named rather than inlined as a literal with a trailing comment: biome's
 * formatter twice reordered such a comment into a single mangled line, and the
 * second time it was the only error-level diagnostic in the repo — i.e. it broke
 * `Lint & Test` before any test ran.
 */
const ROOT_LIST_TIMEOUT_MS = 600_000;

/**
 * The example's `test` script, read from `package.json` rather than hardcoded.
 *
 * Hardcoding the command left a hole once before: adding a flag to that script
 * orphaned a guard with the config file untouched, while this test stayed green
 * and claimed immunity to exactly that.
 */
function exampleTestScript(): string {
  const pkg = JSON.parse(readFileSync(resolve(EXAMPLE_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.test;
  expect(
    script,
    'examples/bun-exec has no `test` script — this guard cannot evaluate its subject',
  ).toBeTruthy();
  expect(
    script,
    `the example's \`test\` script is \`${script}\`, which does not invoke the bun runner; ` +
      'this guard reproduces that command and no longer knows how to.',
  ).toContain('bun-test.mjs');
  return script as string;
}

function collectedFiles(): string {
  // The bun runner prints one `ok`/`FAIL` line per file it ran, so its own
  // output IS the collection list. Asking it what it ran beats maintaining a
  // second idea of what it should run.
  const res = spawnSync('node', [resolve(REPO_ROOT, 'scripts/bun-test.mjs'), 'examples/bun-exec'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, CI: '1' },
  });
  // Unreachable is a FAILURE, never a pass (security.md). A guard that goes
  // green because it could not run its own subject is worse than no guard.
  expect(
    res.status,
    `the bun runner failed (${res.status}): ${res.stderr?.slice(-600) || res.error?.message}`,
  ).toBe(0);
  return res.stdout;
}

function expectedGuardFiles(): string[] {
  return readdirSync(resolve(EXAMPLE_DIR, 'test'))
    .filter((f) => f.endsWith('.test.ts') && !LEGITIMATELY_UNCOLLECTED.test(f))
    .sort();
}

/**
 * Match the repo-relative PATH, never the bare basename.
 *
 * `toContain('ports.test.ts')` passed on `apps/file-manager/child-ports.test.ts`
 * and `tests/e2e-ephemeral-ports.test.ts`, so the root assertion was fail-open
 * for two of the files it claimed to protect. `vitest list` prints paths, so
 * matching the path costs nothing and closes it.
 */
function assertCollected(listed: string, relPath: string, why: string) {
  expect(listed.includes(relPath), why).toBe(true);
}

// Spawns a real `bun run test` in the example. Same story: passes alone,
// exceeds 5s under full-suite parallelism.
describe("examples/bun-exec's guards are actually collected", { timeout: 120_000 }, () => {
  /**
   * The example moved from vitest to `bun:test` (#871), so the runner this
   * guard reproduces changed. What it protects did NOT: a test file that stops
   * being run must fail something.
   *
   * The old version asserted collection by BOTH the example's own vitest config
   * and the root one. There is now a single runner and a single answer, so the
   * two assertions collapse into one — and the root vitest config's job here is
   * the opposite: to EXCLUDE these files, since a `bun:test` import cannot run
   * under vitest at all. That exclusion is asserted below, because an exclude
   * pattern is precisely how a suite gets silently dropped.
   */
  it('the bun runner runs every non-docker test file in the example', () => {
    const listed = collectedFiles();
    const expectedFiles = expectedGuardFiles();
    expect(
      expectedFiles.length,
      'no test files found to check — the scan found nothing',
    ).toBeGreaterThan(0);
    for (const file of expectedFiles) {
      assertCollected(
        listed,
        `examples/bun-exec/test/${file}`,
        `\`${file}\` exists in examples/bun-exec/test/ but the bun runner does not run it. ` +
          'Nothing else notices: the runner still exits 0 and the CI job guard still passes. ' +
          'If it must not run there, give it its own CI job and the `.docker-e2e.test.ts` ' +
          'suffix — that is the one sanctioned way out.',
      );
    }
  });

  it('the example script and this guard invoke the same runner', () => {
    // Reading the script is what stops the two drifting: if someone points the
    // example at a different command, this fails rather than continuing to
    // verify a runner nobody uses.
    expect(exampleTestScript()).toContain('bun-test.mjs');
  });

  it('the ROOT vitest run does NOT collect the example', () => {
    // The other half. These files import `bun:test`, which vitest cannot run,
    // so the root suite only passes if they are excluded.
    //
    // Asserted BEHAVIOURALLY — by asking vitest what it collects — not by
    // grepping the config for a literal. The exclusion used to be a hardcoded
    // glob and is now derived by scanning for `bun:test` imports; a textual
    // assertion would have failed on that refactor while the property it cares
    // about was still perfectly true.
    const res = spawnSync('npx', ['vitest', 'list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, CI: '1' },
    });
    expect(res.status, `\`vitest list\` failed (${res.status}): ${res.stderr?.slice(-400)}`).toBe(
      0,
    );
    // Match the FILE column only, never the whole line. `vitest list` prints
    // `<file> > <suite> > <test>`, and two other guards in this repo carry the
    // example's paths inside their test NAMES — so a whole-line `toContain`
    // matches them and this assertion passes, or fails, for reasons that have
    // nothing to do with what vitest collected. The same fail-open shape as the
    // basename-vs-path note on `assertCollected` above.
    const collectedFiles = new Set(
      res.stdout
        .split('\n')
        .map((line) => line.split(' > ')[0]?.trim())
        .filter(Boolean),
    );
    expect([...collectedFiles].filter((f) => f?.startsWith('examples/bun-exec/'))).toEqual([]);
    // Non-vacuity: the parse must actually be finding files, or the assertion
    // above is satisfied by an empty set.
    expect(collectedFiles.size).toBeGreaterThan(50);
  });
});
