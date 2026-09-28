#!/usr/bin/env node
/**
 * Mutation proof for #1562's `scripts/ga-tarball-diff-gate.mjs` — the
 * `release.yml` wiring that decides WHEN to invoke the #1306 tarball diff.
 *
 * Complements `scripts/mutation-prove-ga-tarball-diff-version-gate.mjs`,
 * which proves the pure decision logic
 * (`validateVersionBump`/`shouldRunGaTarballDiffGate`) in
 * `scripts/lib/ga-tarball-diff.mjs`. This file proves the THIN wiring layer
 * on top: the SKIP/FAIL/RUN exit codes, the notice + step-summary announcements, and that
 * the diff is invoked against the exact args `release.yml` needs
 * (`--ga-ref HEAD`, never a branch name or anything else that could drift
 * out from under the commit actually being published) — plus, since the fix
 * for the run-36418444586 defect (the `ga-tarball-diff` job had no install
 * step, so even a SKIP decision crashed on the `tar`-importing diff module),
 * that a static top-level import of the tar-dependent diff module never
 * comes back (M9).
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
      'a SKIP exits non-zero — every GA with no rc for its own tuple (1.0.1, 1.1.0, ...) would ' +
      'block the release lane',
    subject: 'gate',
    anchor: "announce('notice', 'SKIP (nothing compared)', decision.reason);\n    return 0;",
    replacement: "announce('notice', 'SKIP (nothing compared)', decision.reason);\n    return 1;",
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the SKIP announcement is dropped — a green check that compared nothing would be ' +
      'indistinguishable from "compared and clean" in the checks UI',
    subject: 'gate',
    anchor: "announce('notice', 'SKIP (nothing compared)', decision.reason);",
    replacement: '',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'an ambiguous-credential FAIL exits 0 — rcTag pinned at rc.1 while rc.2 exists would let ' +
      'the GA publish anyway',
    subject: 'gate',
    anchor: "announce('error', 'FAIL', decision.reason);\n    return 1;",
    replacement: "announce('error', 'FAIL', decision.reason);\n    return 0;",
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the GA-side ref is changed from the literal "HEAD" to a branch name — release.yml runs this ' +
      'BEFORE changeset publish creates the tag, so the artifact under diff must be the exact ' +
      'commit about to publish (HEAD), never a moving branch tip',
    subject: 'gate',
    anchor:
      "const code = runDiff(['--rc-ref', decision.rcTag, '--ga-ref', 'HEAD'], { log, repoRoot });",
    replacement:
      "const code = runDiff(['--rc-ref', decision.rcTag, '--ga-ref', 'main'], { log, repoRoot });",
  },
  {
    id: 'M5',
    expect: 'red',
    claim: 'the $GITHUB_STEP_SUMMARY write is removed — no outcome reaches the run summary',
    subject: 'gate',
    anchor: 'if (summaryPath) appendFileSync(',
    replacement: 'if (false) appendFileSync(',
  },
  {
    id: 'M6',
    expect: 'red',
    claim: 'the pinned rcTag is no longer read — the ambiguous-credential check can never fire',
    subject: 'gate',
    anchor: 'const pinnedRcTag = readCredentialRcTag(repoRoot);',
    replacement: 'const pinnedRcTag = null;',
  },
  {
    id: 'M7',
    expect: 'red',
    claim: "the diff's exit code is swallowed — a GA that differs from its rc would publish",
    subject: 'gate',
    anchor: '  return code;\n}',
    replacement: '  return 0;\n}',
  },
  {
    id: 'M9',
    expect: 'red',
    claim:
      'a static top-level import of the tar-dependent diff module comes back (the run-36418444586 ' +
      'defect: `ga-tarball-diff.mjs` -> `lib/tar-entries.mjs` -> the `tar` npm package) — a SKIP/FAIL ' +
      'decision would then crash before it could even be reached in a checkout with no `node_modules`',
    subject: 'gate',
    anchor:
      "import { publishablePackages, readWorkspaceManifests } from './publish-preflight.mjs';",
    replacement:
      "import { publishablePackages, readWorkspaceManifests } from './publish-preflight.mjs';\n" +
      "import { run as _reintroducedStaticImport } from './ga-tarball-diff.mjs';\n" +
      'void _reintroducedStaticImport;',
  },
  {
    id: 'M10',
    expect: 'red',
    claim:
      "release.yml's `ga-tarball-diff` job loses its install step (the live run-36418444586 defect, " +
      'verbatim) — the gate script has nothing to `bun install`, so a credentialed RUN decision ' +
      'cannot shell out to the diff at all',
    subject: 'workflow',
    anchor:
      '      - name: Install dependencies\n' +
      '        run: bun install --frozen-lockfile\n' +
      '\n' +
      '      - name: Run the GA-vs-rc tarball diff gate\n',
    replacement: '      - name: Run the GA-vs-rc tarball diff gate\n',
  },
  {
    id: 'M11',
    expect: 'red',
    claim:
      'the install step is REORDERED to after the gate step — installing too late is the same as ' +
      'not installing for the step that actually needs it',
    subject: 'workflow',
    anchor:
      '      - name: Install dependencies\n' +
      '        run: bun install --frozen-lockfile\n' +
      '\n' +
      '      - name: Run the GA-vs-rc tarball diff gate\n' +
      '        run: node scripts/ga-tarball-diff-gate.mjs\n',
    replacement:
      '      - name: Run the GA-vs-rc tarball diff gate\n' +
      '        run: node scripts/ga-tarball-diff-gate.mjs\n' +
      '\n' +
      '      - name: Install dependencies\n' +
      '        run: bun install --frozen-lockfile\n',
  },
];

/**
 * NEGATIVE CONTROL. A doc-comment sentence, asserted nowhere. Rewording it
 * must leave the guard GREEN, or the seven reds above are equally explained by
 * a text assertion rather than by behaviour.
 */
const NEGATIVE = {
  id: 'M8',
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
    workflow: '.github/workflows/release.yml',
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
