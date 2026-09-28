#!/usr/bin/env node
/**
 * Mutation proof for #1562's version-shape logic in
 * `scripts/lib/ga-tarball-diff.mjs`: `parseRcVersion`, `validateVersionBump`,
 * and `decideGaTarballDiffGate`.
 *
 * WHY THIS NEEDS PROVING SEPARATELY FROM THE #1306 CONTENT-DIFF TESTS
 * --------------------------------------------------------------------
 * `tests/ga-tarball-diff.test.ts` already has extensive behavioural coverage
 * for the CONTENT diff (`compareTarEntries` et al., mutation-reviewed across
 * #1306's own rounds). What #1562 adds on top is a SHAPE decision two levels
 * removed from that: which version pairs the release gate even attempts to
 * compare, and — narrower still — which of those the gate should actually
 * RUN rather than skip. Both are a handful of `if`s whose removal is
 * invisible in a diff and would show up in production as either (a) the gate
 * silently accepting a backwards/mismatched-base rc pair, or (b) the gate
 * either never running (false negative — a real GA-vs-rc drift ships
 * unnoticed) or running on every mid-window rc bump (false positive — it
 * reds on every ordinary feature landing during the credential window,
 * which is precisely the failure mode `decideGaTarballDiffGate`'s own
 * header explains it exists to avoid).
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between
 * mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/ga-tarball-diff.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      "the IDENTICAL-pair shortcut in validateVersionBump is removed — the credentialed rc's own " +
      "re-publish (rcTag's commit diffed against itself) would then be judged by the GA/rc-bump " +
      'rules instead of trivially accepted, which is wrong for a pair with nothing to substitute',
    subject: 'lib',
    anchor: 'if (toVersion === fromVersion) return null; // case 1',
    replacement: 'if (false) return null; // case 1',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the rc-base-mismatch check is removed — validateVersionBump would accept an rc target ' +
      "whose base does not match the credentialed rc's own base (e.g. 1.0.0-rc.1 -> 1.0.1-rc.2), " +
      'which is not the same release line at all',
    subject: 'lib',
    anchor: 'if (to.base !== from.base) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the forward-progress check is removed — validateVersionBump would accept a BACKWARDS rc ' +
      'bump (target rc counter <= source), which cannot be a legitimate "later rc" transition',
    subject: 'lib',
    anchor: 'if (to.n <= from.n) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      "decideGaTarballDiffGate's prerelease SKIP is removed — an rc target would fall through to " +
      'the tag lookup and be judged as if it were a GA cut',
    subject: 'lib',
    anchor: 'if (!GA_VERSION_RE.test(targetVersion)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'the empty-tag-list FAIL is removed — a tagless/shallow checkout would read "no rc tag found" ' +
      'as "not credentialed" and SKIP the 1.0.0 cut instead of failing closed',
    subject: 'lib',
    anchor: 'if (gitTags.length === 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M6',
    expect: 'red',
    claim:
      'the highest rc is chosen LEXICALLY instead of numerically — rc.9 would outrank rc.10 and the ' +
      'GA would be diffed against a superseded candidate',
    subject: 'lib',
    anchor: 'if (highest === null || n > highest.n) highest = { tag, n };',
    replacement: 'if (highest === null || tag > highest.tag) highest = { tag, n };',
  },
  {
    id: 'M7',
    expect: 'red',
    claim:
      'the ambiguous-credential FAIL is removed — rcTag pinned at rc.1 while rc.2 exists would ' +
      'silently diff against rc.2, a candidate the credential may never have measured',
    subject: 'lib',
    anchor: 'if (pinnedSameTuple && pinnedRcTag !== highest.tag) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'the ambiguity check loses its same-tuple scoping — a pin on the NEXT window (v1.1.0-rc.1) ' +
      'would wrongly block the 1.0.0 GA',
    subject: 'lib',
    anchor: 'const pinnedSameTuple = pinnedRcTag?.startsWith(tagPrefix) === true;',
    replacement: 'const pinnedSameTuple = pinnedRcTag !== null;',
  },
  {
    id: 'M9',
    expect: 'red',
    claim:
      'a GA with no rc tag for its own tuple FAILS instead of skipping — every post-GA release ' +
      '(1.0.1, 1.1.0, 2.0.0, 0.4.4) would be blocked, the round-1 defect this replaces',
    subject: 'lib',
    anchor: "if (highest === null) {\n    return {\n      action: 'skip',",
    replacement: "if (highest === null) {\n    return {\n      action: 'fail',",
  },
  {
    id: 'M10',
    expect: 'red',
    claim:
      'the rc-tag pattern loses its end anchor — a look-alike tag (v11.0.0-rc.1-foo) would count as ' +
      'a release candidate for 11.0.0',
    subject: 'lib',
    anchor: '(0|[1-9]\\\\d*)$`);',
    replacement: '(0|[1-9]\\\\d*)`);',
  },
];

/**
 * NEGATIVE CONTROL. The ambiguous-credential reason's trailing clause is
 * prose, asserted nowhere byte-for-byte (the spec only matches /ambiguous/
 * and the two tag names). Rewording it must leave the guard GREEN, or the
 * reds above are equally explained by a text assertion rather than behaviour.
 */
const NEGATIVE = {
  id: 'M11',
  expect: 'green',
  claim:
    "the ambiguity reason's trailing clause is reworded — the spec asserts behaviour, not prose",
  subject: 'lib',
  anchor:
    "'either credential the highest rc (and pin it) or explain the later tag before cutting GA',",
  replacement: "'pin the highest rc or explain the later tag (reworded by the negative control)',",
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    lib: 'scripts/lib/ga-tarball-diff.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (#1562 version-shape gate) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// Removing the whole rc-shape parse makes EVERY well-formed rc version read as
// malformed — proves the runner is pointed at this spec and can see red.
prover.proveCanSeeRed({
  subject: 'lib',
  anchor: 'export function parseRcVersion(version) {\n  const m = RC_VERSION_RE.exec(version);',
  replacement:
    'export function parseRcVersion(version) {\n  return null;\n  const m = RC_VERSION_RE.exec(version);',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
