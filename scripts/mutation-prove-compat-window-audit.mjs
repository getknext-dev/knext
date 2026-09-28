#!/usr/bin/env node
/**
 * Mutation proof for the two guards in `tests/compat-window-audit.test.ts` that
 * are NOT restatements of rules `docs/compat/window-node-lane.md` already had:
 *
 *   1. SHORT LEDGER — a ledger with fewer shards than the run expected is not a
 *      green night. Rule 2 ("every shard failed:0/notRun:0") read over the
 *      shards a ledger CONTAINS is satisfied vacuously by an ABSENT shard; run
 *      30790778590 (2026-08-03) is the live instance, fifteen green rows
 *      reading exactly like sixteen.
 *   2. RERUN — a re-attempted run is not a qualifying night, whatever it
 *      concluded. This is #545's re-run-until-green vector, closed
 *      mechanically.
 *   3. DROPPED RUN — a scheduled run whose ledger cannot be downloaded becomes
 *      an UNRESOLVED night, never a skipped iteration. The trigger is measured,
 *      not hypothetical: `gh run download 32621148829` failed transiently
 *      during the 2026-08-24 review of this script, on a live unexpired
 *      artifact.
 *   4. MERGED STREAK — an unresolved night is admitted into every lane's
 *      window, so it BREAKS the streak instead of being filtered out of it.
 *      This is the half that actually flatters us: a dropped night that
 *      disappears lets `auditWindow` join the nights either side into one
 *      longer streak.
 *   5. UNREADABLE LEDGER — a ledger file that will not parse is a hard failure,
 *      not a `return null` that a `.filter(Boolean)` then erases.
 *   6. MODE-LESS BRIDGING (#1605) — a resolved, scheduled, lane-matched ledger
 *      that carries no credential mode must stay IN the graded sequence (and
 *      therefore disqualify) rather than being dropped by `inScope` before
 *      grading — the same shape as guard 4 above, one level: `claimsCredential`
 *      alone is not enough to decide `inScope`, or the drop returns and the
 *      streaks either side of such a night bridge into one.
 *
 * A #1520 round-1 VOID grade (a night whose only redness was a `kind:
 * 'deploy'` shard failure counted as bridged/evidence-free rather than a real
 * disqualifier) used to be mutation-proven here as guards #6 and #7. Round 2
 * (#1550, lead-directed) REMOVED that grade entirely — a deploy-classified red
 * now disqualifies a night exactly like any other red (see
 * `isDeployOnlyRedShard`'s doc comment in the target file) — so there is no
 * longer a VOID behaviour here to prove. #1553 tracks the open design
 * question of whether some subset should someday be exempted.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. Each mutation below deletes one guard's behaviour and requires
 * the spec to go RED, then to go GREEN again after restore — both directions,
 * because a spec that never recovers proves the restore is broken, not the
 * guard.
 *
 * It uses the shared harness rather than hand-rolling one, for the three
 * reasons this repo has already paid for:
 *   * `resolveTestRunner` — `pnpm exec vitest` resolves NOTHING in a worktree
 *     without its own node_modules, and this proof was written in one (#680,
 *     #681, #685).
 *   * `mutate`/`restore` over a byte snapshot — a silently-failed substitution
 *     yields a green run that proves nothing, and `mutate` asserts the anchor
 *     occurs exactly once and aborts otherwise.
 *   * `declareMutations`/`recordMutation` — so the lane can tell 1-of-2 from
 *     2-of-2. An exit 0 having run half the mutations is a fake green.
 *
 * Judged on EXIT CODES, never on grepped output: vitest writes ANSI, and a
 * pass/fail grep over it once certified fourteen decorative mutations green.
 *
 * Usage:  node scripts/mutation-prove-compat-window-audit.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/compat-window-audit.mjs');
const SPEC = 'tests/compat-window-audit.test.ts';

declareMutations(7);

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

// 1. Stop comparing the recorded shard count to what the run expected — the
//    pre-#695 reading, which trusts whatever rows it was handed.
prove(
  'short-ledger: stop comparing the shard count to shardsExpected',
  'if (expected !== null && (seen !== expected || shards.length !== expected)) {',
  'if (false) {',
);

// 2. Stop disqualifying a re-attempted run, i.e. let a re-run buy a night.
prove(
  'rerun: stop disqualifying a re-attempted run',
  "if (String(ledger?.runAttempt ?? '1') !== '1') {",
  'if (false) {',
);

// 3. Restore the exact pre-fix behaviour of `fetchLedgers`: a run whose ledger
//    download fails is skipped, so the run list stops being the denominator.
prove(
  'dropped run: let a failed download skip the run instead of recording it',
  "      unresolved('artifact-download-failed');\n      continue;",
  '      continue;',
);

// 4. Restore the pre-fix `selectLaneNights`: filter unresolved nights out of the
//    lane, which is what lets `auditWindow` BRIDGE the nights either side of a
//    dropped one into a single longer streak.
prove(
  'merged streak: filter unresolved nights out of the lane, so the streak joins across them',
  "l?.event === 'schedule' && (l?.lane === lane || (isUnresolved(l) && l?.lane == null))",
  "l?.event === 'schedule' && l?.lane === lane",
);

// 5. Restore the pre-fix `readDir`: an unparseable ledger becomes a null that a
//    downstream `.filter` erases, rather than a hard failure.
// The anchor carries the following line as well: `} catch (err) {` alone occurs
// twice (the other is `withRetry`'s), and the harness aborts on an ambiguous
// anchor rather than mutating the wrong one — which is the whole reason a
// silently-failed substitution cannot certify a decorative guard here.
prove(
  'unreadable ledger: swallow the parse error and return a ledger-shaped blank',
  '      } catch (err) {\n        throw new Error(',
  '      } catch (err) {\n        return { shards: [] };\n        throw new Error(',
);

// 6. COUNT-MATCH GUARD (#1520, N1 from the #1550 round-1 review): stop
//    requiring `shard.failures` to cover every counted failure before
//    labelling a shard `deploy-classified:`. Without this guard a PARTIALLY
//    attributed red shard (e.g. failed=2, failures=[{kind:'deploy'}] naming
//    only one of the two) would still get the readable deploy label even
//    though it cannot vouch for the other, unnamed failure.
prove(
  'count-match guard removed: a partially-attributed shard still gets the deploy-classified label',
  'if (!failures || failures.length !== failedCount) return false;',
  'if (!failures) return false;',
);

// 7. MODE-LESS BRIDGING (#1605): revert `inScope`'s credential branch to the
//    pre-fix behaviour — a mode-less, lane-matched, scheduled night is
//    dropped before grading rather than staying in the sequence to be
//    disqualified. This is what let 13 green + 30 mode-less + 1 green read
//    as a single 14-night streak on origin/main.
prove(
  'mode-less bridging: drop a mode-less night before grading instead of disqualifying it',
  'rule 5 already uses for a night whose ledger could not be read at all.\n  return true;\n}',
  'rule 5 already uses for a night whose ledger could not be read at all.\n  return false;\n}',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
