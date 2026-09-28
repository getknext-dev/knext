#!/usr/bin/env node
/**
 * Mutation proof for `audit-published.mjs`'s PRERELEASE-AWARE caret matching
 * (#1591 round 2, B2).
 *
 * WHY THIS EXISTS. `caretSatisfies`/`parseSemver` used to reject any range or
 * version carrying a `-rc.N` suffix outright — round-1 review measured this
 * live: `node scripts/audit-published.mjs` exited 1 on the v1.0.0-rc.1 tree
 * with "range '^1.0.0-rc.1', which this gate cannot vouch for (expected
 * ^x.y.z after pack rewriting)", even though the co-packed sibling was
 * EXACTLY the tarball beside it. A supply-chain gate that cannot be run on
 * the release lane's own first prerelease is not proven for prereleases at
 * all — this prover pins the fix so a future edit cannot silently regress it
 * back to release-only.
 *
 * The claims proved, each of which fails silently if wrong:
 *
 *   1. reverting `parseSemver`'s regex to the OLD release-only shape (no
 *      `-<prerelease>` group) reds the spec — every rc.1/rc.2/1.0.0-vs-rc.1
 *      case in `siblingRangeProblems` depends on parsing the prerelease at
 *      all;
 *   2. removing the "a prerelease only satisfies a same-tuple, prerelease-
 *      bearing floor" guard reds the spec — a prerelease of a DIFFERENT
 *      tuple (patch bumped) would otherwise silently satisfy a caret whose
 *      major alone happens to match, the exact npm §9 rule this gate exists
 *      to enforce;
 *   3. a NEGATIVE control — rewording the doc comment above `caretSatisfies`
 *      stays green, or the reds above are equally explained by a spec
 *      asserting on prose.
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
const SPEC = 'tests/audit-published-sibling-ranges.test.ts';

const PARSE_SEMVER_REGEX =
  '  const m = /^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$/.exec(\n';

const TUPLE_GUARD = '    if (!sameTuple || floor.prerelease.length === 0) return false;\n';

const MUTATIONS = [
  {
    id: 'A1',
    expect: 'red',
    claim:
      "reverting parseSemver's regex to the pre-#1591 release-only shape (drops the " +
      '`-<prerelease>` capture group entirely) makes it return null for every rc.1/rc.2/1.0.0 ' +
      'version string, so the round-2 prerelease describe block reds across the board — the exact ' +
      "regression that shipped round 1 (\"expected ^x.y.z after pack rewriting\") wasn't caught " +
      'because nothing exercised a prerelease before.',
    subject: 'script',
    anchor: PARSE_SEMVER_REGEX,
    replacement: '  const m = /^v?(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(\n',
  },
  {
    id: 'A2',
    expect: 'red',
    claim:
      'removing the same-tuple/prerelease-floor guard in caretSatisfies lets a prerelease of a ' +
      'DIFFERENT [major,minor,patch] tuple (here patch+1) silently satisfy a caret whose major ' +
      "alone matches (1.0.1-rc.1 vs ^1.0.0-rc.1) — npm's semver §9 rule this gate exists to " +
      'enforce, reds the fail-closed test for exactly that shape',
    subject: 'script',
    anchor: TUPLE_GUARD,
    replacement: '    // (mutated) prerelease/tuple guard removed\n',
  },
  {
    id: 'A3',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — rewording the doc comment above caretSatisfies stays green: the reds ' +
      'above are explained by the code, not by a spec asserting on prose',
    subject: 'script',
    anchor:
      "/**\n * Caret satisfaction for `^x.y.z` and `^x.y.z-<prerelease>` ranges — npm's\n" +
      ' * rule: same major (same minor when major is 0, same patch when major and\n',
    replacement:
      "/**\n * Caret satisfaction for `^x.y.z` and `^x.y.z-<prerelease>` ranges (reworded by the " +
      "negative control) — npm's\n" +
      ' * rule: same major (same minor when major is 0, same patch when major and\n',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    script: 'scripts/audit-published.mjs',
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
    "    it('the final release satisfies an rc floor (1.0.0 satisfies ^1.0.0-rc.1)', () => {\n" +
    "      expect(siblingRangeProblems([lib('1.0.0'), core('1.0.0', '^1.0.0-rc.1')])).toEqual([]);\n",
  replacement:
    "    it('the final release satisfies an rc floor (1.0.0 satisfies ^1.0.0-rc.1)', () => {\n" +
    "      expect(siblingRangeProblems([lib('1.0.0'), core('1.0.0', '^1.0.0-rc.1')])).toEqual(['x']);\n",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
