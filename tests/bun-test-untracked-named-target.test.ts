/**
 * An explicitly-named, existing `.test.ts` file must RUN even if it is untracked
 * (#1073).
 *
 * `scripts/bun-test.mjs` discovers targets with `git ls-files`, which lists only
 * TRACKED files. Before this fix, naming a freshly-written untracked test file
 * matched nothing, so the runner printed "no test files matched" and exited 1.
 *
 * The mutation-prover lane depends on the opposite: two provers write an
 * UNTRACKED green canary and run it through this runner as their RED-vs-GREEN
 * self-check (STEP 0). Under `git ls-files` discovery the green canary "failed"
 * for a discovery reason, not an assertion reason, and the provers aborted with
 * `harness cannot discriminate`. The runner's own contract already says "Naming a
 * path is an explicit request" — this makes that hold for untracked files.
 *
 * The regression guard for #879/#902 must survive: a target that matches nothing
 * real (a genuinely-absent path) must still exit 1 with "no test files matched".
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const RUNNER = join(REPO_ROOT, 'scripts', 'bun-test.mjs');

// In-repo, because the runner resolves targets from REPO_ROOT. A unique name so
// a crashed prior run cannot leave a same-named file that alters the result.
const CANARY_REL = 'tests/__untracked-named-target-canary.test.ts';
const CANARY_ABS = join(REPO_ROOT, CANARY_REL);

function runRunner(target: string) {
  return spawnSync('node', [RUNNER, target], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
}

afterEach(() => {
  rmSync(CANARY_ABS, { force: true });
});

describe('bun-test.mjs — explicitly-named target', () => {
  test('runs an existing but UNTRACKED .test.ts file (#1073)', () => {
    writeFileSync(
      CANARY_ABS,
      [
        "import { expect, test } from 'bun:test';",
        "test('untracked canary passes', () => {",
        '  expect(1).toBe(1);',
        '});',
        '',
      ].join('\n'),
    );
    // Precondition: the canary is genuinely untracked, or the test proves nothing.
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', CANARY_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(tracked.status, 'canary must be untracked for this test to be meaningful').not.toBe(0);

    const res = runRunner(CANARY_REL);
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(combined).not.toContain('no test files matched');
    expect(res.status).toBe(0);
  });

  test('a genuinely-absent target still exits 1 with "no test files matched" (#879/#902)', () => {
    expect(existsSync(CANARY_ABS)).toBe(false);
    const res = runRunner('tests/__this-path-does-not-exist.test.ts');
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(combined).toContain('no test files matched');
    expect(res.status).toBe(1);
  });
});
