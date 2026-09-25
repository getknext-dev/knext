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
      'scanCraneVersions: stop requiring the version to look like a real version (accept any string, including an unresolved ${{ }} expression)',
    anchor: '/\\bCRANE_VERSION\\b\\s*[:=]\\s*[\'"]?(v?\\d+\\.\\d+\\.\\d+)[\'"]?/g',
    replacement: '/\\bCRANE_VERSION\\b\\s*[:=]\\s*[\'"]?(\\S+)[\'"]?/g',
  },
  {
    label:
      'scanCranePins: stop cross-checking the download-URL count against the version/checksum pair count',
    anchor: 'if (versions.length !== checksums.length || versions.length !== urlCount) {',
    replacement: 'if (false) {',
  },
  {
    label:
      'countDownloadUrlOccurrences: match a DIFFERENT URL pattern (breaks the cross-check silently)',
    anchor: '/go-containerregistry\\/releases\\/download/g',
    replacement: '/go-containerregistry\\/releases\\/download-typo/g',
  },
  {
    label:
      'scanCranePins: pair versions/checksums out of ORDER (reverse the checksums before pairing)',
    anchor:
      'for (let i = 0; i < versions.length; i++) {\n      found.push({ file, version: versions[i], sha256: checksums[i] });\n    }',
    replacement:
      'const reversed = checksums.slice().reverse();\n    for (let i = 0; i < versions.length; i++) {\n      found.push({ file, version: versions[i], sha256: reversed[i] });\n    }',
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
  {
    // rev-ci-1390-1396 — stop stripping `#` comments before scanning, so a
    // documentation comment describing the CORRECT pin can silently balance
    // the three counts against a real, WRONG inline install next to it.
    label:
      'stripFullLineComments: stop stripping comments before scanning (reintroduce the bypass)',
    anchor: "return text.replace(/^[ \\t]*#.*$/gm, '');",
    replacement: 'return text;',
  },
  {
    // #1429 — stop cross-checking a crane pin's accompanying comment
    // against its own CRANE_VERSION at all. Without this, CRANE_VERSION
    // could be bumped while the "from the vX.Y.Z release's checksums.txt"
    // comment beside it is left naming the OLD version, and nothing would
    // ever flag the drift.
    label: 'scanCranePins: stop cross-checking the accompanying comment against CRANE_VERSION',
    anchor:
      'const commentVersions = scanCraneVersionComments(readSource(file));\n    for (const cv of commentVersions) {\n      if (!versions.includes(cv)) {',
    replacement:
      'const commentVersions = scanCraneVersionComments(readSource(file));\n    for (const cv of commentVersions) {\n      if (false) {',
  },
];

declareMutations(13);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 13) {
  console.error(`FATAL: declared 13 mutations, table has ${MUTATIONS.length}`);
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
