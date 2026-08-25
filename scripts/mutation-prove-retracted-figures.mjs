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
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
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

declareMutations(11);

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

console.log('\n── planting M1: the ledger emptied');
// The marker is embedded in a JSON KEY rather than a comment: JSON has no
// comment syntax, so a `//` marker would make the file unparseable and M1 would
// go red for a syntax error instead of for the vacuity it is meant to prove.
//
// And it is INTERPOLATED from the harness's constant, never written as a
// literal — for the same reason `mutation-harness.mjs` and
// `scan-mutation-residue.mjs` both assemble it from parts. A tracked file
// containing the literal marker IS residue by definition, so an earlier version
// of this line made `scripts/scan-mutation-residue.mjs` exit 1 against a clean
// tree. The repo's own guard caught it; this is the fix, not a suppression.
mutate(ledgerSnap, '"figures": [', `"figures": [], "${MUTATION_MARKER}-original-figures": [`);
check('M1', 'a ledger with no figures must not pass vacuously', 1, runSpec(SPEC));
recordMutation();
restore(ledgerSnap);
assertTreeClean('after M1');

console.log('── planting M2: correction detection WIDENED — quoting alone discharges');
mutate(
  coreSnap,
  '  if (matchesFigure(sourceBody, figure).length === 0) return false;\n  const hay = normalize(sourceBody);\n  return hay.includes(normalize(figure.correctionSignature));',
  '  return matchesFigure(sourceBody, figure).length > 0;',
);
check('M2', 'republishing the error must not count as correcting it', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M2');

console.log('── planting M3: correction detection NARROWED — signature alone is not enough');
mutate(
  coreSnap,
  '  if (matchesFigure(sourceBody, figure).length === 0) return false;',
  '  if (matchesFigure(sourceBody, figure).length === 0) return false;\n  if (!normalize(sourceBody).includes("## correction")) return false;',
);
check('M3', 'a plain-prose reconciliation (#850) must still discharge', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M3');

console.log('── planting M4: blockquote stripping removed — the live false negative re-armed');
mutate(
  coreSnap,
  ".replace(/^[ \\t]*(?:>[ \\t]*)+/gm, '') // blockquote markers, possibly nested",
  '',
);
check('M4', 'a quoted correction must still match its own quote', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M4');

console.log('── planting M5: issue scanning neutered — the gate would inspect nothing');
mutate(coreSnap, '  return [...found].sort((a, b) => a - b);', '  return [];');
check('M5', 'a scan that finds no cited issues must go red', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M5');

console.log('── planting M6: offence reporting suppressed');
mutate(coreSnap, '  return offences;', '  return [];');
check('M6', 'finding offences but reporting none must go red', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M6');

// ── M7–M10: the round-5 fixes. Each closed a hole review found by RUNNING the
// gate, so each needs a mutation or it can silently reopen.

console.log('── planting M7: cross-repo citations lose their owner/repo again');
mutate(
  coreSnap,
  '    add(m[1], m[2], Number(m[3]));\n  }\n  // `owner/repo#N` shorthand.',
  '    add(null, null, Number(m[3]));\n  }\n  // `owner/repo#N` shorthand.',
);
check('M7', 'discarding owner/repo checks the WRONG repository', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M7');

console.log('── planting M8: a cited PR loses its review surfaces');
mutate(coreSnap, '  if (issue?.pull_request) {', '  if (false && issue?.pull_request) {');
check('M8', 'a figure in a PR review body must still be seen', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M8');

console.log('── planting M9: HTML-tag stripping removed from the normaliser');
mutate(coreSnap, "      .replace(/<[^>\\n]{0,200}>/g, '')", '');
check('M9', 'inline HTML must not hide a retracted figure', 1, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after M9');

console.log('── planting M10: a ledger pattern widened back to the over-broad form');
// Restores the exact over-broad pattern round-5 review found: bare "9 restarts"
// flags the bun lane's own true sentence. The negative corpus must catch it.
mutate(
  ledgerSnap,
  '        "9 restarts in 27 nights",\n        "churn: 9 restarts"',
  '        "9 restarts",\n        "churn: 9 restarts",\n        "KNEXT-MUTATION widened"'.replace(
    'KNEXT-MUTATION',
    MUTATION_MARKER,
  ),
);
check('M10', 'an over-broad pattern that flags a TRUE sentence must go red', 1, runSpec(SPEC));
recordMutation();
restore(ledgerSnap);
assertTreeClean('after M10');

/**
 * NC — NEGATIVE CONTROL, and the one that matters most for this gate.
 *
 * The rule keys off the CLAIM (quote + corrected value), not off a label. If it
 * keyed off a label, anyone could discharge an offence by pasting a heading. So
 * relabelling must change NOTHING: the suite must stay green, because the guard
 * already asserts that a cosmetic `## Correction` heading does not discharge.
 * A prover with no negative control cannot tell a guard from a tripwire.
 */
console.log('── planting NC (NEGATIVE control): an inert edit to the same file');
// `mutate()` appends its residue marker as a trailing comment, which is exactly
// the inert change wanted here: the same file is edited, the same harness path
// runs, and nothing the gate depends on moves.
mutate(coreSnap, '  const found = new Set();', '  const found = new Set();');
check('NC', 'an inert edit must leave the gate GREEN', 0, runSpec(SPEC));
recordMutation();
restore(coreSnap);
assertTreeClean('after NC');

console.log('\n── final state');
restore(coreSnap);
restore(ledgerSnap);
assertTreeClean('final');
console.log('   ok  core and ledger restored byte-identically; working tree clean');

if (failures.length) {
  console.error(`\n${failures.length} mutation(s) did NOT behave as required:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n11 mutation(s) behaved as required (10 red, 1 negative control green), 0 survived.');
