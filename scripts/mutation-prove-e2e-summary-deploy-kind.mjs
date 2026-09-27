#!/usr/bin/env node
/**
 * Mutation proof for the `kind: 'deploy'` classification in
 * `scripts/e2e-summary.mjs` (#1520, raised from #1515; reworked #1550 round 2).
 *
 * WHAT THIS PROTECTS. Run 36312054519: a `createNext` deploy-script failure
 * (`Custom deploy script failed: …` / `Custom deploy script returned invalid
 * URL: …`) thrown inside a test file's `beforeAll`, before a single request was
 * made, used to classify as `kind: 'assertion'` (or `unclassified`) — 419 files
 * read as "the self-contained binary serves wrong responses" until the shard
 * logs were checked by hand. `attributeFailure()`/`scanOutputGroups()` in
 * e2e-summary.mjs detect the shared message shape and report `kind: 'deploy'`.
 *
 * #1550 ROUND 2 (lead-directed) reworked the guard after a review found the
 * round-1 version matched the phrase ANYWHERE on any line, file-wide, across
 * every retry — so a genuine regression could read as harness noise. Four
 * properties are now load-bearing, each proven below:
 *   1. ANCHORED — the marker must START its own line (ignoring leading
 *      whitespace), not merely appear as a substring inside an assertion's own
 *      message or a stray log echo.
 *   2. FINAL RETRY ONLY — classification evidence resets when a file's group
 *      re-opens for a new retry attempt, so an earlier retry's deploy failure
 *      never leaks into a later retry that failed for a real reason.
 *   3. PER CASE-BLOCK — a block is 'deploy' only when IT contains the marker;
 *      any other block (or an unexplained failing case with no block at all)
 *      is presumed a genuine, unexplained failure.
 *   4. RANKED BELOW assertion/timeout — a file with both deploy and
 *      non-deploy evidence downgrades to the non-deploy kind, never the
 *      reverse.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. Each mutation below deletes one property and requires
 * `tests/deploy-summary.test.ts` to go RED, then GREEN again after restore —
 * both directions, because a spec that never recovers proves the restore is
 * broken, not the guard.
 *
 * Same shared harness as `scripts/mutation-prove-compat-window-audit.mjs`:
 *   * `mutate`/`restore` over a byte snapshot, anchor asserted to occur exactly
 *     once — a silently-failed substitution would certify a decorative guard
 *     green;
 *   * `declareMutations`/`recordMutation` so the lane can tell partial from
 *     complete;
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

declareMutations(4);

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

// 1. ANCHOR removed: the deploy marker matches anywhere on a line again, so an
//    assertion whose OWN message merely contains the phrase (or a stray log
//    echo) is misread as the harness marker.
prove(
  'anchor removed: the deploy marker matches mid-line again (false positives return)',
  'const deployScriptRe = /^\\s*Custom deploy script (?:failed|returned invalid URL)\\b/;',
  'const deployScriptRe = /Custom deploy script (?:failed|returned invalid URL)\\b/;',
);

// 2. FINAL-RETRY-ONLY removed: an already-seen file's group no longer resets
//    its per-retry evidence on a new retry attempt, so an earlier retry's
//    deploy failure leaks into a later retry that failed for a real reason.
prove(
  "retry reset removed: an earlier retry's evidence leaks into the final retry",
  'Object.assign(g, freshGroup(), { noTestsFound });',
  'void 0;',
);

// 3. PER-CASE-BLOCK scoping removed: a block's own deploy marker is no longer
//    recorded, so a genuinely deploy-only file's blocks are all seen as
//    non-deploy (this is the OTHER half of the anchor mutation above — a
//    classifier that never records a block's own evidence is just as
//    decorative as one that reads a flag nothing sets).
prove(
  "block scoping removed: a case-block's own deploy marker is never recorded",
  'if (inBlock && isDeployLine) blockHasDeploy = true;',
  'if (false) blockHasDeploy = true;',
);

// 4. RANK removed: a file with non-deploy evidence (a genuine assertion/
//    unexplained case) no longer downgrades away from 'deploy' — reverting to
//    the round-1 #1520 bug this round-2 fix exists to close.
prove(
  'rank removed: deploy no longer downgrades below a genuine assertion/timeout',
  'hasNonDeployBlock || unexplainedCase',
  'false',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
