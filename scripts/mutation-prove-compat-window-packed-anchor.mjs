#!/usr/bin/env node
/**
 * Mutation proof for the compat window's PACKED CONTENT ANCHOR (#850, V4).
 *
 * WHY THIS GUARD EXISTS AT ALL, WHICH IS NOT WHAT #850 EXPECTED
 * ------------------------------------------------------------
 * #850 reports that the 14-night window is unreachable because "any merge that
 * moves the packed tarballs restarts it", and the sprint plan's remedy was to
 * re-anchor the window on a content hash of the packed closure. Measured on this
 * branch, the anchor is ALREADY a content hash: `collectPacked` extracts each
 * tarball and digests per-file contents plus the executable bit, and two
 * independent packs of `packages/{lib,db,kn-next}` — plus a third after a full
 * rebuild — produced the identical `packed` component. So there was nothing to
 * re-anchor, and the restarts #850 measured are nights on which the shipped
 * bytes genuinely differed. The decision #850 actually asks for (narrow the
 * fingerprint, or reshape the window) is an ADR amendment and is escalated, not
 * taken here.
 *
 * What WAS missing is that the property was true by construction and untested. A
 * later "simplification" to digest the tarball itself would restart the window
 * EVERY night — tar records a per-entry mtime and gzip records another — while
 * reading in review as tidier code. V1 below is exactly that simplification.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-window-fingerprint.test.ts';

const MUTATIONS = [
  {
    id: 'V1',
    expect: 'red',
    claim:
      'the packed component takes the TARBALL BYTES into the digest — the window then ' +
      'restarts on every repack of identical code, because tar and gzip both record mtimes, ' +
      'and the 14-night gate can never close for a reason that has nothing to do with the ' +
      'code under test',
    subject: 'fingerprint',
    anchor: '      const files = walk(pkgRoot);',
    replacement: [
      '      const files = walk(pkgRoot);',
      "      entries.push({ component: 'packed', path: `${tarball}#bytes`, line:",
      '        `packed\\t${tarball}#bytes\\t-\\t${sha256(readFileSync(join(dir, tarball)))}` });',
    ].join('\n'),
  },
  {
    id: 'V2',
    expect: 'red',
    claim:
      'the per-file MODE leaves the digest — a lifecycle script that silently loses `+x` ' +
      'changes what the night ran while the fingerprint claims the harness held still',
    subject: 'fingerprint',
    anchor: "  const mode = statSync(absolute).mode & 0o111 ? 'x' : '-';",
    replacement: "  const mode = '-';",
  },
];

/**
 * NEGATIVE CONTROL. The `recorded.suite` note is prose printed into the
 * artifact. Rewording it must leave the spec GREEN, or the two reds above are
 * equally explained by the spec asserting on text rather than on the digest.
 */
const NEGATIVE = {
  id: 'V3',
  expect: 'green',
  claim: 'the suite-provenance note is reworded — the spec asserts digests, not prose',
  subject: 'fingerprint',
  anchor: "    note: 'Recorded, not frozen:",
  replacement: "    note: 'Recorded, never frozen:",
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { fingerprint: 'scripts/compat-window-fingerprint.mjs' },
});

console.log(`=== mutation proof: ${SPEC} (V4 packed content anchor) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary drops the packed half out of the digest entirely — the exact
// silent failure the script's own header says it exists to prevent.
prover.proveCanSeeRed({
  subject: 'fingerprint',
  anchor: '  const packedLines = packed.map((e) => e.line).sort();',
  replacement: '  const packedLines = [];',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
