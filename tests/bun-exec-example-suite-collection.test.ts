import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `tests/bun-exec-hardcap-ci.test.ts` proves CI RUNS `bun run test` in
 * `examples/bun-exec`. On its own that is half a scan: nothing said the suite
 * that command runs still COLLECTS the guards inside it. The realistic
 * regression is not deleting a test — it is one line of config that quietly
 * stops collecting one, while every job keeps exiting 0.
 *
 * ASKS THE RUNNER WHAT IT COLLECTS rather than parsing config text, and asks it
 * with the SAME command `package.json`'s `test` script uses — so a flag added
 * there is covered too, not just a config edit.
 *
 * SCANS rather than enumerates — every `test/*.test.ts` on disk must be
 * collected, so a new guard is covered the moment it exists with no edit here.
 */

const REPO_ROOT = resolve(import.meta.dir ?? new URL('.', import.meta.url).pathname, '..');
const EXAMPLE_DIR = resolve(REPO_ROOT, 'examples/bun-exec');

// The one exclusion that may legitimately hide a file, with the reason it is
// allowed. It compiles a ~100 MB binary and builds a container, and it has its
// own CI job (`bun-exec-alpine-image`) whose existence is asserted by
// tests/bun-exec-alpine-image-ci.test.ts. Anything else must be collected.
const LEGITIMATELY_UNCOLLECTED = /\.docker-e2e\.test\.ts$/;

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
  // stdout, not just stderr: the runner reports per-file FAIL lines and the
  // failing child's error on STDOUT, and the old message printed an empty
  // stderr as "undefined" — three CI rounds of a red with no diagnosis.
  expect(
    res.status,
    `the bun runner failed (${res.status}):\n--- stdout tail ---\n${res.stdout?.slice(-1200)}\n--- stderr tail ---\n${res.stderr?.slice(-600) || res.error?.message}`,
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
 * for two of the files it claimed to protect. The runner prints paths, so
 * matching the path costs nothing and closes it.
 */
function assertCollected(listed: string, relPath: string, why: string) {
  expect(listed.includes(relPath), why).toBe(true);
}

/**
 * Spawns a real `bun run test` in the example, one process per file. It passes
 * alone but exceeds a 5 s default under full-suite parallelism (a CI runner does
 * it cold alongside ~20 parallel suites), so the timeout is budgeted well above
 * that.
 *
 * #871: the example moved from vitest to `bun:test`, and so did this guard. There
 * is now a single runner and a single answer to "what gets collected", so what
 * used to be a two-runner cross-check is one assertion. What it protects did NOT
 * change: a test file that stops being run must fail something.
 */
describe("examples/bun-exec's guards are actually collected", () => {
  // Per-test timeout as the 3rd positional arg — NOT `describe(name, { timeout },
  // fn)`, which bun silently DROPS (tests/bun-ignored-timeout-option.test.ts).
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
  }, 120_000);

  it('the example script and this guard invoke the same runner', () => {
    // Reading the script is what stops the two drifting: if someone points the
    // example at a different command, this fails rather than continuing to
    // verify a runner nobody uses.
    expect(exampleTestScript()).toContain('bun-test.mjs');
  });
});
