/**
 * The honest-denominator generator, exercised over its REAL logic (#871, #884).
 *
 * `scripts/lib/coverage-denominator.mjs` replaced vitest's only remaining job:
 * enumerating every source file so one NO test loads shows at 0% and drags the
 * percentage down. `tests/coverage-gate.test.ts` proves the CHECKER over
 * `--lcov=` inputs, but that mode deliberately SKIPS the generator — so without
 * this file the actual new path (`isTypeOnly` skip + `countCodeLines`) would be
 * pinned by nothing but a static grep.
 *
 * These tests feed the generator real files under `os.tmpdir()` (NEVER the
 * checkout — #918) and MUTATION-PROVE the load-bearing direction: a RUNTIME file
 * a test never loaded must land in the denominator at 0%. If `isTypeOnly`
 * regressed to `return true`, every untested file would be skipped, the
 * denominator would shrink, coverage would rise, and the gate would pass on less
 * — the exact #884 defect. The `linesPct < 100` assertions below go RED the
 * moment that happens.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateDenominator } from '../scripts/lib/coverage-denominator.mjs';
import { countCodeLines, isTypeOnly, mergeLcov, summarize } from '../scripts/lib/lcov.mjs';

/** A runtime source file: it transpiles to real JS, so a provider instruments it. */
const RUNTIME_SRC = [
  'export function add(a, b) {',
  '  const sum = a + b;',
  '  return sum;',
  '}',
  'export const doubled = (n) => add(n, n);',
].join('\n');

/** A type-only source file: it transpiles to nothing, so a provider instruments 0 lines. */
const TYPE_ONLY_SRC = [
  'export interface Shape {',
  '  width: number;',
  '  height: number;',
  '}',
  'export type Size = Shape[keyof Shape];',
  "import type { Shape as S } from './other';",
  'export type Alias = S;',
].join('\n');

/** A fully-covered lcov entry over `lines` lines, for the `have` map. */
function coveredEntry(lines: number) {
  return {
    lines: new Map(Array.from({ length: lines }, (_, i) => [i + 1, 1])),
    fnFound: 0,
    fnHit: 0,
    fnNames: new Map<string, number>(),
  };
}

/** Write files under a throwaway os.tmpdir root; returns the root + the relative paths. */
function makeTree(files: Record<string, string>): {
  root: string;
  paths: string[];
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'knext-denom-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return {
    root,
    paths: Object.keys(files),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('isTypeOnly (the load-bearing skip rule)', () => {
  it('a RUNTIME file is never type-only — it must stay in the denominator', () => {
    // The direction that guards #884: if this ever returned true for runtime
    // code, that code would silently escape the denominator. Mutating
    // `isTypeOnly` to `return true` reds exactly here.
    expect(isTypeOnly(RUNTIME_SRC)).toBe(false);
  });

  it('a type-only file IS type-only — a provider instruments zero of its lines', () => {
    expect(isTypeOnly(TYPE_ONLY_SRC)).toBe(true);
  });
});

describe('countCodeLines', () => {
  it('counts code lines, ignoring blanks and comment-only lines', () => {
    const src = [
      '// a line comment',
      '',
      'const a = 1;',
      '/* block',
      '   still comment */',
      'const b = 2;',
      '   ',
      'const c = 3;',
    ].join('\n');
    expect(countCodeLines(src)).toBe(3);
  });

  it('is non-zero for real runtime code', () => {
    expect(countCodeLines(RUNTIME_SRC)).toBeGreaterThan(0);
  });
});

describe('generateDenominator', () => {
  it('folds an untested RUNTIME file into the denominator at 0%, dragging coverage DOWN', () => {
    const { root, paths, cleanup } = makeTree({
      'packages/z/src/covered.ts': RUNTIME_SRC,
      'packages/z/src/untouched.ts': RUNTIME_SRC,
      'packages/z/src/types.ts': TYPE_ONLY_SRC,
    });
    try {
      // Only `covered.ts` was "loaded" by a test.
      const have = new Map([
        ['packages/z/src/covered.ts', coveredEntry(countCodeLines(RUNTIME_SRC))],
      ]);
      const entries = generateDenominator(root, paths, have);
      const byPath = new Map(entries);

      // The untested RUNTIME file is present, at zero hits. THIS is the mutation
      // proof: `isTypeOnly → return true` drops it and this fails.
      expect(byPath.has('packages/z/src/untouched.ts')).toBe(true);
      const untouched = byPath.get('packages/z/src/untouched.ts');
      expect(untouched && [...untouched.lines.values()].every((h) => h === 0)).toBe(true);
      expect(untouched && untouched.lines.size).toBeGreaterThan(0);

      // The type-only file is NOT added — a provider instruments zero of its lines.
      expect(byPath.has('packages/z/src/types.ts')).toBe(false);

      // The already-measured file is not duplicated into the denominator.
      expect(byPath.has('packages/z/src/covered.ts')).toBe(false);

      // End to end: merge the measured file with the generated denominator and
      // summarise. The untested file MUST pull the percentage below 100 — if it
      // had been dropped, this would read a dishonest 100%.
      const merged = mergeLcov([have, new Map(entries)]);
      const summary = summarize(merged, 'packages/z/src/**');
      expect(summary.linesPct).toBeLessThan(100);
      expect(summary.linesPct).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('excludes test/decl/config files from the denominator (policy exclude honoured)', () => {
    const { root, paths, cleanup } = makeTree({
      'packages/z/src/real.ts': RUNTIME_SRC,
      'packages/z/src/real.test.ts': RUNTIME_SRC,
      'packages/z/src/types.d.ts': 'export declare const x: number;',
      'packages/z/src/thing.config.ts': RUNTIME_SRC,
    });
    try {
      const kept = new Set(generateDenominator(root, paths, new Map()).map(([p]) => p));
      expect(kept.has('packages/z/src/real.ts')).toBe(true);
      expect(kept.has('packages/z/src/real.test.ts')).toBe(false);
      expect(kept.has('packages/z/src/types.d.ts')).toBe(false);
      expect(kept.has('packages/z/src/thing.config.ts')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('ignores a path outside the include globs and a file that does not exist', () => {
    const { root, paths, cleanup } = makeTree({
      'packages/z/src/keep.ts': RUNTIME_SRC,
      'apps/z/not-included.ts': RUNTIME_SRC,
    });
    try {
      // A path in the list whose file is missing must be silently skipped, not throw.
      const withGhost = [...paths, 'packages/z/src/ghost.ts'];
      const kept = new Set(generateDenominator(root, withGhost, new Map()).map(([p]) => p));
      expect(kept.has('packages/z/src/keep.ts')).toBe(true);
      expect(kept.has('apps/z/not-included.ts')).toBe(false);
      expect(kept.has('packages/z/src/ghost.ts')).toBe(false);
    } finally {
      cleanup();
    }
  });
});
