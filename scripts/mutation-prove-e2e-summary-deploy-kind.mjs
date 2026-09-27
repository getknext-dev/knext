#!/usr/bin/env node
/**
 * Mutation proof for the `kind: 'deploy'` classification in
 * `scripts/e2e-summary.mjs` (#1520, raised from #1515).
 *
 * WHAT THIS PROTECTS. Run 36312054519: a `createNext` deploy-script failure
 * (`Custom deploy script failed: …` / `Custom deploy script returned invalid
 * URL: …`) thrown inside a test file's `beforeAll`, before a single request was
 * made, used to classify as `kind: 'assertion'` (or `unclassified`) — 419 files
 * read as "the self-contained binary serves wrong responses" until the shard
 * logs were checked by hand. A harness/deploy failure must never read as a
 * runtime regression, so `attributeFailure()` in e2e-summary.mjs now detects
 * the shared message shape and reports `kind: 'deploy'` instead, taking
 * PRIORITY over both the timeout and per-case-assertion markers.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. The mutation below deletes the deploy-classification branch
 * entirely (folds it to `false`, i.e. the ternary falls straight through to the
 * pre-#1520 timeout/assertion/unclassified logic) and requires
 * `tests/deploy-summary.test.ts` to go RED, then GREEN again after restore —
 * both directions, because a spec that never recovers proves the restore is
 * broken, not the guard.
 *
 * Same shared harness as `scripts/mutation-prove-compat-window-audit.mjs`:
 *   * `mutate`/`restore` over a byte snapshot, anchor asserted to occur exactly
 *     once — a silently-failed substitution would certify a decorative guard
 *     green;
 *   * `declareMutations`/`recordMutation` so the lane can tell 0-of-1 from 1-of-1;
 *   * judged on EXIT CODES, never on grepped output — `bun test` prints ANSI.
 *
 * Usage:  node scripts/mutation-prove-e2e-summary-deploy-kind.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/e2e-summary.mjs');
const SPEC = 'tests/deploy-summary.test.ts';

declareMutations(2);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

let pass = 0;
let fail = 0;

function prove(label, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(TARGET);
  try {
    mutate(snap, anchor, replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
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
}

// The harness must be able to SEE red before any verdict it gives means
// anything: a spec that is already red would make every mutation look "caught".
console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. Disable the classifier: `attributeFailure()` stops reading `g.deployScript`
//    at all, so a deploy-script failure falls straight through to the
//    pre-#1520 timeout/assertion/unclassified logic — reverting to exactly the
//    #1520 bug (classified as 'assertion' when the beforeAll cascade printed
//    per-case ✕ lines, 'unclassified' otherwise).
prove(
  'classifier removed: a deploy-script failure reverts to assertion/unclassified',
  'const kind = g?.deployScript',
  'const kind = false',
);

// 2. Disable the SCAN: `scanOutputGroups()` stops setting `g.deployScript`,
//    even though `attributeFailure()` still reads it. This is the OTHER half —
//    a classifier that reads a flag nothing ever sets is just as decorative as
//    one that ignores a flag that IS set, and the two anchors are independent
//    lines, so one mutation cannot stand in for the other.
prove(
  'scan removed: deployScriptRe is checked but never recorded onto the group',
  'if (deployScriptRe.test(line)) g.deployScript = true;',
  'if (deployScriptRe.test(line)) { /* no-op */ }',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
