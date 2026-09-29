/**
 * `scripts/bun-test.mjs` must never hang the whole run on ONE file (#1241).
 *
 * `packages/kn-next/src/__tests__/coverage-margin.test.ts` was observed to hang
 * 27+ minutes under `--coverage`, orphaned (left running after whatever was
 * waiting on it gave up). The runner spawned that child with no timeout at all
 * — nothing outside bun's own per-test default (5000ms, which a truly-stuck
 * event loop can also fail to enforce) bounded how long a single file could run,
 * and nothing killed a file that overran.
 *
 * This pins the runner's OWN outer bound: a per-file kill-timeout that fires
 * regardless of what bun's internal timeout does, reports the file as a loud,
 * attributable FAILURE (never a skip), and actually terminates the child so
 * nothing is left orphaned.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const RUNNER = join(REPO_ROOT, 'scripts', 'bun-test.mjs');

// In-repo (the runner resolves targets from REPO_ROOT), untracked, unique name
// so a crashed prior run cannot leave a same-named file that alters the result.
const HANG_REL = 'tests/__hard-timeout-canary-hangs.test.ts';
const HANG_ABS = join(REPO_ROOT, HANG_REL);

// Second canary: a file that itself spawns a REAL grandchild process (the
// pattern `tests/bytecode-liveness-wiring.test.ts` and
// `tests/kn-next-action-preflight.test.ts` use) and then hangs. This is the
// #1241 recurrence: killing only the immediate bun-test child leaves that
// grandchild running, reparented to pid 1, because it was never in the killed
// process's group.
const GRANDCHILD_HANG_REL = 'tests/__hard-timeout-canary-grandchild.test.ts';
const GRANDCHILD_HANG_ABS = join(REPO_ROOT, GRANDCHILD_HANG_REL);
// Unique per file (not per run): a marker embedded in the grandchild's own
// argv, so it is identifiable in `ps` output independent of the test file's
// path (which appears only in the bun-test CHILD's argv, never the
// grandchild's — the grandchild is a bare `node -e ...`).
const GRANDCHILD_MARKER = 'KNEXT_HARD_TIMEOUT_GRANDCHILD_CANARY_9f3a1c';

afterEach(() => {
  rmSync(HANG_ABS, { force: true });
  rmSync(GRANDCHILD_HANG_ABS, { force: true });
});

/**
 * A test that never resolves. Its OWN bun-level timeout is set to an hour —
 * far past anything this file waits — so what actually bounds this canary is
 * the RUNNER's outer kill, not bun's unrelated per-test default. That is the
 * behaviour under test, not a coincidence of bun's own timeout also firing.
 */
function writeHangingCanary() {
  writeFileSync(
    HANG_ABS,
    [
      "import { test } from 'bun:test';",
      "test('hangs forever', async () => {",
      '  await new Promise(() => {});',
      '}, 3_600_000);',
      '',
    ].join('\n'),
  );
}

/**
 * `spawnSync` blocks the test's own thread until the grandchild exits, so a
 * grandchild that never exits IS the hang — no separate `await new
 * Promise(() => {})` needed, and it matches how the real offending files
 * (bytecode-liveness-wiring, kn-next-action-preflight) actually hang: inside
 * a synchronous child-process call, not an unresolved promise.
 */
function writeGrandchildHangingCanary() {
  writeFileSync(
    GRANDCHILD_HANG_ABS,
    [
      "import { test } from 'bun:test';",
      "import { spawnSync } from 'node:child_process';",
      "test('hangs forever inside a spawnSync of a real, undying grandchild', () => {",
      `  spawnSync('node', ['-e', '/* ${GRANDCHILD_MARKER} */ setInterval(() => {}, 1000);'], { stdio: 'ignore' });`,
      '}, 3_600_000);',
      '',
    ].join('\n'),
  );
}

describe('scripts/bun-test.mjs — per-file hard timeout', () => {
  test('a file that hangs is killed and reported FAILED within the configured bound, never left running', () => {
    writeHangingCanary();
    const start = Date.now();
    const res = Bun.spawnSync(['node', RUNNER, HANG_REL, '--file-timeout=1500'], {
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    const elapsedMs = Date.now() - start;
    const stdout = res.stdout?.toString() ?? '';
    const stderr = res.stderr?.toString() ?? '';
    const combined = `${stdout}${stderr}`;

    // Bounded: well under the 30s outer safety timeout this TEST applies to
    // itself, and in the same order of magnitude as the configured 1500ms
    // file-timeout, not the 3_600_000ms the canary's own bun-level timeout
    // would otherwise need to elapse.
    expect(elapsedMs, combined).toBeLessThan(20_000);

    // Reported as a real, attributable failure — never silently swallowed,
    // never a skip.
    expect(res.exitCode, combined).toBe(1);
    expect(combined).toContain(HANG_REL);
    expect(combined.toLowerCase()).toMatch(/timeout|killed/);

    // No orphan: nothing matching the canary's own path is still running
    // after the runner returned. Filtered in JS against a PLAIN `ps` listing
    // rather than `pgrep -f`/`pgrep -af`: this platform's `pgrep` silently
    // ignores `-a`/`-l` and prints bare PIDs with no command text at all
    // (measured — `-af "bash"` and `-a "bash"` both return PIDs only), which
    // would make a real orphan indistinguishable from noise; and a `pgrep -f
    // "<pattern>"` invocation is its own shell-wrapper self-match (the search
    // string is embedded in that wrapper's own argv) on platforms where it
    // DOES print command text. Filtering `ps`'s output in JS, rather than
    // asking a process-search tool to filter itself, has neither problem.
    const psOut = execSync('ps -eo pid=,command=', { encoding: 'utf8' });
    const survivors = psOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes(HANG_REL))
      .join('\n');
    expect(survivors, `orphaned process(es) still running:\n${survivors}`).toBe('');
  }, 40_000);

  test('a file whose spawnSync starts a real grandchild leaves no grandchild behind after the kill (#1241 recurrence)', () => {
    writeGrandchildHangingCanary();
    const start = Date.now();
    const res = Bun.spawnSync(['node', RUNNER, GRANDCHILD_HANG_REL, '--file-timeout=1500'], {
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    const elapsedMs = Date.now() - start;
    const stdout = res.stdout?.toString() ?? '';
    const stderr = res.stderr?.toString() ?? '';
    const combined = `${stdout}${stderr}`;

    expect(elapsedMs, combined).toBeLessThan(20_000);
    expect(res.exitCode, combined).toBe(1);
    expect(combined).toContain(GRANDCHILD_HANG_REL);
    expect(combined.toLowerCase()).toMatch(/timeout|killed/);

    // The bug class: SIGKILLing only the immediate bun-test child (no process
    // GROUP kill) leaves the real grandchild it spawnSync'd running, reparented
    // to pid 1. Identified by a marker in the grandchild's OWN argv — the test
    // file's path never appears there, only in the (now-dead) bun-test child's.
    const psOut = execSync('ps -eo pid=,ppid=,command=', { encoding: 'utf8' });
    const survivors = psOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes(GRANDCHILD_MARKER))
      .join('\n');
    expect(survivors, `orphaned grandchild process(es) still running:\n${survivors}`).toBe('');
  }, 40_000);
});
