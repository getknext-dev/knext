#!/usr/bin/env node

/**
 * Mutation proof for `tests/compat-disk-floor-check.test.ts` (#1530).
 *
 * WHAT THIS PROVES
 *   1. Below-floor free disk must fail, never pass.
 *   2. An unreadable free-disk reading must fail CLOSED, never default to
 *      "plenty of room".
 *
 * Usage:  node scripts/mutation-prove-compat-disk-floor-check.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/compat-disk-floor-check.mjs');
const SPEC = 'tests/compat-disk-floor-check.test.ts';

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

// 1. Stop comparing against the floor — always pass.
prove(
  'below-floor free disk passes instead of failing',
  `  if (freeBytes < floorBytes) {
    return {
      ok: false,
      state: 'below-floor',
      message: \`free disk \${(freeBytes / 1e9).toFixed(2)}GB is below the \${(floorBytes / 1e9).toFixed(2)}GB floor\`,
    };
  }`,
  '',
);

// 2. Stop failing closed on unreadable free space — default it to ok.
prove(
  'unreadable free-disk reading defaults to ok instead of failing closed',
  `  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) {
    return {
      ok: false,
      state: 'unreadable',
      message: 'could not read free disk space on the runner',
    };
  }`,
  '',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
