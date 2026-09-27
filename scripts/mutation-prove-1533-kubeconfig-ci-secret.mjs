#!/usr/bin/env node
/**
 * Mutation proof for #1533 (ADR-0061 kubeconfig → CI secret) and the #1495
 * fix it carries, including the round-2 review fixes.
 *
 * Guards, each proved from the directions the issue and the review named:
 *
 *   1. FAIL-OPEN (the exact #1495 bug): if the SelfSubjectAccessReview
 *      hazard spot-check cannot run, returns no verdict, or DOES find a
 *      hazardous grant, the credential must be REFUSED. The probe set is
 *      derived from the Role, and each derivation leg is mutated on its own.
 *   2. EXEC-PLUGIN ACCEPTED: the classifier must refuse `exec` and
 *      `auth-provider` independently (this repo's most common PR defect is a
 *      guard that asserts one half of an "or"), through a YAML merge key, and
 *      at any depth. The kubeconfig step must gate on the verdict and must not
 *      be reachable by `skip-credential-preflight`.
 *   3. TOKEN PRINTED: no surface — classifier reason, CLI stderr, doctor
 *      table/JSON, the action's `::error::` line, the push success and
 *      failure paths — may carry the kubeconfig's bytes.
 *   4. Minors: `--ci-kubeconfig --json` argument parsing and the empty-CA
 *      warning in the mint recipe.
 *
 * Shared harness, for the reasons this repo has already paid for:
 *   * `mutate` asserts the anchor occurs exactly once and aborts otherwise —
 *     a silently-failed substitution would certify a decorative guard green;
 *   * `restore` writes the snapshotted bytes back and checks their sha256;
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
const HAZARD_PROBES_SPEC = 'packages/kn-next/src/__tests__/ci-hazard-probes.test.ts';
const PUSH_SECRET_CLI_SPEC = 'packages/kn-next/src/__tests__/init-ci-push-secret-cli.test.ts';
const PUSH_SECRET_SPEC = 'packages/kn-next/src/__tests__/push-kubeconfig-secret.test.ts';
const DOCTOR_CI_KUBECONFIG_SPEC = 'packages/kn-next/src/__tests__/doctor-ci-kubeconfig.test.ts';
const INIT_CI_SPEC = 'packages/kn-next/src/__tests__/ci-init-ci.test.ts';

const PROOF = {
  subjects: {
    preflightMjs: 'packages/kn-next-action/preflight.mjs',
    kubeconfigCheckMjs: 'packages/kn-next-action/kubeconfig-check.mjs',
    actionYml: 'packages/kn-next-action/action.yml',
    kubeconfigSafetyTs: 'packages/kn-next/src/cli/ci/kubeconfig-safety.ts',
    credentialScopeTs: 'packages/kn-next/src/cli/ci/credential-scope.ts',
    initCiTs: 'packages/kn-next/src/cli/ci/init-ci.ts',
    initCiCmdTs: 'packages/kn-next/src/cli/ci/init-ci-cmd.ts',
    pushSecretTs: 'packages/kn-next/src/cli/ci/push-kubeconfig-secret.ts',
    doctorCiKubeconfigTs: 'packages/kn-next/src/cli/doctor/checks/ci-kubeconfig.ts',
    doctorArgsTs: 'packages/kn-next/src/cli/doctor/args.ts',
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

/**
 * The parse-error leak, re-introduced: relay the parser's message AND let it
 * quote source (prettyErrors). Both halves, because the fix is two layers —
 * with prettyErrors off the message carries no excerpt, so relaying it alone
 * would not leak and the mutation would prove nothing.
 */
const LEAK_EDITS = [
  {
    anchor: '                reason: invalidYamlReason(err, kubeconfigYaml),',
    replacement:
      '                reason: `${invalidYamlReason(err, kubeconfigYaml)} ${(err as Error).message}`,',
  },
  {
    anchor: '    { merge: true, logLevel: "error", prettyErrors: false },',
    replacement: '    { merge: true, logLevel: "error", prettyErrors: true },',
  },
  {
    anchor: '    { merge: false, logLevel: "error", prettyErrors: false },',
    replacement: '    { merge: false, logLevel: "error", prettyErrors: true },',
  },
];

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
  {
    label: 'fail-open: a review with no status reads as "not allowed"',
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor: '    throw new Error(`the review of "${probe.label}" returned no status`);',
    replacement: '    return false;',
  },
  {
    label: 'fail-open: a non-boolean `allowed` (the string "true") is accepted as a verdict',
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor: "  if (typeof status.allowed !== 'boolean') {",
    replacement: '  if (false) {',
  },
  {
    label: 'fail-open: an evaluationError is ignored and `allowed: false` trusted',
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor:
      '    throw new Error(`the review of "${probe.label}" did not complete: ${status.evaluationError}`);',
    replacement: '    // evaluationError ignored',
  },
  {
    label: 'fail-open: a non-JSON reply reads as "not allowed"',
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor: '    throw new Error(`the review of "${probe.label}" did not return JSON`);',
    replacement: '    return false;',
  },
  {
    label: 'fail-open: a core without hazardProbes is not refused up front',
    subject: 'preflightMjs',
    spec: HAZARD_SPEC,
    anchor:
      "if (typeof classifyCredentialScope !== 'function' || typeof hazardProbes !== 'function') {",
    replacement: "if (typeof classifyCredentialScope !== 'function') {",
  },
  {
    label: 'probe derivation: the Role verbs are no longer asked in a FOREIGN namespace',
    subject: 'credentialScopeTs',
    spec: HAZARD_PROBES_SPEC,
    anchor: '                        namespace: foreign,\n',
    replacement: '                        namespace,\n',
  },
  {
    label:
      'probe derivation (end to end): Role verbs asked in the TARGET namespace, not a foreign one',
    subject: 'credentialScopeTs',
    spec: HAZARD_SPEC,
    anchor: '                        namespace: foreign,\n',
    replacement: '                        namespace,\n',
  },
  {
    label: 'probe derivation: nextapps verbs OUTSIDE the Role are no longer probed',
    subject: 'credentialScopeTs',
    spec: HAZARD_PROBES_SPEC,
    anchor: '                    if (roleVerbs.has(verb)) continue;',
    replacement: '                    continue;',
  },
  {
    label: 'escalation list: pods/exec is dropped from the probe set (same spec, end to end)',
    subject: 'credentialScopeTs',
    spec: HAZARD_SPEC,
    anchor: '            subresource: "exec",\n            verb: "create",',
    replacement: '            subresource: "exec",\n            verb: "get",',
  },

  // ── Guard 2: exec/auth-provider classifier — BOTH halves, independently ──
  {
    label: 'exec-plugin accepted: the `exec` key is dropped from the refused set',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    anchor: 'const CLOUD_AUTH_KEYS = new Set(["exec", "auth-provider", "authProvider"]);',
    replacement: 'const CLOUD_AUTH_KEYS = new Set(["auth-provider", "authProvider"]);',
  },
  {
    label: 'exec-plugin accepted: the `auth-provider` key is dropped from the refused set',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    anchor: 'const CLOUD_AUTH_KEYS = new Set(["exec", "auth-provider", "authProvider"]);',
    replacement: 'const CLOUD_AUTH_KEYS = new Set(["exec", "authProvider"]);',
  },
  {
    label:
      'merge-key bypass: no merge resolution AND the walk skips `<<` values (the round-1 bypass)',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    edits: [
      {
        anchor: '    { merge: true, logLevel: "error", prettyErrors: false },',
        replacement: '    { merge: false, logLevel: "error", prettyErrors: false },',
      },
      {
        anchor: '        if (reachesCloudAuthKey(v, seen)) return true;',
        replacement: '        if (k !== "<<" && reachesCloudAuthKey(v, seen)) return true;',
      },
    ],
  },
  {
    label: 'depth: the walk stops at the first level of a user entry',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    anchor: '        if (reachesCloudAuthKey(v, seen)) return true;',
    replacement:
      '        if (k === "user" && isRecord(v) && Object.keys(v).some((x) => CLOUD_AUTH_KEYS.has(x))) return true;\n        if (k !== "user" && reachesCloudAuthKey(v, seen)) return true;',
  },
  {
    label: 'alias cycle: the visited-set guard is removed (unbounded recursion)',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    anchor: '    if (seen.has(node)) return false;',
    replacement: '    // cycle guard removed',
  },
  {
    label: "exec-plugin accepted at the action's kubeconfig step: the verdict is never checked",
    subject: 'kubeconfigCheckMjs',
    spec: HAZARD_SPEC,
    anchor: 'if (!safety || safety.ok !== true) {',
    replacement: 'if (false) {',
  },
  {
    label: "the action's kubeconfig step passes when KUBECONFIG is unset",
    subject: 'kubeconfigCheckMjs',
    spec: HAZARD_SPEC,
    anchor:
      "  console.error('::error::No kubeconfig is configured (KUBECONFIG is unset). Refusing.');\n  process.exit(1);",
    replacement:
      "  console.error('::error::No kubeconfig is configured (KUBECONFIG is unset). Refusing.');\n  process.exit(0);",
  },
  {
    label: 'skip-credential-preflight reaches the kubeconfig step again',
    subject: 'actionYml',
    spec: HAZARD_SPEC,
    anchor: '        node "${{ github.action_path }}/kubeconfig-check.mjs"',
    replacement:
      '        if [ "${KNEXT_SKIP_PREFLIGHT:-}" = "true" ]; then exit 0; fi\n        node "${{ github.action_path }}/kubeconfig-check.mjs"',
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
    label: 'token printed: the classifier reason relays the parser message (classifier spec)',
    subject: 'kubeconfigSafetyTs',
    spec: KUBECONFIG_SAFETY_SPEC,
    edits: LEAK_EDITS,
  },
  {
    label: 'token printed: the parser message reaches init-ci --push-secret stderr (child process)',
    subject: 'kubeconfigSafetyTs',
    spec: PUSH_SECRET_CLI_SPEC,
    edits: LEAK_EDITS,
  },
  {
    label: 'token printed: the parser message reaches the doctor table and --json (child process)',
    subject: 'kubeconfigSafetyTs',
    spec: DOCTOR_CI_KUBECONFIG_SPEC,
    edits: LEAK_EDITS,
  },
  {
    label: "token printed: the parser message reaches the action's ::error:: line (child process)",
    subject: 'kubeconfigSafetyTs',
    spec: HAZARD_SPEC,
    edits: LEAK_EDITS,
  },
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

  // ── Guard 4: minors ─────────────────────────────────────────────────────
  {
    label: '`--ci-kubeconfig --json` consumes the flag as the path again',
    subject: 'doctorArgsTs',
    spec: DOCTOR_CI_KUBECONFIG_SPEC,
    anchor: '            if (value === undefined || value.startsWith("-")) {',
    replacement: '            if (value === undefined) {',
  },
  {
    label: 'the mint recipe writes an empty CA without warning',
    subject: 'initCiTs',
    spec: INIT_CI_SPEC,
    anchor: '        `[ -n "$CA_DATA" ] || echo "warning:',
    replacement: '        `[ -n "$CA_DATA" ] && echo "warning:',
  },
];

const DECLARED = 28;
declareMutations(DECLARED);

if (MUTATIONS.length !== DECLARED) {
  console.error(`FATAL: declared ${DECLARED} mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

const ALL_SPECS = [
  HAZARD_SPEC,
  KUBECONFIG_SAFETY_SPEC,
  HAZARD_PROBES_SPEC,
  PUSH_SECRET_CLI_SPEC,
  PUSH_SECRET_SPEC,
  DOCTOR_CI_KUBECONFIG_SPEC,
  INIT_CI_SPEC,
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
    for (const e of m.edits ?? [{ anchor: m.anchor, replacement: m.replacement }]) {
      mutate(snap, e.anchor, e.replacement);
    }
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
