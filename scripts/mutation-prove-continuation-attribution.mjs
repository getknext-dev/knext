#!/usr/bin/env node
/**
 * Mutation proof for continuation-line attribution (#1262, ADR-0057 Amendment 1).
 *
 * WHAT IS BEING PROVED, in both directions
 * ----------------------------------------
 *   1. OVER-attribution is caught. The rule may only credit a line that is
 *      PURELY a string-literal / `+` continuation whose statement evaluates
 *      nothing risky before it. Loosening any one check — a call-carrying line,
 *      a ternary branch, a short-circuit, a statement sharing its line with an
 *      `if`, a record the reports never carried, a `${…}` line — must turn a
 *      spec red. So must every way the first line can read hit on a path that
 *      never runs the statement (rule 5, #1268 review): a throwing call earlier
 *      in the same basic block, a bare nested `{ }`, a `case` clause, an
 *      expression statement treated as a block boundary. And so must letting a
 *      string-converted identifier (`${name}`, `name +`) precede the literal.
 *   2. UNDER-attribution is caught. Removing the attribution (in the lib, or its
 *      wiring in the gate) must put the two-report-merge fixture back to
 *      uncovered — red.
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
const SPEC = 'tests/coverage-continuation-attribution.test.ts';
const LIB = join(REPO_ROOT, 'scripts/lib/continuation-attribution.mjs');
const CHECKER = join(REPO_ROOT, 'scripts/check-coverage.mjs');

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

/** Run the spec. Returns ONLY the exit code — output is deliberately not parsed. */
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
function prove(id, description, snap, edits, expected) {
  console.log(`── ${id}: ${description}`);
  for (const [anchor, replacement] of edits) mutate(snap, anchor, replacement);
  try {
    check(id, description, expected, runSpec(SPEC));
  } finally {
    restore(snap);
  }
  recordMutation();
  assertTreeClean(`after ${id}`);
}

declareMutations(23);

console.log('── baseline: the spec is green unmutated');
assertTreeClean('baseline');
const libSnap = snapshot(LIB);
const checkerSnap = snapshot(CHECKER);
if (runSpec(SPEC) !== 0) {
  console.error('ABORT: the spec is red before any mutation. Nothing below would mean anything.');
  process.exit(1);
}

console.log('── STEP 0: can this harness observe RED at all?');
// The crudest break: nothing is ever attributable.
mutate(libSnap, '  return { ok: true, anchors };', '  return { ok: true, anchors: new Map() };');
const canary = runSpec(SPEC);
restore(libSnap);
if (canary === 0) {
  console.error('ABORT: attributing nothing left the spec GREEN.');
  process.exit(1);
}
console.log(`   ok  the harness sees red (canary exit=${canary})`);
assertTreeClean('after canary');

// ── Direction 1: over-attribution must be caught ──

prove(
  'M1',
  'a continuation line that CONTAINS a call (identifier + `(` allowed on the line) must red',
  libSnap,
  [
    [
      '  K.PlusToken,\n  K.CloseParenToken,',
      '  K.PlusToken,\n  K.Identifier,\n  K.OpenParenToken,\n  K.CloseParenToken,',
    ],
  ],
  1,
);

prove(
  'M2',
  'the before-the-literal scan disabled (a call / optional call / property callee ahead) must red',
  libSnap,
  [['      if (!nothingRiskyBefore(stmt, lit, sf)) {', '      if (false) {']],
  1,
);

prove(
  'M3',
  'the climb accepting ANY parent (ternary branch, short-circuit, arrow body) must red',
  libSnap,
  [
    [
      '    if (ANCHOR_STATEMENTS.has(parent.kind)) return /** @type {ts.Statement} */ (parent);\n    return null;',
      '    if (ANCHOR_STATEMENTS.has(parent.kind)) return /** @type {ts.Statement} */ (parent);\n    node = parent;',
    ],
  ],
  1,
);

prove(
  'M4',
  'a statement sharing its line with an earlier `if (x)` accepted as the anchor must red',
  libSnap,
  [
    [
      "      if (sLine >= line || src.slice(starts[sLine], stmtStart).trim() !== '') {",
      '      if (sLine >= line) {',
    ],
  ],
  1,
);

prove(
  'M5',
  'a short-circuit operator allowed ahead of the literal must red',
  libSnap,
  [
    [
      '  K.PlusToken,\n  K.OpenParenToken,',
      '  K.PlusToken,\n  K.BarBarToken,\n  K.OpenParenToken,',
    ],
  ],
  1,
);

// M6 (an assignment `=` allowed ahead of the literal) is RETIRED, not skipped: the
// separate `=` check it mutated was unobservable — every assignment target is an
// identifier (refused by the rule M18 mutates) or an access / pattern outside the
// allowlist — so the check was removed in the #1268 review rather than kept as
// decoration. The assignment fixture now reds under M18.

prove(
  'M7',
  'attribution ADDING a record the reports never carried must red',
  libSnap,
  [
    [
      '        if (lines.get(line) !== 0) continue; // no record, or already hit',
      '        if ((lines.get(line) ?? 0) !== 0) continue;',
    ],
  ],
  1,
);

prove(
  'M8',
  'a source with parse errors analysed anyway (trusting a broken tree) must red',
  libSnap,
  [
    [
      '  if (diagnostics && diagnostics.length > 0) return { ok: false, anchors: new Map() };',
      '  // parse errors ignored',
    ],
  ],
  1,
);

prove(
  'M9',
  'a `${…}` line treated as a pure continuation must red',
  libSnap,
  [
    [
      'const LITERALS = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral]);',
      'const LITERALS = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead]);',
    ],
    [
      '  K.PlusToken,\n  K.CloseParenToken,',
      '  K.PlusToken,\n  K.TemplateHead,\n  K.TemplateTail,\n  K.Identifier,\n  K.CloseParenToken,',
    ],
    [
      '    if (isPlusBinary(parent) || ts.isParenthesizedExpression(parent)) {',
      '    if (isPlusBinary(parent) || ts.isParenthesizedExpression(parent) || ts.isTemplateExpression(parent)) {',
    ],
  ],
  1,
);

// ── Direction 1, rule 5: the first line hit on a path that never runs the statement ──

prove(
  'M13',
  "rule 5 disabled (the review's `boom(); throw new Error('first ' +` repro) must red",
  libSnap,
  [['      if (!startsItsBasicBlock(stmt)) {', '      if (false) {']],
  1,
);

prove(
  'M14',
  'a bare nested `{ }` block accepted as a basic-block entry must red',
  libSnap,
  [
    [
      '  return owner !== undefined && (FUNCTION_LIKE.has(owner.kind) || isIfBranch(owner, parent));',
      '  return owner !== undefined;',
    ],
  ],
  1,
);

prove(
  'M15',
  'every earlier statement in the block treated as unable to throw must red',
  libSnap,
  [['    if (!cannotThrow(prev)) return false;', '    // every statement treated as inert']],
  1,
);

prove(
  'M16',
  'an expression statement (`boom();`) treated as a block boundary must red',
  libSnap,
  [['  K.TryStatement,\n]);', '  K.TryStatement,\n  K.ExpressionStatement,\n]);']],
  1,
);

// ── Round 3 (#1268 re-review): entry-time work that shares the anchor's block ──

prove(
  'M19',
  'a `using` / `await using` declaration treated as unable to throw must red',
  libSnap,
  [
    [
      '    if ((s.declarationList.flags & ts.NodeFlags.Using) !== 0) return false;',
      '    // using declarations treated as inert',
    ],
  ],
  1,
);

prove(
  'M20',
  'masking with `Using | AwaitUsing` (AwaitUsing = Const | Using) — refuses every `const` — must red',
  libSnap,
  [
    [
      '    if ((s.declarationList.flags & ts.NodeFlags.Using) !== 0) return false;',
      '    if ((s.declarationList.flags & (ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0) return false;',
    ],
  ],
  1,
);

prove(
  'M21',
  'every constructor accepted as a block entry (field initializers run first) must red',
  libSnap,
  [
    [
      '  if (owner !== undefined && ts.isConstructorDeclaration(owner)) return cleanConstructor(owner);',
      '  if (owner !== undefined && ts.isConstructorDeclaration(owner)) return true;',
    ],
  ],
  1,
);

prove(
  'M22',
  'a constructor with parameter properties accepted must red',
  libSnap,
  [
    [
      '  if (ctor.parameters.some((p) => (ts.getModifiers(p)?.length ?? 0) > 0 || ts.getDecorators(p))) {',
      '  if (ctor.parameters.some((p) => ts.getDecorators(p))) {',
    ],
  ],
  1,
);

prove(
  'M23',
  'instance fields / `accessor` fields accepted as inert class members must red',
  libSnap,
  [
    [
      '    return ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m);',
      '    return true;',
    ],
  ],
  1,
);

prove(
  'M24',
  'a `#private` member (brand installed at entry) accepted must red',
  libSnap,
  [
    [
      '    if (m.name && ts.isPrivateIdentifier(m.name)) return false; // brand install at entry',
      '    // private members treated as inert',
    ],
  ],
  1,
);

prove(
  'M17',
  'a `case` clause / module top level accepted as a block entry must red',
  libSnap,
  [
    [
      '  if (!parent || !ts.isBlock(parent)) return false; // module top level, `case`, …',
      '  if (!parent || !ts.isBlock(parent)) return true;',
    ],
  ],
  1,
);

// ── Direction 1, rule 4: a string-converted identifier before the literal ──

prove(
  'M18',
  'a string-converted identifier (`${name}`, `name +`) allowed before the literal must red',
  libSnap,
  [
    [
      '    if (n.kind === K.Identifier && !isCallee(n) && !isDeclaredName(n)) return false;',
      '    // identifiers allowed',
    ],
  ],
  1,
);

// ── Direction 2: removing the attribution must put the fixture back to uncovered ──

prove(
  'M10',
  'the lib no longer attributing (the count still bumps) must red',
  libSnap,
  [['          lines.set(line, hits);\n', '']],
  1,
);

prove(
  'M11',
  'the gate no longer wiring the attribution in must red the two-report-merge fixture',
  checkerSnap,
  [
    [
      'const continuation = attributeContinuations(classified.files, readSource);',
      'const continuation = { files: classified.files, attributed: 0 };',
    ],
  ],
  1,
);

prove(
  'M12',
  'NEGATIVE control: rewording a comment must stay GREEN',
  libSnap,
  [
    [
      "/** Statements whose first line's hit count is the attribution source. */",
      '/** Anchor statements (reworded by the negative control). */',
    ],
  ],
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
console.log('\n23 mutation(s) behaved as required (22 red, 1 negative control green), 0 survived.');
