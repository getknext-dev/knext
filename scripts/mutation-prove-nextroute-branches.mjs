#!/usr/bin/env node
/**
 * Mutation-prove both `nextRoute` branches in cache-handler.js by EXIT CODE,
 * on the shared mutation harness (exact-once anchors, marker, restore).
 *   1. older-Next branch: `key.replace(...) || '/'` -> `return key;`
 *   2. 16.3.7+ branch:    `if (key.startsWith('/route-cache/')) return key;` removed
 * Exit 0 only when the baseline is green and every mutant turns the spec red.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/cache-handler.js');
const SPEC = 'packages/kn-next/src/__tests__/cache-handler-next-stale-after-wake.test.ts';

const MUTATIONS = [
  {
    label: 'older-Next toRoute branch -> return key',
    anchor: "  return key.replace(/(?:\\/index)?\\/?$/, '') || '/';",
    replacement: '  return key;',
  },
  {
    label: '/route-cache/ verbatim branch removed',
    anchor: "  if (key.startsWith('/route-cache/')) return key;",
    replacement: '',
  },
];

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
  const snap = snapshot(SRC);
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
