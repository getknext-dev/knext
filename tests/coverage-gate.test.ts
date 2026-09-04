/**
 * The coverage gate, after it stopped being vitest's job (#884).
 *
 * `vitest.config.ts` used to carry the thresholds, and after the bun migration
 * it was checking them against 3 collected files out of 338. The floors now live
 * in ONE module (`scripts/lib/coverage-policy.mjs`) read by both consumers —
 * vitest's config, for its include/exclude denominator, and
 * `scripts/check-coverage.mjs`, which enforces them over the MERGED lcov of both
 * runners.
 *
 * These tests are the mutation proof for that checker: it must go RED on a
 * merged report below a floor. Every assertion branches on the process EXIT
 * CODE, never on the text — a pass/fail grep has certified an all-green run of
 * decorative mutations in this repo before.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PER_PATH_THRESHOLDS, THRESHOLDS } from '../scripts/lib/coverage-policy.mjs';
import { auditCoverageWiring } from '../scripts/lib/coverage-wiring.mjs';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-coverage.mjs');

/** An lcov record whose line coverage is exactly `pct`, over `total` lines. */
function lcovAt(file: string, pct: number, total = 100): string {
  const hit = Math.round((pct / 100) * total);
  const da = Array.from({ length: total }, (_, i) => `DA:${i + 1},${i < hit ? 1 : 0}`);
  return ['TN:', `SF:${file}`, `FNF:${total}`, `FNH:${hit}`, ...da, 'end_of_record'].join('\n');
}

function runChecker(lcovs: string[]): number {
  const dir = mkdtempSync(join(tmpdir(), 'knext-cov-'));
  const args = lcovs.map((text, i) => {
    const p = join(dir, `r${i}.info`);
    writeFileSync(p, `${text}\n`);
    return `--lcov=${p}`;
  });
  const res = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  // A checker that cannot run at all must not read as a pass; surface it.
  if (res.status === null) throw new Error(`checker did not exit: ${res.error?.message}`);
  return res.status;
}

const CORE_GLOB = 'packages/kn-next/src/**';

describe('scripts/check-coverage.mjs', () => {
  test('exits 0 when the merged report clears every floor', () => {
    expect(
      runChecker([lcovAt('packages/kn-next/src/a.ts', 100), lcovAt('packages/lib/src/b.ts', 100)]),
    ).toBe(0);
  });

  test('exits non-zero when the GLOBAL line floor is missed', () => {
    // Both files well under the global floor.
    const under = Math.max(0, THRESHOLDS.lines - 20);
    expect(
      runChecker([
        lcovAt('packages/kn-next/src/a.ts', under),
        lcovAt('packages/lib/src/b.ts', under),
      ]),
    ).not.toBe(0);
  });

  test('exits non-zero when only the PER-PACKAGE floor is missed', () => {
    // The aggregate is carried over the global floor by another package, exactly
    // the masking the per-package floor was added to prevent: a 100%-covered
    // 400-line lib against a starved kn-next.
    const coreUnder = Math.max(0, PER_PATH_THRESHOLDS[CORE_GLOB].lines - 20);
    expect(
      runChecker([
        lcovAt('packages/kn-next/src/a.ts', coreUnder, 100),
        lcovAt('packages/lib/src/b.ts', 100, 400),
      ]),
    ).not.toBe(0);
  });

  test('MERGES the two runners rather than judging either alone', () => {
    // Same file, complementary halves: neither report clears the floor on its
    // own, the union does. This is the whole point of option A.
    const half = (from: number) =>
      [
        'TN:',
        'SF:packages/kn-next/src/a.ts',
        // Function data is present in both halves so the line merge is what the
        // assertion turns on; a metric with no data at all reds by design.
        'FNF:10',
        'FNH:10',
        ...Array.from(
          { length: 100 },
          (_, i) => `DA:${i + 1},${i >= from && i < from + 50 ? 1 : 0}`,
        ),
        'end_of_record',
      ].join('\n');

    expect(runChecker([half(0)])).not.toBe(0);
    expect(runChecker([half(0), half(50)])).toBe(0);
  });

  test('a file NO runner touched drags the result down instead of vanishing', () => {
    // The honest-denominator invariant. If untouched files were dropped, this
    // pair would report 100% and pass.
    expect(
      runChecker([
        lcovAt('packages/kn-next/src/covered.ts', 100),
        lcovAt('packages/kn-next/src/untouched.ts', 0),
      ]),
    ).not.toBe(0);
  });

  test('refuses when it is handed no coverage at all', () => {
    // A gate that goes green on a missing input measures nothing — the failure
    // mode this issue exists to fix.
    const res = spawnSync(process.execPath, [CHECKER, '--lcov=/nonexistent/lcov.info'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.status).not.toBe(0);
  });
});

describe('ci.yml runs the gate, and feeds it', () => {
  const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  test('the real workflow wires all three steps, in order and undisarmed', () => {
    expect(auditCoverageWiring(ci)).toEqual([]);
  });

  /**
   * The mutation proof for the guard above, run IN MEMORY.
   *
   * A guard that stays green when its subject is removed is decoration, so each
   * case below deletes exactly one load-bearing piece of the workflow and the
   * auditor must report it. Each mutation asserts its anchor occurs exactly once
   * first: a silently-failed substitution yields a green run that proves
   * nothing, which is how this repo once certified 14 decorative mutations.
   *
   * In memory rather than on disk deliberately — nothing to restore, so no
   * mutation residue can survive into a commit inside a file that is legitimately
   * modified, where `git status` cannot see it.
   */
  const mutations: Array<[string, string, string]> = [
    [
      'the bun runner stops passing --coverage',
      'run: node scripts/bun-test.mjs --coverage',
      'run: node scripts/bun-test.mjs',
    ],
    [
      'vitest stops passing --coverage',
      'run: bun x vitest run --coverage',
      'run: bun x vitest run',
    ],
    ['the gate stops running at all', 'run: node scripts/check-coverage.mjs', 'run: echo skipped'],
    [
      'the gate is disarmed with continue-on-error',
      '      - name: Coverage gate (merged across both runners)\n',
      '      - name: Coverage gate (merged across both runners)\n        continue-on-error: true\n',
    ],
    [
      'the gate is made conditional',
      '      - name: Coverage gate (merged across both runners)\n',
      '      - name: Coverage gate (merged across both runners)\n        if: false\n',
    ],
  ];

  for (const [what, anchor, replacement] of mutations) {
    test(`the guard CATCHES: ${what}`, () => {
      expect(ci.split(anchor).length - 1, `anchor must occur exactly once: ${anchor}`).toBe(1);
      expect(auditCoverageWiring(ci.replace(anchor, replacement)).length).toBeGreaterThan(0);
    });
  }

  test('moving the gate BEFORE the runners is caught', () => {
    // Order is load-bearing: the checker merges what the runners left on disk.
    const reordered = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - name: Coverage gate (merged across both runners)',
      '        run: node scripts/check-coverage.mjs',
      '      - name: Run tests (bun)',
      '        run: node scripts/bun-test.mjs --coverage',
      '      - name: Run tests (vitest)',
      '        run: bun x vitest run --coverage',
      '',
    ].join('\n');
    expect(auditCoverageWiring(reordered).length).toBeGreaterThan(0);
  });
});

describe('the thresholds live in exactly one place', () => {
  test('vitest.config.ts declares no thresholds of its own', () => {
    // Two copies of a floor means one of them is wrong and nothing says which.
    // vitest keeps the include/exclude denominator; the floors are the
    // checker's, because vitest can only see the 3 files it collects.
    const config = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).not.toMatch(/^\s*thresholds:/m);
  });

  test('vitest.config.ts takes its include/exclude from the policy module', () => {
    const config = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/coverage-policy\.mjs/);
  });

  test('the policy carries the floors the ratchet was set to', () => {
    expect(THRESHOLDS.lines).toBeGreaterThanOrEqual(70);
    expect(PER_PATH_THRESHOLDS[CORE_GLOB].lines).toBeGreaterThanOrEqual(THRESHOLDS.lines);
  });
});
