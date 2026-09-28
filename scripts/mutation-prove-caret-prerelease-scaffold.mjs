#!/usr/bin/env node
/**
 * Mutation proof for `scaffold-registry.ts`'s PRERELEASE-AWARE pin parser
 * (#1591 round 3).
 *
 * WHY THIS EXISTS. `CARET_PIN` used to be release-only
 * (`/^\^(\d+\.\d+\.\d+)$/`) — round-2 review measured this live: once this
 * PR sets the CLI's own manifest version to `1.0.0-rc.1`, `knext create`
 * renders the pin `^1.0.0-rc.1`, and the release-only shape parsed that to
 * `version: null`, SILENTLY skipping the unpublished-pin registry check
 * `scaffold-registry.ts` exists to run (#950) for every rc build — the same
 * release-only-regex defect round 2 already had to fix twice, in
 * `audit-published.mjs` and `verify-published-group.mjs` (see
 * `mutation-prove-caret-prerelease-audit.mjs` /
 * `-verify.mjs`), in a THIRD place that was missed.
 *
 * The claims proved, each of which fails silently if wrong:
 *
 *   1. reverting `CARET_PIN` to the pre-#1591-round-3 release-only shape (no
 *      `-<prerelease>` group) makes it return null for every rc.1/rc.2/1.0.0
 *      pin, so both the round-3 prerelease-pin describe block AND the
 *      existing "rendered pin equals manifest version" test (#950, section
 *      1b — the manifest version IS `1.0.0-rc.1` on this branch) red;
 *   2. loosening the prerelease identifier grammar from
 *      `[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*` to a bare `.*` makes malformed
 *      pins (empty identifier, trailing dot) parse to a version instead of
 *      failing closed to `null` — the fail-closed half `scaffoldGetknextPins`
 *      promises for a hand-edited, non-template range;
 *   3. a NEGATIVE control — rewording the doc comment above `CARET_PIN`
 *      stays green, so the reds above are explained by the code, not by a
 *      spec asserting on prose.
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
const SPEC = 'packages/kn-next/src/__tests__/scaffold-version-pins.test.ts';

const CARET_PIN_LINE =
  'const CARET_PIN = /^\\^(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)$/;\n';

const MUTATIONS = [
  {
    id: 'S1',
    expect: 'red',
    claim:
      'reverting CARET_PIN to the pre-#1591-round-3 release-only shape (drops the ' +
      '`-<prerelease>` capture group entirely) makes it return null for every rc.1/rc.2/1.0.0 ' +
      'pin, so BOTH the round-3 prerelease-pin cases and the existing #950 "rendered pin equals ' +
      'manifest version" test red — the manifest version on this branch IS 1.0.0-rc.1, so this is ' +
      'the exact regression round 2 review caught live ("knext create" silently skipping the ' +
      'unpublished-pin warning for every rc build).',
    subject: 'script',
    anchor: CARET_PIN_LINE,
    replacement: 'const CARET_PIN = /^\\^(\\d+\\.\\d+\\.\\d+)$/;\n',
  },
  {
    id: 'S2',
    expect: 'red',
    claim:
      'loosening the prerelease identifier grammar to a bare `.*` lets a MALFORMED pin (an empty ' +
      'prerelease identifier, or a trailing dot after the last identifier) parse to a non-null ' +
      'version instead of failing closed — the "malformed pin fails closed to null, never guesses" ' +
      'cases red for exactly that shape.',
    subject: 'script',
    anchor: CARET_PIN_LINE,
    replacement: 'const CARET_PIN = /^\\^(\\d+\\.\\d+\\.\\d+(?:-.*)?)$/;\n',
  },
  {
    id: 'S3',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — rewording the doc comment above CARET_PIN stays green: the reds above ' +
      'are explained by the regex, not by a spec asserting on prose',
    subject: 'script',
    anchor:
      ' * skipped, never guessed at — a malformed pin (e.g. a trailing dot, an empty\n' +
      ' * prerelease identifier, an `||` range) is a hand-edited app whose range is\n' +
      " * the user's call, not ours.\n",
    replacement:
      ' * skipped, never guessed at (reworded by the negative control) — a malformed pin (e.g. a ' +
      'trailing dot, an empty\n' +
      ' * prerelease identifier, an `||` range) is a hand-edited app whose range is\n' +
      " * the user's call, not ours.\n",
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    script: 'packages/kn-next/src/cli/scaffold-registry.ts',
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (prerelease caret pin parsing, #1591 round 3) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

prover.proveCanSeeRed({
  subject: 'spec',
  anchor:
    '    it("cliVersion() reads the real @getknext/core manifest", () => {\n' +
    '        expect(cliVersion()).toBe(manifestVersion());\n',
  replacement:
    '    it("cliVersion() reads the real @getknext/core manifest", () => {\n' +
    '        expect(cliVersion()).toBe(`not-${manifestVersion()}`);\n',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
