/**
 * Does this source REALLY import from `specifier`, as code?
 *
 * The one definition of the bun/vitest partition (#871). Three callers share it
 * — `vitest.config.ts`, `scripts/bun-test.mjs` and `tests/runner-partition.test.ts`
 * — because a partition with three copies of its rule is three chances for two
 * of them to disagree, and when they disagree a test file runs under no runner
 * at all and nothing reports it.
 *
 * ## Why this is not a one-line regex
 *
 * Matching the raw source is wrong: `ts-import-extension-guard.test.ts` builds a
 * FIXTURE containing `import vitest from "vitest"`, and a raw scan made both
 * partitions disown it — vitest excluded it for importing `bun:test`, the bun
 * runner skipped it for "importing" vitest, and it ran nowhere. Silently
 * uncovered, by the very mechanism meant to prevent that.
 *
 * Matching `blankNonCode(src)` is ALSO wrong, and fails in the opposite,
 * larger direction: the blanker blanks string CONTENTS, and a module specifier
 * IS a string — so `from "bun:test"` becomes `from "        "` and nothing ever
 * matches. Applied to the partition that reads as "every file is orphaned",
 * which is at least loud; applied to one side only, it silently hands the whole
 * suite to one runner.
 *
 * So: find candidates in the ORIGINAL, then use the blanked copy — which is
 * position-preserving — to ask whether each candidate sits in code or inside a
 * literal. The `from` keyword survives blanking when it is code and does not
 * when it is text.
 */
import { blankNonCode } from './blank-non-code.mjs';

/**
 * @param {string} src   file contents
 * @param {string} specifier  e.g. 'bun:test' or 'vitest'
 * @returns {boolean} true when `src` imports from `specifier` in real code
 */
export function importsFrom(src, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`from\\s+['"]${escaped}['"]`, 'g');
  const blanked = blankNonCode(src);

  for (const match of src.matchAll(pattern)) {
    // `blankNonCode` preserves offsets, so the same span in the blanked copy
    // tells us whether this `from` was code. Inside a string or comment it has
    // been replaced by spaces.
    if (blanked.slice(match.index, match.index + 4) === 'from') return true;
  }
  return false;
}
