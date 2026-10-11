#!/usr/bin/env node
/**
 * Mutation proof for `tests/committed-manifests-use-workspace-protocol.test.ts`:
 * a literal sibling range such as `"@getknext/lib": "^1.3.0"` committed into a
 * publishable manifest must turn the guard RED.
 *
 * Harness: `mutate` asserts the anchor occurs EXACTLY ONCE and aborts otherwise
 * (never perl), the verdict is the spec's EXIT CODE (never grepped output), the
 * baseline must be green first and green again after each restore. Strict JSON
 * has no comments, so each replacement carries the residue marker as a JSON-legal
 * key instead of letting the harness append a `//` line that would break parsing.
 *
 * Usage:  node scripts/mutation-prove-committed-workspace-ranges.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { MUTATION_MARKER, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/committed-manifests-use-workspace-protocol.test.ts';

const PROOF = {
  subjects: {
    dbJson: 'packages/db/package.json',
    coreJson: 'packages/kn-next/package.json',
    aliasJson: 'packages/kn-next-alias/package.json',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses(spec) {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const marker = `    "//${MUTATION_MARKER}": "literal range"`;

const MUTATIONS = [
  {
    label: 'db depends on a literal @getknext/lib range',
    subject: 'dbJson',
    anchor: '"@getknext/lib": "workspace:^"',
    replacement: `"@getknext/lib": "^1.3.0",\n${marker}`,
  },
  {
    label: 'core depends on a literal @getknext/db range',
    subject: 'coreJson',
    anchor: '"@getknext/db": "workspace:^"',
    replacement: `"@getknext/db": "^1.3.0",\n${marker}`,
  },
  {
    label: 'core depends on a literal @getknext/lib range',
    subject: 'coreJson',
    anchor: '"@getknext/lib": "workspace:^"',
    replacement: `"@getknext/lib": "^1.3.0",\n${marker}`,
  },
  {
    label: 'the kn-next forwarding package depends on a literal @getknext/core range',
    subject: 'aliasJson',
    anchor: '"@getknext/core": "workspace:^"',
    replacement: `"@getknext/core": "^1.3.0",\n${marker}`,
  },
];

declareMutations(MUTATIONS.length);

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses(SPEC)) {
  console.error('FATAL: baseline is not green');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(SPEC)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(SPEC)) {
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
