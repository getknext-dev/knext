#!/usr/bin/env node
/**
 * Mutation proof for the fleet-wide anchor-drift guard (#1223), direction 2
 * of 2 — the RATCHET FLOOR notices the scanner itself losing a resolution
 * tier (review feedback on #1250).
 *
 * `tests/mutation-prover-anchor-drift.test.ts`'s aggregate floors
 * (`MIN_RESOLVED_PAIRS`/`MIN_RESOLVED_PROVERS`) exist because a
 * `toBeGreaterThan(10)`-style smoke check would stay green if a whole
 * resolution tier silently broke: disabling the wrapper-function tier
 * (`findAnchorParamFunctions`/`scanWrapperCallSites` in
 * `scripts/lib/prover-anchor-scan.mjs` — the shape
 * `mutation-prove-compat-window-audit.mjs` itself uses) still leaves the
 * fleet resolving 30 pairs across 6 provers (measured), comfortably above a
 * low bar and silently under the real one (66 pairs / 12 provers).
 *
 * This script plants exactly that: `findAnchorParamFunctions` stops finding
 * ANY function (its `anchor`-parameter lookup always misses, so it
 * `continue`s past every declaration), and requires the ratchet-floor
 * assertions to go RED, then restores and requires GREEN again.
 *
 * A single target (`scripts/lib/prover-anchor-scan.mjs`) in its own script —
 * see `scripts/mutation-prove-prover-anchor-drift.mjs`'s header for why this
 * is split from direction 1 rather than folded in.
 *
 * Usage:  node scripts/mutation-prove-prover-anchor-scanner-tier.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/lib/prover-anchor-scan.mjs');
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

console.log('Baseline: the ratchet-floor guard must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

console.log('── mutation: disable the wrapper-function anchor-resolution tier');
const snap = snapshot(TARGET);
try {
  mutate(snap, "const anchorIdx = names.indexOf('anchor');", 'const anchorIdx = -1;');
  if (specPasses()) {
    console.log('   x DECORATION: the ratchet floors stayed GREEN with the tier disabled');
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
  console.error('The ratchet floors failed to notice a lost resolution tier — decoration.');
  process.exit(1);
}
