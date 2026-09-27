#!/usr/bin/env node
/**
 * Mutation proof for the #1455 (F6) empty-dir lane guard,
 * `scripts/lib/e2e-empty-dir.sh`'s `ed_assert_clean`, exercised by
 * `tests/e2e-empty-dir.test.ts`.
 *
 * The exit criterion is explicit: "guard reds on a planted node_modules".
 * That claim is only worth anything if the test that checks it would go RED
 * were the guard turned into a no-op — otherwise the guard is decoration.
 * Two mutations, one per forbidden-entry class the guard checks:
 *
 *   1. Drop the `node_modules`/`.output` sweep entirely — the mutation named
 *      in the exit criterion.
 *   2. Drop the ".next may contain only `static`" check — a stray
 *      `.next/server` (the disk-mode tree leaking into the empty dir) would
 *      then pass silently.
 *
 * Shared harness, for the reasons this repo has already paid for elsewhere
 * (scripts/mutation-prove-compat-cell-fingerprint.mjs):
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * judged on EXIT CODES only, never on grepped/ANSI output;
 *   * both directions proven — a mutation must go RED, and the restore must
 *     go GREEN again, or the restore itself is broken.
 *
 * Usage: node scripts/mutation-prove-empty-dir-guard.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/lib/e2e-empty-dir.sh');
const SPEC = 'tests/e2e-empty-dir.test.ts';

declareMutations(2);

const { command, args, runArgs } = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec passed. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(command, [...args, ...runArgs(SPEC)], {
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

// 1. THE mutation named in the exit criterion: a planted node_modules/.output
//    must be invisible to the guard once this loop is gutted.
prove(
  'node_modules/.output sweep: empty the forbidden-name list',
  'for forbidden in node_modules .output; do',
  'for forbidden in; do',
);

// 2. A stray .next/server (or any non-static .next entry) must be invisible
//    once the "only static may accompany the binary" check is disarmed.
prove(
  '.next-other-than-static check: disarm it (`if false`)',
  'if [ "${name}" != "static" ]; then',
  'if false; then',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
