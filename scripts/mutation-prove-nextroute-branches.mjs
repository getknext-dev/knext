#!/usr/bin/env node
/**
 * Mutation-prove the build-scoping of the window the cache handler hands Next
 * (`scopeWindowToBuild`, Next >= 16.4.0 applies a handler's `cacheControl`
 * directly) by EXIT CODE, on the shared mutation harness (exact-once anchors,
 * marker, restore). (Formerly proved the `nextRoute` branches of the #1888
 * seed, which Next 16.4.0 made redundant and which are deleted.)
 *   1. the foreign-build strip is removed (a previous build's window is honoured)
 *   2. the same-build keep is broken (every window is withheld)
 *   3. the Redis read path stops calling `scopeWindowToBuild`
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
    label: 'foreign-build strip removed (cacheControl handed back unchanged)',
    anchor: '  const { cacheControl: _foreignWindow, ...rest } = entry;\n  return rest;',
    replacement: '  return entry;',
  },
  {
    label: 'same-build keep broken (every window withheld)',
    anchor: 'if (currentBuildId !== undefined && entry.buildId === currentBuildId) return entry;',
    replacement:
      'if (currentBuildId !== undefined && entry.buildId === currentBuildId && false) return entry;',
  },
  {
    label: 'Redis read path no longer scopes the window',
    anchor: 'return scopeWindowToBuild(parsed, ctx);',
    replacement: 'return parsed;',
  },
];

declareMutations(3);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 3) {
  console.error(`FATAL: declared 3 mutations, table has ${MUTATIONS.length}`);
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
