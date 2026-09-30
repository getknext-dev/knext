import { describe, expect, it } from 'bun:test';
import { evaluateErrorBudget } from '../scripts/upgrade-e2e/error-budget.mjs';

/**
 * Unit tests for the operator upgrade-under-load e2e's error-budget
 * assertion (#1668). Pure — no cluster, no fs — so the pass/fail logic is
 * exercised directly against synthetic attempt logs.
 */
describe('evaluateErrorBudget', () => {
  it('passes when the error rate is within budget', () => {
    const attempts = [
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: false }, // 1/5 = 20%... use a bigger sample for a tight budget below
    ];
    const result = evaluateErrorBudget(attempts, 0.5);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(5);
    expect(result.errors).toBe(1);
    expect(result.rate).toBeCloseTo(0.2, 5);
  });

  it('fails when the error rate exceeds the stated budget', () => {
    const attempts = Array.from({ length: 100 }, (_, i) => ({ ok: i >= 5 })); // 5% errors
    const result = evaluateErrorBudget(attempts, 0.02); // 2% budget
    expect(result.ok).toBe(false);
    expect(result.errors).toBe(5);
    expect(result.rate).toBeCloseTo(0.05, 5);
  });

  it('treats zero attempts as a failure, never a vacuous pass', () => {
    const result = evaluateErrorBudget([], 0.5);
    expect(result.ok).toBe(false);
    expect(result.total).toBe(0);
  });

  it('treats a non-boolean ok field as an error, not a pass', () => {
    const attempts = [{ ok: true }, { status: 500 }];
    const result = evaluateErrorBudget(attempts, 0.5);
    expect(result.errors).toBe(1);
  });

  it('rejects an out-of-range budget', () => {
    expect(() => evaluateErrorBudget([], 1.5)).toThrow(RangeError);
    expect(() => evaluateErrorBudget([], -0.1)).toThrow(RangeError);
  });

  it('rejects a non-array attempts value', () => {
    // @ts-expect-error deliberate misuse for the guard
    expect(() => evaluateErrorBudget(null, 0.5)).toThrow(TypeError);
  });
});
