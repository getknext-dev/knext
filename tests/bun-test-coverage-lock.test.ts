/**
 * `scripts/bun-test.mjs --coverage` must not let two runs in the same
 * checkout silently clobber each other (#1242).
 *
 * The runner used to unconditionally `rmSync` then `mkdirSync` the shared
 * `coverage-bun/` (or `KNEXT_BUN_COVERAGE_DIR`) pile at the start of every
 * `--coverage` invocation. Two coverage runs overlapping in the same
 * (non-worktree) checkout — a local `bun run test:coverage` started while a
 * CI-mirroring run is still going, or two terminals — would race on that
 * wipe: whichever started second could delete the first's in-flight per-file
 * reports mid-merge, producing a wrong coverage number with no error at all.
 *
 * Fixed with an exclusive PID lock (`<coverage-dir>.lock`, sibling to the
 * coverage directory so wiping the directory never touches it): a run that
 * cannot acquire the lock FAILS LOUDLY and leaves the held directory
 * untouched, rather than proceeding to wipe it. A lock whose recorded PID is
 * no longer alive (a crashed prior run, e.g. SIGKILLed) is reclaimed rather
 * than blocking forever.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const RUNNER = join(REPO_ROOT, 'scripts', 'bun-test.mjs');

const dirs: string[] = [];
function tempCoverageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-covlock-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runCoverage(coverageDir: string, extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [RUNNER, '--coverage', ...extraArgs, 'tests/blank-non-code.test.ts'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, KNEXT_BUN_COVERAGE_DIR: coverageDir },
    },
  );
}

/** A background process guaranteed to still be alive while the assertions run. */
function spawnLiveHolder() {
  const p = spawn('sleep', ['30'], { stdio: 'ignore' });
  return p;
}

describe('scripts/bun-test.mjs — coverage output lock (#1242)', () => {
  test('a live lock blocks a second coincident run, loudly, and never touches the held directory', () => {
    const dir = tempCoverageDir();
    mkdirSync(dir, { recursive: true });
    const canary = join(dir, 'PRE-EXISTING-report.info');
    writeFileSync(canary, 'SF:untouched\n');

    const holder = spawnLiveHolder();
    try {
      writeFileSync(`${dir}.lock`, String(holder.pid));

      const res = runCoverage(dir);
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

      expect(res.status, combined).not.toBe(0);
      expect(combined.toLowerCase()).toMatch(/lock|already in progress|another/);
      // The held directory's existing content must survive untouched — the
      // defect this closes is exactly "silently deletes the other run's
      // in-flight output".
      expect(existsSync(canary), combined).toBe(true);
      expect(readFileSync(canary, 'utf8')).toBe('SF:untouched\n');
    } finally {
      holder.kill('SIGKILL');
      rmSync(`${dir}.lock`, { force: true });
    }
  });

  test('a stale lock (dead PID) is reclaimed, not a permanent block', () => {
    const dir = tempCoverageDir();
    // A PID essentially guaranteed not to be a live process on any machine
    // running this test.
    writeFileSync(`${dir}.lock`, '999999999');

    const res = runCoverage(dir);
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(res.status, combined).toBe(0);
    expect(existsSync(dir), combined).toBe(true);
    const reports = readdirSync(dir).filter((f: string) => f.endsWith('.info'));
    expect(reports.length, combined).toBeGreaterThanOrEqual(1);
  });

  test('two truly-concurrent runs against the SAME directory: exactly one proceeds, the other is refused, no interleaving', async () => {
    const dir = tempCoverageDir();

    // A few files, not one: a single-file run can complete (and release the
    // lock) inside the spawn-overhead window before the second process even
    // gets to its own lock probe, which would make BOTH runs legitimately
    // see the lock free and pass — not what this test is checking. A few
    // files keeps the run's own wall-clock time comfortably above that
    // window without depending on any one file being slow.
    const TARGETS = [
      'tests/blank-non-code.test.ts',
      'tests/lcov-merge.test.ts',
      'tests/bun-test-untracked-named-target.test.ts',
    ];

    const spawnRun = () =>
      new Promise<{ code: number | null; output: string }>((resolvePromise) => {
        const child = spawn(process.execPath, [RUNNER, '--coverage', ...TARGETS], {
          cwd: REPO_ROOT,
          env: { ...process.env, KNEXT_BUN_COVERAGE_DIR: dir },
        });
        let output = '';
        child.stdout.on('data', (d) => (output += d));
        child.stderr.on('data', (d) => (output += d));
        child.on('close', (code) => resolvePromise({ code, output }));
      });

    const [a, b] = await Promise.all([spawnRun(), spawnRun()]);
    const results = [a, b];
    const succeeded = results.filter((r) => r.code === 0);
    const refused = results.filter((r) => r.code !== 0);

    // Exactly one wins the lock; the other is refused loudly (never a silent
    // no-op, never both silently interleaving into the same directory).
    expect(succeeded.length, `a=${JSON.stringify(a)}\nb=${JSON.stringify(b)}`).toBe(1);
    expect(refused.length).toBe(1);
    expect(refused[0]!.output.toLowerCase()).toMatch(/lock|already in progress|another/);

    // The winner's report survived intact.
    expect(existsSync(dir)).toBe(true);
    const reports = readdirSync(dir).filter((f: string) => f.endsWith('.info'));
    expect(reports.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
