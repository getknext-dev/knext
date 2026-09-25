#!/usr/bin/env node
/**
 * Mutation proof for #1406's checkout-before-script guard:
 *   - `tests/nightly-alert-checkout.test.ts` — every job that EXECUTES a
 *     `scripts/*` file has an earlier `actions/checkout` (or tar-extract)
 *     step in the same job.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-nightly-alert-checkout.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'tests/nightly-alert-checkout.test.ts';

const PROOF = {
  subjects: {
    actionPinWorkflow: '.github/workflows/action-pin-resolution-nightly.yml',
    checkoutTest: 'tests/nightly-alert-checkout.test.ts',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    // Remove the fix itself: drop the checkout step this PR added back out
    // of a real workflow, so the job again runs a repo script cold.
    label:
      'action-pin-resolution-nightly.yml: drop the checkout step from nightly-red-alert (reintroduce #1406)',
    subject: 'actionPinWorkflow',
    anchor:
      '      # #1406 — this job\'s own steps shell out to scripts/nightly-alert-issue.mjs,\n      # which requires the repo to be checked out; nothing upstream shares a\n      # checkout across jobs. Anonymous, same as the sibling job above: this\n      # step reads nothing GH_TOKEN-scoped from the checkout itself.\n      - name: Checkout code\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n\n      - name: Create or update the "Action pin SHA↔tag mismatch" issue (idempotent)',
    replacement:
      '      - name: Create or update the "Action pin SHA↔tag mismatch" issue (idempotent)',
  },
  {
    // Drop the execution-verb requirement from the detector: a bare mention
    // of a scripts/ path (e.g. inside a message string) would then falsely
    // trip the guard on the tree as it stands today — the tree has such
    // mentions (test-e2e-deploy.yml), so this mutation must be caught by
    // the "no job executes a scripts/ file..." assertion going from
    // "0 findings" to a nonempty list, which fails a DIFFERENT, unrelated,
    // job that never lacked a checkout.
    label: 'runsRepoScript: drop the execution-verb requirement (bare-mention false positive)',
    subject: 'checkoutTest',
    anchor:
      'const SCRIPT_EXEC_RE =\n  /\\b(?:node|bash|sh|python3?|bun|tsx)\\s+"?(?:\\$\\{?GITHUB_WORKSPACE\\}?\\/)?scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)"?\\b|(?:^|\\s)\\.\\/scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)\\b|(?:^|\\s)"?\\$\\{?GITHUB_WORKSPACE\\}?\\/scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)"?\\b/m;',
    replacement: 'const SCRIPT_EXEC_RE = /scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)\\b/m;',
  },
  {
    // Drop the tar-extract recognition: the guard would then falsely accuse
    // `deploy-tests` (which legitimately restores the repo via a downloaded
    // workspace tarball, never `actions/checkout`) of missing a checkout —
    // a DIFFERENT false positive than the one above, on a real job in the
    // tree today.
    label: 'isTarExtractStep: stop recognising the tar-extract workspace-restore pattern',
    subject: 'checkoutTest',
    anchor:
      'function providesRepoContent(step: YamlStep, precededByDownloadArtifact: boolean): boolean {\n  return isCheckoutStep(step) || isTarExtractStep(step, precededByDownloadArtifact);\n}',
    replacement:
      'function providesRepoContent(step: YamlStep, precededByDownloadArtifact: boolean): boolean {\n  return isCheckoutStep(step);\n}',
  },
  {
    // #1422 — the TIGHTENED tar-extract check reverts to the pre-#1422 bare
    // `tar x…f` (any tarball at all is "repo-providing", ignoring
    // `precededByDownloadArtifact` entirely). A job that unpacks an
    // UNRELATED tarball (an adapter package, a prebuilt Next.js bundle)
    // would then be silently accepted as having provided the repo.
    label:
      'isTarExtractStep: revert to bare tar x…f, ignoring the workspace-tarball name / download-artifact requirement (#1422)',
    subject: 'checkoutTest',
    anchor:
      "function isTarExtractStep(step: YamlStep, precededByDownloadArtifact: boolean): boolean {\n  if (typeof step.run !== 'string') return false;\n  if (WORKSPACE_TARBALL_TAR_EXTRACT_RE.test(step.run)) return true;\n  return precededByDownloadArtifact && GENERIC_TAR_EXTRACT_RE.test(step.run);\n}",
    replacement:
      "function isTarExtractStep(step: YamlStep, _precededByDownloadArtifact: boolean): boolean {\n  return typeof step.run === 'string' && GENERIC_TAR_EXTRACT_RE.test(step.run);\n}",
  },
  {
    // #1422 — the WIDENED SCRIPT_EXEC_RE reverts to the pre-#1422 invoker
    // set (drops bun/tsx and the $GITHUB_WORKSPACE/scripts/... forms). A
    // future `bun scripts/x.mjs` or `$GITHUB_WORKSPACE/scripts/x.sh` step
    // with no checkout would then be silently invisible to the scan.
    label: 'SCRIPT_EXEC_RE: revert to the pre-#1422 invoker set (drop bun/tsx/$GITHUB_WORKSPACE)',
    subject: 'checkoutTest',
    anchor:
      'const SCRIPT_EXEC_RE =\n  /\\b(?:node|bash|sh|python3?|bun|tsx)\\s+"?(?:\\$\\{?GITHUB_WORKSPACE\\}?\\/)?scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)"?\\b|(?:^|\\s)\\.\\/scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)\\b|(?:^|\\s)"?\\$\\{?GITHUB_WORKSPACE\\}?\\/scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)"?\\b/m;',
    replacement:
      'const SCRIPT_EXEC_RE =\n  /\\b(?:node|bash|sh|python3?)\\s+scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)\\b|(?:^|\\s)\\.\\/scripts\\/[\\w./-]+\\.(?:mjs|sh|js|ts)\\b/m;',
  },
];

declareMutations(5);

if (MUTATIONS.length !== 5) {
  console.error(`FATAL: declared 5 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
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
