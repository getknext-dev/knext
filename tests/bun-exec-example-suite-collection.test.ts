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
 * The args `examples/bun-exec`'s own `test` script passes, read from
 * `package.json` rather than hardcoded. Hardcoding `['--config',
 * 'vitest.config.ts']` left a hole: adding `--exclude` to that script orphaned a
 * guard with the config file untouched, while this test stayed green and claimed
 * immunity to exactly that.
 */
function exampleTestScriptArgs(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(EXAMPLE_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.test;
  expect(
    script,
    'examples/bun-exec has no `test` script — this guard cannot evaluate its subject',
  ).toBeTruthy();
  const parts = (script as string).trim().split(/\s+/);
  expect(
    parts[0],
    `the example's \`test\` script is \`${script}\`, which does not start with vitest; this guard ` +
      'reproduces that command and no longer knows how to.',
  ).toBe('vitest');
  // `vitest run …` -> `vitest list …`; keep every remaining flag verbatim.
  return parts.slice(1).filter((p) => p !== 'run');
}

function collectedFiles(cwd: string, args: string[]): string {
  const res = spawnSync('npx', ['vitest', 'list', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, CI: '1' },
  });
  // Unreachable is a FAILURE, never a pass (security.md). A guard that goes
  // green because it could not run its own subject is worse than no guard.
  expect(
    res.status,
    `\`vitest list\` failed in ${cwd} (${res.status}): ${res.stderr?.slice(-600) || res.error?.message}`,
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

describe("examples/bun-exec's guards are actually collected", () => {
  it("the example's own `bun run test` command collects every non-docker test file", () => {
    const listed = collectedFiles(EXAMPLE_DIR, exampleTestScriptArgs());
    const expectedFiles = expectedGuardFiles();
    expect(
      expectedFiles.length,
      'no test files found to check — the scan found nothing',
    ).toBeGreaterThan(0);
    for (const file of expectedFiles) {
      assertCollected(
        listed,
        `test/${file}`,
        `\`${file}\` exists in examples/bun-exec/test/ but \`bun run test\` does not collect it. ` +
          'That command will still exit 0 and the CI job guard will still pass, so nothing notices ' +
          'it stopped running. If it must not run there, give it its own CI job and the ' +
          '`.docker-e2e.test.ts` suffix — that is the one sanctioned way out.',
      );
    }
  });

  it(
    'the ROOT config collects them too — that is the job that actually runs in `Lint & Test`',
    () => {
      const listed = collectedFiles(REPO_ROOT, []);
      const expectedFiles = expectedGuardFiles();
      // Non-vacuity, asserted here too and not only in the sibling: an empty
      // list would make this loop a silent pass.
      expect(
        expectedFiles.length,
        'no test files found to check — the scan found nothing',
      ).toBeGreaterThan(0);
      for (const file of expectedFiles) {
        assertCollected(
          listed,
          `examples/bun-exec/test/${file}`,
          `\`${file}\` is not collected by the ROOT vitest config. The root run is what ` +
            '`Lint & Test` executes, so a guard missing here is unenforced on every PR even while ' +
            "the example's own config still collects it.",
        );
      }
    },
    ROOT_LIST_TIMEOUT_MS,
  );
});
