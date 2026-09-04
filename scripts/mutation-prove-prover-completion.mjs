#!/usr/bin/env node
/**
 * Mutation proof for the prover-completion guard (#545, #710) —
 * `tests/prover-completion.test.ts` over `scripts/lib/prover-completion.mjs`.
 *
 * WHY THIS EXISTS. The guard being proved here is the one that stops a mutation
 * prover reporting success on a partial run. It was written *because* this PR's
 * flagship prover died at M10, executed 9 of 11 mutations, skipped its negative
 * control, and a tracked report claimed it completed.
 *
 * A guard against silent partial proofs that is itself unproven would be the
 * same defect one level up — so it gets the same treatment, including its own
 * negative control.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`)
 *   - every verdict branches on the runner's EXIT CODE; output is never parsed;
 *   - STEP 0 requires BOTH a red canary and a green canary, because a runner
 *     broken at startup reds for every input and a red-only canary cannot tell
 *     that apart from a working one;
 *   - PREFLIGHT resolves every anchor before anything is planted;
 *   - a COMPLETION GUARD asserts this prover itself ran to the end — the same
 *     rule it is proving, applied to itself;
 *   - anchored edits go through the byte-snapshot harness, which refuses unless
 *     the anchor occurs exactly once. No `perl`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { countOccurrences, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { assessCompletion, evaluatePreflight } from './lib/prover-completion.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/prover-completion.test.ts';
const CORE = join(REPO_ROOT, 'scripts/lib/prover-completion.mjs');
const RED_CANARY = 'tests/__canary-completion-red.test.ts';
const GREEN_CANARY = 'tests/__canary-completion-green.test.ts';

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Run a spec. Returns ONLY the exit code. */
function runSpec(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const res = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (res.status === null) {
    throw new Error(`runner did not exit cleanly: ${res.signal ?? res.error}`);
  }
  return res.status;
}

const failures = [];
function check(id, description, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures.push(`${id}: ${description} — exit ${actual}, expected ${expected}`);
  console.log(`   ${ok ? 'ok' : 'FAIL'}  ${id} exit=${actual} (want ${expected}) — ${description}`);
}

function assertTreeClean(label) {
  const dirty = git('status', '--porcelain')
    .split('\n')
    .filter((line) => line.trim() && !line.includes('.claude/'));
  if (dirty.length) throw new Error(`[${label}] working tree not clean:\n${dirty.join('\n')}`);
}

function writeCanary(path, shouldPass) {
  writeFileSync(
    join(REPO_ROOT, path),
    [
      "import { describe, expect, it } from 'vitest';",
      "describe('canary', () => {",
      `  it('${shouldPass ? 'passes' : 'fails'} on purpose', () => {`,
      `    expect(1).toBe(${shouldPass ? '1' : '2'});`,
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

const PLAN = [
  {
    id: 'C1',
    title: 'the completion verdict hard-wired to OK',
    desc: 'a guard that always passes cannot detect a partial run',
    expected: 1,
    anchor: '  return { ok: reasons.length === 0, reasons, neverRan };',
    replacement: '  return { ok: true, reasons: [], neverRan };',
  },
  {
    id: 'C2',
    title: 'the declared-vs-executed count check removed',
    desc: 'a short run must not pass as complete',
    expected: 1,
    anchor: '  if (executedIds.length !== declaredIds.length) {',
    replacement: '  if (false) {',
  },
  {
    id: 'C3',
    title: 'the negative-control check removed',
    desc: 'a run whose control never fired must still fail',
    expected: 1,
    anchor: '  if (!controlId || !executed.has(controlId)) {',
    replacement: '  if (false) {',
  },
  {
    id: 'C4',
    title: 'the control check weakened to "was one declared"',
    desc: 'declaring a control is not the same as running it',
    expected: 1,
    // The subtle wrong version: it accepts a plan that NAMES a control even
    // though the control never executed — exactly the M10 run.
    anchor: '  if (!controlId || !executed.has(controlId)) {',
    replacement: '  if (!controlId) {',
  },
  {
    id: 'C5',
    title: 'the died-partway check removed',
    desc: 'a run that threw must not be reported as complete',
    expected: 1,
    anchor: '  if (died) reasons.push(`died at ${died.id}: ${died.message}`);',
    replacement: '',
  },
  {
    id: 'C6',
    title: 'preflight accepts a missing anchor',
    desc: 'a stale anchor must be caught before anything is planted',
    expected: 1,
    // Anchored on the PREDICATE, not on the statement's layout. The first
    // version spanned the whole `const stale = anchorCounts.filter(...)` line,
    // and biome had already reflowed that chain across three lines — so the
    // anchor did not resolve. Exactly the M10 failure, caught this time by the
    // preflight before anything was planted, which is what the preflight is for.
    // End-of-line span ON PURPOSE (PR #940 sweep): the harness appends a
    // line-comment residue marker after a single-line replacement, and the
    // previous mid-line anchor ('(a) => a.count !== 1') had that marker
    // comment out the chain's closing ')' — the file stopped parsing, the
    // guard reddened on the failed import, and the kill was for the wrong
    // reason. The predicate concern in the comment above still holds: the
    // anchor stays on THIS line only, never spanning the reflowable chain.
    anchor: '    .filter((a) => a.count !== 1)',
    replacement: '    .filter((a) => a.count > 1)',
  },
  {
    id: 'C7',
    title: 'preflight reports only the first stale anchor',
    desc: 'every stale anchor must be reported in one pass',
    expected: 1,
    anchor: '  return { ok: stale.length === 0, stale };',
    replacement: '  return { ok: stale.length === 0, stale: stale.slice(0, 1) };',
  },
  {
    /**
     * NC — the negative control for the guard that checks negative controls.
     *
     * An inert edit must leave the suite GREEN. Without it, C1–C7 could all be
     * reding because the file simply fails to parse under any change, and this
     * prover would score 7/7 while establishing nothing.
     */
    id: 'NC',
    title: 'NEGATIVE control — an inert edit to the same file',
    desc: 'an inert edit must leave the guard GREEN',
    expected: 0,
    isNegativeControl: true,
    anchor: '  const reasons = [];',
    replacement: '  const reasons = [];',
  },
];

declareMutations(PLAN.length);

console.log('── baseline: the unmutated guard is green');
assertTreeClean('baseline');
const coreSnap = snapshot(CORE);
if (runSpec(SPEC) !== 0) {
  console.error('ABORT: the guard is not green before any mutation.');
  process.exit(1);
}

console.log('── STEP 0: can this harness tell RED from GREEN?');
writeCanary(RED_CANARY, false);
writeCanary(GREEN_CANARY, true);
const redExit = runSpec(RED_CANARY);
const greenExit = runSpec(GREEN_CANARY);
rmSync(join(REPO_ROOT, RED_CANARY), { force: true });
rmSync(join(REPO_ROOT, GREEN_CANARY), { force: true });
if (redExit !== 1 || greenExit !== 0) {
  console.error(
    `ABORT: harness cannot discriminate — red canary exited ${redExit} (want 1), green canary exited ${greenExit} (want 0).`,
  );
  process.exit(1);
}
console.log('   ok  red canary exit=1, green canary exit=0 — the harness discriminates');
assertTreeClean('after canaries');

console.log("── preflight: do every mutation's anchors still exist?");
{
  const counts = PLAN.map((m) => ({
    id: m.id,
    count: countOccurrences(readFileSync(CORE, 'utf8'), m.anchor),
  }));
  const { ok, stale } = evaluatePreflight(counts);
  if (!ok) {
    console.error(
      `\nABORT before planting: ${stale.length} of ${PLAN.length} anchors do not resolve.`,
    );
    for (const s of stale) console.error(`  ${s.id}: anchor occurs ${s.count}x (need exactly 1)`);
    process.exit(1);
  }
  console.log(`   ok  all ${PLAN.length} anchors resolve exactly once`);
}

const executedIds = [];
let died = null;
let inFlight = null;

try {
  for (const m of PLAN) {
    inFlight = m;
    console.log(`── planting ${m.id}: ${m.title}`);
    mutate(coreSnap, m.anchor, m.replacement);
    // VALIDITY BEFORE VERDICT (PR #940 sweep). A mutation that leaves the
    // subject unparseable reds the guard on the failed import, and that red
    // is indistinguishable in the log from the guard doing its job — C6's old
    // mid-line anchor did exactly this. Throwing here is safe: the `finally`
    // below restores the snapshot, and assessCompletion reports the death.
    {
      const parseProblem = jsStillParses(readFileSync(CORE, 'utf8'));
      if (parseProblem) {
        throw new Error(
          `${m.id} left its subject INVALID (${parseProblem}). Its verdict would be a red for ` +
            'the wrong reason. Fix the mutation, do not accept the red.',
        );
      }
    }
    check(m.id, m.desc, m.expected, runSpec(SPEC));
    recordMutation();
    executedIds.push(m.id);
    restore(coreSnap);
    assertTreeClean(`after ${m.id}`);
    inFlight = null;
  }
} catch (err) {
  died = { id: inFlight?.id ?? '(unknown)', message: String(err?.message ?? err) };
} finally {
  restore(coreSnap);
}

console.log('\n── final state');
assertTreeClean('final');
console.log('   ok  guard restored byte-identically; working tree clean');

// This prover applies its own rule to itself.
const completion = assessCompletion({
  declaredIds: PLAN.map((m) => m.id),
  executedIds,
  controlId: PLAN.find((m) => m.isNegativeControl)?.id ?? null,
  died,
});
if (!completion.ok) {
  console.error('\nPROVER DID NOT COMPLETE — this is a FAILURE, not a partial success.');
  console.error(`  declared: ${PLAN.length}`);
  console.error(`  executed: ${executedIds.length}`);
  for (const reason of completion.reasons) console.error(`  ${reason}`);
  process.exit(1);
}

if (failures.length) {
  console.error(`\n${failures.length} mutation(s) did NOT behave as required:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

const reds = PLAN.filter((m) => !m.isNegativeControl).length;
console.log(
  `\n${PLAN.length} mutation(s) behaved as required (${reds} red, ${PLAN.length - reds} negative control green), 0 survived.`,
);
