#!/usr/bin/env node
/**
 * Mutation proof for `tests/compat-shipped-pin-dispatch-poll.test.ts`'s
 * `pickDispatchedRun` coverage — specifically the `dispatchId` EXACT-MATCH
 * branch added for rev-1382 finding 2 (4 concurrent legs latching onto the
 * same run because "newest workflow_dispatch not seen before" is a
 * heuristic every leg satisfies identically).
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-dispatch-poll.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-shipped-pin-dispatch-poll.test.ts';
const SUBJECT = resolve(REPO_ROOT, 'scripts/lib/dispatch-poll.mjs');

const MUTATIONS = [
  {
    label: 'fall through to the recency heuristic even when dispatchId is set',
    anchor: 'if (opts.dispatchId) {',
    replacement: 'if (false) {',
  },
  {
    label: 'match displayTitle with includes() instead of exact equality',
    anchor: '.filter((r) => r.displayTitle === opts.dispatchId)',
    replacement: ".filter((r) => String(r.displayTitle ?? '').includes(opts.dispatchId))",
  },
  {
    label:
      'drop the headBranch/event/beforeIds filter before the dispatchId branch (matches ANY run)',
    anchor: `const base = runsAfter.filter(
    (r) =>
      !beforeIds.has(r.databaseId) &&
      r.event === 'workflow_dispatch' &&
      r.headBranch === opts.headBranch,
  );`,
    replacement: 'const base = runsAfter;',
  },
  {
    label: 'fall back to a non-null default when no exact match is found (never fail closed)',
    anchor: 'return exact[0] ?? null;',
    replacement: 'return exact[0] ?? base[0] ?? null;',
  },
];

declareMutations(4);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 4) {
  console.error(`FATAL: declared 4 mutations, table has ${MUTATIONS.length}`);
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
