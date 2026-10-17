#!/usr/bin/env node
/**
 * Mutation proof for the CDN purge specs' fake clock refusing what would run away
 * (#2499), graded by `packages/kn-next/src/__tests__/cdn-purge-fake-clock.test.ts`
 * on the shared driver.
 *
 * WHY. `mutation-prove-cdn-purge.mjs` row M03 (MAX_ATTEMPTS 3 -> 4) handed the fake
 * clock `sleep(NaN)`; that turned every later timestamp into NaN, the purger's rate
 * limiter then called `sleep` forever, and the instant fake `sleep` pushed to its
 * recording array in a tight loop. It took a 16 GB hosted runner down in seconds,
 * twice, in the same leg of the mutation-prover lane. The clock now throws on a
 * non-finite or negative wait and on a runaway count; these rows remove each guard
 * and the spec must go red.
 *
 * This is its own small prover, not rows in the lane prover, because its subject
 * exists on `integration/v2` only and the lane prover is byte-identical on `main`.
 *
 * Verdicts are by EXIT CODE only, every anchor must occur exactly once (preflight),
 * the baseline must be green, a canary must go red first, restores are
 * content-verified. Each mutation is graded by a spec that FAILS FAST, never by one
 * that could spin.
 *
 * Usage:  node scripts/mutation-prove-2499-cdn-fake-clock.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/cdn-purge-fake-clock.test.ts';

const MUTATIONS = [
  {
    id: 'F01',
    subject: 'clock',
    claim: 'a NaN / infinite / negative wait is accepted again (the clock is poisoned)',
    anchor: '            if (!Number.isFinite(ms) || ms < 0) {',
    replacement: '            if (false) {',
  },
  {
    id: 'F02',
    subject: 'clock',
    claim: 'a runaway sleep loop is no longer cut off',
    anchor: '            if (sleeps.length >= MAX_FAKE_SLEEPS) {',
    replacement: '            if (false) {',
  },
];

// A real mutation of a real subject, distinct from the rows.
const CANARY = {
  subject: 'clock',
  anchor: '            t += ms;\n        },\n        advance:',
  replacement: '            t += 1;\n        },\n        advance:',
};

// Inline literal: the lane's subject-existence audit reads these from the call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { clock: 'packages/kn-next/src/__tests__/helpers/cdn-purge-fixtures.ts' },
});

console.log('=== mutation proof: the CDN purge fake clock refuses a runaway (#2499) ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
