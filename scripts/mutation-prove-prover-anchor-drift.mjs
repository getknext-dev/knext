#!/usr/bin/env node
/**
 * Mutation proof for the fleet-wide anchor-drift guard (#1223), direction 1
 * of 2 — the guard notices a REAL prover's anchor going stale.
 *
 * `tests/mutation-prover-anchor-drift.test.ts` exists to catch a mutation
 * prover whose hardcoded text anchor no longer occurs in its subject —
 * `scripts/mutation-prove-compat-window-audit.mjs` mutation #4 did exactly
 * that and the prover ABORTED silently until a human ran it by hand. This
 * script plants the SAME failure mode directly: delete a real, currently-
 * resolved anchor from its real subject file, and require the guard to go
 * RED, then restore and require GREEN again.
 *
 * Direction 2 — the scanner's own wrapper-function resolution tier breaking
 * — is proved separately in
 * `scripts/mutation-prove-prover-anchor-scanner-tier.mjs`, a single-target
 * script rather than folded into this one. `scripts/lib/prover-lane.mjs`'s
 * own PR-time anchor-liveness audit pairs each literal anchor with the
 * NEAREST preceding `resolve(...)`-bound target in the file — sound for the
 * repo's overwhelming one-target-per-prover convention, but it mis-paired
 * this file's second target when both lived here, misreporting an anchor
 * against the wrong subject. Splitting rather than reshaping the shared
 * heuristic follows the same convention every other prover in this repo
 * already uses.
 *
 * Mutates via the shared byte-snapshot harness
 * (`scripts/lib/mutation-harness.mjs`), so restoration is content-addressed
 * and a stall between mutate and restore is findable by
 * `scripts/scan-mutation-residue.mjs` rather than by luck. Never `perl` for
 * the substitution — a silently-failed one yields a green run that proves
 * nothing; `mutate()` asserts the anchor occurs exactly once and aborts
 * otherwise.
 *
 * Usage:  node scripts/mutation-prove-prover-anchor-drift.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/compat-window-audit.mjs');
const SPEC = 'tests/mutation-prover-anchor-drift.test.ts';

declareMutations(1);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never grepped output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

let pass = 0;
let fail = 0;

console.log('Baseline: the drift guard must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// Break the EXACT anchor mutation #4 of mutation-prove-compat-window-audit.mjs
// covers — the anchor #1223's fix re-pointed at the current
// `selectLaneNights` shape. Deleting it from the real subject file is
// precisely the drift scenario the guard exists to catch: an anchor a
// prover declares that no longer occurs, exactly once, in its subject.
console.log('── mutation: delete the merged-streak anchor from compat-window-audit.mjs');
const snap = snapshot(TARGET);
try {
  mutate(
    snap,
    "l?.event === 'schedule' && (l?.lane === lane || (isUnresolved(l) && l?.lane == null))",
    "l?.event === 'schedule' && l?.lane === lane",
  );
  if (specPasses()) {
    console.log('   x DECORATION: the drift guard stayed GREEN with the anchor deleted');
    fail += 1;
  } else {
    console.log('   ok went RED as required');
    pass += 1;
  }
  recordMutation();
} finally {
  restore(snap);
}
if (!specPasses()) {
  console.error(`   FATAL: ${SPEC} did not go green again after restore`);
  process.exit(1);
}
console.log('   ok back to GREEN after restore');

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('The drift guard failed to notice a deleted anchor — it is decoration.');
  process.exit(1);
}
