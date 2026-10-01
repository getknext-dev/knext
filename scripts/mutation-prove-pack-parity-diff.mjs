#!/usr/bin/env node
/**
 * Mutation proof for `scripts/lib/pack-parity-diff.mjs` /
 * `tests/pack-parity-diff.test.ts` (#1734, G3).
 *
 * Shared harness (see `scripts/lib/mutation-harness.mjs`'s own header for
 * why): `mutate` asserts the anchor occurs exactly once and aborts
 * otherwise; restoration is content-addressed (never replayed inverse
 * edits); judged on EXIT CODES, never grepped output.
 *
 * Usage:  node scripts/mutation-prove-pack-parity-diff.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/pack-parity-diff.test.ts';

// `subjects` map, read by `scripts/lib/prover-lane.mjs`'s `proverSubjectPaths`
// (#912/#927) — every `{ subject: 'key', anchor: '…' }` entry below resolves
// against this, which is what lets the repo-wide prover-liveness audit
// (`tests/mutation-prover-lane.test.ts`) see these anchors statically rather
// than reporting this prover unaudited.
const PROOF = {
  subjects: {
    packParityDiff: 'scripts/lib/pack-parity-diff.mjs',
  },
};

const MUTATIONS = [
  {
    label: 'comparePackedTarballEntries: stop reporting onlyInA (extra file in A never flagged)',
    subject: 'packParityDiff',
    anchor: 'const onlyInA = [...aByName.keys()].filter((name) => !bByName.has(name)).sort();',
    replacement: 'const onlyInA = [];',
  },
  {
    label: 'comparePackedTarballEntries: stop reporting onlyInB (missing file never flagged)',
    subject: 'packParityDiff',
    anchor: 'const onlyInB = [...bByName.keys()].filter((name) => !aByName.has(name)).sort();',
    replacement: 'const onlyInB = [];',
  },
  {
    label:
      'comparePackedTarballEntries: stop comparing file content bytes (byte diff never flagged)',
    subject: 'packParityDiff',
    anchor: 'if (!aData.equals(bData)) differingFiles.push(name);',
    replacement: '',
  },
  {
    label: 'comparePackedTarballEntries: identical always reports true regardless of findings',
    subject: 'packParityDiff',
    anchor:
      'return {\n    identical: onlyInA.length === 0 && onlyInB.length === 0 && differingFiles.length === 0,\n    onlyInA,\n    onlyInB,\n    differingFiles,\n  };',
    replacement:
      'return {\n    identical: true,\n    onlyInA,\n    onlyInB,\n    differingFiles,\n  };',
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
  console.log(`-- mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
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
