import { describe, expect, it } from 'bun:test';
import { evaluateDiskFloor } from '../scripts/compat-disk-floor-check.mjs';

/**
 * #1530 (sprint B4) — the free-disk floor must fail a shard as an INFRA
 * fault, never silently pass on unreadable input.
 */

describe('evaluateDiskFloor', () => {
  it('passes when free space is at or above the floor', () => {
    const v = evaluateDiskFloor({ freeBytes: 10e9, floorBytes: 5e9 });
    expect(v.ok).toBe(true);
    expect(v.state).toBe('ok');
  });

  it('passes at exactly the floor (inclusive)', () => {
    const v = evaluateDiskFloor({ freeBytes: 5e9, floorBytes: 5e9 });
    expect(v.ok).toBe(true);
  });

  it('fails below the floor', () => {
    const v = evaluateDiskFloor({ freeBytes: 1e9, floorBytes: 5e9 });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('below-floor');
  });

  it('fails closed on unreadable free space (null)', () => {
    const v = evaluateDiskFloor({ freeBytes: null, floorBytes: 5e9 });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('unreadable');
  });

  it('fails closed on non-finite free space (NaN)', () => {
    const v = evaluateDiskFloor({ freeBytes: Number.NaN, floorBytes: 5e9 });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('unreadable');
  });

  it('fails closed on a negative free-space reading', () => {
    const v = evaluateDiskFloor({ freeBytes: -1, floorBytes: 5e9 });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('unreadable');
  });
});
