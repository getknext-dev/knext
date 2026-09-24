#!/usr/bin/env node
/**
 * Mutation proof for #1347's deterministic pin policy:
 *   - `tests/nightly-alert-issue.test.ts` — the shared helper never pins.
 *   - `tests/nightly-alert-pin-policy.test.ts` — the allowlist scan.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-nightly-alert-pin-policy.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELPER_SPEC = 'tests/nightly-alert-issue.test.ts';
const HELPER_SUBJECT = resolve(REPO_ROOT, 'scripts/lib/nightly-alert-issue.mjs');

const POLICY_SPEC = 'tests/nightly-alert-pin-policy.test.ts';
const ACTION_PIN_WORKFLOW = resolve(
  REPO_ROOT,
  '.github/workflows/action-pin-resolution-nightly.yml',
);

const RUNNER_HELPER = resolveSpecRunner(REPO_ROOT, HELPER_SPEC);
const RUNNER_POLICY = resolveSpecRunner(REPO_ROOT, POLICY_SPEC);

function specPasses(runner, spec) {
  const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'nightly-alert-issue.mjs: reintroduce a `gh issue pin` call on create',
    kind: 'helper',
    anchor: '  return { number, created: true };',
    replacement:
      "  gh(['issue', 'pin', String(number), '--repo', repo]);\n  return { number, created: true };",
  },
  {
    label:
      'nightly-alert-issue.mjs: stop finding an EXISTING issue by exact title (always creates)',
    kind: 'helper',
    anchor: 'const existing = issues.find((i) => i.title === title);',
    replacement: 'const existing = undefined;',
  },
  {
    label: 'nightly-alert-issue.mjs: drop --limit 100 from the list call',
    kind: 'helper',
    anchor: "    '--limit',\n    '100',\n    '--json',\n    'number,title',",
    replacement: "'--json',\n    'number,title',",
  },
  {
    label: 'action-pin-resolution-nightly.yml: reintroduce an inline `gh issue pin` call',
    kind: 'policy-workflow',
    subject: ACTION_PIN_WORKFLOW,
    anchor: 'TITLE="${title}" BODY="${body}" node scripts/nightly-alert-issue.mjs',
    replacement:
      'new_url="$(gh issue create --repo "${GITHUB_REPOSITORY}" --title "${title}" --body "${body}")"\n          gh issue pin "${new_url##*/}" --repo "${GITHUB_REPOSITORY}" || true',
  },
  {
    label:
      'nightly-alert-issue.mjs: the SCRIPT itself (not just the workflow) pins directly, bypassing the tracker exception',
    kind: 'policy-script',
    subject: HELPER_SUBJECT,
    anchor: '  return { number, created: true };',
    replacement:
      "  gh(['issue', 'pin', String(number), '--repo', repo]);\n  return { number, created: true };",
  },
  {
    label: 'PIN_ALLOWLIST: widen the allowlist to excuse a second, arbitrary file',
    kind: 'policy-test-self',
    subject: resolve(REPO_ROOT, 'tests/nightly-alert-pin-policy.test.ts'),
    anchor: "const PIN_ALLOWLIST = new Set(['scripts/compat-matrix-tracker.mjs']);",
    replacement:
      "const PIN_ALLOWLIST = new Set(['scripts/compat-matrix-tracker.mjs', 'scripts/lib/nightly-alert-issue.mjs']);",
  },
];

declareMutations(6);

if (MUTATIONS.length !== 6) {
  console.error(`FATAL: declared 6 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: both specs must be GREEN before anything is mutated.');
if (!specPasses(RUNNER_HELPER, HELPER_SPEC) || !specPasses(RUNNER_POLICY, POLICY_SPEC)) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const subjectPath = m.kind === 'helper' ? HELPER_SUBJECT : m.subject;
  const spec = m.kind === 'helper' ? HELPER_SPEC : POLICY_SPEC;
  const runner = m.kind === 'helper' ? RUNNER_HELPER : RUNNER_POLICY;

  const snap = snapshot(subjectPath);
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(runner, spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(runner, spec)) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
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
