#!/usr/bin/env node
/**
 * Mutation proof for the blocking-gate AUDIT ENGINE (#661 round 2, item 2).
 *
 * The round-1 review defeated the engine by execution: it replaced
 * `continueOnErrorProblem`'s literal-false check with `return null` and turned
 * the `'if' in job` and fail-closed-allowlist branches into `if (false)`, then
 * ran the exact assertions both callers make against the real `ci.yml`. Every
 * one stayed GREEN. The callers only assert `problems === []` on a CLEAN
 * workflow, so any LOOSENING of the helper is invisible to them by construction.
 *
 * `workflow.md`: "a guard that stays green when its subject is removed is
 * decoration" — and that applies to the engine, not only to the workflow it
 * audits. `tests/blocking-gate-helper.test.ts` is the regression coverage; this
 * script is the standing proof that the coverage actually bites. It removes each
 * detection in turn and REQUIRES that file to go red.
 *
 * Restoration is from a BYTE SNAPSHOT via scripts/lib/mutation-harness.mjs, and
 * every mutation carries the residue marker, so a stall between mutate and
 * restore is findable by `scripts/scan-mutation-residue.mjs` rather than by luck.
 *
 * Usage:  node scripts/mutation-prove-blocking-gate.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = resolve(REPO_ROOT, 'tests/helpers/blocking-gate.ts');
const SPEC = 'tests/blocking-gate-helper.test.ts';

let pass = 0;
let fail = 0;

function vitest(spec) {
  return (
    spawnSync('pnpm', ['exec', 'vitest', 'run', spec], { cwd: REPO_ROOT, encoding: 'utf8' })
      .status === 0
  );
}

/** The spec must be RED while the detection is removed, and GREEN once restored. */
function prove(label, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(HELPER);
  try {
    mutate(snap, anchor, replacement);
    if (vitest(SPEC)) {
      console.log('   x DECORATION: the spec stayed GREEN with the detection removed');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
  } finally {
    restore(snap);
  }
  if (!vitest(SPEC)) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(`Baseline: ${SPEC} must be GREEN before anything is mutated.`);
if (!vitest(SPEC)) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. The exact round-1 neuter: `continue-on-error` stops being a problem in
//    every form, including a literal `true`.
prove(
  'continueOnErrorProblem never reports anything',
  "  if (!('continue-on-error' in container)) return null;",
  '  return null;',
);

// 2. The exact round-1 neuter: a job-level `if:` stops being detected.
prove('the job-level `if:` detection', "if ('if' in job) {", 'if (false) {');

// 3. The exact round-1 neuter: the fail-closed job-key allowlist stops firing,
//    so `strategy`/`concurrency`/`environment`/`defaults`/`uses` all pass.
prove(
  'the fail-closed job-key allowlist',
  "      if (!ALLOWED_JOB_KEYS.has(key) && key !== 'if' && key !== 'continue-on-error') {",
  '      if (false) {',
);

// 4. The transitive `needs` walk stops recursing, so a gate that `needs:` a
//    skippable or non-existent job passes.
prove(
  'the transitive `needs` walk',
  '      queue.push({ id: dep, via: [...via, id] });',
  '      void dep;',
);

// 5. The gate step`s own `if:` stops being detected.
prove("the gate step's `if:` detection", "    if ('if' in step) {", '    if (false) {');

// 6. Round-2 item 1: the trigger-filter audit stops firing, so `branches`,
//    `branches-ignore`, `types`, `paths` and `paths-ignore` all pass.
prove(
  'the fail-closed pull_request trigger-filter audit',
  '      problems.push(\n        `the \\`pull_request\\` trigger carries a \\`${key}\\` filter, so a PR can be merged without this gate ever running`,\n      );',
  '      void key;',
);

// 7. Round-2 item 1, the precise half: `*` stops being distinguished from `**`.
//    This is the one that matters — a universal-filter exemption that is too
//    generous silently re-admits `ci.yml`'s live `branches: ['*']` defect.
prove(
  'the `*` vs `**` distinction in isUniversalBranchFilter',
  "  return list.some((entry) => entry === '**');",
  '  return true;',
);

// 8. #679 item 1: `bodyIsPerPr` splits on `&&` as well as `||`. That is the
//    "fix the apparent inconsistency" edit a future author would reach for, and
//    it WIDENS the rule — `${{ github.head_ref && github.ref }}` flips from
//    rejected to accepted, admitting a group whose per-PR-ness the audit never
//    established (`a && b` evaluates to `b`, so all-operands-vary proves
//    nothing about the result).
prove(
  'splitting the concurrency-group body on `&&` as well as `||`',
  "  const operands = body.split('||').map((s) => s.trim());",
  '  const operands = body.split(/\\|\\||&&/).map((s) => s.trim());',
);

console.log(`\n${pass} mutation(s) went red as required, ${fail} stayed green.`);
process.exit(fail === 0 ? 0 : 1);
