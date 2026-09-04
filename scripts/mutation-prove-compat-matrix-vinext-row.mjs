#!/usr/bin/env node
/**
 * Mutation proof for #898's compat-matrix additions (sprint 2, lane G — G1).
 *
 * WHAT #898 CLAIMED, AND WHY IT NEEDS PROVING
 * -------------------------------------------
 * ADR-0048 made the compiled vinext single executable the only artifact users
 * can build, and its own consequence #2 records the cost: the official
 * compatibility suite stopped covering the shipped path. #898 added a row for
 * that axis — honestly ❌ — plus three guard assertions:
 *
 *   1. the vinext-axis row EXISTS. Deleting it returns the matrix to claiming
 *      NOTHING about the only artifact users can build, silently.
 *   2. the evidence contract binds it IFF ✅. Flipping the row green without a
 *      run id, a pinned ref and an all-green result must red.
 *   3. no FOURTH row rides the word "official" past the contract. The allowlist
 *      widened by one; a scan that widened to "anything" would look identical in
 *      a green run.
 *
 * The PR body asserted these in prose and committed no prover. That is the
 * sprint-1 systemic finding in one file: the matrix guard is precisely the kind
 * that goes green while inert, because its subject is a document, and a document
 * can lose a row without anything failing to compile.
 *
 * ASYMMETRY WORTH STATING. M1 and M2 mutate the DOCUMENT; M3 mutates the GUARD.
 * Both directions are needed and they prove different things: the first two say
 * the guard notices a matrix that has drifted, the third says the guard's own
 * allowlist has not been widened into uselessness. A prover with only the first
 * kind cannot tell a live guard from one whose filter now matches everything.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only, never output; the
 * baseline must be green; a canary must go red first; anchors must occur exactly
 * once or the harness aborts; the tree is verified clean between mutations. All
 * of that lives in `scripts/lib/guard-prover.mjs`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-matrix.test.ts';

/** The vinext row's leading cell — unique, and the thing #898 added. */
const VINEXT_ROW_HEAD =
  '| Official suite — vinext single-executable axis (the SHIPPED artifact, ADR-0048) | ❌ |';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the vinext-axis row is DELETED — the matrix silently stops claiming anything about the ' +
      'only artifact users can build',
    subject: 'matrix',
    anchor: VINEXT_ROW_HEAD,
    // Renaming the row's feature cell removes it as far as every `/vinext
    // single-executable axis/i` filter is concerned, without leaving a
    // half-parsed table behind — deleting the line outright would also trip the
    // column-count assertion and grade for the wrong reason.
    replacement: '| Official suite — some other axis | ❌ |',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the row is flipped to ✅ with no run id, no pinned ref and no all-green result — the ' +
      'evidence contract must bind the new row exactly as it binds the Node credential',
    subject: 'matrix',
    anchor: VINEXT_ROW_HEAD,
    replacement:
      '| Official suite — vinext single-executable axis (the SHIPPED artifact, ADR-0048) | ✅ |',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'a FOURTH row claims official-suite backing — the inventory assertion must refuse a row it ' +
      'does not know, which is the only thing standing between "official" and an unaudited claim',
    subject: 'matrix',
    anchor: VINEXT_ROW_HEAD,
    // A fourth row, deliberately ❌. The status matters: the evidence contract
    // only binds ✅ rows, so an ❌ row isolates the INVENTORY assertion. A ✅
    // row would red through `officialFlipProblems` and grade the wrong thing.
    replacement:
      '| Official suite — some undocumented fourth axis | ❌ | — | Added by the prover. |\n' +
      VINEXT_ROW_HEAD,
  },
];

/**
 * ROUND 1'S INVALID MUTATION, recorded rather than deleted.
 *
 * M3 was first written as "widen the allowlist regex to `/./`" and it SURVIVED.
 * That looked like a hole and was not one: `officialRows` (`:825`) is derived
 * INDEPENDENTLY of the allowlist — `/official/i` against feature OR evidence —
 * so the evidence contract still binds a fourth ✅ row however wide the
 * allowlist gets. Widening it removes the INVENTORY assertion, not the gate,
 * and the prover's claim ("would ride past the evidence contract") was simply
 * false.
 *
 * That is an invalid mutation, not a decorative guard, and the distinction is
 * the one `mutation-prove-install-smoke-coverage.mjs`'s own M10 had to make. The
 * mutation above is the one the assertion actually exists for.
 */

/**
 * NEGATIVE CONTROL. The Notes cell is prose — long, argumentative prose, most of
 * it evidence narration. Editing it must leave the guard GREEN.
 *
 * Without this, every red above could be explained by the guard being sensitive
 * to the file changing at all, which would make it a tripwire rather than a
 * guard. It also pins something real: the matrix is edited constantly, and a
 * guard that reddened on prose would be turned off within a sprint.
 */
const NEGATIVE = {
  id: 'M4',
  expect: 'green',
  claim: 'a Notes-cell rewording must be free — the guard checks structure, not prose',
  subject: 'matrix',
  anchor: '**Lane exists; NO NUMBER PUBLISHED YET — the first scheduled run produces one.**',
  replacement:
    '**Lane exists; no number published yet (reworded by the negative control) — the first ' +
    'scheduled run produces one.**',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    // Only the DOCUMENT. Round 1 also declared `guard: SPEC`, left over from a
    // mutation of the guard's own allowlist that turned out to be invalid (see
    // the note above M3) — a subject no mutation used, i.e. exactly the dead
    // declaration the #927 liveness audit exists to surface.
    matrix: 'docs/compat-matrix.md',
  },
});

console.log(`=== mutation proof: ${SPEC} (#898 vinext-axis row) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary blanks the row-parsing regex's status column, which every
// assertion in the suite depends on. If THAT does not red, nothing below means
// anything — and it also proves the runner is pointed at the right spec.
prover.proveCanSeeRed({
  subject: 'matrix',
  anchor: VINEXT_ROW_HEAD,
  replacement: '| Official suite — vinext single-executable axis (the SHIPPED artifact) | 🙂 |',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
