#!/usr/bin/env node
/**
 * Mutation proof for `ensure-published-group.mjs`'s `main()` publish-closure
 * wiring — the derived `distTag` reaching `npmPublish` (#1591 round 3,
 * finding 3).
 *
 * WHY THIS EXISTS. Round 2 (M1) made `npmPublish` accept a `tag` and forward
 * it as `--tag <tag>`, and covered that forwarding two ways: a pure unit test
 * of `npmPublish` itself, and a real-spawnSync fake-npm argv capture
 * (`tests/ensure-published-group-fake-npm.test.ts`). Neither one exercises
 * the ONE call site inside `main()` that actually computes `distTag` and
 * passes it through — `main()` is not exported (it reads the real
 * `.changeset/config.json`, the real workspace, and shells out to a real
 * `npm view`/`npm publish`, so it cannot be spawned in a unit test the way
 * the fake-npm suite spawns individual functions). Round-3 review measured
 * this live: mutating `npmPublish(dirByName.get(name), registry, distTag)`
 * to `…, registry, null)` left every existing test green — a prerelease
 * republish would silently ship with no `--tag`, and npm >= 11 refuses that
 * outright, exactly the defect M1 already fixed once, regressed at the one
 * call site nothing read.
 *
 * The claims proved, each of which fails silently if wrong:
 *
 *   1. dropping `distTag` to a hardcoded `null` at the `npmPublish(...)` call
 *      site inside `main()`'s publish closure reds the new source-scan
 *      assertion;
 *   2. dropping the `const distTag = prereleaseDistTag(targetVersion);`
 *      derivation itself (replacing it with a hardcoded `null`) also reds —
 *      the tag must be DERIVED, never guessed or hard-coded;
 *   3. a NEGATIVE control — rewording the comment introducing this
 *      describe block's own explanatory prose (in this file, not the
 *      subject) stays green: N/A here since this prover has no spec-side
 *      prose to reword independent of the anchors above, so the negative
 *      control instead reformats WHITESPACE ONLY around the call site
 *      (adding a trailing space before the closing paren) and stays green —
 *      the assertion is a `.toContain` substring check, insensitive to
 *      anything outside the exact anchor text.
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
const SPEC = 'tests/ensure-published-group.test.ts';

const PUBLISH_CALL_LINE = '        return npmPublish(dirByName.get(name), registry, distTag);\n';

const DIST_TAG_DERIVATION_LINE = '  const distTag = prereleaseDistTag(targetVersion);\n';

const MUTATIONS = [
  {
    id: 'D1',
    expect: 'red',
    claim:
      "dropping distTag to a hardcoded null at main()'s npmPublish call site means a prerelease " +
      'republish ships with no --tag and npm >= 11 refuses it outright — exactly the M1 defect ' +
      'round 2 fixed once, regressed at the one call site nothing tested before this prover.',
    subject: 'script',
    anchor: PUBLISH_CALL_LINE,
    replacement: '        return npmPublish(dirByName.get(name), registry, null);\n',
  },
  {
    id: 'D2',
    expect: 'red',
    claim:
      'hard-coding distTag itself to null (instead of deriving it from prereleaseDistTag) means ' +
      'the tag is never computed at all — a stable release would still work, but every ' +
      'prerelease republish would silently omit --tag.',
    subject: 'script',
    anchor: DIST_TAG_DERIVATION_LINE,
    replacement: '  const distTag = null;\n',
  },
  {
    id: 'D3',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — adding a trailing space before the closing paren of the SAME call site ' +
      'stays green: the assertion is a substring .toContain check anchored on the exact call, so ' +
      'whitespace elsewhere in the file (not inside the anchor) is irrelevant. Proves the reds ' +
      'above are explained by the call site changing, not by an unrelated file diff.',
    subject: 'script',
    anchor: '  const workspace = readWorkspace();\n',
    replacement:
      '  const workspace = readWorkspace();\n  // (negative control) unrelated comment\n',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    script: 'scripts/ensure-published-group.mjs',
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (main() publish distTag wiring, #1591 round 3) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

prover.proveCanSeeRed({
  subject: 'spec',
  anchor:
    "  it('distTag itself is derived from prereleaseDistTag(targetVersion), never hard-coded', () => {\n" +
    "    expect(source).toContain('const distTag = prereleaseDistTag(targetVersion);');\n",
  replacement:
    "  it('distTag itself is derived from prereleaseDistTag(targetVersion), never hard-coded', () => {\n" +
    "    expect(source).toContain('const distTag = definitely not this string');\n",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
