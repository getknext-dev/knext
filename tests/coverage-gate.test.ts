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
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import {
  activeMetricExceptions,
  assertEveryMetricAccountedFor,
  COVERAGE_METRIC_EXCEPTIONS,
  PER_PATH_THRESHOLDS,
  THRESHOLDS,
} from '../scripts/lib/coverage-policy.mjs';
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

describe('the branch/statement loss is a DATED exception, not prose (sprint 2, lane G)', () => {
  /**
   * WHAT THIS REPLACES. `docs/benchmarks/coverage-baseline.md` recorded, in
   * prose, that bun's lcov carries no `BRDA`/`BRF`/`BRH` so branch coverage does
   * not survive the merge, and that `statements` has no lcov representation at
   * all. Both floors were therefore dropped. That reasoning was correct and the
   * decision was right — but a paragraph is not a control. Nothing re-asks the
   * question, nothing dates it, and `security.md`'s own standard applies: a
   * documented expectation degrades, and its efficacy is unobservable until it
   * has already failed. Two metrics stopped being gated, and the only thing
   * between that and permanence was somebody remembering.
   *
   * So it becomes the shape the repo already uses for an accepted Trivy or
   * npm-audit finding (`precompile-closure.mjs:206-248`): an entry with a
   * justification, an `added` date and an `expires` date, where an unknown key
   * THROWS — a typo'd `expiress` is otherwise an exception that never expires
   * while reading as one that does — and where expiry FAILS CLOSED rather than
   * quietly resuming the ungated behaviour.
   */
  test('branches and statements are both excused, and by name', () => {
    const metrics = COVERAGE_METRIC_EXCEPTIONS.map((e) => e.metric).sort();
    expect(metrics).toEqual(['branches', 'statements']);
  });

  test('every exception carries a justification and both dates', () => {
    for (const e of COVERAGE_METRIC_EXCEPTIONS) {
      expect(e.justification.length, `${e.metric}: no justification`).toBeGreaterThan(40);
      expect(e.added, `${e.metric}: added`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.expires, `${e.metric}: expires`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        new Date(`${e.expires}T00:00:00Z`).getTime(),
        `${e.metric}: expires before it was added`,
      ).toBeGreaterThan(new Date(`${e.added}T00:00:00Z`).getTime());
    }
  });

  test('an unexpired exception suppresses its metric', () => {
    const active = activeMetricExceptions(new Date('2026-09-05T00:00:00Z'));
    expect([...active].sort()).toEqual(['branches', 'statements']);
  });

  test('EXPIRY FAILS CLOSED — a lapsed exception stops suppressing', () => {
    // The whole point. Read at a date past every `expires`, nothing is excused,
    // so the gate has to fail rather than carry on ungated.
    const active = activeMetricExceptions(new Date('2099-01-01T00:00:00Z'));
    expect([...active]).toEqual([]);
  });

  test('a MISSING expires is rejected — an exception with no clock is not an exception', () => {
    expect(() =>
      activeMetricExceptions(new Date(), [
        { metric: 'branches', justification: 'x'.repeat(50), added: '2026-09-04' },
      ]),
    ).toThrow(/expires/);
  });

  test("a typo'd key THROWS rather than being ignored", () => {
    // `expiress` would otherwise parse as an entry with no expiry at all — an
    // exception that never lapses, wearing the appearance of one that does.
    expect(() =>
      activeMetricExceptions(new Date(), [
        {
          metric: 'branches',
          justification: 'x'.repeat(50),
          added: '2026-09-04',
          expiress: '2026-12-01',
        },
      ]),
    ).toThrow(/expiress/);
  });

  test('a metric with neither a floor nor a live exception is a FAILURE', () => {
    // The half that makes the exception mean anything. If `branches` were simply
    // deleted from the list without a floor appearing, the gate must notice —
    // otherwise "expired" and "quietly removed" look identical from outside.
    expect(() => assertEveryMetricAccountedFor({ lines: 77 }, new Set())).toThrow(/branches/);
  });

  test('a metric excused by a LIVE exception is accounted for', () => {
    expect(() =>
      assertEveryMetricAccountedFor(
        { lines: 77, functions: 74 },
        new Set(['branches', 'statements']),
      ),
    ).not.toThrow();
  });

  test('the gate script consults the exceptions (the wiring is not decoration)', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'scripts/check-coverage.mjs'), 'utf8');
    expect(blankNonCode(source)).toMatch(/assertEveryMetricAccountedFor\s*\(/);
  });
});
