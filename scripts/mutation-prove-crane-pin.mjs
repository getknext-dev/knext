#!/usr/bin/env node
/**
 * Mutation proof for `tests/crane-pin-lockstep.test.ts` (#1211 item 2).
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-crane-pin.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/crane-pin-lockstep.test.ts';
const SUBJECT = resolve(REPO_ROOT, 'scripts/lib/crane-pin.mjs');

const MUTATIONS = [
  {
    label: 'assertLockstep: stop throwing on a divergent pin set',
    anchor: 'if (distinct.size > 1) {',
    replacement: 'if (false) {',
  },
  {
    label: 'assertLockstep: stop throwing on an EMPTY pin set',
    anchor: 'if (pins.length === 0) {',
    replacement: 'if (false) {',
  },
  {
    label:
      'findPinsInDoc: stop requiring the version to look like a real version (accept any string)',
    anchor:
      "    typeof doc.CRANE_VERSION === 'string' &&\n    typeof doc.CRANE_SHA256 === 'string' &&\n    /^v?\\d+\\.\\d+\\.\\d+$/.test(doc.CRANE_VERSION)",
    replacement: "typeof doc.CRANE_VERSION === 'string' && typeof doc.CRANE_SHA256 === 'string'",
  },
  {
    label:
      'scanCranePins: stop recursing into nested objects (would miss env: blocks nested under jobs/steps)',
    anchor:
      "for (const value of Object.values(doc)) {\n    if (value && typeof value === 'object') findPinsInDoc(value, out);\n  }",
    replacement: '',
  },
  {
    label: 'parseChecksumsTxt: stop throwing on an empty/malformed checksums file',
    anchor: 'if (map.size === 0) {',
    replacement: 'if (false) {',
  },
  {
    label:
      'parseChecksumsTxt: accept the leading "*" as part of the filename (breaks matching against filenameForPin())',
    anchor: '/^([0-9a-f]{64})\\s+\\*?(\\S+)$/i',
    replacement: '/^([0-9a-f]{64})\\s+(\\S+)$/i',
  },
  {
    label: 'verifyPinAgainstChecksums: stop throwing on a missing checksums entry',
    anchor: 'if (upstream === undefined) {',
    replacement: 'if (false) {',
  },
  {
    label: 'verifyPinAgainstChecksums: stop throwing on a checksum mismatch',
    anchor: 'if (upstream.toLowerCase() !== pin.sha256.toLowerCase()) {',
    replacement: 'if (false) {',
  },
  {
    label: 'filenameForPin: return the wrong platform asset',
    anchor: "return 'go-containerregistry_Linux_x86_64.tar.gz';",
    replacement: "return 'go-containerregistry_Darwin_arm64.tar.gz';",
  },
];

declareMutations(9);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 9) {
  console.error(`FATAL: declared 9 mutations, table has ${MUTATIONS.length}`);
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
