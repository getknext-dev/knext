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
    // #1429 finding 1a — stop requiring a crane pin to carry an accompanying
    // version comment. A pin with NO comment would pass silently.
    label: 'scanCranePins: stop requiring a crane pin to have an accompanying version comment',
    anchor: 'if (named.length === 0) {',
    replacement: 'if (false) {',
  },
  {
    // #1429 finding 1b — narrow the comment parse back to one phrasing
    // ("from the vX.Y.Z"). A single-line "from v9.9.9" comment then yields
    // no token and the loose-parse end-to-end test goes red.
    label: 'scanCraneVersionComments: parse only the exact "from the vX.Y.Z" phrasing',
    anchor: 'const versionTokenRe = /\\bv\\d+\\.\\d+\\.\\d+\\b(?!\\.\\d)/gi;',
    replacement: 'const versionTokenRe = /(?<=from the )v\\d+\\.\\d+\\.\\d+\\b(?!\\.\\d)/gi;',
  },
  {
    // #1429 — make the v prefix OPTIONAL again. "go 1.22.3" / "10.0.0.1" in a
    // comment block then become tokens that differ from the pin's version,
    // so a block that names the correct version plus those throws.
    label: 'scanCraneVersionComments: accept bare X.Y.Z tokens (v prefix optional)',
    anchor: 'const versionTokenRe = /\\bv\\d+\\.\\d+\\.\\d+\\b(?!\\.\\d)/gi;',
    replacement: 'const versionTokenRe = /\\bv?\\d+\\.\\d+\\.\\d+\\b(?!\\.\\d)/gi;',
  },
  {
    // #1429 — drop the ".<digit>" exclusion. The trailing \b then matches
    // before the "." of "v9.9.9.1", reading it as v9.9.9 and passing.
    label: 'scanCraneVersionComments: drop the ".<digit>" exclusion (v0.20.2.1 reads as v0.20.2)',
    anchor: 'const versionTokenRe = /\\bv\\d+\\.\\d+\\.\\d+\\b(?!\\.\\d)/gi;',
    replacement: 'const versionTokenRe = /\\bv\\d+\\.\\d+\\.\\d+\\b/gi;',
  },
  {
    // #1429 finding 2 — compare each comment against ANY CRANE_VERSION in
    // the file (the old `versions.includes(cv)` shape) instead of its OWN
    // pin. The single-drift test still passes; only the swapped-comments
    // test (operator-e2e-nightly.yml's two-pin shape) catches it.
    label: "scanCranePins: compare a pin's comment file-wide instead of against its OWN pin",
    anchor: 'const stale = named.filter((cv) => cv !== versions[i]);',
    replacement: 'const stale = named.filter((cv) => !versions.includes(cv));',
  },
  {
    // #1429 — count commented-out CRANE_SHA256 lines in the raw comment
    // scan, shifting its ordinals off the stripped-text pairing.
    label: 'scanCraneVersionComments: stop skipping commented-out CRANE_SHA256 lines',
    anchor: 'if (commentLineRe.test(lines[i]) || !shaAssignRe.test(lines[i])) continue;',
    replacement: 'if (!shaAssignRe.test(lines[i])) continue;',
  },
];

declareMutations(18);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 18) {
  console.error(`FATAL: declared 18 mutations, table has ${MUTATIONS.length}`);
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
