/**
 * The PUBLISHED entry for `@getknext/core/internal/logger` (tsup builds this
 * file to `dist/utils/logger.js` and `.d.ts`).
 *
 * `./logger` is the implementation and, deliberately, the test-only entry: it
 * also exports `__resetLoggerForTests`, which has to be defined in the module
 * whose state it resets. This file lists the non-seam exports by name — never
 * `export *`, which would carry the seam back out.
 * `scripts/scan-published-seams.mjs` reds if a `__` name becomes reachable from
 * a published entry, and `__tests__/test-seam-split.test.ts` checks this list
 * stays equal to the implementation's non-seam exports.
 */
export { createLogger, logger } from "./logger";
