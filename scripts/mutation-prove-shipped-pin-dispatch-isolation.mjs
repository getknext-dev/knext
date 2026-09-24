#!/usr/bin/env node
/**
 * Mutation proof for `tests/compat-shipped-pin-dispatch-isolation.test.ts`
 * (rev-1382 ISSUES_FOUND round on #1382, fixed): the 4 defects in how the
 * shipped-pin early-warning lane's 4-leg matrix dispatches and identifies
 * `test-e2e-deploy.yml` runs.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-shipped-pin-dispatch-isolation.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-shipped-pin-dispatch-isolation.test.ts';

const PROOF = {
  subjects: {
    testE2eDeploy: '.github/workflows/test-e2e-deploy.yml',
    earlyWarningWorkflow: '.github/workflows/compat-shipped-pin-early-warning.yml',
    dispatchScript: 'scripts/compat-shipped-pin-dispatch-and-wait.mjs',
  },
};

const MUTATIONS = [
  // ── finding 1+prereq: dispatchId input / run-name ────────────────────────
  {
    label: 'test-e2e-deploy.yml: drop the dispatchId input entirely',
    subject: 'testE2eDeploy',
    anchor:
      "      dispatchId:\n        description: '#1382 — optional caller-supplied id for this run, embedded in `run-name:` and the dispatch concurrency group so a multi-leg fan-out (e.g. the shipped-pin early-warning lane) can identify and isolate its OWN dispatched run by an exact match, never a \"newest run\" guess.'\n        required: false\n        type: string\n        default: ''\n",
    replacement: '',
  },
  {
    label: 'test-e2e-deploy.yml: hardcode run-name to the constant workflow name',
    subject: 'testE2eDeploy',
    anchor: 'run-name: ${{ github.event.inputs.dispatchId || github.workflow }}',
    replacement: 'run-name: ${{ github.workflow }}',
  },

  // ── finding 1: concurrency group must fold in dispatchId ─────────────────
  {
    label: 'test-e2e-deploy.yml: concurrency group drops dispatchId (reverts to pre-#1382 shape)',
    subject: 'testE2eDeploy',
    anchor:
      "group: ${{ github.event_name == 'workflow_dispatch' && format('{0}-dispatch-{1}-{2}', github.workflow, github.ref, github.event.inputs.dispatchId || 'shared') || format('{0}-run-{1}', github.workflow, github.run_id) }}",
    replacement:
      "group: ${{ github.event_name == 'workflow_dispatch' && format('{0}-dispatch-{1}', github.workflow, github.ref) || format('{0}-run-{1}', github.workflow, github.run_id) }}",
  },

  // ── finding 3: alert must be a single job after the matrix ───────────────
  {
    label:
      'compat-shipped-pin-early-warning.yml: move the alert step back INSIDE the matrix job (per-leg)',
    subject: 'earlyWarningWorkflow',
    anchor:
      '  alert:\n    name: Create or update the tracking issue (idempotent, never pinned)\n    needs: [dispatch-and-wait]',
    replacement:
      '  alert:\n    name: Create or update the tracking issue (idempotent, never pinned)\n    needs: []',
  },

  // ── finding 4: job timeout must exceed the script's own MAX_WAIT_MS ──────
  {
    label:
      'compat-shipped-pin-early-warning.yml: shrink the matrix job timeout back to equal MAX_WAIT_MS (90)',
    subject: 'earlyWarningWorkflow',
    anchor: 'timeout-minutes: 100',
    replacement: 'timeout-minutes: 90',
  },

  // ── dispatchId plumbing: script + workflow ────────────────────────────────
  {
    label: 'compat-shipped-pin-dispatch-and-wait.mjs: stop reading DISPATCH_ID from env',
    subject: 'dispatchScript',
    anchor: '  const dispatchId = process.env.DISPATCH_ID;',
    replacement: "  const dispatchId = '';",
  },
  {
    label: 'compat-shipped-pin-dispatch-and-wait.mjs: stop passing dispatchId to pickDispatchedRun',
    subject: 'dispatchScript',
    anchor:
      'run = pickDispatchedRun(runsBefore, await listRecentRuns(repo), {\n      headBranch: ref,\n      dispatchId,\n    });',
    replacement:
      'run = pickDispatchedRun(runsBefore, await listRecentRuns(repo), {\n      headBranch: ref,\n    });',
  },
  {
    label: 'compat-shipped-pin-early-warning.yml: stop setting DISPATCH_ID for the matrix cell',
    subject: 'earlyWarningWorkflow',
    anchor:
      '          DISPATCH_ID: ${{ github.run_id }}-${{ matrix.runtime }}-${{ matrix.builder }}\n',
    replacement: '',
  },
];

declareMutations(8);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 8) {
  console.error(`FATAL: declared 8 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
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
