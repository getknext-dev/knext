#!/usr/bin/env node

/**
 * Mutation proof for `tests/compat-operator-digest-check.test.ts` (#1530).
 *
 * WHAT THIS PROVES
 *   1. A mismatch between the live OKE operator digest and the release digest
 *      must never be graded `ok: true` — that is the exact bug this guard
 *      exists to prevent: "an operator-digest mismatch can no longer count as
 *      a red or a green night" starts with it never counting as GREEN at the
 *      pure-decision layer.
 *   2. An unreadable side (either digest `null`) must fail closed, never
 *      default to a match.
 *
 * Judged on EXIT CODES only (bun/vitest ANSI output has already once
 * certified a decorative mutation green via a text grep in this repo).
 *
 * Usage:  node scripts/mutation-prove-compat-operator-digest-check.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/compat-operator-digest-check.mjs');
const SPEC = 'tests/compat-operator-digest-check.test.ts';

declareMutations(2);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

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

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. Stop comparing the two digests — let a mismatch pass as `ok: true`.
prove(
  'mismatch is graded ok: true instead of failing',
  `  if (liveDigest !== releaseDigest) {
    return {
      ok: false,
      state: 'mismatch',
      message: \`OKE operator is running \${liveDigest}, the release recorded \${releaseDigest} — the night is INVALID, not failed\`,
    };
  }
  return { ok: true, state: 'match', message: 'OKE operator digest matches the release digest' };`,
  `  return { ok: true, state: 'match', message: 'OKE operator digest matches the release digest' };`,
);

// 2. Stop failing closed on a missing live digest — default it to a match.
prove(
  'missing live digest defaults to a match instead of failing closed',
  `  if (!liveDigest) {
    return {
      ok: false,
      state: 'live-digest-missing',
      message: 'could not read the OKE operator Deployment image digest',
    };
  }`,
  '',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
