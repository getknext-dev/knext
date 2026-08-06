/**
 * The DECLARED-vs-RUN contract every mutation prover speaks (#685).
 *
 * WHY THIS EXISTS AT ALL. An exit code is not enough to tell whether a prover
 * proved anything. `scripts/mutation-prove-publish-markers.mjs` had been dying
 * at item 5 since #675 deleted the string it anchored on: items 6-10 never ran,
 * the script still exited 0, and it was cited as evidence for all thirteen
 * mutations for several PRs. A lane that checks only the exit code calls that
 * GREEN, which is the failure this contract exists to make loud.
 *
 * So a prover DECLARES, up front, how many mutations it intends to run, and
 * RECORDS each one it actually scored. The declaration is emitted alongside the
 * count on `process.on('exit')` — on exit rather than at the end of the script,
 * because the interesting runs are the ones that stop early, and a summary that
 * only prints on the happy path would be absent exactly when it matters.
 *
 * The comparison is the LANE's job (`./prover-lane.mjs`), not this module's: a
 * prover must not be able to grade itself. And it is checked in BOTH directions
 * — run < declared is the "died at item 5" case, run > declared means someone
 * added a mutation without bumping the declaration, which is how the declaration
 * would otherwise rot into a lie nobody notices.
 */

/**
 * The machine-readable marker the lane greps for.
 *
 * A distinctive literal rather than a natural-language line: every prover's
 * human-facing tail already says something like "30 disarm(s) went red", and
 * parsing prose is how a lane starts silently matching nothing.
 */
export const PROVER_SUMMARY_PREFIX = '::prover-summary::';

const state = { declared: null, run: 0, emitted: false };

function emit() {
  if (state.emitted) return;
  state.emitted = true;
  const payload = JSON.stringify({ declared: state.declared ?? 0, run: state.run });
  console.log(`${PROVER_SUMMARY_PREFIX} ${payload}`);
}

/**
 * Declare how many mutations this prover intends to score, and arm the summary.
 *
 * Call once, before the first mutation. Prefer a count DERIVED from the prover's
 * own mutation list (`MUTATIONS.length`) over a hand-maintained integer; where
 * the mutations are inline calls, a literal is acceptable because the
 * both-directions comparison reddens the moment it drifts.
 *
 * @param {number} count
 */
export function declareMutations(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`declareMutations expects a non-negative integer, got ${count}`);
  }
  state.declared = count;
  process.on('exit', emit);
}

/** Record ONE scored mutation — called where the pass/fail verdict is reached. */
export function recordMutation() {
  state.run += 1;
}

/**
 * The last summary a prover emitted, or `null` if it emitted none.
 *
 * LAST rather than first: a prover's own output may quote the marker (this
 * module's docs do), and the authoritative line is the one the exit hook wrote.
 *
 * @param {string} output
 * @returns {{ declared: number, run: number } | null}
 */
export function parseProverSummary(output) {
  let found = null;
  for (const line of output.split('\n')) {
    const idx = line.indexOf(PROVER_SUMMARY_PREFIX);
    if (idx === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(idx + PROVER_SUMMARY_PREFIX.length).trim());
      if (Number.isInteger(parsed?.declared) && Number.isInteger(parsed?.run)) found = parsed;
    } catch {
      // A malformed line is not a summary; keep looking rather than throwing —
      // "no summary" is a failure the lane reports with the prover's name.
    }
  }
  return found;
}
