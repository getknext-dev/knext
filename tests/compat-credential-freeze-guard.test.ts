import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  evaluateFreezeGuard,
  frozenFileSet,
  isFrozen,
  markerValidity,
  PIN_FILE,
} from '../scripts/compat-credential-freeze-guard.mjs';

/**
 * GUARD TESTS for #1302 — the credential freeze guard.
 *
 * Layout mirrors the decision structure documented in
 * scripts/compat-credential-freeze-guard.mjs's header:
 *   1. isFrozen — reads the pin's rcTag;
 *   2. markerValidity — structural + expiry check on rcBumpMarker;
 *   3. frozenFileSet — the DERIVED (never hardcoded) protected-file set,
 *      reused from scripts/compat-window-fingerprint.mjs's collectHarness;
 *   4. evaluateFreezeGuard — the whole decision, and the four scenarios the
 *      task explicitly asks to be mutation-proved: red when frozen with a
 *      touched file, green when unfrozen, green with a valid marker, red
 *      with an expired marker.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('isFrozen (#1302)', () => {
  it('rcTag: null is NOT frozen (ADR-0056: "null = no RC cut yet")', () => {
    expect(isFrozen({ rcTag: null })).toBe(false);
  });

  it('a missing rcTag key is NOT frozen', () => {
    expect(isFrozen({})).toBe(false);
  });

  it('any non-null rcTag IS frozen, including a malformed one (fail-safe direction)', () => {
    expect(isFrozen({ rcTag: 'v1.0.0-rc.1' })).toBe(true);
    expect(isFrozen({ rcTag: 'not-even-a-real-tag-format' })).toBe(true);
  });

  it('a non-object pin is NOT frozen', () => {
    expect(isFrozen(null)).toBe(false);
    expect(isFrozen(undefined)).toBe(false);
    expect(isFrozen('rcTag: v1')).toBe(false);
  });
});

describe('markerValidity (#1302)', () => {
  const NOW = new Date('2026-09-24T12:00:00Z');

  it('no rcBumpMarker present is invalid', () => {
    expect(markerValidity({ rcTag: 'v1.0.0-rc.1' }, NOW).valid).toBe(false);
  });

  it('a well-formed, unexpired marker is valid', () => {
    const result = markerValidity(
      {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: {
          date: '2026-09-24',
          expires: '2026-10-08',
          reason: 'founder-approved test',
        },
      },
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('an EXPIRED marker is invalid (today > expires)', () => {
    const result = markerValidity(
      {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-08-01', expires: '2026-08-15', reason: 'stale' },
      },
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/);
  });

  it('today == expires is still valid (inclusive boundary)', () => {
    const result = markerValidity(
      {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-09-01', expires: '2026-09-24', reason: 'x' },
      },
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects malformed dates', () => {
    expect(
      markerValidity(
        { rcBumpMarker: { date: '09/24/2026', expires: '2026-10-08', reason: 'x' } },
        NOW,
      ).valid,
    ).toBe(false);
    expect(
      markerValidity({ rcBumpMarker: { date: '2026-09-24', expires: 'soon', reason: 'x' } }, NOW)
        .valid,
    ).toBe(false);
  });

  it('rejects an empty or missing reason', () => {
    expect(
      markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08', reason: '' } },
        NOW,
      ).valid,
    ).toBe(false);
    expect(
      markerValidity({ rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08' } }, NOW).valid,
    ).toBe(false);
  });

  it('rejects expires <= date (a marker that is never valid)', () => {
    expect(
      markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-09-24', reason: 'x' } },
        NOW,
      ).valid,
    ).toBe(false);
    expect(
      markerValidity(
        { rcBumpMarker: { date: '2026-09-24', expires: '2026-09-01', reason: 'x' } },
        NOW,
      ).valid,
    ).toBe(false);
  });

  it('rejects a non-object rcBumpMarker (e.g. a stray string or array)', () => {
    expect(markerValidity({ rcBumpMarker: 'approved' }, NOW).valid).toBe(false);
    expect(markerValidity({ rcBumpMarker: [] }, NOW).valid).toBe(false);
  });
});

describe('frozenFileSet — DERIVED from CREDENTIAL_CELLS + collectHarness, never hardcoded (#1302)', () => {
  it('unions collectHarness paths across every workflowFile-bearing cell, via DI', () => {
    const fakeCells = [
      { lane: 'a', workflowFile: 'wf-a.yml' },
      { lane: 'b', workflowFile: 'wf-b.yml' },
      // No workflowFile — must be SKIPPED, never passed to collectHarnessFn
      // (which would throw for a lane with nothing to fingerprint).
      { lane: 'c', workflowFile: null },
    ];
    const calls: string[] = [];
    const fakeCollectHarness = (_repoRoot: string, lane: string) => {
      calls.push(lane);
      if (lane === 'c') throw new Error('must never be called for a null-workflowFile cell');
      return [
        { component: 'harness', path: `${lane}/one.mjs`, line: 'x' },
        { component: 'harness', path: `${lane}/two.mjs`, line: 'y' },
      ];
    };
    const set = frozenFileSet('/repo', { cells: fakeCells, collectHarnessFn: fakeCollectHarness });
    expect(calls.sort()).toEqual(['a', 'b']);
    expect(set).toEqual(new Set(['a/one.mjs', 'a/two.mjs', 'b/one.mjs', 'b/two.mjs']));
  });

  it('REAL integration: reaches known real files in this checkout (non-vacuous)', () => {
    // No DI — the actual CREDENTIAL_CELLS and the actual collectHarness,
    // against this real repo. Proves the derivation reaches real,
    // known-frozen files rather than only ever being exercised against a
    // fake.
    const set = frozenFileSet(REPO_ROOT);
    expect(set.has('.github/workflows/test-e2e-deploy.yml')).toBe(true);
    expect(set.has('test/deploy-tests-manifest.knext.json')).toBe(true);
    expect(set.has(PIN_FILE)).toBe(true);
    expect(set.has('scripts/compat-credential-ref.mjs')).toBe(true);
    // The smoke manifest is dispatch-only and explicitly excluded from the
    // harness pattern (#1301 review round 1) — the freeze guard inherits
    // that exclusion for free by reusing collectHarness rather than
    // re-declaring the manifest glob itself.
    expect(set.has('test/deploy-tests-manifest.smoke.knext.json')).toBe(false);
  });

  it('never includes the guard workflow/script itself (not part of the credential harness)', () => {
    const set = frozenFileSet(REPO_ROOT);
    expect(set.has('scripts/compat-credential-freeze-guard.mjs')).toBe(false);
    expect(set.has('.github/workflows/compat-credential-freeze-guard.yml')).toBe(false);
  });
});

describe('evaluateFreezeGuard — the four required scenarios (#1302)', () => {
  const NOW = new Date('2026-09-24T12:00:00Z');
  const FROZEN_SET = new Set(['.github/workflows/test-e2e-deploy.yml', 'scripts/e2e-deploy.sh']);

  it('RED: frozen (rcTag set) + a touched frozen file + no marker', () => {
    const result = evaluateFreezeGuard({
      pin: { rcTag: 'v1.0.0-rc.1' },
      touchedFiles: ['scripts/e2e-deploy.sh', 'README.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.touchedFrozenFiles).toEqual(['scripts/e2e-deploy.sh']);
    expect(result.reason).toMatch(/no valid rcBumpMarker/);
  });

  it('GREEN: unfrozen (rcTag null) even though the touched files WOULD be frozen ones', () => {
    const result = evaluateFreezeGuard({
      pin: { rcTag: null },
      touchedFiles: ['scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/not frozen/);
  });

  it('GREEN: frozen + touched frozen file + a VALID rcBumpMarker', () => {
    const result = evaluateFreezeGuard({
      pin: {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08', reason: 'reviewed rc re-cut' },
      },
      touchedFiles: ['scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/rcBumpMarker exempts it/);
  });

  it('RED: frozen + touched frozen file + an EXPIRED rcBumpMarker', () => {
    const result = evaluateFreezeGuard({
      pin: {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-08-01', expires: '2026-08-15', reason: 'old approval' },
      },
      touchedFiles: ['scripts/e2e-deploy.sh'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/);
  });

  it('GREEN: frozen, but the touched files are NOT in the frozen set at all', () => {
    const result = evaluateFreezeGuard({
      pin: { rcTag: 'v1.0.0-rc.1' },
      touchedFiles: ['README.md', 'docs/whatever.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.touchedFrozenFiles).toEqual([]);
  });

  it('a marker present but touching NO frozen files does not even need to be valid', () => {
    // The marker is only consulted once a frozen file is actually touched —
    // an unrelated PR carrying a stray/expired marker object must not be
    // penalized for it.
    const result = evaluateFreezeGuard({
      pin: {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2020-01-01', expires: '2020-01-02', reason: 'ancient, irrelevant' },
      },
      touchedFiles: ['README.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('multiple touched frozen files are all listed', () => {
    const result = evaluateFreezeGuard({
      pin: { rcTag: 'v1.0.0-rc.1' },
      touchedFiles: ['scripts/e2e-deploy.sh', '.github/workflows/test-e2e-deploy.yml', 'README.md'],
      frozenSet: FROZEN_SET,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.touchedFrozenFiles.sort()).toEqual(
      ['.github/workflows/test-e2e-deploy.yml', 'scripts/e2e-deploy.sh'].sort(),
    );
  });
});

describe('the pin file itself documents rcBumpMarker (#1302)', () => {
  it('.github/compat-credential-ref.json parses and rcTag is currently null (no live window today)', () => {
    const pin = JSON.parse(readFileSync(resolve(REPO_ROOT, PIN_FILE), 'utf8'));
    expect(isFrozen(pin)).toBe(false);
  });
});

/**
 * CLI-level end-to-end (#1302): spawns the REAL script as a subprocess
 * against real fixture files, exercising the argument parsing, file I/O and
 * exit code the workflow actually depends on — not just the exported pure
 * functions. The four scenarios below are the exact ones named in the task:
 * red when frozen with a touched file, green when unfrozen, green with a
 * valid marker, red with an expired marker. `--now` makes the process
 * deterministic without touching the system clock.
 */
describe('CLI subprocess — the four required scenarios, end to end (#1302)', () => {
  const SCRIPT = resolve(REPO_ROOT, 'scripts/compat-credential-freeze-guard.mjs');
  const NOW_ARG = '2026-09-24T12:00:00Z';

  function run(pin: unknown, touchedFiles: string[]): { status: number | null; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'knext-freeze-guard-'));
    try {
      const pinFile = join(dir, 'base-pin.json');
      const changedFile = join(dir, 'changed-files.txt');
      writeFileSync(pinFile, JSON.stringify(pin));
      writeFileSync(changedFile, `${touchedFiles.join('\n')}\n`);
      try {
        const stdout = execFileSync(
          process.execPath,
          [
            SCRIPT,
            '--repo-root',
            REPO_ROOT,
            '--base-pin-file',
            pinFile,
            '--changed-files-file',
            changedFile,
            '--now',
            NOW_ARG,
          ],
          { encoding: 'utf8' },
        );
        return { status: 0, stdout };
      } catch (err) {
        const e = err as { status: number | null; stdout?: string };
        return { status: e.status, stdout: e.stdout ?? '' };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('RED (exit 1): frozen + a real touched frozen file (test-e2e-deploy.yml) + no marker', () => {
    const { status, stdout } = run({ rcTag: 'v1.0.0-rc.1' }, [
      '.github/workflows/test-e2e-deploy.yml',
    ]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/no valid rcBumpMarker/);
  });

  it('GREEN (exit 0): unfrozen (rcTag: null), even touching a would-be-frozen file', () => {
    const { status, stdout } = run({ rcTag: null }, ['.github/workflows/test-e2e-deploy.yml']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/not frozen/);
  });

  it('GREEN (exit 0): frozen + touched frozen file + a valid rcBumpMarker', () => {
    const { status, stdout } = run(
      {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-09-24', expires: '2026-10-08', reason: 'e2e test' },
      },
      ['.github/workflows/test-e2e-deploy.yml'],
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/rcBumpMarker exempts it/);
  });

  it('RED (exit 1): frozen + touched frozen file + an EXPIRED rcBumpMarker', () => {
    const { status, stdout } = run(
      {
        rcTag: 'v1.0.0-rc.1',
        rcBumpMarker: { date: '2026-08-01', expires: '2026-08-15', reason: 'stale' },
      },
      ['.github/workflows/test-e2e-deploy.yml'],
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/expired/);
  });

  it('GREEN (exit 0): frozen, touched files are entirely unrelated to the credential harness', () => {
    const { status } = run({ rcTag: 'v1.0.0-rc.1' }, ['README.md', 'docs/some-page.md']);
    expect(status).toBe(0);
  });

  it('exits 2 (usage error) when a required flag is missing, not a silent pass', () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, '--repo-root', REPO_ROOT], { encoding: 'utf8' }),
    ).toThrow();
    try {
      execFileSync(process.execPath, [SCRIPT, '--repo-root', REPO_ROOT], { encoding: 'utf8' });
    } catch (err) {
      expect((err as { status: number }).status).toBe(2);
    }
  });
});
