import { describe, expect, it } from 'bun:test';
import { assessCompletion, evaluatePreflight } from '../scripts/lib/prover-completion.mjs';

/**
 * GUARD TEST — a mutation prover that stops partway must FAIL, not report a
 * partial success. (#545, #710)
 *
 * WHAT WENT WRONG, MEASURED
 * -------------------------
 * `scripts/mutation-prove-retracted-figures.mjs` — the prover for this PR's
 * flagship guard — died at M10 because `60bae6d` ran biome over the ledger and
 * collapsed the `patterns` array onto one line, invalidating an anchor that
 * spanned two lines at a fixed indent. It executed **9 of 11** mutations. M10
 * and the **negative control** never ran. The only signal was an unhandled
 * stack trace after nine `ok` lines, and a tracked report claimed the prover
 * completed.
 *
 * WHY THE MISSING CONTROL IS THE SERIOUS PART
 * -------------------------------------------
 * Nine reds with no control is not 82% of a proof. Reds alone cannot establish
 * that a prover distinguishes a guard from a tripwire — something that reds at
 * ANY edit reds at EVERY edit and would score 9/9. Ruling that out is the
 * control's entire job, so a run that skips it has proved nothing about the
 * prover, however many reds it collected.
 *
 * BOTH HALVES
 * -----------
 *   1. a complete, control-inclusive run is judged OK (otherwise the guard is
 *      unpassable and gets deleted);
 *   2. every way a run can fall short is judged NOT ok — including the case
 *      where the count is complete but no control was ever in the plan, which
 *      a count check alone cannot see.
 */

const complete = {
  declaredIds: ['M1', 'M2', 'NC'],
  executedIds: ['M1', 'M2', 'NC'],
  controlId: 'NC',
  died: null,
};

describe('a complete run passes (the positive half)', () => {
  it('accepts a run that executed everything it declared, control included', () => {
    const v = assessCompletion(complete);
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.neverRan).toEqual([]);
  });
});

describe('every way a run falls short is a FAILURE (the negative half)', () => {
  it('fails when the run died partway, naming where', () => {
    const v = assessCompletion({
      ...complete,
      executedIds: ['M1'],
      died: { id: 'M2', message: 'anchor occurs 0 times' },
    });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain('died at M2');
  });

  it('fails when fewer mutations executed than were declared', () => {
    const v = assessCompletion({ ...complete, executedIds: ['M1', 'M2'] });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('declared 3, executed 2');
  });

  it('names exactly which mutations never ran', () => {
    const v = assessCompletion({ ...complete, executedIds: ['M1'] });
    expect(v.neverRan).toEqual(['M2', 'NC']);
  });

  it('THE M10 SHAPE: nine reds and no control is a failure, not a partial success', () => {
    const declaredIds = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'NC'];
    const v = assessCompletion({
      declaredIds,
      executedIds: declaredIds.slice(0, 9),
      controlId: 'NC',
      died: { id: 'M10', message: 'anchor occurs 0 times' },
    });
    expect(v.ok).toBe(false);
    expect(v.neverRan).toEqual(['M10', 'NC']);
    expect(v.reasons.join(' ')).toContain('NEGATIVE CONTROL never ran');
  });

  it('fails when the control never ran EVEN IF the declared count is complete', () => {
    // The case a count check alone cannot see: a plan that is internally
    // consistent but contains no control at all. Reds establish nothing here.
    const v = assessCompletion({
      declaredIds: ['M1', 'M2'],
      executedIds: ['M1', 'M2'],
      controlId: null,
      died: null,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('NEGATIVE CONTROL never ran');
  });

  it('fails when a control is declared but was not among the executed', () => {
    const v = assessCompletion({
      declaredIds: ['M1', 'NC'],
      executedIds: ['M1', 'M1'],
      controlId: 'NC',
      died: null,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('NEGATIVE CONTROL never ran');
  });
});

describe('preflight resolves every anchor before anything is planted', () => {
  it('passes when every anchor occurs exactly once', () => {
    const v = evaluatePreflight([
      { id: 'M1', count: 1 },
      { id: 'M2', count: 1 },
    ]);
    expect(v.ok).toBe(true);
    expect(v.stale).toEqual([]);
  });

  it('fails a MISSING anchor — the M10 shape a formatter created', () => {
    const v = evaluatePreflight([
      { id: 'M1', count: 1 },
      { id: 'M10', count: 0 },
    ]);
    expect(v.ok).toBe(false);
    expect(v.stale).toEqual([{ id: 'M10', count: 0 }]);
  });

  it('fails an AMBIGUOUS anchor too — a substitution that could hit either site', () => {
    const v = evaluatePreflight([{ id: 'M3', count: 2 }]);
    expect(v.ok).toBe(false);
    expect(v.stale).toEqual([{ id: 'M3', count: 2 }]);
  });

  it('reports EVERY stale anchor at once, not just the first', () => {
    // The point of preflighting: a crash reports one anchor per run, so
    // repointing three of them takes three runs. This reports all three.
    const v = evaluatePreflight([
      { id: 'M1', count: 0 },
      { id: 'M2', count: 1 },
      { id: 'M3', count: 2 },
      { id: 'M4', count: 0 },
    ]);
    expect(v.stale.map((s: { id: string }) => s.id)).toEqual(['M1', 'M3', 'M4']);
  });
});
