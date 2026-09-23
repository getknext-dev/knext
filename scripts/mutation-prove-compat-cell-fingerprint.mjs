#!/usr/bin/env node
/**
 * Mutation proof for the #1294 guards in `tests/compat-window-fingerprint.test.ts`
 * and `tests/compat-vinext-lane.test.ts`:
 *
 *   1. PER-CELL WORKFLOW ENTRY — `workflowRootForLane` must resolve each lane's
 *      OWN executing workflow (`compat-vinext.yml` for the vinext cells) from
 *      the ONE declared table (`CREDENTIAL_CELLS`), not a hardcoded
 *      `test-e2e-deploy.yml`. This is the mutation named in the exit
 *      criteria: DROP `compat-vinext.yml` from the inputs by reverting to the
 *      pre-#1294 hardcode, and the spec must go RED.
 *   2. SCRIPTS/LIB SCAN — `scripts/lib/e2e-*` must be part of the frozen
 *      harness (#1280 pieces, e.g. `e2e-state-snapshot.sh`), not silently
 *      invisible to the digest.
 *   3. `--lane` MUST ACTUALLY SELECT — a lane argument that gets computed but
 *      then discarded (falling back to the default lane always) is
 *      indistinguishable from no lane support at all.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. Each mutation below deletes one piece of behaviour and requires
 * the spec to go RED, then GREEN again after restore — both directions,
 * because a spec that never recovers proves the restore is broken, not the
 * guard.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `declareMutations`/`recordMutation` — the lane can tell 2-of-3 from
 *     3-of-3;
 *   * judged on EXIT CODES, never on grepped output — vitest/bun:test write
 *     ANSI, and a pass/fail grep over it once certified fourteen decorative
 *     mutations green.
 *
 * Usage:  node scripts/mutation-prove-compat-cell-fingerprint.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/compat-window-fingerprint.mjs');
const SPECS = ['tests/compat-window-fingerprint.test.ts', 'tests/compat-vinext-lane.test.ts'];

declareMutations(3);

const RUNNERS = SPECS.map((spec) => ({ spec, runner: resolveSpecRunner(REPO_ROOT, spec) }));

/** True when EVERY spec in SPECS passed. Exit code only — never the output. */
function specsPass() {
  for (const { spec, runner } of RUNNERS) {
    const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status !== 0) return false;
  }
  return true;
}

let pass = 0;
let fail = 0;

function prove(label, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(TARGET);
  try {
    mutate(snap, anchor, replacement);
    if (specsPass()) {
      console.log('   x DECORATION: the specs stayed GREEN with the behaviour removed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specsPass()) {
    console.error(`   FATAL: ${SPECS.join(', ')} did not go green again after restore`);
    process.exit(1);
  }
}

// The harness must be able to SEE red before any verdict it gives means
// anything: specs that are already red would make every mutation look "caught".
console.log('Baseline: the specs must be GREEN before anything is mutated.');
if (!specsPass()) {
  console.error(`FATAL: ${SPECS.join(', ')} are not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. THE mutation named in the exit criteria: drop compat-vinext.yml from a
//    vinext cell's inputs by reverting `workflowRootForLane` to the pre-#1294
//    hardcode. Every lane, including bun-vinext, would fingerprint
//    test-e2e-deploy.yml again — exactly the bug #1294 exists to close.
prove(
  'per-cell workflow entry: hardcode every lane back to test-e2e-deploy.yml',
  "  return { kind: 'file', path: `.github/workflows/${cell.workflowFile}` };",
  "  return { kind: 'file', path: '.github/workflows/test-e2e-deploy.yml' };",
);

// 2. Stop scanning scripts/lib/e2e-* — the #1280 pieces (e.g.
//    e2e-state-snapshot.sh) become invisible to the digest again.
prove(
  'scripts/lib scan: remove the scripts/lib/e2e-* harness root',
  "  { kind: 'dir', path: 'scripts/lib', match: /^e2e-[^/]*\\.(sh|mjs|cjs|js)$/ },\n",
  '',
);

// 3. Stop actually USING the caller's `lane` — every call fingerprints the
//    default lane regardless of what was requested.
prove(
  '--lane is computed but discarded: collectHarness always uses CREDENTIAL_LANE',
  'const harness = collectHarness(repoRoot, lane, { workflowFile });',
  'const harness = collectHarness(repoRoot, CREDENTIAL_LANE, { workflowFile });',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
