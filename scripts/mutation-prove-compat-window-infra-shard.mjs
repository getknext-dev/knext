#!/usr/bin/env node

/**
 * Mutation proof for `tests/compat-window-audit-infra-shard.test.ts` (#1530).
 *
 * WHAT THIS PROVES
 *   1. An infra-aborted shard (the free-disk-floor pre-check) must still
 *      disqualify the night. Without the label branch this already worked —
 *      what this guards is that REMOVING the disqualifying branch entirely
 *      (folding infra shards into the same silent-pass path a truly green
 *      shard takes) is caught.
 *   2. The `infra-classified:` label itself must not be decorative — without
 *      `isInfraOnlyRedShard`'s branch, an infra shard reads as a generic red,
 *      indistinguishable from a real regression in triage.
 *
 * Usage:  node scripts/mutation-prove-compat-window-infra-shard.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'scripts/compat-window-audit.mjs');
const SPEC = 'tests/compat-window-audit-infra-shard.test.ts';

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

// 1. Remove the `infra-classified:` label branch entirely, folding an infra
//    shard into the generic red message.
prove(
  'infra shard loses its distinct label, reads as a generic red',
  `          : isInfraOnlyRedShard(shard, f.value)
            ? \`infra-classified: shard \${id} red (failed=\${f.value} notRun=\${n.value}) — the \` +
              'free-disk floor aborted this shard before it ran a single test (#1530); it ' +
              'still disqualifies the night (a runner fault proves nothing either way about ' +
              'the ref under test) but is never mistaken for kind:assertion'
            : \`shard \${id} red (failed=\${f.value} notRun=\${n.value})\`,`,
  `          : \`shard \${id} red (failed=\${f.value} notRun=\${n.value})\`,`,
);

// 2. Let a shard carrying a REAL failure alongside an infra marker be
//    mislabelled infra-classified (isInfraOnlyRedShard's failedCount guard).
prove(
  'a real failure alongside an infra marker is still labelled infra-classified',
  'function isInfraOnlyRedShard(shard, failedCount) {\n  if (failedCount > 0) return false;',
  'function isInfraOnlyRedShard(shard, failedCount) {',
);

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
