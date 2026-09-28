#!/usr/bin/env node
/**
 * Mutation proof for #1562's `scripts/ga-tarball-diff-gate.mjs` — the
 * `release.yml` wiring that decides WHEN to invoke the #1306 tarball diff.
 *
 * Complements `scripts/mutation-prove-ga-tarball-diff-version-gate.mjs`,
 * which proves the pure decision logic
 * (`validateVersionBump`/`shouldRunGaTarballDiffGate`) in
 * `scripts/lib/ga-tarball-diff.mjs`. This file proves the THIN wiring layer
 * on top: the `rcTag === null` no-op branch, the skip/run branch, and that
 * the diff is invoked against the exact args `release.yml` needs
 * (`--ga-ref HEAD`, never a branch name or anything else that could drift
 * out from under the commit actually being published).
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
const SPEC = 'tests/ga-tarball-diff-gate.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the rcTag===null no-op branch is removed — main() would then call `.replace` on `null` (or ' +
      'otherwise mis-handle the uncredentialed state) instead of a clean, loudly-logged no-op',
    subject: 'gate',
    anchor: 'if (rcTag === null) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the skip branch is removed — every mid-window rc bump would fall through to invoking the ' +
      'diff, exactly the false-positive shouldRunGaTarballDiffGate exists to prevent',
    subject: 'gate',
    anchor: 'if (!decision.run) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the GA-side ref is changed from the literal "HEAD" to a branch name — release.yml runs this ' +
      'BEFORE changeset publish creates the GA/rc tag, so the artifact under diff must be the exact ' +
      'commit about to publish (HEAD), never a moving branch tip that could drift mid-run',
    subject: 'gate',
    anchor: "return runDiff(['--rc-ref', rcTag, '--ga-ref', 'HEAD'], { log });",
    replacement: "return runDiff(['--rc-ref', rcTag, '--ga-ref', 'main'], { log });",
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the "v" prefix strip on rcTag is removed — a credentialed rc tag ("v1.0.0-rc.1") would then ' +
      'never compare as IDENTICAL to the bare tree version ("1.0.0-rc.1") shouldRunGaTarballDiffGate ' +
      "reads, so the credentialed rc's own first publish would wrongly read as a mid-window bump " +
      'and SKIP instead of RUN',
    subject: 'gate',
    anchor: "const rcVersion = rcTag.replace(/^v/, '');",
    replacement: 'const rcVersion = rcTag;',
  },
];

/**
 * NEGATIVE CONTROL. A doc-comment sentence, asserted nowhere. Rewording it
 * must leave the guard GREEN, or the four reds above are equally explained by
 * a text assertion rather than by behaviour.
 */
const NEGATIVE = {
  id: 'M5',
  expect: 'green',
  claim: 'a header doc-comment sentence is reworded — the spec asserts behaviour, not prose',
  subject: 'gate',
  anchor: 'workflow triggers on `push: branches: [main]`, not on a tag push.',
  replacement:
    'workflow triggers on a push to main, never a tag push (reworded by the negative control).',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    gate: 'scripts/ga-tarball-diff-gate.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (#1562 release-gate wiring) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// Making readCredentialRcTag always throw breaks every test in the spec —
// proves the runner is pointed at this spec and can see red.
prover.proveCanSeeRed({
  subject: 'gate',
  anchor: 'export function readCredentialRcTag(repoRoot) {',
  replacement:
    "export function readCredentialRcTag(repoRoot) {\n  throw new Error('canary');\n  // eslint-disable-next-line no-unreachable",
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
