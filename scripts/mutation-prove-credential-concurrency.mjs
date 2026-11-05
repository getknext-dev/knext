#!/usr/bin/env node
/**
 * Mutation proof for v2 R5: one concurrency group across every credential workflow,
 * and a slot watchdog that flags a cancelled credential run.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * scripts/compat-line-workflow.mjs is deliberately not a subject: any byte edit to it
 * moves the guard digest in the derived workflow's header, so the specs would go red
 * for that reason and prove nothing about the substitution. The substitution is held
 * by the byte-for-byte round trip in tests/credential-concurrency-group.test.ts.
 *
 * Usage:  node scripts/mutation-prove-credential-concurrency.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = [
  'tests/credential-concurrency-group.test.ts',
  'tests/credential-slot-watchdog-cancelled.test.ts',
  'tests/actionlint-workflow.test.ts',
];

const PROOF = {
  subjects: {
    e2e: '.github/workflows/test-e2e-deploy.yml',
    vinext: '.github/workflows/compat-vinext.yml',
    v13: '.github/workflows/compat-credential-v1.3.yml',
    actionlint: '.github/workflows/actionlint.yml',
    alert: '.github/workflows/credential-slot-watchdog.yml',
    lib: 'scripts/lib/credential-slot-watchdog.mjs',
    cli: 'scripts/credential-slot-watchdog.mjs',
  },
};

const QUEUE_LINE = "  queue: ${{ github.event_name == 'schedule' && 'max' || 'single' }}\n";

const MUTATIONS = [
  // ── the group ────────────────────────────────────────────────────────────
  {
    label: 'test-e2e-deploy.yml: drop queue, so a third arrival replaces a pending run',
    subject: 'e2e',
    anchor: QUEUE_LINE,
    replacement: '',
  },
  {
    label: 'test-e2e-deploy.yml: queue max on a dispatch too, which GitHub rejects next to cancel',
    subject: 'e2e',
    anchor: "&& 'max' || 'single' }}",
    replacement: "&& 'max' || 'max' }}",
  },
  {
    label: 'test-e2e-deploy.yml: a scheduled run leaves the group for a per-run one',
    subject: 'e2e',
    anchor: "github.event_name == 'schedule' && 'knext-compat-credential-lanes' || format(",
    replacement: "github.event_name == 'schedule' && github.run_id || format(",
  },
  {
    label: 'test-e2e-deploy.yml: a dispatch joins the group',
    subject: 'e2e',
    anchor:
      "group: ${{ github.event_name == 'schedule' && 'knext-compat-credential-lanes' || format('{0}-dispatch-{1}-{2}', github.workflow, github.ref, github.event.inputs.dispatchId || 'shared') }}",
    replacement: "group: 'knext-compat-credential-lanes'",
  },
  {
    label: 'test-e2e-deploy.yml: cancel-in-progress on every trigger',
    subject: 'e2e',
    anchor: "  cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' }}\n",
    replacement: '  cancel-in-progress: true\n',
  },
  {
    label: 'compat-vinext.yml: leaves the group (a credential workflow the scan must catch)',
    subject: 'vinext',
    anchor: "github.event_name == 'schedule' && 'knext-compat-credential-lanes' || format(",
    replacement: "github.event_name == 'schedule' && github.run_id || format(",
  },
  {
    label: 'compat-credential-v1.3.yml: drops queue (the derived lane the scan must catch)',
    subject: 'v13',
    anchor: QUEUE_LINE,
    replacement: '',
  },
  {
    label: 'actionlint.yml: the queue key is no longer ignored',
    subject: 'actionlint',
    anchor: ` -ignore 'unexpected key "queue" for "concurrency" section'`,
    replacement: '',
  },
  {
    label: 'credential-slot-watchdog.yml: the alert stops naming the cancelled verdict',
    subject: 'alert',
    anchor: 'was CANCELLED or timed out',
    replacement: 'ended',
  },
  // ── the watchdog ─────────────────────────────────────────────────────────
  {
    label: 'lib: a cancelled run is not a lost run',
    subject: 'lib',
    anchor: "new Set(['cancelled', 'timed_out'])",
    replacement: "new Set(['timed_out'])",
  },
  {
    label: 'lib: a timed-out run is not a lost run',
    subject: 'lib',
    anchor: "new Set(['cancelled', 'timed_out'])",
    replacement: "new Set(['cancelled'])",
  },
  {
    label: 'lib: a cancelled dispatch flags',
    subject: 'lib',
    anchor: "    if (run.event !== undefined && run.event !== 'schedule') continue;\n",
    replacement: '',
  },
  {
    label: 'lib: a cancelled early-warning run flags',
    subject: 'lib',
    anchor: '    if (run.earlyWarning === true) continue;\n',
    replacement: '',
  },
  {
    label: 'lib: a cancellation is flagged in every window, not once',
    subject: 'lib',
    anchor: '    if (!(cancelledAt > startMs && cancelledAt <= endMs)) continue;\n',
    replacement: '',
  },
  {
    label: 'lib: a run still waiting reads as started',
    subject: 'lib',
    anchor: 'r.run_started_at && !NOT_STARTED_STATUSES.has(r.status)',
    replacement: 'r.run_started_at',
  },
  {
    label: 'lib: a mention outside the concurrency block makes a workflow a member',
    subject: 'lib',
    anchor: "return group.includes(`'${CREDENTIAL_CONCURRENCY_GROUP}'`);",
    replacement: 'return workflowText.includes(CREDENTIAL_CONCURRENCY_GROUP);',
  },
  {
    label: 'cli: cancelled runs are never checked',
    subject: 'cli',
    anchor: '      workflowFiles: credentialWorkflowFiles,\n',
    replacement: '      workflowFiles: [],\n',
  },
  {
    label: 'cli: the CLI watches only the v1.0 lane instead of the scan',
    subject: 'cli',
    anchor:
      'credentialWorkflowFiles: credentialWorkflowFiles ?? discoverCredentialWorkflowFiles(),',
    replacement: 'credentialWorkflowFiles: credentialWorkflowFiles ?? [WORKFLOW_FILE],',
  },
  {
    label: 'cli: the cancellation window is the fire window, so a recent cancel is missed',
    subject: 'cli',
    anchor: 'start: new Date(window.start.getTime() + graceMs),',
    replacement: 'start: new Date(window.start.getTime()),',
  },
  {
    label: 'cli: an empty scan reads as quiet',
    subject: 'cli',
    anchor: '  if (files.length === 0) {\n',
    replacement: '  if (files.length < 0) {\n',
  },
];

declareMutations(20);

if (MUTATIONS.length !== 20) {
  console.error(`FATAL: declared 20 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

function specsPass() {
  for (const spec of SPECS) {
    const runner = resolveSpecRunner(REPO_ROOT, spec);
    const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status !== 0) return false;
  }
  return true;
}

console.log('Baseline: the specs must be GREEN before anything is mutated.');
if (!specsPass()) {
  console.error(`FATAL: ${SPECS.join(', ')} are not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specsPass()) {
      console.log('   x DECORATION: the specs stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specsPass()) {
    console.error('   FATAL: the specs did not go green again after restore');
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
