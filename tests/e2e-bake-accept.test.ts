import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { evaluateBakeOutcome, parseWarmedLines } from '../scripts/e2e-bake-accept.mjs';

/**
 * e2e-bake-accept (#1299) — moves the harness-only "accept any HTTP status"
 * tolerance OUT of the shipped compile-cache bake driver
 * (`packages/kn-next/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs`,
 * staged byte-for-byte into every user's image) and into this
 * harness-owned wrapper instead.
 *
 * WHY this shape. The shipped driver's own contract does not change in the
 * way that matters: on every exit path (2xx success, non-2xx failure, a
 * thrown exception) it flushes the V8 compile cache before exiting, so the
 * BYTES on disk are correct no matter what this wrapper decides — this
 * wrapper only ever changes the harness's PASS/FAIL verdict, never what
 * gets baked. That is what lets the "warm" signal survive the move: a
 * fixture built to 404/500 still exercises (and so still caches) the
 * server runtime that rendered it, exactly as it did when the knob lived
 * inside the driver.
 *
 * REVIEW ROUND on #1377 found the ORIGINAL tolerance check too loose: it
 * trusted "exit code non-zero" as proof of the known non-2xx failure, but
 * a signal-killed child (SIGKILL) or one that threw an uncaught exception
 * AFTER logging one good WARMED line both also produce a non-zero-looking
 * outcome — and both were wrongly tolerated, recording
 * `compile_cache_bake=ok` for a cache that was never actually flushed.
 * `evaluateBakeOutcome` now requires EVERY one of: no signal, exit code
 * EXACTLY 1, a `COMPILE_CACHE:` line in stdout (proof the loop finished and
 * flushed), the driver's own `"a warm path did not answer 2xx"` marker in
 * stderr, every WARMED status a REAL 3-digit HTTP code, and at least one of
 * those non-2xx. The tests below cover the pure decision AND, at the CLI
 * level, real fake children exhibiting each of the three failure modes the
 * review round named: a signal kill, a crash after a good WARMED line, and
 * an all-2xx set that still exits non-zero.
 *
 * `evaluateBakeOutcome` is the pure decision (unit-tested below); the CLI
 * subprocess describe block covers the wrapper end to end.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const COMPILE_CACHE_LINE = 'COMPILE_CACHE:/app/.next/compile-cache';
const FAILURE_STDERR = '[knext] compile-cache bake FAILED: a warm path did not answer 2xx';

/** A realistic non-2xx-failure stdout: one WARMED line plus the flush marker. */
function failureStdout(warmedLine: string): string {
  return [warmedLine, COMPILE_CACHE_LINE].join('\n');
}

describe('parseWarmedLines', () => {
  it("extracts path/status/ms from the driver's own WARMED: lines", () => {
    const stdout = [
      'WARMED:/ok status=200 ms=12',
      'some unrelated line',
      'WARMED:/boom status=500 ms=3',
      'COMPILE_CACHE:/app/.next/compile-cache',
    ].join('\n');
    expect(parseWarmedLines(stdout)).toEqual([
      { path: '/ok', status: '200', ms: 12 },
      { path: '/boom', status: '500', ms: 3 },
    ]);
  });

  it('captures a connection-error line (status=error) verbatim', () => {
    const stdout = 'WARMED:/reset status=error ms=5 (socket hang up)';
    expect(parseWarmedLines(stdout)).toEqual([{ path: '/reset', status: 'error', ms: 5 }]);
  });

  it('returns an empty array when the driver never got far enough to log anything', () => {
    expect(parseWarmedLines('some other crash output\n')).toEqual([]);
  });

  it('is not confused by extra whitespace/trailing content on the line', () => {
    const stdout = 'WARMED:/a status=204 ms=0\r\n';
    expect(parseWarmedLines(stdout)).toEqual([{ path: '/a', status: '204', ms: 0 }]);
  });
});

describe('evaluateBakeOutcome — the decision this wrapper exists for (#1299)', () => {
  it('GREEN: driver exited 0 (the strict 2xx bake succeeded) — acceptAnyStatus is irrelevant', () => {
    const r = evaluateBakeOutcome({
      exitCode: 0,
      signal: null,
      stdout: 'WARMED:/ok status=200 ms=1',
      stderr: '',
      acceptAnyStatus: false,
    });
    expect(r.ok).toBe(true);
  });

  it('RED: driver exited non-zero and acceptAnyStatus is OFF — a real failure, no tolerance', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      signal: null,
      stdout: failureStdout('WARMED:/not-there status=404 ms=1'),
      stderr: FAILURE_STDERR,
      acceptAnyStatus: false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/KNEXT_WARM_ACCEPT_ANY_STATUS is not set/);
  });

  it('GREEN: driver exited non-zero, acceptAnyStatus ON, every marker present, one non-2xx status', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      signal: null,
      stdout: failureStdout('WARMED:/not-there status=404 ms=1'),
      stderr: FAILURE_STDERR,
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/tolerated under KNEXT_WARM_ACCEPT_ANY_STATUS/);
  });

  it('GREEN: acceptAnyStatus ON, a 500 also tolerated', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      signal: null,
      stdout: failureStdout('WARMED:/boom status=500 ms=1'),
      stderr: FAILURE_STDERR,
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(true);
  });

  it('RED: acceptAnyStatus ON, but a warm path never answered (status=error — a connection failure)', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      signal: null,
      stdout: failureStdout('WARMED:/reset status=error ms=5 (socket hang up)'),
      stderr: FAILURE_STDERR,
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-numeric status/);
  });

  it('RED: acceptAnyStatus ON, but exit non-zero with NO WARMED lines at all — never reached a real response', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      signal: null,
      stdout: COMPILE_CACHE_LINE,
      stderr: FAILURE_STDERR,
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no WARMED line at all/);
  });

  it('RED: acceptAnyStatus ON, one path errors even though another answered — any non-numeric status is disqualifying', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      signal: null,
      stdout: failureStdout(
        ['WARMED:/ok status=200 ms=1', 'WARMED:/reset status=error ms=2'].join('\n'),
      ),
      stderr: FAILURE_STDERR,
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(false);
  });

  describe('round-#1377 hardening: exit code alone is never enough', () => {
    it('RED: signal-killed child (SIGKILL) after a good WARMED line — never tolerated', () => {
      const r = evaluateBakeOutcome({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: failureStdout('WARMED:/not-there status=404 ms=1'),
        stderr: FAILURE_STDERR,
        acceptAnyStatus: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/killed by signal SIGKILL/);
    });

    it('RED: exit code is non-zero but NOT exactly 1 (some other crash code)', () => {
      const r = evaluateBakeOutcome({
        exitCode: 137,
        signal: null,
        stdout: failureStdout('WARMED:/not-there status=404 ms=1'),
        stderr: FAILURE_STDERR,
        acceptAnyStatus: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/not the driver's own documented non-2xx failure code/);
    });

    it('RED: a good WARMED line, exit 1, but NO COMPILE_CACHE: line — the loop never actually finished/flushed', () => {
      const r = evaluateBakeOutcome({
        exitCode: 1,
        signal: null,
        stdout: 'WARMED:/not-there status=404 ms=1', // no COMPILE_CACHE: line
        stderr: FAILURE_STDERR,
        acceptAnyStatus: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/COMPILE_CACHE/);
    });

    it("RED: exit 1, COMPILE_CACHE present, but stderr lacks the driver's own failure marker (unknown crash)", () => {
      const r = evaluateBakeOutcome({
        exitCode: 1,
        signal: null,
        stdout: failureStdout('WARMED:/not-there status=404 ms=1'),
        stderr: 'TypeError: something else entirely blew up',
        acceptAnyStatus: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/does not contain the driver's own/);
    });

    it('RED: every WARMED status is 2xx yet the driver still exited 1 — contradicts the known failure shape', () => {
      const r = evaluateBakeOutcome({
        exitCode: 1,
        signal: null,
        stdout: failureStdout('WARMED:/ok status=200 ms=1'),
        stderr: FAILURE_STDERR,
        acceptAnyStatus: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/every WARMED status was 2xx/);
    });

    it('RED: a malformed status ("abc") is not a real HTTP status', () => {
      const r = evaluateBakeOutcome({
        exitCode: 1,
        signal: null,
        stdout: failureStdout('WARMED:/weird status=abc ms=1'),
        stderr: FAILURE_STDERR,
        acceptAnyStatus: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/non-numeric status/);
    });

    it('RED: an empty status is not a real HTTP status', () => {
      const r = evaluateBakeOutcome({
        exitCode: 1,
        signal: null,
        stdout: failureStdout('WARMED:/weird status= ms=1'),
        stderr: FAILURE_STDERR,
        acceptAnyStatus: true,
      });
      expect(r.ok).toBe(false);
    });
  });
});

/**
 * CLI-level (#1299, hardened #1377): spawns the REAL wrapper as a
 * subprocess against small fake children — including, in the hardening
 * block, children that reproduce each of the three failure modes the
 * review round proved with fake children (a signal kill, a crash after a
 * good WARMED line, an all-2xx-but-nonzero exit).
 */
describe('CLI subprocess — e2e-bake-accept.mjs wrapper', () => {
  const SCRIPT = resolve(REPO_ROOT, 'scripts/e2e-bake-accept.mjs');
  const NODE_ONE_LINER = (code: string) => ['-e', code];

  /** A realistic FAILING driver: one non-2xx WARMED line, the flush marker, the exact stderr marker, exit 1. */
  const FAKE_DRIVER_NON2XX_FAILURE = [
    'console.log("WARMED:/not-there status=404 ms=1")',
    `console.log(${JSON.stringify(COMPILE_CACHE_LINE)})`,
    `console.error(${JSON.stringify(FAILURE_STDERR)})`,
    'process.exit(1)',
  ].join('; ');

  it('exits 0 and passes through a successful child unchanged', () => {
    const r = execFileSync(
      process.execPath,
      [
        SCRIPT,
        process.execPath,
        ...NODE_ONE_LINER('console.log("WARMED:/ok status=200 ms=1"); process.exit(0)'),
      ],
      { encoding: 'utf8' },
    );
    expect(r).toContain('WARMED:/ok status=200 ms=1');
  });

  it('exits non-zero when the child fails and KNEXT_WARM_ACCEPT_ANY_STATUS is unset', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [SCRIPT, process.execPath, ...NODE_ONE_LINER(FAKE_DRIVER_NON2XX_FAILURE)],
        { encoding: 'utf8' },
      ),
    ).toThrow();
  });

  it('exits 0 when the child fails on a genuine non-2xx status (with every marker present) AND KNEXT_WARM_ACCEPT_ANY_STATUS=1', () => {
    const r = execFileSync(
      process.execPath,
      [SCRIPT, process.execPath, ...NODE_ONE_LINER(FAKE_DRIVER_NON2XX_FAILURE)],
      { encoding: 'utf8', env: { ...process.env, KNEXT_WARM_ACCEPT_ANY_STATUS: '1' } },
    );
    expect(r).toContain('WARMED:/not-there status=404 ms=1');
  });

  it('the KNEXT_WARM_ACCEPT_ANY_STATUS var is stripped from the CHILD env — the child never sees it', () => {
    const r = execFileSync(
      process.execPath,
      [
        SCRIPT,
        process.execPath,
        ...NODE_ONE_LINER(
          "console.log('saw=' + (process.env.KNEXT_WARM_ACCEPT_ANY_STATUS ?? '<unset>')); console.log('WARMED:/ok status=200 ms=1'); process.exit(0)",
        ),
      ],
      { encoding: 'utf8', env: { ...process.env, KNEXT_WARM_ACCEPT_ANY_STATUS: '1' } },
    );
    expect(r).toContain('saw=<unset>');
  });

  it('exits 2 (usage error) with no command given', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' })).toThrow();
    try {
      execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    } catch (err) {
      expect((err as { status: number }).status).toBe(2);
    }
  });

  describe("round-#1377 hardening, real fake children (the reviewer's own proof cases)", () => {
    it('a driver killed by SIGKILL mid-run (proven via a self-terminating fake driver) is never tolerated', () => {
      // A more direct proof: the fake "driver" logs a good WARMED line, then
      // kills ITSELF with SIGKILL — spawnSync on the wrapper then observes
      // signal=SIGKILL, exitCode=null for that child, exactly the shape
      // evaluateBakeOutcome must refuse regardless of the flag.
      const r = spawnSync(
        process.execPath,
        [
          SCRIPT,
          process.execPath,
          ...NODE_ONE_LINER(
            'console.log("WARMED:/not-there status=404 ms=1"); process.kill(process.pid, "SIGKILL");',
          ),
        ],
        { encoding: 'utf8', env: { ...process.env, KNEXT_WARM_ACCEPT_ANY_STATUS: '1' } },
      );
      expect(r.status).not.toBe(0);
      expect((r.stderr ?? '') + (r.stdout ?? '')).toMatch(/killed by signal SIGKILL/);
    });

    it('a driver that logs a good WARMED line then throws (crash, never reaching COMPILE_CACHE:) is never tolerated', () => {
      const r = spawnSync(
        process.execPath,
        [
          SCRIPT,
          process.execPath,
          ...NODE_ONE_LINER(
            'console.log("WARMED:/not-there status=404 ms=1"); throw new Error("boom after warming");',
          ),
        ],
        { encoding: 'utf8', env: { ...process.env, KNEXT_WARM_ACCEPT_ANY_STATUS: '1' } },
      );
      expect(r.status).not.toBe(0);
      expect((r.stderr ?? '') + (r.stdout ?? '')).toMatch(/COMPILE_CACHE/);
    });

    it('a driver whose WARMED statuses are ALL 2xx but that still exits non-zero is never tolerated', () => {
      const r = spawnSync(
        process.execPath,
        [
          SCRIPT,
          process.execPath,
          ...NODE_ONE_LINER(
            [
              'console.log("WARMED:/ok status=200 ms=1")',
              `console.log(${JSON.stringify(COMPILE_CACHE_LINE)})`,
              `console.error(${JSON.stringify(FAILURE_STDERR)})`,
              'process.exit(1)',
            ].join('; '),
          ),
        ],
        { encoding: 'utf8', env: { ...process.env, KNEXT_WARM_ACCEPT_ANY_STATUS: '1' } },
      );
      expect(r.status).not.toBe(0);
      expect((r.stderr ?? '') + (r.stdout ?? '')).toMatch(/every WARMED status was 2xx/);
    });
  });
});
