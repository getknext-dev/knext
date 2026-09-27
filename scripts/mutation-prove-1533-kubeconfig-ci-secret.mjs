#!/usr/bin/env node
/**
 * Mutation proof for #1533 (ADR-0061 kubeconfig → CI secret) and the #1495
 * fix it carries.
 *
 * Three guards, each proved from BOTH directions the issue named explicitly:
 *
 *   1. FAIL-OPEN (the exact #1495 bug): if the SelfSubjectAccessReview
 *      hazard spot-check cannot run, or if it DOES find a hazardous grant,
 *      the credential must still be REFUSED — never silently treated as
 *      "nothing to complain about".
 *   2. EXEC-PLUGIN ACCEPTED: the `exec:`/`auth-provider:` kubeconfig
 *      classifier must refuse BOTH keys independently — this repo's own
 *      most common PR defect is a guard that asserts only one half of an
 *      "or" condition, so each half is mutated and proved on its own.
 *   3. TOKEN PRINTED: neither the CLI success path nor the push failure
 *      path may ever include the kubeconfig's raw bytes in anything they
 *      print.
 *   4. Two wiring checks: `doctor --ci-kubeconfig` and the action's step-0
 *      refusal must actually GATE on the classifier's verdict, not just
 *      call it and ignore the answer.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `declareMutations`/`recordMutation` — the lane can tell N-of-M from
 *     M-of-M;
 *   * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-1533-kubeconfig-ci-secret.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HAZARD_SPEC = 'tests/kn-next-action-preflight-hazard-and-kubeconfig.test.ts';
const KUBECONFIG_SAFETY_SPEC = 'packages/kn-next/src/__tests__/ci-kubeconfig-safety.test.ts';
const PUSH_SECRET_CLI_SPEC = 'packages/kn-next/src/__tests__/init-ci-push-secret-cli.test.ts';
const PUSH_SECRET_SPEC = 'packages/kn-next/src/__tests__/push-kubeconfig-secret.test.ts';
const DOCTOR_CI_KUBECONFIG_SPEC = 'packages/kn-next/src/__tests__/doctor-ci-kubeconfig.test.ts';

const PROOF = {
  subjects: {
    preflightMjs: 'packages/kn-next-action/preflight.mjs',
    kubeconfigSafetyTs: 'packages/kn-next/src/cli/ci/kubeconfig-safety.ts',
    initCiCmdTs: 'packages/kn-next/src/cli/ci/init-ci-cmd.ts',
    pushSecretTs: 'packages/kn-next/src/cli/ci/push-kubeconfig-secret.ts',
    doctorCiKubeconfigTs: 'packages/kn-next/src/cli/doctor/checks/ci-kubeconfig.ts',
  },
};

// resolveSpecRunner's return is spec-agnostic (always runs
// scripts/bun-test.mjs, which takes the spec as its own runtime arg) — ONE
// shared runner, the spec string varies per call to specPasses below.
const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses(spec) {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  // ── Guard 1: fail-OPEN reintroduced (#1495) ────────────────────────────
  {
    label:
      "fail-open: the hazard spot-check's own failure to run stops refusing (sets hazardsFound = [] instead of exiting 1)",
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor:
      '  console.error(`\\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);\n  process.exit(1);\n}\n\nif (hazardsFound.length > 0) {',
    replacement:
      '  console.error(`\\nunderlying error: ${err instanceof Error ? err.message : String(err)}`);\n  hazardsFound = [];\n}\n\nif (hazardsFound.length > 0) {',
  },
  {
    label: 'fail-open: a found hazard no longer refuses (the length check is disarmed)',
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor: 'if (hazardsFound.length > 0) {',
    replacement: 'if (false) {',
  },

  // ── Guard 2: exec/auth-provider classifier — BOTH halves, independently ──
  {
    label: 'exec-plugin accepted: the `exec:` half of the classifier is disarmed',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    anchor: 'if ("exec" in user || "auth-provider" in user) {',
    replacement: 'if (false || "auth-provider" in user) {',
  },
  {
    label: 'exec-plugin accepted: the `auth-provider:` half of the classifier is disarmed',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    anchor: 'if ("exec" in user || "auth-provider" in user) {',
    replacement: 'if ("exec" in user || false) {',
  },
  {
    label:
      "exec-plugin accepted at the action's own step-0 gate: the verdict is computed but never checked",
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor: '  const safety = classifyKubeconfigSafety(kubeconfigRaw);\n  if (!safety.ok) {',
    replacement: '  const safety = classifyKubeconfigSafety(kubeconfigRaw);\n  if (false) {',
  },
  {
    label: "exec-plugin accepted at doctor's own gate: the verdict is computed but never checked",
    subject: 'doctorCiKubeconfigTs',
    spec: DOCTOR_CI_KUBECONFIG_SPEC,
    anchor: '    if (!verdict.ok) {',
    replacement: '    if (false) {',
  },

  // ── Guard 3: the token must never be printed or logged ──────────────────
  {
    label: 'token printed: the CLI success message logs the raw kubeconfig instead of the path',
    subject: 'initCiCmdTs',
    spec: PUSH_SECRET_CLI_SPEC,
    anchor:
      '        log.info(\n            `pushed ${path} as the KNEXT_KUBECONFIG secret via \\`gh secret set\\``,\n        );',
    replacement: '        log.info(raw);',
  },
  {
    label: "token printed: the push failure message includes the kubeconfig's raw bytes",
    subject: 'pushSecretTs',
    spec: PUSH_SECRET_SPEC,
    anchor:
      '                `gh secret set ${secretName} exited ` +\n                `${result.code ?? "without running"} — is gh installed and ` +\n                "authenticated (`gh auth status`)?",',
    replacement:
      '                `gh secret set ${secretName} exited ` +\n                `${result.code ?? "without running"} — is gh installed and ` +\n                "authenticated (`gh auth status`)? " +\n                kubeconfigYaml,',
  },
];

declareMutations(8);

if (MUTATIONS.length !== 8) {
  console.error(`FATAL: declared 8 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

const ALL_SPECS = [
  HAZARD_SPEC,
  KUBECONFIG_SAFETY_SPEC,
  PUSH_SECRET_CLI_SPEC,
  PUSH_SECRET_SPEC,
  DOCTOR_CI_KUBECONFIG_SPEC,
];

console.log('Baseline: every spec must be GREEN before anything is mutated.');
if (!ALL_SPECS.every((s) => specPasses(s))) {
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
    if (specPasses(m.spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(m.spec)) {
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
