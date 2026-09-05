/**
 * Every skip construct in a spec file, found by scanning (#927).
 *
 * WHY THIS EXISTS. Sprint 2's "no self-skipping guard survives" sweep was
 * reported as clean on the strength of an ad-hoc one-liner, and review showed
 * the report was wrong in two independent ways: the glob missed `apps/**` and
 * `examples/**` entirely, and the pattern list omitted `.skipIf` — which is the
 * form almost every real skip in this repo uses. Actual answer: ELEVEN files,
 * not one.
 *
 * A sweep whose result depends on remembering to include a directory and a
 * spelling is not a sweep. So the question is asked by a committed scan that
 * fails when the answer changes, and the answer itself is DECLARED in the tree
 * (`tests/declared-test-skips.test.ts`) so a new skip has to be argued for
 * rather than merely added.
 *
 * WHAT A SKIP COSTS, and why declaring is not bureaucracy: a `skipIf` predicate
 * that is false in CI reports the same green as a passing test. The repo has
 * `it.skipIf(!existsSync(artifact))` sites that simply vanish when the artifact
 * was not built — the exact "control that reports success while inert" class
 * sprint 1 named as the project's most common defect.
 */

import { blankNonCode } from './blank-non-code.mjs';

/**
 * The constructs that remove a test from the run.
 *
 * `.skipIf` is listed FIRST because leaving it out is what made the original
 * sweep wrong, and `.todo` counts because a todo is a test that does not run
 * while reading like one that does.
 */
export const SKIP_FORMS = Object.freeze([
  'describe.skipIf',
  'it.skipIf',
  'test.skipIf',
  'describe.skip',
  'it.skip',
  'test.skip',
  'describe.todo',
  'it.todo',
  'test.todo',
]);

/** Forms that vanish silently when their predicate is false at runtime. */
export const CONDITIONAL_FORMS = Object.freeze(SKIP_FORMS.filter((f) => f.endsWith('.skipIf')));

/**
 * Count each skip form in one spec's source.
 *
 * Counted on the BLANKED view so a comment discussing `it.skip` — several do,
 * including this module's own consumers — is not a finding, while a call is.
 * The longest form is matched first so `it.skipIf` is never counted as `it.skip`.
 *
 * @param {string} source
 * @returns {Record<string, number>} form -> count, omitting zeros
 */
export function scanSkips(source) {
  let code = blankNonCode(source);
  const counts = {};
  for (const form of [...SKIP_FORMS].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![.\\w$])${form.replace('.', '\\.')}\\s*\\(`, 'g');
    const n = (code.match(re) ?? []).length;
    if (n > 0) {
      counts[form] = n;
      // Consume the matches so a shorter form cannot re-count them.
      code = code.replace(re, ' '.repeat(form.length + 1));
    }
  }
  return counts;
}

/** Total skips in a source, across all forms. */
export function skipCount(source) {
  return Object.values(scanSkips(source)).reduce((a, b) => a + b, 0);
}
