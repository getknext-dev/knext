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

afterEach(() => {
  rmSync(HANG_ABS, { force: true });
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
});
