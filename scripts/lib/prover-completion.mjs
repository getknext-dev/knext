/**
 * Did a mutation prover actually finish? (#545, #710)
 *
 * WHY THIS IS A MODULE AND NOT AN `if` INSIDE THE PROVER
 * ------------------------------------------------------
 * `scripts/mutation-prove-retracted-figures.mjs` died at M10 on an anchor a
 * formatter had invalidated. It executed 9 of 11 mutations, the NEGATIVE CONTROL
 * never ran, and the only signal was an unhandled stack trace printed after nine
 * `ok` lines — while a tracked report claimed the prover completed.
 *
 * Nine reds with no control is not a partial success. It is an **unproven
 * prover**: reds alone cannot show that a prover distinguishes a guard from a
 * tripwire, because something that reds at any edit reds at every edit. That is
 * the whole job of the control, and it is the one thing the run skipped.
 *
 * The guard against that is itself a guard, so it has to be testable and
 * mutable rather than an inline conditional nobody can exercise — the same
 * reason `assembleSources` was lifted out of the resolver. Both functions here
 * are pure: no I/O, no process exit, no logging. The caller decides what to do
 * with the verdict.
 */

/**
 * PREFLIGHT — do all the mutation anchors resolve, before anything is planted?
 *
 * The byte-snapshot harness already refuses a substitution whose anchor is not
 * unique, and that refusal is what stops a silently-failed mutation being
 * scored. But it fires mid-run, one mutation at a time, after earlier mutations
 * have already executed — so a stale anchor reads as "the prover crashed"
 * instead of "these anchors need repointing". Checking the whole plan up front
 * turns a crash into a report, with the tree still untouched.
 *
 * @param {Array<{id: string, count: number}>} anchorCounts
 *   One entry per planned mutation: how many times its anchor occurs in its
 *   target file.
 * @returns {{ok: boolean, stale: Array<{id: string, count: number}>}}
 */
export function evaluatePreflight(anchorCounts) {
  const stale = anchorCounts
    .filter((a) => a.count !== 1)
    .map((a) => ({ id: a.id, count: a.count }));
  return { ok: stale.length === 0, stale };
}

/**
 * COMPLETION — did the run reach the end, and did the control run?
 *
 * Three independent ways a run can fail to prove what it claims, all of which
 * must be caught:
 *
 *   1. it **died** partway (an exception, a stale anchor, a killed runner);
 *   2. it executed **fewer** mutations than it declared — the mismatch the
 *      prover-lane audit also checks, restated here so the prover itself is
 *      loud rather than relying on a downstream reader;
 *   3. the **negative control did not run**, which is separate from (2): a plan
 *      could execute its declared count while the control was never in the plan
 *      at all, and reds alone establish nothing about discrimination.
 *
 * `reasons` is ordered most-diagnostic first, so a caller printing them puts the
 * cause before the consequences.
 *
 * @param {{declaredIds: string[], executedIds: string[], controlId: string|null,
 *          died: {id: string, message: string}|null}} run
 * @returns {{ok: boolean, reasons: string[], neverRan: string[]}}
 */
export function assessCompletion({ declaredIds, executedIds, controlId, died }) {
  const executed = new Set(executedIds);
  const neverRan = declaredIds.filter((id) => !executed.has(id));
  const reasons = [];

  if (died) reasons.push(`died at ${died.id}: ${died.message}`);
  if (executedIds.length !== declaredIds.length) {
    reasons.push(`declared ${declaredIds.length}, executed ${executedIds.length}`);
  }
  if (neverRan.length) reasons.push(`never ran: ${neverRan.join(', ')}`);
  // Checked INDEPENDENTLY of the count: a plan can be complete by count and
  // still have no control in it, which is the case reds cannot detect.
  if (!controlId || !executed.has(controlId)) {
    reasons.push(
      'the NEGATIVE CONTROL never ran — reds alone do not show this prover can ' +
        'distinguish a guard from a tripwire',
    );
  }

  return { ok: reasons.length === 0, reasons, neverRan };
}
