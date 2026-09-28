#!/usr/bin/env node

/**
 * Mutation proof for the INVALID-night semantics added in #1530
 * (`tests/compat-window-audit-invalid.test.ts`), kept separate from
 * `mutation-prove-compat-window-audit.mjs` because it targets a different
 * spec file — mixing specs in one prover makes a caught/uncaught count
 * ambiguous about which spec caught which mutation.
 *
 * WHAT THIS PROVES, AND WHY IT IS NOT DECORATION.
 *
 *   1. PAUSE, NOT RESET. An invalid night (today: an OKE operator digest that
 *      does not match the release digest the credential ref resolved) must
 *      leave a streak untouched — the qualifying nights either side of it
 *      still join into one. Without the `if (night.invalid) continue;`
 *      branch in `auditWindow`'s loop, an invalid night falls into the
 *      `!night.eligible` branch below it and RESETS the streak exactly like
 *      any other disqualified night — silently converting "no evidence
 *      either way" into "counts against you", which is the one direction
 *      #1530 exists to forbid.
 *   2. NEVER A GREEN NIGHT. `gradeNight` must return `eligible: false` for an
 *      invalid night. Without that, an invalid run — one that produced ZERO
 *      shard evidence — could bank a night on nothing.
 *
 * Judged on EXIT CODES only, per this repo's own lesson (vitest/bun ANSI
 * output once certified fourteen decorative mutations green via a text grep).
 *
 * Usage:  node scripts/mutation-prove-compat-window-invalid.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/compat-window-audit.mjs');
const SPEC = 'tests/compat-window-audit-invalid.test.ts';

declareMutations(2);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
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

// 1. Remove the pause branch entirely, so an invalid night falls through to
//    the disqualified branch and RESETS the streak instead of being skipped.
prove(
  'invalid night resets the streak instead of pausing it',
  `    if (night.invalid) {
      // #1530: an INVALID night PAUSES the count rather than resetting it —
      // the opposite of the unresolved/disqualified branch below. It is not a
      // silently-dropped night (rule 5's concern): we have direct evidence the
      // run's precondition was bad before it produced a single shard, so
      // there is nothing here that could have been a real red or green night
      // erased by skipping it. \`open\`/\`pendingCause\` are deliberately left
      // untouched so the qualifying nights either side of it still join into
      // one streak.
      continue;
    }
`,
  '',
);

// 2. Let an invalid night grade as eligible (a fully-wired but untested claim
//    of "shard evidence" that isn't there) — must never happen.
prove(
  'invalid night can grade eligible: true',
  `      disqualifiers: [\`invalid: \${ledger.invalid}\`],
      eligible: false,`,
  `      disqualifiers: [],
      eligible: true,`,
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
