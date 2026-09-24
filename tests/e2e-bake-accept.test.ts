import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
 * `evaluateBakeOutcome` is the pure decision (unit-tested below);
 * `tests/e2e-bake-accept-cli.test.ts` covers the CLI/subprocess wrapper
 * against the REAL shipped driver end to end.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

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
      stdout: 'WARMED:/ok status=200 ms=1',
      acceptAnyStatus: false,
    });
    expect(r.ok).toBe(true);
  });

  it('RED: driver exited non-zero and acceptAnyStatus is OFF — a real failure, no tolerance', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      stdout: 'WARMED:/not-there status=404 ms=1',
      acceptAnyStatus: false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/KNEXT_WARM_ACCEPT_ANY_STATUS is not set/);
  });

  it('GREEN: driver exited non-zero, acceptAnyStatus ON, every warmed path answered a real (non-2xx) status', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      stdout: 'WARMED:/not-there status=404 ms=1',
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/tolerated under KNEXT_WARM_ACCEPT_ANY_STATUS/);
  });

  it('GREEN: acceptAnyStatus ON, a 500 also tolerated', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      stdout: 'WARMED:/boom status=500 ms=1',
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(true);
  });

  it('RED: acceptAnyStatus ON, but a warm path never answered (status=error — a connection failure)', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      stdout: 'WARMED:/reset status=error ms=5 (socket hang up)',
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/never answered/);
  });

  it('RED: acceptAnyStatus ON, but exit non-zero with NO WARMED lines at all — never reached a real response', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      stdout: 'some crash before any warm attempt',
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/never reached a real response/);
  });

  it('RED: acceptAnyStatus ON, one path errors even though another answered — any error is disqualifying', () => {
    const r = evaluateBakeOutcome({
      exitCode: 1,
      stdout: ['WARMED:/ok status=200 ms=1', 'WARMED:/reset status=error ms=2'].join('\n'),
      acceptAnyStatus: true,
    });
    expect(r.ok).toBe(false);
  });
});

/**
 * CLI-level (#1299): spawns the REAL wrapper as a subprocess against a tiny
 * fake command, exercising argv parsing, env-stripping and exit codes.
 * tests/e2e-bake-accept-cli.test.ts covers it against the real shipped
 * driver end to end (mirroring the layering the freeze-guard tests use).
 */
describe('CLI subprocess — e2e-bake-accept.mjs wrapper', () => {
  const SCRIPT = resolve(REPO_ROOT, 'scripts/e2e-bake-accept.mjs');
  const NODE_ONE_LINER = (code: string) => ['-e', code];

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
        [
          SCRIPT,
          process.execPath,
          ...NODE_ONE_LINER('console.log("WARMED:/not-there status=404 ms=1"); process.exit(1)'),
        ],
        { encoding: 'utf8' },
      ),
    ).toThrow();
  });

  it('exits 0 when the child fails on non-2xx status alone AND KNEXT_WARM_ACCEPT_ANY_STATUS=1', () => {
    const r = execFileSync(
      process.execPath,
      [
        SCRIPT,
        process.execPath,
        ...NODE_ONE_LINER('console.log("WARMED:/not-there status=404 ms=1"); process.exit(1)'),
      ],
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
});
