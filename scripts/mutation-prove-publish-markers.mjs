#!/usr/bin/env node
/**
 * Mutation proof for the #674 round-2 fixes.
 *
 * Round 1's guards were green against the real `.github/workflows` while the
 * classifier behind them had four holes, every one found by executing it on an
 * input it had never been given. Green-on-one-known-answer is not coverage, so
 * this script restores each round-1 behaviour in turn and REQUIRES the specs to
 * go red. A test that stays green with the defect back is decoration.
 *
 * Restoration is from a BYTE SNAPSHOT (scripts/lib/mutation-harness.mjs), every
 * mutation carries the residue marker, and each anchor is asserted to occur
 * exactly once before anything is written.
 *
 * The mutation LIST lives in `scripts/lib/publish-markers-proof.mjs` (#681), so
 * `tests/publish-markers-proof-runnable.test.ts` can check every anchor still
 * resolves without running the mutations. It had to: an anchor went stale in
 * #675, `mutate` aborted at item 5, and items 6-10 never ran while this script
 * was still cited as evidence. No CI job runs any prover, so that test is what
 * makes the next such rot loud instead of silent.
 *
 * Usage:  node scripts/mutation-prove-publish-markers.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';
import { MUTATIONS } from './lib/publish-markers-proof.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * DERIVED from the mutation list, so the declaration cannot disagree with it.
 *
 * This prover is the reason the lane compares declared against run at all: it
 * ran 4 of these 13 for several PRs — `mutate` aborted on an anchor #675 had
 * deleted — and still exited 0, so an exit-code-only check called it green.
 */
declareMutations(MUTATIONS.length);

let pass = 0;
let fail = 0;

/**
 * `pnpm exec vitest` used to launch this, and it resolves NOTHING in a tree
 * without its own `node_modules` — a git worktree, a fresh clone before install
 * (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found`). Every spec
 * would then look RED, i.e. every mutation would look proved, off a runner that
 * never started. Same resolver as the other prover (#672 round 5), for the same
 * reason.
 */
const RUNNER = resolveTestRunner(REPO_ROOT);

function vitest(spec) {
  return (
    spawnSync(RUNNER.command, [...RUNNER.args, 'run', spec], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).status === 0
  );
}

/** The spec must be RED while the pre-fix defect is restored, and GREEN after. */
function prove({ label, file, spec, anchor, replacement }) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(resolve(REPO_ROOT, file));
  try {
    mutate(snap, anchor, replacement);
    if (vitest(spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the pre-fix defect restored');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!vitest(spec)) {
    console.log(
      '   x the spec did not return to GREEN after restore — investigate before trusting',
    );
    fail += 1;
  }
}

for (const mutation of MUTATIONS) prove(mutation);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
