#!/usr/bin/env node

/**
 * Mutation proof for `tests/compat-disk-floor-wiring.test.ts` (#1530 round 2).
 *
 * WHAT THIS PROVES
 * Round-2 review found that the disk-floor guard's pure functions
 * (`evaluateDiskFloor`, `isInfraOnlyRedShard`) were mutation-proved, but the
 * WORKFLOW WIRING that actually calls them was not — an anchor-exact mutation
 * of the live `.github/workflows/test-e2e-deploy.yml` removing the wiring left
 * every existing spec green. This proves the three wiring defects the review
 * found each red `tests/compat-disk-floor-wiring.test.ts`:
 *
 *   1. deleting the whole "Free disk floor" step;
 *   2. deleting the skip branch in "Run official deploy tests" (the suite
 *      would run the real tests after a floor breach instead of skipping);
 *   3. deleting the early `exit 0` in "Summarize shard result" (an
 *      empty-log 0/0/0 parse would overwrite the infra-classified summary the
 *      floor step already wrote).
 *
 * The anchors are never hand-transcribed. `.github/workflows/test-e2e-deploy.yml`
 * is a large, comment-heavy YAML file, and retyping a multiline block from it
 * is exactly how a mutation silently drifts from what is actually on disk
 * (mutation-harness.mjs's own header names this failure mode). Instead each
 * anchor is SLICED out of the file's own current bytes at run time — the
 * mutation is guaranteed byte-identical to what is really there, because it IS
 * what is really there.
 *
 * Usage:  node scripts/mutation-prove-compat-disk-floor-wiring.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml');
const SPEC = 'tests/compat-disk-floor-wiring.test.ts';
const BREACH_GUARD_OPEN = `if [ "\${{ steps.disk-floor.outputs.ok }}" = 'false' ]; then`;
const FI_LINE = '\n          fi\n';

declareMutations(3);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

/**
 * The span of ONE step's text, from its `- name: <stepName>` line up to (but
 * not including) the next step at the same indentation. Throws if the name is
 * missing or ambiguous — the same contract
 * `tests/compat-disk-floor-wiring.test.ts`'s own `stepBlock` uses, kept as an
 * independent implementation here rather than an import, so a bug in one
 * cannot make the other agree with it.
 */
function stepSpan(text, stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`mutation-prove-compat-disk-floor-wiring: step not found: ${stepName}`);
  }
  if (text.indexOf(marker, start + 1) !== -1) {
    throw new Error(`mutation-prove-compat-disk-floor-wiring: step name not unique: ${stepName}`);
  }
  const next = text.indexOf('\n      - name:', start);
  const end = next === -1 ? text.length : next + 1;
  return { start, end };
}

/** The full `if [...disk-floor...]; then ... fi` guard inside one step's span. */
function breachGuardSpan(stepText) {
  const guardStart = stepText.indexOf(BREACH_GUARD_OPEN);
  if (guardStart === -1) {
    throw new Error('mutation-prove-compat-disk-floor-wiring: breach guard not found in step');
  }
  const fiIdx = stepText.indexOf(FI_LINE, guardStart);
  if (fiIdx === -1) {
    throw new Error('mutation-prove-compat-disk-floor-wiring: closing `fi` not found for guard');
  }
  const guardEnd = fiIdx + FI_LINE.length;
  return { guardStart, guardEnd };
}

let pass = 0;
let fail = 0;

function prove(label, buildMutation) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(TARGET);
  try {
    const { anchor, replacement } = buildMutation(readFileSync(TARGET, 'utf8'));
    mutate(snap, anchor, replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the wiring removed');
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

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. Delete the whole "Free disk floor" step.
prove('delete the whole "Free disk floor" step', (text) => {
  const { start, end } = stepSpan(text, 'Free disk floor (#1530)');
  return { anchor: text.slice(start, end), replacement: '' };
});

// 2. Delete the skip branch in "Run official deploy tests" — the real suite
// would run unconditionally, even after a breach.
prove(
  'delete the disk-floor skip branch in "Run official deploy tests" (suite runs after a breach)',
  (text) => {
    const { start, end } = stepSpan(text, 'Run official deploy tests (knext adapter)');
    const step = text.slice(start, end);
    const { guardStart, guardEnd } = breachGuardSpan(step);
    const anchor = step.slice(guardStart, guardEnd);
    // Replacement: the ELSE branch's own body, run UNCONDITIONALLY — sliced
    // out of the guard being deleted (never re-typed), so this mutation
    // proves "the skip guard is gone", not "we also broke the invocation".
    const elseMarker = '\n          else\n';
    const elseIdx = anchor.indexOf(elseMarker);
    if (elseIdx === -1) {
      throw new Error('mutation-prove-compat-disk-floor-wiring: no else branch in the guard');
    }
    const elseBody = anchor.slice(elseIdx + elseMarker.length, anchor.lastIndexOf(FI_LINE));
    return { anchor, replacement: elseBody };
  },
);

// 3. Delete the early `exit 0` in "Summarize shard result" — an empty-log
// 0/0/0 parse would clobber the infra-classified summary the floor step wrote.
prove(
  'delete the early exit in "Summarize shard result" (empty-log parse overwrites the infra summary)',
  (text) => {
    const { start, end } = stepSpan(text, 'Summarize shard result');
    const step = text.slice(start, end);
    const { guardStart, guardEnd } = breachGuardSpan(step);
    return { anchor: step.slice(guardStart, guardEnd), replacement: '' };
  },
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
