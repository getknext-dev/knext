#!/usr/bin/env node
/**
 * Mutation proof for the standalone build-id lock-step guard (#1417).
 *
 * On Next >= 16.2.11 a `deploymentId` (filled from `NEXT_DEPLOYMENT_ID`)
 * makes `next build` write the constant `build-TfctsWXpff2fKS` and ignore
 * `generateBuildId`. knext now owns `KNEXT_BUILD_ID`, and the guard in
 * `packages/kn-next/src/cli/build-id-env.ts` names the next.config fix when it
 * sees the constant OR a config that never reads `KNEXT_BUILD_ID`.
 *
 * `workflow.md`: "a guard that stays green when its subject is removed is
 * decoration". Each mutation below removes one detection (or reverts the
 * scaffold template) and REQUIRES `build-id-env.test.ts` to go red, judged by
 * the runner's EXIT CODE, never by grepping its output.
 *
 * Restoration is from a BYTE SNAPSHOT via scripts/lib/mutation-harness.mjs
 * (sha256-verified), every anchor must occur exactly once or the harness
 * aborts, and every mutation carries the residue marker.
 *
 * Usage:  node scripts/mutation-prove-build-id-env.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = resolve(REPO_ROOT, 'packages/kn-next/src/cli/build-id-env.ts');
const TEMPLATE = resolve(REPO_ROOT, 'packages/kn-next/templates/app/next.config.ts.hbs');
const SPEC = 'packages/kn-next/src/__tests__/build-id-env.test.ts';

/** The four neuters below; the lane compares declared against run both ways. */
declareMutations(4);

let pass = 0;
let fail = 0;

function specGreen() {
  const runner = resolveSpecRunner(REPO_ROOT, SPEC);
  return (
    spawnSync(runner.command, [...runner.args, ...runner.runArgs(SPEC)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).status === 0
  );
}

/** The spec must be RED while the subject is mutated, and GREEN once restored. */
function prove(label, file, anchor, replacement) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    if (specGreen()) {
      console.log('   x DECORATION: the spec stayed GREEN with the subject mutated');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specGreen()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(`Baseline: ${SPEC} must be GREEN before anything is mutated.`);
if (!specGreen()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// 1. The constant-build-id detection is removed: only the config-text check
//    remains, so a config that reads KNEXT_BUILD_ID but still lets a
//    deploymentId reach `next build` gets the plain, non-actionable message.
prove(
  'the constant-BUILD_ID detection',
  GUARD,
  '    if (builtId === NEXT_CONSTANT_BUILD_ID || !readsKnextBuildId) {',
  '    if (!readsKnextBuildId) {',
);

// 2. The "next.config never reads KNEXT_BUILD_ID" detection is removed: an app
//    still on the old generateBuildId line (random id, no constant) loses the
//    one-sentence fix.
prove(
  'the config-never-reads-KNEXT_BUILD_ID detection',
  GUARD,
  '    if (builtId === NEXT_CONSTANT_BUILD_ID || !readsKnextBuildId) {',
  '    if (builtId === NEXT_CONSTANT_BUILD_ID) {',
);

// 3. The scaffold template reverts to the pre-fix generateBuildId line: the
//    shipped config no longer reads KNEXT_BUILD_ID, so the fake `next build`
//    mints a random id and the FIX case fails the lock-step.
prove(
  "the template's generateBuildId line reverted",
  TEMPLATE,
  '    generateBuildId: () => process.env.KNEXT_BUILD_ID || process.env.NEXT_DEPLOYMENT_ID || null,',
  `    // ${MUTATION_MARKER}\n    generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null,`,
);

// 4. The standalone leg stops removing an inherited NEXT_DEPLOYMENT_ID: a CI
//    runner that exports one puts Next back on the constant-id path.
prove(
  'the standalone leg removing an inherited NEXT_DEPLOYMENT_ID',
  GUARD,
  '    delete env[NEXT_DEPLOYMENT_ID_ENV];',
  '    void 0;',
);

console.log(`\n${pass} red as required, ${fail} decoration`);
process.exit(fail === 0 ? 0 : 1);
