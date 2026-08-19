#!/usr/bin/env node
/**
 * Standing mutation proof for the ci.yml BLOCKING-GATE guards (#672 item 1).
 *
 * `scripts/mutation-prove-blocking-gate.mjs` proves the audit ENGINE cannot be
 * gutted. This one proves the opposite direction, on the real workflow: every
 * guard that claims "this ci.yml job runs unconditionally on a PR and its
 * failure fails the run" must go RED when that claim is actually falsified.
 *
 * It exists because #672 measured the gap it closes. Before the conversion,
 * `tests/compile-cache-health-bun-ci.test.ts` asked the question as TEXT
 * (`not.toMatch(/continue-on-error:\s*true/)` over the job's lines) and stayed
 * GREEN under all four disarms below — the same four #661 measured on the
 * bun-exec guards. A guard that stays green while its subject is removed is
 * decoration, and the only way to know which of those a guard is, is to remove
 * the subject and look.
 *
 * PRE-CONVERSION BASELINE, per guard — recorded here because #672's own PR body
 * UNDER-CLAIMED it and a commit message cannot be corrected in place. The
 * round-2 review caught the error; the number below was then re-measured by
 * replaying the five disarms against the HEAD~1 text guard:
 *
 *   - `compile-cache-bun-probe` (compile-cache-health-bun-ci): GREEN under all
 *     five.
 *   - `typecheck-root` (root-typecheck-gate): GREEN under FOUR — `"if": false`,
 *     `'if': false`, `needs: <skippable>`, and the zero-expansion `strategy:`.
 *     The PR body listed only the quoted key and `strategy:`. Its one catch was
 *     `continue-on-error: ${{ true }}`, and only by accident of breadth: that
 *     guard matched a bare `/continue-on-error/` rather than the
 *     `/continue-on-error:\s*true/` its siblings used. Understating a guard's
 *     blind spots is the same failure as overstating its coverage, so the
 *     measured figure lives in the tree rather than in a PR body.
 *
 * The mutations are applied to `.github/workflows/ci.yml` through the byte-
 * snapshot harness, so the workflow is restored content-addressed rather than by
 * replaying inverse edits, and every mutation carries the residue marker.
 *
 * Usage:  node scripts/mutation-prove-ci-blocking-gates.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  disarmAnchor,
  disarmReplacement,
  explainNothingRan as explainNothingRanIn,
  GATES,
  runGateTest as runGateTestIn,
} from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * `GATE_TEST_NAME` and `GATES` now live in `./lib/ci-blocking-gate-proof.mjs`,
 * so `tests/ci-blocking-gate-proof-runnable.test.ts` can assert this proof is
 * still runnable without importing this script and running all 30 mutations.
 *
 * #677 made the workflow, the selected assertion name and the `needs:` disarm
 * PER-GATE: `resolve-image-pins` lives in `image-pin-resolution-nightly.yml`,
 * not `ci.yml`. The script name still says `ci`; the set no longer does.
 */

/**
 * The disarms for one gate. Each is a single valid-YAML edit that neutralises
 * the job while leaving its definition otherwise intact — four measured in #661,
 * plus the two the fail-closed allowlist caught that nobody had enumerated.
 *
 * The `needs:` one is the indirection the text guards missed entirely: the gate
 * disappears without its own definition ever being touched. Its target is
 * per-gate (see `GATES`) because a workflow whose only other job `needs:` the
 * gate would give a CYCLE rather than a disarm.
 */
const disarmsFor = (gate) => [
  { label: 'a quoted "if": false key', inject: '    "if": false' },
  { label: "a single-quoted 'if': false key", inject: "    'if': false" },
  {
    label: 'continue-on-error as an EXPRESSION, not a literal true',
    inject: '    continue-on-error: ${{ true }}',
  },
  {
    label: `${gate.needsDisarm.inject.trim()} (a job that can skip)`,
    inject: gate.needsDisarm.inject,
    define: gate.needsDisarm.define,
  },
  {
    label: 'a matrix strategy that can expand to zero jobs',
    inject: '    strategy:\n      matrix:\n        shard: []',
  },
];

/**
 * DERIVED — every gate times every disarm, so a gate or a disarm added below is
 * declared without a second edit. The lane (#685) compares this against the
 * number actually scored and fails on either direction, which is what makes a
 * prover that stops at gate 3 of 6 loud instead of a green that proves nothing.
 */
declareMutations(GATES.reduce((n, gate) => n + disarmsFor(gate).length, 0));

let pass = 0;
let fail = 0;

const runGateTest = (gate) => runGateTestIn(REPO_ROOT, gate.spec, gate.testName);

/**
 * Say WHY nothing ran — or say the cause was not determined.
 *
 * The diagnosis itself lives in `./lib/ci-blocking-gate-proof.mjs` so
 * `tests/ci-blocking-gate-proof-diagnosis.test.ts` can assert each cause is
 * attributed on POSITIVE evidence without importing this script and running all
 * 25 mutations. Three causes have been misattributed here, each by a branch that
 * defaulted to the most common one (#680); the fallback now says it does not
 * know and prints what it observed.
 */
const explainNothingRan = (gate, result) =>
  explainNothingRanIn(REPO_ROOT, gate.spec, result, gate.testName);

/** The assertion must be RED while the job is disarmed, and GREEN once restored. */
function prove(gate, disarm) {
  const { jobId, spec } = gate;
  console.log(`── ${spec} :: ${jobId} :: ${disarm.label}`);
  const anchor = disarmAnchor(jobId, disarm);
  const snap = snapshot(resolve(REPO_ROOT, gate.workflow));
  try {
    // The anchor is the job KEY, so the injection lands at job level whatever
    // the job's body looks like — no dependence on which line happens to be
    // first, which is how an anchored-on-a-neighbour mutation silently no-ops.
    // `define` (empty for every ci.yml gate) prepends a job the disarm needs.
    //
    // Built by the SHARED `disarmReplacement` (#690) so the runnable-proof spec
    // can audit the very text this line injects rather than a look-alike.
    mutate(snap, anchor, disarmReplacement(jobId, disarm));
    const result = runGateTest(gate);
    const { ok, ran } = result;
    if (ran === 0) {
      console.error(explainNothingRan(gate, result));
      restore(snap);
      process.exit(1);
    }
    if (ok) {
      console.log('   x DECORATION: the guard stayed GREEN with the gate disarmed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!runGateTest(gate).ok) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: every gate assertion must be GREEN against its real workflow.');
for (const gate of GATES) {
  const result = runGateTest(gate);
  const { ok, ran } = result;
  if (ran === 0) {
    console.error(explainNothingRan(gate, result));
    process.exit(1);
  }
  if (!ok) {
    console.error(`FATAL: ${gate.spec} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

for (const gate of GATES) {
  for (const disarm of disarmsFor(gate)) prove(gate, disarm);
}

console.log(`\n${pass} disarm(s) went red as required, ${fail} stayed green.`);
process.exit(fail === 0 ? 0 : 1);
