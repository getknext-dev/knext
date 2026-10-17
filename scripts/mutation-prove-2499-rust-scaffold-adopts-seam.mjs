#!/usr/bin/env node
/**
 * Mutation proof that the cargo-heavy Rust scaffold prover ADOPTS the lane's
 * per-leg cargo target directory (#2499), graded by
 * `tests/mutation-prover-lane-sharding.test.ts` on the shared driver.
 *
 * This is its own small prover, not rows in `mutation-prove-2499-prover-lane-shards.mjs`,
 * because its subject (`mutation-prove-2489-rust-scaffold.mjs`) exists on
 * `integration/v2` only, and the lane prover is byte-identical on `main`, where a
 * missing subject would crash it. This file therefore ships with the
 * `integration/v2` change alone.
 *
 * One row, one behaviour: the prover must copy KNEXT_LANE_CARGO_TARGET_DIR into its
 * OWN CARGO_TARGET_DIR. Without it the seam has no consumer and the scaffold
 * prover's ~20 spec runs each do a cold dependency build again.
 *
 * Verdicts are by EXIT CODE only, the anchor must occur exactly once (preflight),
 * the baseline must be green, a canary must go red first, and every restore is
 * content-verified.
 *
 * Usage:  node scripts/mutation-prove-2499-rust-scaffold-adopts-seam.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/mutation-prover-lane-sharding.test.ts';

const MUTATIONS = [
  {
    id: 'A01',
    subject: 'scaffold',
    claim:
      'the scaffold prover no longer adopts the per-leg cargo target dir (the seam has no consumer)',
    anchor: '  process.env.CARGO_TARGET_DIR = process.env.KNEXT_LANE_CARGO_TARGET_DIR;',
    replacement: '  void 0;',
  },
];

// A real mutation of a real subject, distinct from the row.
const CANARY = {
  subject: 'wf',
  anchor: '      fail-fast: false',
  replacement: '      fail-fast: true',
};

// Inline literal: the lane's subject-existence audit reads these from the call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    scaffold: 'scripts/mutation-prove-2489-rust-scaffold.mjs',
    wf: '.github/workflows/mutation-prover-nightly.yml',
  },
});

console.log('=== mutation proof: the Rust scaffold prover adopts the lane cargo dir (#2499) ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
