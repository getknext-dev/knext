#!/usr/bin/env node
/**
 * Mutation proof for the retracted-figure boundary gate (#545, #710) —
 * `tests/retracted-figures.test.ts` over `scripts/lib/retracted-figures.mjs`.
 *
 * WHAT IS BEING PROVED, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * This gate exists because the same defect reproduced SIX times across three
 * review rounds: a figure corrected in one place while another copy went on
 * publishing the old value. A gate against a recurring defect that turns out to
 * be decoration is worse than none — it converts an open problem into a
 * false sense of closure. So every load-bearing behaviour is mutated and must
 * go red.
 *
 * The mutations target the decisions that could each silently neuter the gate:
 *   M1  the ledger emptied            — a vacuous gate passes everything
 *   M2  correction detection widened  — quoting alone would discharge an offence
 *   M3  correction detection narrowed — the #850 plain-prose reconciliation
 *   M4  blockquote stripping removed  — the live false negative, re-armed
 *   M5  issue scanning neutered       — a gate that inspects no issues
 *   M6  offence reporting suppressed  — finds offences, reports none
 *
 * M7–M10 pin the round-5 fixes. Each closed a hole review found by RUNNING the
 * gate rather than reading it, so each needs a mutation or it can silently
 * reopen:
 *   M7  cross-repo citation loses its owner/repo — resolves the WRONG repo
 *   M8  a cited PR loses its review surfaces     — under-scanned, silently
 *   M9  HTML-tag stripping removed               — `<b>9</b> restarts` evades
 *   M10 a ledger pattern widened                 — flags a TRUE sentence
 *
 *   NC  NEGATIVE CONTROL: an inert edit must leave the gate GREEN. A prover
 *       with no negative control cannot tell a guard from a tripwire.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`)
 *   - Every verdict branches on the runner's EXIT CODE; output is never parsed,
 *     and no run is ever piped into `tail`.
 *   - STEP 0 proves the harness can tell RED from GREEN — a red canary AND a
 *     green canary. A red-only canary cannot detect a runner that is broken at
 *     startup and therefore red for every input; that exact failure nearly
 *     certified four false results in this PR's round-3 review.
 *   - Anchored edits go through the shared byte-snapshot harness, which refuses
 *     unless the anchor occurs EXACTLY ONCE. No `perl`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';
import {
  countOccurrences,
  MUTATION_MARKER,
  mutate,
  restore,
  snapshot,
} from './lib/mutation-harness.mjs';
import { assessCompletion, evaluatePreflight } from './lib/prover-completion.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/retracted-figures.test.ts';
const CORE = join(REPO_ROOT, 'scripts/lib/retracted-figures.mjs');
const LEDGER = join(REPO_ROOT, 'docs/compat/retracted-figures.json');
const RED_CANARY = 'tests/__canary-retracted-red.test.ts';
const GREEN_CANARY = 'tests/__canary-retracted-green.test.ts';

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Run a spec. Returns ONLY the exit code. */
function runSpec(spec) {
  const runner = resolveTestRunner(REPO_ROOT);
  const res = spawnSync(runner.command, [...runner.args, 'run', spec], {
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

console.log('── baseline: the unmutated gate is green');
assertTreeClean('baseline');
const coreSnap = snapshot(CORE);
const ledgerSnap = snapshot(LEDGER);
if (runSpec(SPEC) !== 0) {
  console.error('ABORT: the gate is not green before any mutation.');
  process.exit(1);
}

/**
 * STEP 0 — the harness must tell red from green, not merely produce a red.
 *
 * Round 3's reviewer passed `--reporter=basic`, which vitest 4 rejects at
 * startup, so EVERY invocation exited 1 — including the baseline. A red-only
 * canary reports PASS in that world and certifies nothing. Requiring a green
 * canary too is what makes the harness's discrimination observable.
 */
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
/**
 * THE PLAN — every mutation as DATA, not as a straight-line script.
 *
 * WHY THIS SHAPE. The straight-line version died at M10 on a stale anchor and
 * ran 9 of 11: the four mutations after the failure never executed, and the
 * NEGATIVE CONTROL never ran at all — so the run proved nothing about whether
 * this prover can tell a guard from a tripwire, while a tracked report claimed
 * it completed. Declaring the plan as data makes three things structural rather
 * than hopeful:
 *
 *   1. every anchor is CHECKED BEFORE anything is planted (`preflight` below),
 *      so a stale anchor is reported up-front for ALL mutations at once instead
 *      of being discovered one crash at a time;
 *   2. the executed count is compared against the declared count at the end,
 *      and a shortfall FAILS LOUDLY (see the completion guard);
 *   3. the negative control is a member of the plan, so "did it run?" is an
 *      assertion rather than an assumption.
 *
 * `file` is which snapshot the mutation targets — the restore is looked up from
 * the plan, never hand-paired with the mutation at the call site.
 */
const PLAN = [
  {
    id: 'M1',
    file: 'ledger',
    title: 'the ledger emptied',
    desc: 'a ledger with no figures must not pass vacuously',
    expected: 1,
    anchor: '"figures": [',
    // The marker goes in a JSON KEY, not a comment: JSON has no comment syntax,
    // so a `//` marker would make the file unparseable and M1 would go red for a
    // syntax error instead of for the vacuity it exists to prove. And it is
    // INTERPOLATED — a tracked file containing the literal marker IS residue,
    // which is how this prover reddened `scan-mutation-residue.mjs` once already.
    replacement: `"figures": [], "${MUTATION_MARKER}-original-figures": [`,
  },
  {
    id: 'M2',
    file: 'core',
    title: 'correction detection WIDENED — quoting alone discharges',
    desc: 'republishing the error must not count as correcting it',
    expected: 1,
    anchor:
      '  if (matchesFigure(sourceBody, figure).length === 0) return false;\n  const hay = normalize(sourceBody);\n  return hay.includes(normalize(figure.correctionSignature));',
    replacement: '  return matchesFigure(sourceBody, figure).length > 0;',
  },
  {
    id: 'M3',
    file: 'core',
    title: 'correction detection NARROWED — signature alone is not enough',
    desc: 'a plain-prose reconciliation (#850) must still discharge',
    expected: 1,
    anchor: '  if (matchesFigure(sourceBody, figure).length === 0) return false;',
    replacement:
      '  if (matchesFigure(sourceBody, figure).length === 0) return false;\n  if (!normalize(sourceBody).includes("## correction")) return false;',
  },
  {
    id: 'M4',
    file: 'core',
    title: 'blockquote stripping removed — the live false negative re-armed',
    desc: 'a quoted correction must still match its own quote',
    expected: 1,
    anchor: ".replace(/^[ \\t]*(?:>[ \\t]*)+/gm, '') // blockquote markers, possibly nested",
    replacement: '',
  },
  {
    id: 'M5',
    file: 'core',
    title: 'issue scanning neutered — the gate would inspect nothing',
    desc: 'a scan that finds no cited issues must go red',
    expected: 1,
    anchor:
      '    if (!byKey.has(key)) byKey.set(key, { owner: owner ?? null, repo: repo ?? null, number });',
    replacement:
      '    if (false) byKey.set(key, { owner: owner ?? null, repo: repo ?? null, number });',
  },
  {
    id: 'M6',
    file: 'core',
    title: 'offence reporting suppressed',
    desc: 'finding offences but reporting none must go red',
    expected: 1,
    anchor: '  return offences;',
    replacement: '  return [];',
  },
  // ── M7–M10 pin the round-5 fixes. Each closed a hole review found by RUNNING
  // the gate, so each needs a mutation or it can silently reopen.
  {
    id: 'M7',
    file: 'core',
    title: 'cross-repo citations lose their owner/repo again',
    desc: 'discarding owner/repo checks the WRONG repository',
    expected: 1,
    anchor: '    add(m[1], m[2], Number(m[3]));\n  }\n  // `owner/repo#N` shorthand.',
    replacement: '    add(null, null, Number(m[3]));\n  }\n  // `owner/repo#N` shorthand.',
  },
  {
    id: 'M8',
    file: 'core',
    title: 'a cited PR loses its review surfaces',
    desc: 'a figure in a PR review body must still be seen',
    expected: 1,
    anchor: '  if (issue?.pull_request) {',
    replacement: '  if (false && issue?.pull_request) {',
  },
  {
    id: 'M9',
    file: 'core',
    title: 'HTML-tag stripping removed from the normaliser',
    desc: 'inline HTML must not hide a retracted figure',
    expected: 1,
    anchor: "      .replace(/<[^>\\n]{0,200}>/g, '')",
    replacement: '',
  },
  {
    id: 'M10',
    file: 'ledger',
    title: 'a ledger pattern widened back to the over-broad form',
    desc: 'an over-broad pattern that flags a TRUE sentence must go red',
    expected: 1,
    // ANCHORED ON A STRING LITERAL, NOT ON LAYOUT. The previous anchor spanned
    // two lines of the `patterns` array at a fixed indent; `60bae6d` ran biome
    // over the ledger, collapsed the array onto one line, and the anchor
    // vanished — which is what killed this prover at M10. A JSON string literal
    // is the one thing a formatter will not rewrite, so the anchor is now the
    // quoted value itself. (Bare `9 restarts in 27 nights` occurs twice — it is
    // also in the `wrong` field — so the quotes are load-bearing, not cosmetic.)
    anchor: '"9 restarts in 27 nights"',
    replacement: `"9 restarts", "${MUTATION_MARKER} widened"`,
  },
  {
    /**
     * NC — NEGATIVE CONTROL, and the one that matters most for this gate.
     *
     * An inert edit must leave the gate GREEN. Without it, a prover cannot tell
     * a guard from a tripwire — something that reds at any edit reds at every
     * edit, and would score 10/10 above while proving nothing.
     *
     * `mutate()` appends its residue marker as a trailing comment, which IS the
     * inert change: the same file is written, the same harness path runs, and
     * nothing the gate depends on moves.
     *
     * It runs LAST, which is exactly why the completion guard below exists: in
     * the run that died at M10 this never executed, and 9 reds with no control
     * is not a partial success — it is an unproven prover.
     */
    id: 'NC',
    file: 'core',
    title: 'NEGATIVE control — an inert edit to the same file',
    desc: 'an inert edit must leave the gate GREEN',
    expected: 0,
    isNegativeControl: true,
    anchor: '  const byKey = new Map();',
    replacement: '  const byKey = new Map();',
  },
];

declareMutations(PLAN.length);

const snapFor = (m) => (m.file === 'ledger' ? ledgerSnap : coreSnap);
const pathFor = (m) => (m.file === 'ledger' ? LEDGER : CORE);

/**
 * PREFLIGHT — every anchor must resolve BEFORE anything is planted.
 *
 * The harness already refuses a substitution whose anchor is not unique, and
 * that refusal is what stopped a silently-failed mutation being scored. But it
 * fires mid-run, one mutation at a time, after earlier mutations have already
 * executed — so a stale anchor reads as "the prover crashed" rather than "these
 * three anchors need repointing". Checking the whole plan first turns a crash
 * into a report.
 */
function preflight() {
  const counts = PLAN.map((m) => ({
    id: m.id,
    count: countOccurrences(readFileSync(pathFor(m), 'utf8'), m.anchor),
  }));
  // The VERDICT is pure and lives in scripts/lib/prover-completion.mjs, so it
  // can be unit-tested and mutated. This function only gathers and prints.
  const { ok, stale } = evaluatePreflight(counts);
  if (!ok) {
    console.error(
      `\nABORT before planting: ${stale.length} of ${PLAN.length} anchors do not resolve.`,
    );
    for (const s of stale) console.error(`  ${s.id}: anchor occurs ${s.count}x (need exactly 1)`);
    console.error(
      '\nNothing was mutated, so the tree is untouched. Repoint the anchors at the current\n' +
        'source. Prefer anchors a formatter will not rewrite — a JSON string literal rather\n' +
        'than a multi-line array at a fixed indent, which is what broke M10 when biome\n' +
        'collapsed the ledger.',
    );
    process.exit(1);
  }
  console.log(`   ok  all ${PLAN.length} anchors resolve exactly once`);
}

console.log("── preflight: do every mutation's anchors still exist?");
preflight();

const executedIds = [];
let died = null;
let inFlight = null;

try {
  for (const m of PLAN) {
    inFlight = m;
    console.log(`── planting ${m.id}: ${m.title}`);
    mutate(snapFor(m), m.anchor, m.replacement);
    check(m.id, m.desc, m.expected, runSpec(SPEC));
    recordMutation();
    executedIds.push(m.id);
    restore(snapFor(m));
    assertTreeClean(`after ${m.id}`);
    inFlight = null;
  }
} catch (err) {
  died = { id: inFlight?.id ?? '(unknown)', message: String(err?.message ?? err) };
} finally {
  // Restore unconditionally and in both files. A mutation that survives a crash
  // is the incident this repo's byte-snapshot harness was built for, and the
  // straight-line version had no finally at all.
  restore(coreSnap);
  restore(ledgerSnap);
}

console.log('\n── final state');
assertTreeClean('final');
console.log('   ok  core and ledger restored byte-identically; working tree clean');

/**
 * COMPLETION GUARD — a partial run is a FAILURE, never a partial success.
 *
 * This is the general fix. The specific stale anchor is repointed above, but the
 * next early death would have been just as quiet: the summary line would read
 * `{"declared":11,"run":9}`, four mutations and the negative control would be
 * missing, and the only signal was an unhandled stack trace that a reader could
 * mistake for noise after nine `ok` lines. Now the prover says exactly what
 * failed to happen, and says it after the `ok`s rather than before them.
 */
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
const controls = PLAN.length - reds;
console.log(
  `\n${PLAN.length} mutation(s) behaved as required (${reds} red, ${controls} negative control green), 0 survived.`,
);
