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
const POLICY_SPEC = 'tests/nightly-alert-pin-policy.test.ts';

const PROOF = {
  subjects: {
    helper: 'scripts/lib/nightly-alert-issue.mjs',
    actionPinWorkflow: '.github/workflows/action-pin-resolution-nightly.yml',
    policyTest: 'tests/nightly-alert-pin-policy.test.ts',
  },
};

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
    subject: 'helper',
    spec: HELPER_SPEC,
    anchor: '  return { number, created: true };',
    replacement:
      "  gh(['issue', 'pin', String(number), '--repo', repo]);\n  return { number, created: true };",
  },
  {
    label:
      'nightly-alert-issue.mjs: stop finding an EXISTING issue by exact title (always creates)',
    subject: 'helper',
    spec: HELPER_SPEC,
    anchor: 'const existing = issues.find((i) => i.title === title);',
    replacement: 'const existing = undefined;',
  },
  {
    label: 'nightly-alert-issue.mjs: drop --limit 100 from the list call',
    subject: 'helper',
    spec: HELPER_SPEC,
    anchor: "    '--limit',\n    '100',\n    '--json',\n    'number,title',",
    replacement: "'--json',\n    'number,title',",
  },
  {
    label: 'action-pin-resolution-nightly.yml: reintroduce an inline `gh issue pin` call',
    subject: 'actionPinWorkflow',
    spec: POLICY_SPEC,
    anchor: 'TITLE="${title}" BODY="${body}" node scripts/nightly-alert-issue.mjs',
    replacement:
      'new_url="$(gh issue create --repo "${GITHUB_REPOSITORY}" --title "${title}" --body "${body}")"\n          gh issue pin "${new_url##*/}" --repo "${GITHUB_REPOSITORY}" || true',
  },
  {
    label:
      'nightly-alert-issue.mjs: the SCRIPT itself (not just the workflow) pins directly, bypassing the tracker exception',
    subject: 'helper',
    spec: POLICY_SPEC,
    anchor: '  return { number, created: true };',
    replacement:
      "  gh(['issue', 'pin', String(number), '--repo', repo]);\n  return { number, created: true };",
  },
  {
    label: 'PIN_ALLOWLIST: widen the allowlist to excuse a second, arbitrary file',
    subject: 'policyTest',
    spec: POLICY_SPEC,
    anchor: "const PIN_ALLOWLIST = new Set(['scripts/compat-matrix-tracker.mjs']);",
    replacement:
      "const PIN_ALLOWLIST = new Set(['scripts/compat-matrix-tracker.mjs', 'scripts/lib/nightly-alert-issue.mjs']);",
  },
  {
    // #1406 review round 2, bypass 1: drop the flag-tolerant signal, so a
    // `gh --repo X issue pin ...` bypass (a global flag interposed before
    // the subcommand) is invisible to the scan again.
    label: 'PIN_SIGNALS: drop the flag-tolerant `gh ... issue pin` regex (bypass 1)',
    subject: 'policyTest',
    spec: POLICY_SPEC,
    anchor:
      'const PIN_SIGNALS = [\n  /\\bgh issue pin\\b/,\n  /\\bgh\\b[^\\n]*\\bissue\\s+pin\\b/,',
    replacement: 'const PIN_SIGNALS = [\n  /\\bgh issue pin\\b/,',
  },
  {
    // #1406 review round 2, bypass 2: narrow the scanned extensions back to
    // `.mjs`-only, so a pin bypass planted in a `.sh`/`.js`/`.ts` file under
    // `scripts/` is invisible to the scan again.
    label: 'SCRIPT_EXTENSIONS: narrow back to .mjs-only (bypass 2)',
    subject: 'policyTest',
    spec: POLICY_SPEC,
    anchor: "const SCRIPT_EXTENSIONS = ['.mjs', '.sh', '.js', '.ts'];",
    replacement: "const SCRIPT_EXTENSIONS = ['.mjs'];",
  },
];

declareMutations(8);

if (MUTATIONS.length !== 8) {
  console.error(`FATAL: declared 8 mutations, table has ${MUTATIONS.length}`);
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
  const runner = m.spec === HELPER_SPEC ? RUNNER_HELPER : RUNNER_POLICY;

  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(runner, m.spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(runner, m.spec)) {
    console.error(`   FATAL: ${m.spec} did not go green again after restore`);
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
