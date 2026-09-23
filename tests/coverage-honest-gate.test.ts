/**
 * The honest line floor, end to end through `scripts/check-coverage.mjs` (#1248).
 *
 * The gate now reports two line percentages: the RAW one over every `DA` record
 * bun emitted, and the HONEST one over executable lines only (see
 * `scripts/lib/executable-lines.mjs`). Both are gated. These tests hold the
 * load-bearing direction: an uncovered EXECUTABLE line is still counted, and one
 * such line is enough to cross the honest floor — while a noise line going
 * uncovered moves nothing.
 *
 * Every verdict branches on the checker's EXIT CODE, never on its output.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  HONEST_PER_PATH_THRESHOLDS,
  HONEST_THRESHOLDS,
  PER_PATH_THRESHOLDS,
  THRESHOLDS,
} from '../scripts/lib/coverage-policy.mjs';
import { classifyLines } from '../scripts/lib/executable-lines.mjs';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-coverage.mjs');
const CORE_GLOB = 'packages/kn-next/src/**';

/** A REAL tracked source, so the checker classifies its lines from disk. */
const REAL = 'packages/kn-next/src/generators/loadtest-job.ts';
/** Deliberately NOT on disk: unclassifiable, so every record is kept in both numbers. */
const FAKE = 'packages/kn-next/src/zz-honest-gate-fixture.ts';

function runChecker(lcov: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'knext-honest-'));
  try {
    const p = join(dir, 'r.info');
    writeFileSync(p, `${lcov}\n`);
    const res = spawnSync(process.execPath, [CHECKER, `--lcov=${p}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (res.status === null) throw new Error(`checker did not exit: ${res.error?.message}`);
    return res.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(file: string, da: Array<[number, number]>, fn = 0): string {
  return [
    'TN:',
    `SF:${file}`,
    `FNF:${fn}`,
    `FNH:${fn}`,
    ...da.map(([l, h]) => `DA:${l},${h}`),
    'end_of_record',
  ].join('\n');
}

describe('honest line floors — policy shape', () => {
  test('every raw line floor has an honest counterpart that is not weaker', () => {
    expect(HONEST_THRESHOLDS.lines).toBeGreaterThanOrEqual(THRESHOLDS.lines);
    for (const [glob, floors] of Object.entries(PER_PATH_THRESHOLDS)) {
      const honest = (HONEST_PER_PATH_THRESHOLDS as Record<string, { lines: number }>)[glob];
      expect({ glob, has: honest !== undefined }).toEqual({ glob, has: true });
      expect(honest?.lines).toBeGreaterThanOrEqual(floors.lines);
    }
  });

  test('the raw floors were NOT lowered to make room for the honest number', () => {
    expect(THRESHOLDS.lines).toBeGreaterThanOrEqual(77);
    expect(PER_PATH_THRESHOLDS[CORE_GLOB]?.lines).toBeGreaterThanOrEqual(78.5);
  });
});

describe('scripts/check-coverage.mjs — the honest floor, at its exact boundary', () => {
  const src = readFileSync(join(REPO_ROOT, REAL), 'utf8');
  const res = classifyLines(src, REAL);
  const classes: string[] = res.classes;
  const execLines = classes.flatMap((c, i) => (c === 'executable' ? [i + 1] : []));
  const noiseLines = classes.flatMap((c, i) => (c !== 'executable' ? [i + 1] : []));

  // Both files sit under the core glob, so the binding floor is the stricter one.
  const floor = Math.max(HONEST_THRESHOLDS.lines, HONEST_PER_PATH_THRESHOLDS[CORE_GLOB].lines);
  // A total whose floor product is not an integer, so "exactly at the floor" is
  // unambiguous in floating point: hit/T >= floor, (hit-1)/T < floor.
  const T = 2003;
  const hitNeeded = Math.ceil((floor * T) / 100);
  const fakeLines = T - execLines.length;
  const fakeHits = hitNeeded - execLines.length;

  function lcov(opts: { uncoverExec?: number; uncoverNoise?: number }): string {
    const real: Array<[number, number]> = classes.map((_, i) => {
      const line = i + 1;
      return [line, line === opts.uncoverExec || line === opts.uncoverNoise ? 0 : 1];
    });
    const fake: Array<[number, number]> = Array.from({ length: fakeLines }, (_, i) => [
      i + 1,
      i < fakeHits ? 1 : 0,
    ]);
    return [record(REAL, real), record(FAKE, fake, 10)].join('\n');
  }

  test('the fixture is meaningful: a real parsed file with both executable and noise lines', () => {
    expect(res.ok).toBe(true);
    expect(execLines.length).toBeGreaterThan(10);
    expect(noiseLines.length).toBeGreaterThan(10);
    expect(fakeHits).toBeGreaterThan(0);
    expect(fakeHits).toBeLessThan(fakeLines);
  });

  test('baseline: exactly at the honest floor, the gate is GREEN', () => {
    expect(runChecker(lcov({}))).toBe(0);
  });

  test('MUTATION: one uncovered EXECUTABLE line is counted and turns the gate RED', () => {
    expect(runChecker(lcov({ uncoverExec: execLines[0] }))).not.toBe(0);
  });

  test('negative control: one uncovered NOISE line moves nothing — still GREEN', () => {
    expect(runChecker(lcov({ uncoverNoise: noiseLines[0] }))).toBe(0);
  });
});
