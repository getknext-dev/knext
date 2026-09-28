#!/usr/bin/env node
/**
 * Mutation proof for #1534 (`knext init-ci --provider gitlab`) — the GitLab
 * CI/CD template and the two CLI verbs it drives through
 * (`doctor --ci-kubeconfig`, `ci-preflight`).
 *
 * Guards proved, matching the shape of `mutation-prove-1533-kubeconfig-ci-secret.mjs`:
 *
 *   1. STRUCTURE: a preflight job removed (renamed out from under the
 *      pipeline), `allow_failure` added to a preflight job, and the
 *      ordering guarantee (`credential-preflight` depending on
 *      `kubeconfig-check`) removed — each must red the structural/hermetic
 *      test (`ci-init-ci-gitlab.test.ts`).
 *   2. TOKEN NEVER ARGV: `push-kubeconfig-secret-gitlab.ts` moving the
 *      kubeconfig from `glab`'s stdin to its argv must red the real
 *      subprocess proof (`init-ci-push-secret-gitlab-cli.test.ts`).
 *   3. REFUSALS DISARMED: the exec-plugin classifier and the `glab`
 *      availability check in `push-kubeconfig-secret-gitlab.ts`, and the
 *      kubeconfig-safety / credential-scope / hazard-spot-check gates in
 *      `ci-preflight.ts`, must each red their owning spec when removed.
 *
 * Shared harness (`mutation-harness.mjs`, `prover-report.mjs`): anchors must
 * occur exactly once and abort otherwise; restoration is content-addressed;
 * judged on EXIT CODES only.
 *
 * Usage: node scripts/mutation-prove-1534-gitlab-template.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GITLAB_TEMPLATE_SPEC = 'packages/kn-next/src/__tests__/ci-init-ci-gitlab.test.ts';
const PUSH_SECRET_GITLAB_SPEC =
  'packages/kn-next/src/__tests__/push-kubeconfig-secret-gitlab.test.ts';
const PUSH_SECRET_GITLAB_CLI_SPEC =
  'packages/kn-next/src/__tests__/init-ci-push-secret-gitlab-cli.test.ts';
const CI_PREFLIGHT_SPEC = 'packages/kn-next/src/__tests__/ci-preflight.test.ts';
const INIT_CI_CMD_GITLAB_SPEC = 'packages/kn-next/src/__tests__/init-ci-cmd-gitlab.test.ts';

const PROOF = {
  subjects: {
    initCiGitlabTs: 'packages/kn-next/src/cli/ci/init-ci-gitlab.ts',
    pushSecretGitlabTs: 'packages/kn-next/src/cli/ci/push-kubeconfig-secret-gitlab.ts',
    ciPreflightTs: 'packages/kn-next/src/cli/ci/ci-preflight.ts',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses(spec) {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  // ── Guard 1: a preflight job removed from the pipeline ──────────────────
  {
    label:
      'the credential-preflight job is renamed out from under the pipeline (a job silently removed)',
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor:
      'credential-preflight:\n  stage: preflight\n  image: node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32\n  needs:\n    - kubeconfig-check\n',
    replacement:
      'xcredential-preflight:\n  stage: preflight\n  image: node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32\n  needs:\n    - kubeconfig-check\n',
  },

  // ── Guard 2: allow_failure added to a preflight job (made skippable) ────
  {
    label:
      'credential-preflight gains allow_failure: true — a hazard finding no longer blocks deploy',
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor:
      'credential-preflight:\n  stage: preflight\n  image: node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32\n  needs:\n    - kubeconfig-check\n',
    replacement:
      'credential-preflight:\n  stage: preflight\n  image: node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32\n  allow_failure: true\n  needs:\n    - kubeconfig-check\n',
  },

  // ── Guard 3: the ordering guarantee is removed (order swapped/dropped) ──
  {
    label:
      "credential-preflight no longer needs kubeconfig-check — the exec-plugin refusal is not guaranteed to run before this job's first kubectl call",
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor: '  needs:\n    - kubeconfig-check\n  rules:',
    replacement: '  rules:',
  },
  {
    label:
      'deploy no longer needs credential-preflight — a refused credential does not stop the deploy job',
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor: '  needs:\n    - kubeconfig-check\n    - credential-preflight\n  rules:',
    replacement: '  needs:\n    - kubeconfig-check\n  rules:',
  },

  // ── Guard 4: the token moves from glab's stdin to its argv ──────────────
  {
    label: "the kubeconfig moves from glab's stdin to its argv (ps-visible on a shared runner)",
    subject: 'pushSecretGitlabTs',
    spec: PUSH_SECRET_GITLAB_CLI_SPEC,
    anchor:
      '        ["variable", "set", secretName, "--masked", "--protected"],\n        encoded,\n    );',
    replacement:
      '        ["variable", "set", secretName, "--masked", "--protected", encoded],\n        "",\n    );',
  },

  // ── Guard 5: the two refusals in push-kubeconfig-secret-gitlab.ts ───────
  {
    label:
      'push-secret-gitlab: the exec-plugin classifier is disarmed — a cloud-credential kubeconfig is pushed',
    subject: 'pushSecretGitlabTs',
    spec: PUSH_SECRET_GITLAB_SPEC,
    anchor: '    if (!verdict.ok) {',
    replacement: '    if (false) {',
  },
  {
    label: 'push-secret-gitlab: the glab-availability check is disarmed — always tries to run glab',
    subject: 'pushSecretGitlabTs',
    spec: PUSH_SECRET_GITLAB_SPEC,
    anchor: '    if (!available()) {',
    replacement: '    if (false) {',
  },

  // ── Guard 6: ci-preflight.ts — the three gates it orchestrates ──────────
  {
    label:
      'ci-preflight: the kubeconfig-safety refusal is disarmed — an exec-plugin kubeconfig passes',
    subject: 'ciPreflightTs',
    spec: CI_PREFLIGHT_SPEC,
    anchor: '    if (!safety.ok) {',
    replacement: '    if (false) {',
  },
  {
    label: 'ci-preflight: the credential-scope refusal is disarmed — an over-broad Role passes',
    subject: 'ciPreflightTs',
    spec: CI_PREFLIGHT_SPEC,
    anchor: '    if (!scope.ok) {',
    replacement: '    if (false) {',
  },
  {
    label:
      'ci-preflight: the hazard spot-check refusal is disarmed — a granted hazard probe passes',
    subject: 'ciPreflightTs',
    spec: CI_PREFLIGHT_SPEC,
    anchor: '    if (hazardsFound.length > 0) {',
    replacement: '    if (false) {',
  },

  // ── Guard 7 (#1588 round 3, finding 1): docker-cli-buildx removed ───────
  {
    label:
      'the deploy job drops docker-cli-buildx — `docker buildx build` has no plugin to run, even though `docker-cli` alone still installs',
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor: 'apk add --no-cache docker-cli docker-cli-buildx curl bash',
    replacement: 'apk add --no-cache docker-cli curl bash',
  },

  // ── Guard 8 (#1588 round 3, finding 2): kubectl sha256 fetched again ────
  {
    label:
      'the embedded kubectl sha256 check reverts to a second curl download from dl.k8s.io — TOFU against a substituted binary is reopened',
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor: 'echo "${KUBECTL_SHA256_LINUX_AMD64}  kubectl" | sha256sum -c -',
    replacement:
      'curl -fsSLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256"\n      echo "$(cat kubectl.sha256)  kubectl" | sha256sum -c -',
  },

  // ── Guard 9 (#1588 round 3, finding 3): dind service loses its digest pin ─
  {
    label:
      'the dind service reverts to a bare mutable tag — the privileged docker-in-docker service holding the registry token and kubeconfig is no longer digest-pinned',
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor: '- docker:27.3.1-dind@${DIND_DIGEST}',
    replacement: '- docker:27.3.1-dind',
  },

  // ── Guard 10 (#1588 round 4, finding 1): the deploy job never installs bun ─
  {
    label:
      "the deploy job drops the bun install step — the default (bun) runtime's `kn-next deploy` shells out to `bun run …` and node:22-alpine has no bun at all",
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor: '    - *knext_kubectl_install\n    - *knext_bun_install\n',
    replacement: '    - *knext_kubectl_install\n',
  },

  // ── Guard 11 (#1588 round 4 review, blocker): the bun sha256 VALUE is unpinned ──
  {
    label:
      'the embedded BUN_SHA256_LINUX_X64_MUSL is replaced with a wrong-but-well-formed sha256 — the shape check alone cannot tell a wrong hash from the real one, so a Bun version bump without its matching hash would ship a template whose sha256sum -c fails on every user\'s deploy',
    subject: 'initCiGitlabTs',
    spec: GITLAB_TEMPLATE_SPEC,
    anchor:
      'const BUN_SHA256_LINUX_X64_MUSL =\n    "4835eca59d6da70f4674f5642f6e459dcadab773695b2ed9922d131057989742";',
    replacement:
      'const BUN_SHA256_LINUX_X64_MUSL =\n    "0000000000000000000000000000000000000000000000000000000000000000";',
  },
];

const DECLARED = 15;
declareMutations(DECLARED);

if (MUTATIONS.length !== DECLARED) {
  console.error(`FATAL: declared ${DECLARED} mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

const ALL_SPECS = [
  GITLAB_TEMPLATE_SPEC,
  PUSH_SECRET_GITLAB_SPEC,
  PUSH_SECRET_GITLAB_CLI_SPEC,
  CI_PREFLIGHT_SPEC,
  INIT_CI_CMD_GITLAB_SPEC,
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
