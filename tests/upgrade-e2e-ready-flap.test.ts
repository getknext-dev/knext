import { describe, expect, it } from 'bun:test';
import {
  cumulativeNotReadyMillis,
  evaluateReadyBound,
} from '../scripts/upgrade-e2e/ready-flap.mjs';

/**
 * Unit tests for the operator upgrade-under-load e2e's "no NextApp goes
 * not-Ready for longer than a stated bound" assertion (#1668). Pure — no
 * cluster, no fs — exercised against synthetic Ready-condition traces.
 *
 * The bound is CUMULATIVE (summed across every flap in the trace), not the
 * duration of the single longest flap — see ready-flap.mjs's docblock for
 * why, and the "many short flaps" test below for the case that
 * distinguishes the two.
 */
describe('cumulativeNotReadyMillis', () => {
  it('is zero when every sample is Ready', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'True' },
      { ts: 2000, status: 'True' },
    ];
    expect(cumulativeNotReadyMillis(samples)).toBe(0);
  });

  it('sums the gaps where status is not True', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' }, // not-Ready starts
      { ts: 4000, status: 'True' }, // not-Ready ends after 3000ms
      { ts: 5000, status: 'True' },
    ];
    expect(cumulativeNotReadyMillis(samples)).toBe(3000);
  });

  it('sorts out-of-order samples before folding', () => {
    const samples = [
      { ts: 4000, status: 'True' },
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' },
    ];
    expect(cumulativeNotReadyMillis(samples)).toBe(3000);
  });

  it('returns 0 for an empty trace (the caller must treat that as a failure)', () => {
    expect(cumulativeNotReadyMillis([])).toBe(0);
  });

  it('sums MULTIPLE separate flaps, none of which individually exceeds a bound the sum does', () => {
    // Three flaps of 40s each (120s cumulative) — no single flap exceeds a
    // 90s bound, but the sum must. This is what distinguishes "cumulative"
    // from "longest single flap": a longest-flap measure would pass this
    // trace; the cumulative measure this module implements must not.
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 10_000, status: 'False' },
      { ts: 50_000, status: 'True' }, // flap 1: 40s
      { ts: 60_000, status: 'False' },
      { ts: 100_000, status: 'True' }, // flap 2: 40s
      { ts: 110_000, status: 'False' },
      { ts: 150_000, status: 'True' }, // flap 3: 40s
    ];
    expect(cumulativeNotReadyMillis(samples)).toBe(120_000);
  });
});

describe('evaluateReadyBound', () => {
  it('fails an empty trace even though the raw fold is 0', () => {
    const result = evaluateReadyBound([], 90_000);
    expect(result.ok).toBe(false);
    expect(result.sampleCount).toBe(0);
  });

  it('passes when cumulative not-Ready time is within the bound', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' },
      { ts: 5000, status: 'True' },
    ];
    const result = evaluateReadyBound(samples, 10_000);
    expect(result.ok).toBe(true);
    expect(result.notReadyMillis).toBe(4000);
  });

  it('fails when cumulative not-Ready time exceeds the bound', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 1000, status: 'False' },
      { ts: 200_000, status: 'True' },
    ];
    const result = evaluateReadyBound(samples, 90_000);
    expect(result.ok).toBe(false);
    expect(result.notReadyMillis).toBe(199_000);
  });

  it('fails when the SUM of several sub-bound flaps exceeds the bound', () => {
    const samples = [
      { ts: 0, status: 'True' },
      { ts: 10_000, status: 'False' },
      { ts: 50_000, status: 'True' }, // flap 1: 40s (under the 90s bound alone)
      { ts: 60_000, status: 'False' },
      { ts: 100_000, status: 'True' }, // flap 2: 40s (under the 90s bound alone)
      { ts: 110_000, status: 'False' },
      { ts: 150_000, status: 'True' }, // flap 3: 40s (under the 90s bound alone)
    ];
    const result = evaluateReadyBound(samples, 90_000);
    expect(result.ok).toBe(false);
    expect(result.notReadyMillis).toBe(120_000);
  });
});
