#!/usr/bin/env node
/**
 * Mutation proof for the HONEST line denominator (#1248, ADR-0057).
 *
 * WHAT IS BEING PROVED
 * --------------------
 * The coverage gate now also judges a line % over EXECUTABLE lines only. That
 * is only honest if two claims hold, in both directions:
 *
 *   1. the gate still COUNTS an uncovered executable line — dropping the filter,
 *      the honest floors, or the "keep it" branch must turn a spec red;
 *   2. the classifier NEVER reclassifies an executable line as noise — erasing a
 *      runtime construct (an `else`, a decorator, a call's argument parens, a
 *      class `extends`) must turn the tricky-case fixture red.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`)
 * ----------------------------------------
 *   - Every verdict branches on the runner's EXIT CODE. Output is never parsed.
 *   - STEP 0 proves the harness can SEE RED before any green is trusted.
 *   - Edits go through `scripts/lib/mutation-harness.mjs`: each anchor must occur
 *     EXACTLY ONCE, and restores are byte-identical.
 *   - The last mutation is a NEGATIVE control: rewording a comment must stay green.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLASSIFIER_SPEC = 'tests/coverage-executable-lines.test.ts';
const GATE_SPEC = 'tests/coverage-honest-gate.test.ts';
const CLASSIFIER = join(REPO_ROOT, 'scripts/lib/executable-lines.mjs');
const CHECKER = join(REPO_ROOT, 'scripts/check-coverage.mjs');

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

/** Run a spec. Returns ONLY the exit code — output is deliberately not parsed. */
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
  const ok = expected === 0 ? actual === 0 : actual !== 0;
  if (!ok)
    failures.push(`${id}: ${description} — exit ${actual}, expected ${expected ? 'non-zero' : 0}`);
  console.log(`   ${ok ? 'ok' : 'FAIL'}  ${id} exit=${actual} — ${description}`);
}

function assertTreeClean(label) {
  const dirty = git('status', '--porcelain', '--', 'scripts', 'tests')
    .split('\n')
    .filter((line) => line.trim());
  if (dirty.length) throw new Error(`[${label}] working tree not clean:\n${dirty.join('\n')}`);
}

/** Plant one mutation, run the spec, require the expected verdict, restore. */
function prove(id, description, snap, edits, spec, expected) {
  console.log(`── ${id}: ${description}`);
  for (const [anchor, replacement] of edits) mutate(snap, anchor, replacement);
  try {
    check(id, description, expected, runSpec(spec));
  } finally {
    restore(snap);
  }
  recordMutation();
  assertTreeClean(`after ${id}`);
}

declareMutations(13);

console.log('── baseline: both specs are green unmutated');
assertTreeClean('baseline');
const classifierSnap = snapshot(CLASSIFIER);
const checkerSnap = snapshot(CHECKER);
if (runSpec(CLASSIFIER_SPEC) !== 0 || runSpec(GATE_SPEC) !== 0) {
  console.error('ABORT: a spec is red before any mutation. Nothing below would mean anything.');
  process.exit(1);
}

console.log('── STEP 0: can this harness observe RED at all?');
// The crudest break: every token becomes punctuation, so every line is noise.
mutate(classifierSnap, '    runtime[line] = 1;\n  };', '    punct[line] = 1;\n  };');
const canary = runSpec(CLASSIFIER_SPEC);
restore(classifierSnap);
if (canary === 0) {
  console.error('ABORT: erasing every executable line left the classifier spec GREEN.');
  process.exit(1);
}
console.log(`   ok  the harness sees red (canary exit=${canary})`);
assertTreeClean('after canary');

// ── Direction 2: the classifier must never call an executable line noise ──

prove(
  'M1',
  'an `else` keyword treated as punctuation must red the fixture',
  classifierSnap,
  [
    [
      '    if (CLOSERS.has(tok.kind)) {',
      '    if (CLOSERS.has(tok.kind) || tok.kind === K.ElseKeyword) {',
    ],
  ],
  CLASSIFIER_SPEC,
  1,
);

prove(
  'M2',
  'runtime openers (call parens, object/array literals) treated as noise must red',
  classifierSnap,
  [
    [
      '  if (!RUNTIME_OPENER_PARENTS.has(parent.kind)) return false;',
      '  if (parent) return false;',
    ],
  ],
  CLASSIFIER_SPEC,
  1,
);

prove(
  'M3',
  'a class `extends` expression erased as a type must red',
  classifierSnap,
  [
    [
      '  if (node.kind === K.ExpressionWithTypeArguments) {',
      '  if (node.kind === K.ExpressionWithTypeArguments) {\n    return true;',
    ],
  ],
  CLASSIFIER_SPEC,
  1,
);

prove(
  'M4',
  'a decorator erased as type-only must red',
  classifierSnap,
  [['    case K.IndexSignature:', '    case K.IndexSignature:\n    case K.Decorator:']],
  CLASSIFIER_SPEC,
  1,
);

// ── Direction 1: the gate must still count an uncovered executable line ──

prove(
  'M5',
  'honestCoverage dropping executable records must red',
  classifierSnap,
  [['      if (cls === undefined || isExecutableClass(cls)) {', '      if (cls === undefined) {']],
  CLASSIFIER_SPEC,
  1,
);

prove(
  'M6',
  'the gate judging the honest floor on the RAW data must miss the one-line flip — red',
  checkerSnap,
  [
    [
      'const classified = honestCoverage(scoped, readSource);',
      'const classified = { files: scoped, noise: {}, unclassified: [] };',
    ],
  ],
  GATE_SPEC,
  1,
);

prove(
  'M7',
  'the gate no longer checking the honest floors must red',
  checkerSnap,
  [
    [
      "check('global (honest lines)', summarize(honest.files), HONEST_THRESHOLDS);",
      '// the global honest floor is no longer checked',
    ],
    [
      'for (const [glob, floors] of Object.entries(HONEST_PER_PATH_THRESHOLDS)) {',
      'for (const [glob, floors] of Object.entries({})) {',
    ],
  ],
  GATE_SPEC,
  1,
);

// ── Review round 2: the two latent erasures, re-opened ──

prove(
  'M9',
  'the runtime `void` operator erased as the `void` type must red',
  classifierSnap,
  [['    return ts.isTypeNode(node) && inTypeSlot(node);', '    return ts.isTypeNode(node);']],
  CLASSIFIER_SPEC,
  1,
);

prove(
  'M10',
  'an instantiation expression used as a value erased as a type must red',
  classifierSnap,
  [
    [
      '    if (!clause || !ts.isHeritageClause(clause)) return false;',
      '    if (!clause) return true;',
    ],
  ],
  CLASSIFIER_SPEC,
  1,
);

// ── Fail-closed: an unclassifiable source keeps EVERY record ──

prove(
  'M11',
  'a source with parse errors classified anyway (trusting a broken tree) must red',
  classifierSnap,
  [
    [
      '  if (diagnostics && diagnostics.length > 0) return { ok: false, classes: [] };',
      '  // parse errors ignored',
    ],
  ],
  CLASSIFIER_SPEC,
  1,
);

prove(
  'M12',
  'a DA line with no classification (past EOF) dropped instead of kept must red',
  classifierSnap,
  [
    [
      '      if (cls === undefined || isExecutableClass(cls)) {',
      '      if (cls !== undefined && isExecutableClass(cls)) {',
    ],
  ],
  CLASSIFIER_SPEC,
  1,
);

prove(
  'M13',
  'the gate reading a MISSING source as empty (so its records get classified) must red',
  checkerSnap,
  [['  } catch {\n    return null;\n  }', "  } catch {\n    return '';\n  }"]],
  GATE_SPEC,
  1,
);

prove(
  'M8',
  'NEGATIVE control: rewording a comment must stay GREEN',
  classifierSnap,
  [
    [
      '/** Closers and separators — never the carrier of a runtime operation. */',
      '/** Closers and separators (reworded by the negative control). */',
    ],
  ],
  CLASSIFIER_SPEC,
  0,
);

console.log('\n── final state');
assertTreeClean('final');
console.log('   ok  subjects restored byte-identically; working tree clean');

if (failures.length) {
  console.error(`\n${failures.length} mutation(s) did NOT behave as required:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n13 mutation(s) behaved as required (12 red, 1 negative control green), 0 survived.');
