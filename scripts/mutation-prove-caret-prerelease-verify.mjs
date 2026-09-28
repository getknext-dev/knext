#!/usr/bin/env node
/**
 * Mutation proof for `verify-published-group.mjs`'s PRERELEASE-AWARE caret
 * matching (#1591 round 2, B2).
 *
 * WHY THIS EXISTS. `caretSatisfies`/`parseSemver` here are a byte-for-byte
 * duplicate of `audit-published.mjs`'s (each gate must independently vouch
 * for its own closure — see the doc comment on `caretSatisfies` in both
 * files) — so BOTH need their own prover, not one shared one. Round-1 review
 * measured this gate refusing the release lane's own v1.0.0-rc.1 tree the
 * same way: `node scripts/verify-published-group.mjs --pre` exited 1 on
 * EVERY fixed-group edge, including `kn-next -> @getknext/core`, with
 * "expected ^x.y.z". This prover pins the fix so a future edit here cannot
 * silently regress it back to release-only, independent of whether
 * `audit-published.mjs`'s copy is proved.
 *
 * The claims proved, each of which fails silently if wrong:
 *
 *   1. reverting `parseSemver`'s regex to the OLD release-only shape reds
 *      the spec — every rc.1/rc.2/1.0.0-vs-rc.1 case in `fixedGroupProblems`
 *      and the direct `caretSatisfies`/`parseSemver` tests depend on parsing
 *      the prerelease at all;
 *   2. removing the "a prerelease only satisfies a same-tuple, prerelease-
 *      bearing floor" guard reds the spec — a prerelease of a DIFFERENT
 *      tuple would otherwise silently satisfy a same-major caret, exactly
 *      the npm §9 rule this gate exists to enforce;
 *   3. a NEGATIVE control — rewording the doc comment above `caretSatisfies`
 *      stays green.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline;
 * a canary red first; anchors exactly once or abort; clean tree between
 * mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/verify-published-group.test.ts';

const PARSE_SEMVER_REGEX =
  '  const m = /^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$/.exec(\n';

const TUPLE_GUARD = '    if (!sameTuple || floor.prerelease.length === 0) return false;\n';

const MUTATIONS = [
  {
    id: 'V1',
    expect: 'red',
    claim:
      "reverting parseSemver's regex to the pre-#1591 release-only shape makes it return null " +
      'for every rc.1/rc.2/1.0.0 version string, so the round-2 prerelease describe blocks (both ' +
      'fixedGroupProblems and the direct caretSatisfies/parseSemver tests) red across the board — ' +
      "the exact regression that shipped round 1 (\"expected ^x.y.z\") wasn't caught because " +
      'nothing exercised a prerelease before',
    subject: 'script',
    anchor: PARSE_SEMVER_REGEX,
    replacement: '  const m = /^v?(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(\n',
  },
  {
    id: 'V2',
    expect: 'red',
    claim:
      'removing the same-tuple/prerelease-floor guard in caretSatisfies lets a prerelease of a ' +
      'DIFFERENT [major,minor,patch] tuple silently satisfy a caret whose major alone matches — ' +
      "npm's semver §9 rule this gate exists to enforce",
    subject: 'script',
    anchor: TUPLE_GUARD,
    replacement: '    // (mutated) prerelease/tuple guard removed\n',
  },
  {
    id: 'V3',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — rewording the doc comment above caretSatisfies stays green: the reds ' +
      'above are explained by the code, not by a spec asserting on prose',
    subject: 'script',
    anchor:
      "/**\n * Caret satisfaction for `^x.y.z` and `^x.y.z-<prerelease>` ranges — npm's\n" +
      ' * rule: same major (same minor when major is 0, same patch when both are 0),\n',
    replacement:
      "/**\n * Caret satisfaction for `^x.y.z` and `^x.y.z-<prerelease>` ranges (reworded by the " +
      "negative control) — npm's\n" +
      ' * rule: same major (same minor when major is 0, same patch when both are 0),\n',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    script: 'scripts/verify-published-group.mjs',
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (prerelease caret matching, #1591 round 2 B2) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

prover.proveCanSeeRed({
  subject: 'spec',
  anchor:
    "    it('passes the final 1.0.0 fixed group against the rc.1 floor (the GA cutover)', () => {\n" +
    "      expect(fixedGroupProblems(rcGroup('1.0.0'), fixed)).toEqual([]);\n",
  replacement:
    "    it('passes the final 1.0.0 fixed group against the rc.1 floor (the GA cutover)', () => {\n" +
    "      expect(fixedGroupProblems(rcGroup('1.0.0'), fixed)).toEqual([{ never: 'matches' }]);\n",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
