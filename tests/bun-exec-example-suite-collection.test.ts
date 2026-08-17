import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `tests/bun-exec-hardcap-ci.test.ts` proves CI RUNS `bun run test` in
 * `examples/bun-exec`. On its own that is half a scan: nothing said the suite
 * that command runs still COLLECTS the guards inside it. The realistic
 * regression is not deleting a test — it is one line of config that quietly
 * stops collecting one, while every job keeps exiting 0.
 *
 * ASKS VITEST WHAT IT COLLECTS rather than parsing config text. A first version
 * regexed the first `exclude:` array it found, and the system-designer gate
 * found three ways past it, all fail-OPEN:
 *   (a) a `coverage: { exclude: [...] }` block added above `test.exclude` — an
 *       ordinary vitest edit — made it validate the wrong array and pass;
 *   (b) a `--exclude` or `--config` flag added to package.json's `test` script
 *       orphaned a guard with the config file untouched;
 *   (c) it only ever looked at the example's config, while the ROOT config is
 *       what collects these files in the `Lint & Test` job.
 * `vitest list` is immune to all three: it is the resolved collection, after
 * every config layer, plugin and CLI flag.
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
 * Files the ROOT run legitimately does not LIST, with the mechanism that keeps
 * them enforced elsewhere. `vitest list` prints test cases, so a file whose only
 * `describe` is conditionally skipped emits no lines even though the file is
 * collected — which is indistinguishable from being excluded unless it is
 * modelled, as here.
 *
 * Membership is not a free pass: each entry must name a CI job AND the
 * fail-closed switch that stops the skip being silent there.
 */
const ROOT_UNLISTED = new Map([
  [
    'sigterm-hardcap-e2e.test.ts',
    'describe.skipIf(!bunAvailable), and the root Lint & Test job has no bun on PATH. Enforced by ' +
      'the dedicated `bun-exec-hardcap` job, which sets KNEXT_REQUIRE_BUN=1 — that converts "bun ' +
      'is missing" from a silent skip into a thrown error, and tests/bun-exec-hardcap-ci.test.ts ' +
      'asserts that env var is present on that job.',
  ],
]);

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

describe("examples/bun-exec's guards are actually collected", () => {
  it("the example's own `bun run test` config collects every non-docker test file", () => {
    const listed = collectedFiles(EXAMPLE_DIR, ['--config', 'vitest.config.ts']);
    const expectedFiles = expectedGuardFiles();
    expect(
      expectedFiles.length,
      'no test files found to check — the scan found nothing',
    ).toBeGreaterThan(0);
    for (const file of expectedFiles) {
      expect(
        listed,
        `\`${file}\` exists in examples/bun-exec/test/ but the example's vitest config does not ` +
          'collect it. `bun run test` will still exit 0 and the CI job guard will still pass, so ' +
          'nothing notices it stopped running. If it must not run there, give it its own CI job ' +
          'and the `.docker-e2e.test.ts` suffix — that is the one sanctioned way out.',
      ).toContain(file);
    }
  });

  it('the ROOT config collects them too — that is the job that actually runs in `Lint & Test`', () => {
    const listed = collectedFiles(REPO_ROOT, []);
    for (const file of expectedGuardFiles()) {
      const reason = ROOT_UNLISTED.get(file);
      if (reason) {
        // Not a free pass: the file must still be collected SOMEWHERE with a
        // fail-closed mechanism, which the reason names and a sibling test asserts.
        expect(reason, `${file} is allow-listed with an empty reason`).toMatch(/\S/);
        continue;
      }
      expect(
        listed,
        `\`${file}\` is not collected by the ROOT vitest config. The root run is what ` +
          '`Lint & Test` executes, so a guard missing here is unenforced on every PR even while ' +
          "the example's own config still collects it. If that is intentional, add it to " +
          'ROOT_UNLISTED with the CI job that runs it and the fail-closed switch that stops it ' +
          'skipping silently there.',
      ).toContain(file);
    }
  }, // into a timeout rather than a verdict. // `vitest list` over the whole repo takes ~30 s; the 5 s default turned this
  180_000);
});
