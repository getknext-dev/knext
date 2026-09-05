/**
 * published-seam-policy.mjs — the mutating test seams still exported from a
 * PUBLISHED subpath, with a clock on each (T6b residual, #936).
 *
 * WHAT IS EXCUSED. `@getknext/core/adapters/cache-handler` exports
 * `__setRedisClientForTests` and `__resetEnvForTests`. Both repoint process-wide
 * cache state, and both ship to consumers.
 *
 * T6b closed the half that could be closed cheaply: they now refuse
 * unconditionally under `NODE_ENV=production`, so the `KNEXT_TEST_SEAMS` flag
 * cannot re-open them in a production process no matter who sets it. What that
 * does NOT do is remove the surface — a consumer's dev or CI process is still a
 * process where a transitive dependency can repoint the cache.
 *
 * The real fix, named by the sprint-2 system design, is to move the seams to a
 * test-only entry and scan every published subpath's `dist` for surviving
 * `__`-prefixed identifiers. That is a **public-API change** and therefore a
 * `workflow.md` escalation trigger, so it is not something a hardening PR gets
 * to do quietly. It is tracked as #936.
 *
 * WHY THIS FILE EXISTS AT ALL. A deferral recorded only in a PR body is a
 * deferral that outlives everyone who remembers it — `security.md`'s own point
 * that a documented expectation degrades and its efficacy is unobservable until
 * it has already failed. So the deferral gets the same treatment #928 got: a
 * justification, a date, and a clock read by the shared `dated-exemptions.mjs`,
 * which reds CI when it lapses.
 */

import { activeExemptions } from './dated-exemptions.mjs';

/** The subject key. One entry per seam, so a third cannot arrive unnoticed. */
export const SEAM_RELOCATION_EXEMPTIONS = Object.freeze([
  Object.freeze({
    seam: '@getknext/core/adapters/cache-handler#__setRedisClientForTests',
    justification:
      'Repoints the process-wide Redis client from a published subpath. Fails closed under ' +
      'NODE_ENV=production since T6b, but the export still exists for consumers. Relocation to a ' +
      'test-only entry is a public-API change (workflow.md trigger) tracked in #936.',
    added: '2026-09-04',
    expires: '2026-12-01',
  }),
  Object.freeze({
    seam: '@getknext/core/adapters/cache-handler#__resetEnvForTests',
    justification:
      'Drops the live client, connect promise and circuit-breaker deadline from a published ' +
      'subpath. Same NODE_ENV=production refusal and the same unremoved export surface; ' +
      'relocation tracked in #936.',
    added: '2026-09-04',
    expires: '2026-12-01',
  }),
]);

/**
 * The seams still excused at `now`. Empty means the clock ran out and the
 * relocation is due — the caller asserts that, because a shared reader cannot
 * enforce what its callers do with a smaller set.
 *
 * @param {Date} [now]
 * @returns {Set<string>}
 */
export function activeSeamRelocationExemptions(now = new Date()) {
  return activeExemptions(SEAM_RELOCATION_EXEMPTIONS, { field: 'seam', now });
}
