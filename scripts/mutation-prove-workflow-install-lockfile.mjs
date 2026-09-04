#!/usr/bin/env node
/**
 * Mutation proof for the workflow install-vs-lockfile guard (#926).
 *
 * WHY THIS GUARD EXISTS, AND WHY IT NEEDS PROVING
 * ----------------------------------------------
 * The workspace moved from pnpm to bun and deleted pnpm-lock.yaml; release.yml
 * kept running `pnpm install --frozen-lockfile` in all three jobs, so the npm
 * publish lane died at install for weeks while `release-lane-liveness.test.ts`
 * stayed green — that guard asserts the lane's SHAPE, not that its installer
 * can install. `tests/workflow-install-lockfile.test.ts` is the general form:
 * every tracked workflow is scanned for install commands whose lockfile the
 * repo does not carry. A guard in that position — the one everything else
 * assumes is watching — must be proved able to go red, or it is the same
 * decoration one layer up.
 *
 * The claims proved here, each of which fails silently if wrong:
 *
 *   1. restoring the #926 defect verbatim (a pnpm install on the publish path)
 *      reds the guard;
 *   2. every installer family is matched, not just the one that bit (npm ci);
 *   3. the foreign-checkout exception cannot be BORROWED — an install placed
 *      under `next.js/` in a workflow that never checks vercel/next.js out is a
 *      violation, not an exemption;
 *   4. the scan's non-vacuity floors are real: an empty corpus reds, a
 *      stale/renamed exception reds, and a PENDING_FIXES ledger entry that
 *      stops covering a live violation reds (it cannot outlive #917);
 *   5. and two NEGATIVE controls — a workspace-member bun install (root
 *      bun.lock reachable by the ancestor walk) and a log line QUOTING an
 *      install command — stay green, or every red above is equally explained by
 *      a guard that reds on everything.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/workflow-install-lockfile.test.ts';

/** A planted step must leave the workflow PARSEABLE, or its red proves nothing. */
const validYaml = (mutated) => {
  try {
    parse(mutated);
    return undefined;
  } catch (err) {
    return `release.yml no longer parses as YAML: ${err.message}`;
  }
};

/**
 * The audit job's install step — anchored WITH its following comment, which is
 * unique to that job (the same `run:` line appears in all three jobs).
 */
const AUDIT_INSTALL =
  '      - name: Install dependencies\n' +
  '        run: bun install --frozen-lockfile\n' +
  '\n' +
  '      # Build in dependency order so the packed tarballs carry real dist/ (lib →\n';

/** The preflight step — a unique spot to plant additional steps in front of. */
const PREFLIGHT_STEP =
  '      - name: Compare tree versions against the registry\n' +
  '        id: preflight\n' +
  '        run: node scripts/publish-preflight.mjs\n';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the #926 defect restored VERBATIM — the audit job installs with `pnpm install ' +
      '--frozen-lockfile` against a repo with no pnpm-lock.yaml. This is literally what main ' +
      'shipped, and what nothing reddened on for weeks',
    subject: 'workflow',
    anchor: AUDIT_INSTALL,
    replacement:
      '      - name: Install dependencies\n' +
      '        run: pnpm install --frozen-lockfile\n' +
      '\n' +
      '      # Build in dependency order so the packed tarballs carry real dist/ (lib →\n',
    validate: validYaml,
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'a DIFFERENT installer family, same hole — `npm ci` needs package-lock.json, which the ' +
      'repo does not carry. The guard must cover every family, not just the one that already bit',
    subject: 'workflow',
    anchor: PREFLIGHT_STEP,
    replacement:
      '      - name: Install dependencies (planted)\n' +
      '        run: npm ci\n' +
      '\n' +
      `${PREFLIGHT_STEP}`,
    validate: validYaml,
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the foreign-checkout exception cannot be borrowed: an install under `next.js/` in a ' +
      'workflow that never checks out vercel/next.js must be a violation. Without this, naming a ' +
      'directory after the harness exempts any install from the guard',
    subject: 'workflow',
    anchor: PREFLIGHT_STEP,
    replacement:
      '      - name: Harness install (planted — no such checkout in this workflow)\n' +
      '        working-directory: next.js\n' +
      '        run: corepack pnpm install --frozen-lockfile\n' +
      '\n' +
      `${PREFLIGHT_STEP}`,
    validate: validYaml,
  },
  {
    id: 'M4',
    expect: 'red',
    claim:
      'the corpus collapses — a broken pathspec means zero workflows scanned, and zero scanned ' +
      'must be a FAILURE, never "zero violations". This is the non-vacuity floor doing its job',
    subject: 'spec',
    anchor: "'.github/workflows/*.yml'",
    replacement: "'.github/workflows-none/*.yml'",
  },
  {
    id: 'M5',
    expect: 'red',
    claim:
      'the declared exception goes stale — renaming its path means it exempts nothing, and a ' +
      'stale exception must red rather than linger as a hole the next install inherits. This also ' +
      'reds the harness installs it used to cover, proving the exemption was load-bearing',
    subject: 'spec',
    anchor: "    path: 'next.js',",
    replacement: "    path: 'not-a-real-checkout',",
  },
  {
    id: 'M6',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — a workspace-member `bun install --frozen-lockfile` under apps/docs is ' +
      'satisfied by the ROOT bun.lock via the ancestor walk (exactly how bun resolves it). A red ' +
      'here would mean the guard false-positives on every legitimate subdirectory install',
    subject: 'workflow',
    anchor: PREFLIGHT_STEP,
    replacement:
      '      - name: Workspace-member install (planted negative control)\n' +
      '        working-directory: apps/docs\n' +
      '        run: bun install --frozen-lockfile\n' +
      '\n' +
      `${PREFLIGHT_STEP}`,
    validate: validYaml,
  },
  {
    id: 'M7',
    expect: 'green',
    claim:
      'NEGATIVE CONTROL — a log line QUOTING an install command is not an install command. The ' +
      'harness retry loops print exactly such lines; a red here would force weakening the scan ' +
      'until it found nothing',
    subject: 'workflow',
    anchor: PREFLIGHT_STEP,
    replacement:
      '      - name: Say the words without running them (planted negative control)\n' +
      '        run: echo "pnpm install --frozen-lockfile"\n' +
      '\n' +
      `${PREFLIGHT_STEP}`,
    validate: validYaml,
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'a PENDING_FIXES entry goes stale — repointing it at a workflow with no such violation ' +
      'must red BOTH ways: the entry covers nothing (the self-enforcing staleness assertion), ' +
      'and the violation it used to cover reds the main assertion. This is what makes the ' +
      'ledger unable to outlive, or be borrowed beyond, the defect it documents',
    subject: 'spec',
    anchor: "    workflow: '.github/workflows/compat-vinext.yml',",
    replacement: "    workflow: '.github/workflows/does-not-exist.yml',",
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    workflow: '.github/workflows/release.yml',
    spec: SPEC,
  },
});

console.log(`=== mutation proof: ${SPEC} (workflow installs have a real lockfile, #926) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

// The canary raises the corpus floor above anything the repo could satisfy —
// a real mutation of the real spec, so it also proves the runner is pointed at
// this file rather than exiting 0 on one it never collected.
prover.proveCanSeeRed({
  subject: 'spec',
  anchor: "expect(files.length, 'tracked workflow corpus collapsed').toBeGreaterThan(15);",
  replacement: "expect(files.length, 'tracked workflow corpus collapsed').toBeGreaterThan(1500);",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
