import { describe, expect, it } from 'bun:test';
import { evaluateReadyBound, totalNotReadyMillis } from '../scripts/upgrade-e2e/ready-flap.mjs';

/**
 * Unit tests for the operator upgrade-under-load e2e's "no NextApp goes
 * not-Ready for longer than a stated bound" assertion (#1668). Pure — no
 * cluster, no fs — exercised against synthetic Ready-condition traces.
 */
describe('totalNotReadyMillis', () => {
  it('is zero when every sample is Ready', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'True' },
      { ts: 2000, status: 'True' },
    ];
    expect(totalNotReadyMillis(samples)).toBe(0);
  });

  it('sums the gaps where status is not True', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' }, // not-Ready starts
      { ts: 4000, status: 'True' }, // not-Ready ends after 3000ms
      { ts: 5000, status: 'True' },
    ];
    expect(totalNotReadyMillis(samples)).toBe(3000);
  });

  it('sorts out-of-order samples before folding', () => {
    const samples = [
      { ts: 4000, status: 'True' },
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' },
    ];
    expect(totalNotReadyMillis(samples)).toBe(3000);
  });

  it('returns 0 for an empty trace (the caller must treat that as a failure)', () => {
    expect(totalNotReadyMillis([])).toBe(0);
  });
});

describe('evaluateReadyBound', () => {
  it('fails an empty trace even though the raw fold is 0', () => {
    const result = evaluateReadyBound([], 90_000);
    expect(result.ok).toBe(false);
    expect(result.sampleCount).toBe(0);
  });

  it('passes when total not-Ready time is within the bound', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' },
      { ts: 5000, status: 'True' },
    ];
    const result = evaluateReadyBound(samples, 10_000);
    expect(result.ok).toBe(true);
    expect(result.notReadyMillis).toBe(4000);
  });

  it('fails when total not-Ready time exceeds the bound', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' },
      { ts: 200_000, status: 'True' },
    ];
    const result = evaluateReadyBound(samples, 90_000);
    expect(result.ok).toBe(false);
    expect(result.notReadyMillis).toBe(199_000);
  });
});
