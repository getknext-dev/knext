/**
 * The lcov merge that makes the coverage gate honest again (#884).
 *
 * Two runners now produce coverage — `vitest` (3 files) and `scripts/bun-test.mjs`
 * (the suite, one PROCESS per test file, so one lcov per file). Neither report
 * alone is the truth: vitest enumerates every source file (the honest
 * DENOMINATOR, untouched files at 0%) while bun's per-file reports carry almost
 * all of the executed lines (the NUMERATOR).
 *
 * This suite pins the merge rules, which are the fiddly part:
 *   - a line executed in ANY report is covered in the merge;
 *   - a file present in only one report survives;
 *   - a file NO runner touched stays at 0% and never vanishes — dropping it
 *     would raise the percentage by shrinking the denominator, which is the
 *     exact dishonesty this gate exists to prevent.
 */

import { describe, expect, test } from 'bun:test';
import { formatLcov, mergeLcov, parseLcov, summarize } from '../scripts/lib/lcov.mjs';

const record = (
  file: string,
  da: Array<[number, number]>,
  extra: { fnf?: number; fnh?: number } = {},
) =>
  [
    'TN:',
    `SF:${file}`,
    `FNF:${extra.fnf ?? 0}`,
    `FNH:${extra.fnh ?? 0}`,
    ...da.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${da.length}`,
    `LH:${da.filter(([, h]) => h > 0).length}`,
    'end_of_record',
  ].join('\n');

describe('parseLcov', () => {
  test('reads DA line hits, the function counts, and the file path', () => {
    const parsed = parseLcov(
      record(
        'packages/lib/src/a.ts',
        [
          [1, 3],
          [2, 0],
        ],
        { fnf: 4, fnh: 1 },
      ),
    );

    const a = parsed.get('packages/lib/src/a.ts');
    expect(a).toBeDefined();
    expect(a?.lines.get(1)).toBe(3);
    expect(a?.lines.get(2)).toBe(0);
    expect(a?.fnFound).toBe(4);
    expect(a?.fnHit).toBe(1);
  });

  test('reads vitest-style named function records (FN/FNDA)', () => {
    const parsed = parseLcov(
      [
        'TN:',
        'SF:packages/kn-next/src/b.ts',
        'FN:10,buildCR',
        'FNDA:0,buildCR',
        'FNF:1',
        'FNH:0',
        'DA:10,0',
        'end_of_record',
      ].join('\n'),
    );

    expect(parsed.get('packages/kn-next/src/b.ts')?.fnNames.get('buildCR')).toBe(0);
  });
});

describe('mergeLcov', () => {
  test('a line executed in EITHER report is executed in the merge', () => {
    const merged = mergeLcov([
      record('src/a.ts', [
        [1, 0],
        [2, 5],
      ]),
      record('src/a.ts', [
        [1, 7],
        [2, 0],
      ]),
    ]);

    expect(merged.get('src/a.ts')?.lines.get(1)).toBe(7);
    expect(merged.get('src/a.ts')?.lines.get(2)).toBe(5);
  });

  test('hit counts for the same line are SUMMED across reports', () => {
    const merged = mergeLcov([record('src/a.ts', [[1, 2]]), record('src/a.ts', [[1, 3]])]);
    expect(merged.get('src/a.ts')?.lines.get(1)).toBe(5);
  });

  test('a file present in only one report survives the merge', () => {
    const merged = mergeLcov([record('src/a.ts', [[1, 1]]), record('src/b.ts', [[1, 1]])]);
    expect([...merged.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('a file NO report executed stays in the merge at zero — it never vanishes', () => {
    const merged = mergeLcov([
      record('src/untouched.ts', [
        [1, 0],
        [2, 0],
      ]),
      record('src/covered.ts', [[1, 4]]),
    ]);

    expect(merged.has('src/untouched.ts')).toBe(true);
    const total = summarize(merged);
    // 3 lines known, 1 executed — the untouched file is still in the denominator.
    expect(total.linesFound).toBe(3);
    expect(total.linesHit).toBe(1);
  });

  test('lines only one report KNOWS about widen the denominator', () => {
    // bun reports only the lines of files it loaded; vitest enumerates all of
    // them. Taking the union of KNOWN lines (not just executed ones) is what
    // stops the bun half from silently shrinking the denominator.
    const merged = mergeLcov([
      record('src/a.ts', [[1, 1]]),
      record('src/a.ts', [
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    ]);

    const total = summarize(merged);
    expect(total.linesFound).toBe(3);
    expect(total.linesHit).toBe(1);
  });

  test('function counts merge as a conservative lower bound (bun emits no names)', () => {
    // bun's lcov carries FNF/FNH counts with no per-function identity, so a true
    // union is impossible. max() under-reports at worst, which is the safe
    // direction for a floor.
    const merged = mergeLcov([
      record('src/a.ts', [[1, 1]], { fnf: 10, fnh: 6 }),
      record('src/a.ts', [[1, 0]], { fnf: 10, fnh: 4 }),
    ]);

    expect(merged.get('src/a.ts')?.fnFound).toBe(10);
    expect(merged.get('src/a.ts')?.fnHit).toBe(6);
  });

  test('named function records union across reports', () => {
    const named = (name: string, hits: number) =>
      [
        'TN:',
        'SF:src/a.ts',
        `FN:1,${name}`,
        `FNDA:${hits},${name}`,
        'FNF:2',
        `FNH:${hits > 0 ? 1 : 0}`,
        'DA:1,0',
        'end_of_record',
      ].join('\n');

    const merged = mergeLcov([named('one', 1), named('two', 3)]);
    expect(merged.get('src/a.ts')?.fnHit).toBe(2);
  });
});

describe('summarize', () => {
  const merged = mergeLcov([
    record('packages/kn-next/src/deep/a.ts', [
      [1, 1],
      [2, 0],
    ]),
    record('packages/lib/src/b.ts', [
      [1, 1],
      [2, 1],
    ]),
  ]);

  test('reports the global totals as percentages', () => {
    const total = summarize(merged);
    expect(total.linesFound).toBe(4);
    expect(total.linesHit).toBe(3);
    expect(total.linesPct).toBeCloseTo(75, 5);
  });

  test('restricts to a path prefix so the per-package floor is measurable', () => {
    const core = summarize(merged, 'packages/kn-next/src/**');
    expect(core.linesFound).toBe(2);
    expect(core.linesHit).toBe(1);
    expect(core.linesPct).toBeCloseTo(50, 5);
  });

  test('an empty selection reports 0 found rather than dividing by zero', () => {
    const none = summarize(merged, 'packages/nope/src/**');
    expect(none.linesFound).toBe(0);
    expect(none.linesPct).toBe(0);
  });
});

describe('formatLcov', () => {
  test('round-trips through parse without losing a file or a line', () => {
    const merged = mergeLcov([
      record(
        'src/a.ts',
        [
          [1, 2],
          [7, 0],
        ],
        { fnf: 3, fnh: 1 },
      ),
    ]);
    const reparsed = parseLcov(formatLcov(merged));

    expect(reparsed.get('src/a.ts')?.lines.get(1)).toBe(2);
    expect(reparsed.get('src/a.ts')?.lines.get(7)).toBe(0);
    expect(reparsed.get('src/a.ts')?.fnFound).toBe(3);
    expect(reparsed.get('src/a.ts')?.fnHit).toBe(1);
  });
});
