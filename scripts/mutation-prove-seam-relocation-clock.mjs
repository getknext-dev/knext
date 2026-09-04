#!/usr/bin/env node
/**
 * Mutation proof for the T6b relocation deferral's clock (#936).
 *
 * WHAT IS BEING PROVED, AND WHY IT MATTERS
 * ----------------------------------------
 * T6b closed the cheap half of the published-seam problem: the two mutating
 * seams on `@getknext/core/adapters/cache-handler` refuse unconditionally under
 * `NODE_ENV=production`. The surface itself is still there, and removing it is a
 * public-API change — a `workflow.md` escalation trigger — so it is DEFERRED and
 * tracked in #936.
 *
 * A deferral recorded only in a PR body outlives everyone who remembers it.
 * `security.md` states the general form: a documented expectation degrades, and
 * its efficacy is unobservable until it has already failed. So the deferral
 * carries a dated exemption, and this proves the date is load-bearing rather
 * than decorative:
 *
 *   1. the seam set is DISCOVERED from the gate calls, so a third seam cannot
 *      ship with no exception and no clock;
 *   2. an exemption whose `expires` has passed STOPS being returned — a reader
 *      that never expires anything is the quietest way to neuter a deferral,
 *      because it still reads as dated;
 *   3. the caller treats a lapsed exemption as a FAILURE, not as an empty set it
 *      can shrug at.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/published-seam-relocation-clock.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      "the exemption reader stops expiring anything — #936's deferral then reads as dated " +
      'forever while its clock has silently stopped, which is the failure this file exists for',
    subject: 'policy',
    anchor: "  return activeExemptions(SEAM_RELOCATION_EXEMPTIONS, { field: 'seam', now });",
    replacement: '  void now;\n  return new Set(SEAM_RELOCATION_EXEMPTIONS.map((e) => e.seam));',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'a gated seam loses its exemption entry — it is then on a published subpath with NO ' +
      'tracked deferral at all, which is the state before #936 was filed',
    subject: 'policy',
    anchor: "    seam: '@getknext/core/adapters/cache-handler#__resetEnvForTests',",
    replacement: "    seam: '@getknext/core/adapters/cache-handler#__someOtherThing',",
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the seam scan stops discovering — zero seams means both loops iterate zero times and the ' +
      'whole file passes vacuously, the shape this repo has already had to close twice',
    subject: 'spec',
    anchor: '/assertTestSeamEnabled\\(\\s*[\'"](__[A-Za-z0-9_]+)[\'"]\\s*\\)/g',
    replacement: '/assertTestSeamEnabledXX\\(\\s*[\'"](__[A-Za-z0-9_]+)[\'"]\\s*\\)/g',
  },
];

/**
 * NEGATIVE CONTROL. The `justification` text is prose an author is meant to
 * improve — that is the point of requiring a substantive one. Rewording it must
 * leave the guard GREEN, or the three reds above are equally explained by the
 * spec freezing the policy file's source text, and the guard would red on every
 * honest clarification of why the deferral exists.
 */
const NEGATIVE = {
  id: 'M4',
  expect: 'green',
  claim: 'an exemption JUSTIFICATION is reworded — the guard asserts the clock, not the prose',
  subject: 'policy',
  anchor:
    "      'Repoints the process-wide Redis client from a published subpath. Fails closed under ' +",
  replacement:
    "      'Repoints the process-wide Redis client from a published subpath (reworded by the negative control). Fails closed under ' +",
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    policy: 'scripts/lib/published-seam-policy.mjs',
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (#936 relocation clock) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary back-dates the exemption so it is ALREADY lapsed. The "still
// excused today" case must red, which also proves the runner is pointed at this
// spec rather than exiting 0 on a file it never collected.
prover.proveCanSeeRed({
  subject: 'policy',
  anchor: "    added: '2026-09-04',\n    expires: '2026-12-01',\n  }),\n]);",
  replacement: "    added: '2020-01-01',\n    expires: '2020-01-02',\n  }),\n]);",
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
