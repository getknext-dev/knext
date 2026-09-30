import { describe, expect, it } from 'vitest';
import {
  extractRatchetFloors,
  findLoweredFloors,
  RATCHET_FLOOR_MARKER,
} from '../scripts/lib/ratchet-floors.mjs';

describe('extractRatchetFloors', () => {
  it('extracts a marked bare-scalar constant', () => {
    const source = `
// @ratchet-floor
const MIN_RESOLVED_PAIRS = 316;
`;
    expect(extractRatchetFloors(source, 'tests/x.test.ts')).toEqual({
      'tests/x.test.ts::MIN_RESOLVED_PAIRS': 316,
    });
  });

  it('extracts every marked constant in a file, independently', () => {
    const source = `
// @ratchet-floor
const MIN_RESOLVED_PAIRS = 316;
// @ratchet-floor
const MIN_RESOLVED_PROVERS = 24;
`;
    expect(extractRatchetFloors(source, 'tests/x.test.ts')).toEqual({
      'tests/x.test.ts::MIN_RESOLVED_PAIRS': 316,
      'tests/x.test.ts::MIN_RESOLVED_PROVERS': 24,
    });
  });

  it('extracts a marked flat-object constant, one leaf per key', () => {
    const source = `
/**
 * @ratchet-floor
 */
export const THRESHOLDS = {
  lines: 77,
  functions: 74,
};
`;
    expect(extractRatchetFloors(source, 'scripts/lib/coverage-policy.mjs')).toEqual({
      'scripts/lib/coverage-policy.mjs::THRESHOLDS.lines': 77,
      'scripts/lib/coverage-policy.mjs::THRESHOLDS.functions': 74,
    });
  });

  it('extracts a marked nested-object constant, one leaf per sub-key', () => {
    const source = `
// @ratchet-floor
export const PER_PATH_THRESHOLDS = {
  'packages/kn-next/src/**': {
    lines: 79.0,
    functions: 76,
  },
};
`;
    expect(extractRatchetFloors(source, 'x.mjs')).toEqual({
      'x.mjs::PER_PATH_THRESHOLDS.packages/kn-next/src/**.lines': 79.0,
      'x.mjs::PER_PATH_THRESHOLDS.packages/kn-next/src/**.functions': 76,
    });
  });

  it('ignores an unmarked constant entirely', () => {
    const source = `
const UNMARKED = 5;
`;
    expect(extractRatchetFloors(source, 'x.mjs')).toEqual({});
  });

  it('does NOT treat a mid-sentence mention of the marker as a real marker line (regression)', () => {
    // The guard's own header docs quote `@ratchet-floor` in prose while describing
    // the contract; that prose line has no declaration beneath it and must not throw.
    const source = `
/**
 * Reads every \`@ratchet-floor\`-marked constant and fails if it went down.
 */
const UNMARKED = 5;
`;
    expect(extractRatchetFloors(source, 'x.mjs')).toEqual({});
  });

  it('throws when a marker is not followed by a const declaration', () => {
    const source = `
// @ratchet-floor
function notAConst() {}
`;
    expect(() => extractRatchetFloors(source, 'x.mjs')).toThrow(/must be followed by/);
  });

  it('the marker constant itself is the literal scanned for', () => {
    expect(RATCHET_FLOOR_MARKER).toBe('@ratchet-floor');
  });
});

describe('findLoweredFloors', () => {
  it('reports no violations when every head value is >= base', () => {
    const base = { 'f.mjs::A': 10, 'f.mjs::B': 5 };
    const head = { 'f.mjs::A': 10, 'f.mjs::B': 6 };
    expect(findLoweredFloors(base, head)).toEqual([]);
  });

  it('reports a violation when a floor is lowered', () => {
    const base = { 'f.mjs::A': 10 };
    const head = { 'f.mjs::A': 9 };
    expect(findLoweredFloors(base, head)).toEqual([{ key: 'f.mjs::A', base: 10, head: 9 }]);
  });

  it('ignores a floor removed entirely at head (not this guard concern)', () => {
    const base = { 'f.mjs::A': 10 };
    const head = {};
    expect(findLoweredFloors(base, head)).toEqual([]);
  });

  it('suppresses a violation covered by an allowlist entry introduced at head', () => {
    const base = { 'f.mjs::A': 10 };
    const head = { 'f.mjs::A': 9 };
    const headAllowlist = [{ file: 'f.mjs', path: 'A', reason: 'deliberate', date: '2026-09-30' }];
    expect(findLoweredFloors(base, head, headAllowlist, [])).toEqual([]);
  });

  it('does NOT suppress a violation when the allowlist entry was inherited from base, not introduced', () => {
    const base = { 'f.mjs::A': 10 };
    const head = { 'f.mjs::A': 9 };
    const entry = { file: 'f.mjs', path: 'A', reason: 'deliberate', date: '2026-09-01' };
    // present at BOTH base and head => inherited, exempts nothing
    expect(findLoweredFloors(base, head, [entry], [entry])).toEqual([
      { key: 'f.mjs::A', base: 10, head: 9 },
    ]);
  });

  it('an allowlist entry for a DIFFERENT key does not suppress this violation', () => {
    const base = { 'f.mjs::A': 10 };
    const head = { 'f.mjs::A': 9 };
    const headAllowlist = [{ file: 'g.mjs', path: 'B', reason: 'x', date: '2026-09-30' }];
    expect(findLoweredFloors(base, head, headAllowlist, [])).toEqual([
      { key: 'f.mjs::A', base: 10, head: 9 },
    ]);
  });
});
