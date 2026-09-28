#!/usr/bin/env node
/**
 * Mutation proof for the `kind: 'deploy'` classification in
 * `scripts/e2e-summary.mjs` (#1520, raised from #1515; reworked #1550 round 2;
 * extended #1555 with the round-2 review's follow-ups).
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
 * properties are load-bearing, proven below (mutations 1-4):
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
 * #1555 (the round-2 closing review's own follow-ups) adds three more
 * (mutations 5-9, two of them each proving BOTH halves of one property):
 *   5/6. AFTERALL-TEARDOWN EXCUSED (N1) — a `Test suite failed to run` block
 *      that is the harness's own `next.destroy()` TypeError, a SIDE EFFECT of
 *      an earlier deploy failure in the SAME group, does not by itself
 *      downgrade the file away from 'deploy'. Both the DETECTION (mutation 5)
 *      and the EXCEPTION that reads it (mutation 6) are proven separately —
 *      a detector nothing reads, or an exception nothing sets, are equally
 *      decorative.
 *   7. UNEXPLAINED-CASE GUARD (N2) — a failing case with NO error-detail
 *      block at all downgrades the file, independent of `hasNonDeployBlock`
 *      (mutation 4 removes both at once; this isolates this half alone).
 *   8/9. RETRY EVIDENCE PRESERVED (N3) — an earlier retry's own cases/timeout
 *      are archived (mutation 8) and actually reported via `attempts`
 *      (mutation 9), rather than silently discarded by the mutation-2 reset —
 *      `compat-vinext-ledger.mjs` matches known failures on `cases`, so this
 *      evidence loss is a real regression, not cosmetic.
 *
 * #1555 ROUND 2 (closing-review follow-ups on N1 itself) adds two more:
 *   10. hasDeployBlock GATE ON THE EXCUSE — the teardown excuse must only
 *      read as evidence when the SAME group also proves a real deploy
 *      failure; dropping that gate lets a lone teardown-cascade block (no
 *      deploy evidence anywhere) silently stop counting as a non-deploy
 *      block at all, changing an unrelated-crash file's kind.
 *   11. teardownCascadeRe's LINE-START ANCHOR — without it, an assertion's
 *      own `Received: "TypeError: … (reading 'destroy')"` diff line reads as
 *      the harness's own marker (the same false-positive class the anchor on
 *      `deployScriptRe`, mutation 1, exists to prevent).
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

declareMutations(11);

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
  'Object.assign(g, freshGroup(), { noTestsFound, priorAttempts });',
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

// 5. #1555 N1 DETECTION removed: the afterAll-teardown TypeError is never
//    recognized on its own block, so the exception in mutation 6 never fires
//    and a real deploy failure followed by the teardown cascade downgrades to
//    'assertion' again (the exact ~11% measured regression this fix closes).
prove(
  "afterAll-teardown detection removed: a deploy failure followed by the harness's own next.destroy() TypeError downgrades to assertion",
  'if (inBlock && isTeardownLine) blockHasTeardownLine = true;',
  'if (false) blockHasTeardownLine = true;',
);

// 6. #1555 N1 EXCEPTION removed: even with the teardown correctly detected
//    (mutation 5's flag still sets), the exception that excuses it from
//    `hasNonDeployBlock` is gone — the OTHER half of the same property, since
//    a detector nothing reads is exactly as decorative as an exception
//    nothing sets.
prove(
  'afterAll-teardown exception removed: the detected teardown block counts as a genuine non-deploy block again',
  'const hasNonDeployBlock = blocks.some((b) => !b.deploy && !isExcusedTeardownBlock(b));',
  'const hasNonDeployBlock = blocks.some((b) => !b.deploy);',
);

// 7. #1555 N2 unexplainedCase removed IN ISOLATION from hasNonDeployBlock
//    (mutation 4 removes both at once and would not by itself prove this
//    guard matters on its own): a failing case with no error-detail block at
//    all no longer downgrades a file whose PRINTED blocks are all
//    deploy-explained.
prove(
  'unexplainedCase guard removed: an unexplained failing case with no block at all no longer downgrades away from deploy',
  'const unexplainedCase = cases.length > explainedBlockCount;',
  'const unexplainedCase = false;',
);

// 8. #1555 N3 ARCHIVAL removed: the about-to-be-discarded retry's own
//    cases/timeoutMs is never snapshotted before the mutation-2 reset
//    overwrites it — an earlier retry's evidence is silently lost again
//    (rather than surviving via `attempts`), the exact regression a
//    round-2-era review found in `compat-vinext-ledger.mjs`'s known-failure
//    matching on `cases`.
prove(
  "retry-evidence archival removed: an earlier retry's cases/timeoutMs are silently dropped instead of preserved in `attempts`",
  'const priorAttempts = [...g.priorAttempts, snapshotAttempt(g)];',
  'const priorAttempts = g.priorAttempts;',
);

// 9. #1555 N3 REPORTING removed: even with the archival intact (mutation 8),
//    `attributeFailure()` never surfaces it on the returned `ShardFailure` —
//    the OTHER half of the same property, an archive nothing reads.
prove(
  'retry-evidence reporting removed: archived prior-attempt evidence is never surfaced on the returned failure record',
  '...(priorAttempts.length > 0 ? { attempts: [...priorAttempts, snapshotAttempt(g)] } : {}),',
  '...{},',
);

// 10. #1555 round-2 review (M1) — the `hasDeployBlock &&` gate on the excuse
//    is dropped, so a LONE teardown-cascade block (no deploy evidence
//    anywhere in the group) is wrongly excused from `hasNonDeployBlock` too,
//    changing an otherwise-unrelated-crash file's kind (fixture A2: assertion
//    → unclassified).
prove(
  'hasDeployBlock gate on the excuse removed: a lone teardown-cascade block with NO deploy evidence anywhere is wrongly excused too',
  'const isExcusedTeardownBlock = (b) => hasDeployBlock && b.teardownCascade;',
  'const isExcusedTeardownBlock = (b) => b.teardownCascade;',
);

// 11. #1555 round-2 review (M2) — `teardownCascadeRe`'s line-start anchor is
//    removed, so an assertion's own diff line that merely CONTAINS the
//    marker text (e.g. `Received: "TypeError: … (reading 'destroy')"`) is
//    read as the harness's own teardown crash and excused (fixture A4-shape:
//    assertion → deploy).
prove(
  "teardownCascadeRe anchor removed: an assertion's own diff text containing the marker is excused as the harness's teardown crash",
  "const teardownCascadeRe =\n    /^\\s*TypeError: Cannot read propert(?:y|ies) of (?:undefined|null) \\(reading '(?:destroy|close|stop)'\\)/;",
  "const teardownCascadeRe =\n    /TypeError: Cannot read propert(?:y|ies) of (?:undefined|null) \\(reading '(?:destroy|close|stop)'\\)/;",
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
