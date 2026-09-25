#!/usr/bin/env node
/**
 * Mutation proof for `tests/compat-shipped-pin-early-warning.test.ts`
 * (#1376 option b, founder-approved 2026-09-25) — the two hard
 * requirements the coordinator named explicitly:
 *
 *   1. the lane must never count toward the v1.0 credential;
 *   2. the lane's ref must stay tied to `manifest.shippedNextPin`.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-shipped-pin-early-warning.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/compat-shipped-pin-early-warning.test.ts';

const PROOF = {
  subjects: {
    testE2eDeploy: '.github/workflows/test-e2e-deploy.yml',
    earlyWarningWorkflow: '.github/workflows/compat-shipped-pin-early-warning.yml',
    dispatchScript: 'scripts/compat-shipped-pin-dispatch-and-wait.mjs',
    dispatchPollLib: 'scripts/lib/dispatch-poll.mjs',
  },
};

const MUTATIONS = [
  // ── Requirement 1: never counts toward the v1.0 credential ──────────────
  {
    label: 'test-e2e-deploy.yml: add a 5th credential cron literal to KNEXT_COMPAT_MODE',
    subject: 'testE2eDeploy',
    anchor: "(github.event.schedule == '47 23 * * *' && 'credential') || 'early-warning' }}",
    replacement:
      "(github.event.schedule == '47 23 * * *' && 'credential') || (github.event.schedule == '17 8 * * 1' && 'credential') || 'early-warning' }}",
  },
  {
    label:
      "compat-shipped-pin-early-warning.yml: reuse one of test-e2e-deploy.yml's credential cron literals",
    subject: 'earlyWarningWorkflow',
    anchor: "cron: '17 8 * * 1'",
    replacement: "cron: '17 1 * * *'",
  },
  {
    label: 'compat-shipped-pin-early-warning.yml: add a pull_request trigger',
    subject: 'earlyWarningWorkflow',
    anchor: 'on:\n  workflow_dispatch: {}',
    replacement: 'on:\n  pull_request: {}\n  workflow_dispatch: {}',
  },
  {
    label: "dispatch-and-wait.mjs: dispatch via a DIFFERENT gh subcommand (never 'workflow run')",
    subject: 'dispatchScript',
    anchor: "  gh([\n    'workflow',\n    'run',",
    replacement: "  gh([\n    'run',\n    'rerun',",
  },

  // ── Requirement 2: tied to manifest.shippedNextPin ───────────────────────
  {
    label: 'dispatch-poll.mjs: hardcode shippedPinRef instead of deriving it',
    subject: 'dispatchPollLib',
    anchor: 'export function shippedPinRef(manifest) {\n  return `v${manifest.shippedNextPin}`;\n}',
    replacement: "export function shippedPinRef(manifest) {\n  return 'v16.3.3';\n}",
  },
  {
    label:
      'dispatch-and-wait.mjs: hardcode nextjsRef instead of calling shippedPinRef(loadManifest())',
    subject: 'dispatchScript',
    anchor: 'const nextjsRef = shippedPinRef(loadManifest());',
    replacement: "const nextjsRef = 'v16.3.3';",
  },
  {
    label:
      'compat-shipped-pin-early-warning.yml: add a hardcoded nextjsRef literal to the workflow',
    subject: 'earlyWarningWorkflow',
    anchor: 'on:\n  workflow_dispatch: {}',
    replacement: 'on:\n  workflow_dispatch: {}\n# nextjsRef=v16.3.3 (hardcoded probe)',
  },
];

declareMutations(7);

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

if (MUTATIONS.length !== 7) {
  console.error(`FATAL: declared 7 mutations, table has ${MUTATIONS.length}`);
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
