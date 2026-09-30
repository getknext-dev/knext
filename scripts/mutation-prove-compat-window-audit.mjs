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
 * `isDeployOnlyRedShard`'s doc comment in the target file) — so there was no
 * VOID behaviour here to prove, until #1553 (ADR-0056 Amendment 4, founder
 * decision 2026-09-30) reintroduced a NARROWER one: a night void-eligible only
 * on a PROVEN `kind: 'pre-knext'` failure plus a self-referencing marker,
 * bridged at most once per open streak. Guards 18-25 below prove every branch
 * of that gate independently:
 *   18. KIND CHECK — a `kind: 'deploy'` failure carrying a forged pre-knext-
 *       shaped `phase` field must still never classify (`kind` and `phase`
 *       are checked independently on purpose).
 *   19. MARKER RUNID — a marker naming a different run (copy-pasted/forged)
 *       must never grant the grace.
 *   20. MARKER LANE — a marker naming a different lane must never grant it.
 *   21. MARKER PHASE — a marker with an unrecognised phase must never grant it.
 *   22. CREDENTIAL-SCOPE GATE — void grading must never apply outside
 *       `scope: 'credential'`.
 *   23. FINGERPRINT CONTINUITY — a void-eligible night whose fingerprint does
 *       not match the open streak must not bridge it.
 *   24. ONE BRIDGE PER STREAK — a second void-eligible night in the same
 *       still-open streak must not bridge again.
 *   25. EMPTY-DISQUALIFIER GUARD — a fully green night (nothing to excuse)
 *       must never be reported void-eligible, marker or not.
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

declareMutations(25);

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

// ── #1612 round 2 — rule 8 (the missing-night calendar) ─────────────────────

prove(
  'missing-night insertion: never synthesize a stand-in for an empty cron slot',
  '.filter((d) => !known.has(d))',
  '.filter(() => false)',
);

prove(
  'grace removed: call a slot missing the moment it fires, not slot + grace',
  'while (fireMs(slot) + graceMs > now.getTime())',
  'while (fireMs(slot) > now.getTime())',
);

prove(
  'grace boundary: a night exactly at slot + grace is still treated as in flight',
  '+ graceMs > now.getTime()',
  '+ graceMs >= now.getTime()',
);

prove(
  'fail-open: met stops requiring a verified calendar',
  "met: scope === 'credential' && calendar.checked && longest.nights >= requiredNights,",
  "met: scope === 'credential' && longest.nights >= requiredNights,",
);

prove(
  'fail-open report: an unverified calendar falls through to the GATE MET/NOT MET line',
  'if (!audit.calendarChecked) {',
  'if (false) {',
);

prove(
  'partial calendar: undated nights are ignored instead of making the calendar unverified',
  'if (undated > 0) {',
  'if (false) {',
);

prove(
  'wall-clock dating: a run belongs to its createdAt date, not its cron slot',
  'return ms >= fireMs(d) ? d : addUTCDays(d, -1);',
  'return d;',
);

prove(
  'slot dedupe removed: two runs in one cron slot count as two nights',
  'if (perSlot.get(n.date) > 1) {',
  'if (false) {',
);

prove(
  'silent lane drop: a wired lane with no credential cron is tolerated',
  'if (!laneToCron.has(lane)) {',
  'if (false) {',
);

prove(
  'stale cron: a credential cron absent from on.schedule is tolerated',
  'if (!scheduled.has(cron)) {',
  'if (false) {',
);

// ── #1553 (ADR-0056 Amendment 4) — the bounded VOID grade ───────────────────

// 18. KIND CHECK: a `kind: 'deploy'` failure with a forged pre-knext-shaped
//     `phase` field must still never classify as pre-knext.
prove(
  'kind check removed: a deploy-kind failure with a forged phase field classifies as pre-knext',
  "return failures.every((f) => f?.kind === 'pre-knext' && PRE_KNEXT_PHASES.includes(f?.phase));",
  'return failures.every((f) => PRE_KNEXT_PHASES.includes(f?.phase));',
);

// 19. MARKER RUNID: a marker naming a different run must never grant the grace.
prove(
  'marker runId check removed: a marker copy-pasted from another run still grants void',
  "if (String(marker.runId ?? '') !== String(ledger?.runId ?? '')) return false;",
  'if (false) return false;',
);

// 20. MARKER LANE: a marker naming a different lane must never grant it.
prove(
  'marker lane check removed: a marker for a different lane still grants void',
  'if (marker.lane !== ledger?.lane) return false;',
  'if (false) return false;',
);

// 21. MARKER PHASE: a marker with an unrecognised phase must never grant it.
prove(
  'marker phase check removed: a marker with a garbage phase still grants void',
  'if (!PRE_KNEXT_PHASES.includes(marker.phase)) return false;',
  'if (false) return false;',
);

// 22. CREDENTIAL-SCOPE GATE: void grading must never apply outside
//     scope: 'credential'.
prove(
  'credential-scope gate removed: an early-warning night can be granted void',
  "const voidMarkerValid =\n    scope === 'credential' && isValidPreKnextVoidMarker(ledger?.preKnextVoidMarker, ledger);",
  'const voidMarkerValid = isValidPreKnextVoidMarker(ledger?.preKnextVoidMarker, ledger);',
);

// 23. FINGERPRINT CONTINUITY: a void-eligible night whose fingerprint does not
//     match the open streak must not bridge it.
prove(
  'fingerprint continuity removed: a void-eligible night bridges across a fingerprint change',
  '        open !== null &&\n        open.fingerprint === night.fingerprint &&\n        !open.voidUsed;',
  '        open !== null &&\n        !open.voidUsed;',
);

// 24. ONE BRIDGE PER STREAK: a second void-eligible night in the same
//     still-open streak must not bridge again.
prove(
  'budget cap removed: a second void night in the same open streak still bridges',
  '        open.fingerprint === night.fingerprint &&\n        !open.voidUsed;',
  '        open.fingerprint === night.fingerprint;',
);

// 25. EMPTY-DISQUALIFIER GUARD: a fully green night (nothing to excuse) must
//     never be reported void-eligible, marker or not.
prove(
  'empty-disqualifier guard removed: a fully green night is reported void-eligible',
  'if (!voidMarkerValid || disqualifiers.length === 0) return false;',
  'if (!voidMarkerValid) return false;',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
