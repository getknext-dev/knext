#!/usr/bin/env node
/**
 * Mutation proof for `tests/resolve-scale-test-image.test.ts`'s #1211
 * hardening (items 1 and 3):
 *
 *   1. `checkPullable`'s only network egress is the injected exec/crane —
 *      a stronger invariant than the pre-existing #670c literal scan.
 *   3. the `input` (workflow_dispatch override) path still runs
 *      `checkPullable` — it used to return verbatim, unverified.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-resolve-scale-test-image.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/resolve-scale-test-image.test.ts';
const SUBJECT = resolve(REPO_ROOT, 'scripts/resolve-scale-test-image.mjs');

const MUTATIONS = [
  // ── item 3: override path must still call checkPullable ──────────────────
  {
    label: 'resolveScaleTestImage: override path returns verbatim again, skipping checkPullable',
    anchor:
      'if (override) {\n    await checkPullable(override, { exec, crane });\n    return override;\n  }',
    replacement: 'if (override) {\n    return override;\n  }',
  },

  // ── item 1: checkPullable must never gain a direct network primitive ─────
  {
    label: 'checkPullable: add a fetch() call alongside exec()',
    anchor: "result = await exec(crane, ['manifest', ref]);",
    replacement: "await fetch(ref);\n    result = await exec(crane, ['manifest', ref]);",
  },
];

declareMutations(2);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 2) {
  console.error(`FATAL: declared 2 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(SUBJECT);
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
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

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
