#!/usr/bin/env node
/**
 * Mutation proof for the composite-action script-injection guard (#2531).
 *
 * `.claude/rules/workflow.md`: "a guard that stays green when its subject is
 * removed is decoration." One guard, `tests/action-script-injection.test.ts`.
 * Each mutation removes ONE protection and REQUIRES it to go red. Three kinds:
 *
 *   A*  the ACTIONS: re-add a `${{ inputs.* }}` / `${{ github.head_ref }}` /
 *       `${{ secrets.* }}` inside a `run:` body, in the published action, the
 *       legacy root action, and the local composite under `.github/actions`
 *       (the last proves discovery reaches it);
 *   V*  the VALIDATION and the PIN: neuter the tag / bucket / version allowlist,
 *       or let the CLI float to `latest`, or let the two pins drift;
 *   E*  an ERROR MESSAGE echoes an input again (a newline in it forges workflow
 *       commands);
 *   W*  WORKFLOWS: `github.base_ref` interpolated into a `ci.yml` script again,
 *       and each piece of the workflow denylist, its discovery and its fail-closed
 *       branch removed;
 *   S*  the SCAN itself: stop treating an expression as untrusted, stop reading
 *       `with.script`, swallow an unparseable file, or stop discovering a file.
 *
 * The shared driver (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts
 * by EXIT CODE only, every anchor occurs exactly once (checked up front), the
 * baseline must be green, a canary must go red before any green is trusted, and
 * every restore is content-verified. Commit the work FIRST: the tree must be clean.
 *
 * Usage:  node scripts/mutation-prove-2531-action-script-injection.mjs
 * Exit 0 = every row behaved as required; 1 = one did not or the run was partial.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  // ── A: re-add an interpolation to a run: body ──────────────────────────────
  {
    id: 'A1',
    subject: 'kna',
    claim: 'published action: the tag is interpolated into the deploy script again',
    anchor: 'if [ -n "$KNEXT_TAG" ]; then DEPLOY_ARGS+=(--tag "$KNEXT_TAG"); fi',
    replacement: 'if [ -n "${{ inputs.tag }}" ]; then DEPLOY_ARGS+=(--tag "${{ inputs.tag }}"); fi',
  },
  {
    id: 'A2',
    subject: 'kna',
    claim: 'published action: the bucket is interpolated into the deploy script again',
    anchor: 'if [ -n "$KNEXT_BUCKET" ]; then DEPLOY_ARGS+=(--bucket "$KNEXT_BUCKET"); fi',
    replacement:
      'if [ -n "${{ inputs.bucket }}" ]; then DEPLOY_ARGS+=(--bucket "${{ inputs.bucket }}"); fi',
  },
  {
    id: 'A3',
    subject: 'kna',
    claim: 'published action: the `= "true"` comparison for doctor is interpolated again',
    anchor: 'if [ "$KNEXT_DOCTOR" = "true" ]; then',
    replacement: 'if [ "${{ inputs.doctor }}" = "true" ]; then',
  },
  {
    id: 'A4',
    subject: 'kna',
    claim: 'published action: the dry-run comparison is interpolated again',
    anchor: 'if [ "$KNEXT_DRY_RUN" = "true" ]; then DEPLOY_ARGS+=(--dry-run); fi',
    replacement: 'if [ "${{ inputs.dry-run }}" = "true" ]; then DEPLOY_ARGS+=(--dry-run); fi',
  },
  {
    id: 'A5',
    subject: 'kna',
    claim: 'published action: an untrusted event field reaches a different step (not just Deploy)',
    anchor: 'node "${{ github.action_path }}/kubeconfig-check.mjs"',
    replacement: 'node "${{ github.action_path }}/kubeconfig-check.mjs" ${{ github.head_ref }}',
  },
  {
    id: 'A6',
    subject: 'root',
    claim: 'legacy root action: the tag is interpolated again',
    anchor: '[ -n "$KNEXT_TAG" ]       && args+=( --tag       "$KNEXT_TAG" )',
    replacement: '[ -n "${{ inputs.tag }}" ]       && args+=( --tag       "${{ inputs.tag }}" )',
  },
  {
    id: 'A7',
    subject: 'root',
    claim: 'legacy root action: the registry is interpolated again',
    anchor: '[ -n "$KNEXT_REGISTRY" ]  && args+=( --registry  "$KNEXT_REGISTRY" )',
    replacement:
      '[ -n "${{ inputs.registry }}" ]  && args+=( --registry  "${{ inputs.registry }}" )',
  },
  {
    id: 'A8',
    subject: 'root',
    claim:
      'legacy root action: the dry-run comparison that guards the output is interpolated again',
    anchor: 'if [ "$KNEXT_DRY_RUN" = "true" ]; then\n          echo "url="',
    replacement: 'if [ "${{ inputs.dry-run }}" = "true" ]; then\n          echo "url="',
  },
  {
    id: 'A9',
    subject: 'root',
    claim: 'legacy root action: a secrets expression comes back inside an error message',
    anchor: 'e.g. secrets.KUBECONFIG_B64."',
    replacement: 'e.g. \\${{ secrets.KUBECONFIG_B64 }}."',
  },
  {
    id: 'A10',
    subject: 'mirror',
    claim: 'the local composite under .github/actions is scanned too (discovery reaches it)',
    anchor: 'sudo systemctl restart docker',
    replacement: 'sudo systemctl restart docker ${{ github.head_ref }}',
  },

  // ── V: validation and the pin ──────────────────────────────────────────────
  {
    id: 'V1',
    subject: 'kna',
    claim: 'published action: the tag allowlist accepts anything',
    anchor: "tag_re='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'",
    replacement: "tag_re='.*'",
  },
  {
    id: 'V2',
    subject: 'kna',
    claim: 'published action: the bucket allowlist accepts anything',
    anchor: "bucket_re='^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$'",
    replacement: "bucket_re='.*'",
  },
  {
    id: 'V3',
    subject: 'root',
    claim: 'legacy root action: the tag allowlist accepts anything',
    anchor: "tag_re='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'",
    replacement: "tag_re='.*'",
  },
  {
    id: 'V4',
    subject: 'root',
    claim: 'legacy root action: the bucket allowlist accepts anything',
    anchor: "bucket_re='^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$'",
    replacement: "bucket_re='.*'",
  },
  {
    id: 'V5',
    subject: 'kna',
    claim: 'published action: the cli-version check accepts a range or a dist-tag',
    anchor: "version_re='^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'",
    replacement: "version_re='.*'",
  },
  {
    id: 'V6',
    subject: 'kna',
    claim: 'published action: the default cli-version floats to latest',
    anchor: "default: '1.3.1'",
    replacement: "default: 'latest'",
  },
  {
    id: 'V7',
    subject: 'kna',
    claim: 'published action: the default CLI runs the package with no version at all',
    anchor: 'CLI=(npx --yes "@getknext/core@$KNEXT_CLI_VERSION")',
    replacement: 'CLI=(npx --yes @getknext/core)',
  },
  {
    id: 'V8',
    subject: 'root',
    claim: 'legacy root action: the doctor step runs an unpinned package',
    anchor:
      'KNEXT_CLI_PACKAGE: \'@getknext/core@1.3.1\'\n      run: |\n        set -euo pipefail\n        npx --yes "$KNEXT_CLI_PACKAGE" doctor',
    replacement:
      'KNEXT_CLI_PACKAGE: \'@getknext/core\'\n      run: |\n        set -euo pipefail\n        npx --yes "$KNEXT_CLI_PACKAGE" doctor',
  },
  {
    id: 'V9',
    subject: 'root',
    claim: 'the legacy root pin drifts from the published action pin',
    anchor: "KNEXT_CLI_PACKAGE: '@getknext/core@1.3.1'\n        KNEXT_REGISTRY",
    replacement: "KNEXT_CLI_PACKAGE: '@getknext/core@1.3.0'\n        KNEXT_REGISTRY",
  },

  // ── S: the scan itself ─────────────────────────────────────────────────────
  {
    id: 'S1',
    subject: 'scan',
    claim: 'every expression is treated as runner-controlled: nothing is ever flagged',
    anchor: 'return RUNNER_CONTROLLED.some((re) => re.test(expression));',
    replacement: 'return true;',
  },
  {
    id: 'S2',
    subject: 'scan',
    claim: 'the allowlist widens to all of the github context (github.event, github.head_ref)',
    anchor: '  /^github\\.workspace$/,',
    replacement: '  /^github\\./,',
  },
  {
    id: 'S3',
    subject: 'scan',
    claim: 'the scan only recognises inputs.* — other untrusted contexts pass',
    anchor: 'return [...body.matchAll(/\\$\\{\\{([\\s\\S]*?)\\}\\}/g)]',
    replacement: 'return [...body.matchAll(/\\$\\{\\{\\s*(inputs\\.[\\s\\S]*?)\\}\\}/g)]',
  },
  {
    id: 'S4',
    subject: 'scan',
    claim: 'a github-script `script:` body is no longer scanned',
    anchor:
      "if (typeof step?.with?.script === 'string') bodies.push(['with.script', step.with.script]);",
    replacement: '',
  },
  {
    id: 'S5',
    subject: 'scan',
    claim: 'a `run:` body is no longer scanned',
    anchor: "if (typeof step?.run === 'string') bodies.push(['run', step.run]);",
    replacement: '',
  },
  {
    id: 'S6',
    subject: 'scan',
    claim: 'a file that is not parseable YAML passes silently',
    anchor:
      'throw new Error(`${file}: not parseable YAML, so it cannot be scanned: ${e.message}`);',
    replacement: 'return [];',
  },
  {
    id: 'S7',
    subject: 'scan',
    claim: 'a composite whose steps are not a list passes silently',
    anchor:
      'throw new Error(`${file}: composite action whose runs.steps is not a list; cannot be scanned`);',
    replacement: 'return [];',
  },
  {
    id: 'S8',
    subject: 'scan',
    claim: 'discovery stops reaching actions outside the two published ones',
    anchor: '} else if (e.isFile() && /^action\\.ya?ml$/.test(e.name)) {',
    replacement:
      "} else if (e.isFile() && /^action\\.ya?ml$/.test(e.name) && !rel.startsWith('.github')) {",
  },

  // ── E: an error message echoes an input (newline forges workflow commands) ──
  {
    id: 'E1',
    subject: 'kna',
    claim: "the 'cli' error message echoes the raw input again",
    anchor: 'was not found on PATH."',
    replacement: 'was not found on PATH. cli=\\"$KNEXT_CLI\\""',
  },
  {
    id: 'E2',
    subject: 'kna',
    claim: "the unknown 'auth' error message echoes the raw input again",
    anchor: 'unknown auth mode (expected: kubeconfig)',
    replacement: "unknown auth mode '$KNEXT_AUTH' (expected: kubeconfig)",
  },

  // ── W: workflows ───────────────────────────────────────────────────────────
  {
    id: 'W1',
    subject: 'ci',
    claim: 'ci.yml interpolates github.base_ref into the docs-reminder script again (1st step)',
    anchor: 'git fetch --no-tags --depth=1 origin "$BASE_REF" || true\n          CHANGED=',
    replacement:
      'git fetch --no-tags --depth=1 origin "${{ github.base_ref }}" || true\n          CHANGED=',
  },
  {
    id: 'W2',
    subject: 'ci',
    claim:
      'ci.yml interpolates github.base_ref into the internal-reference script again (2nd step)',
    anchor: 'git fetch --no-tags --depth=1 origin "$BASE_REF" || true\n          # Only scan',
    replacement:
      'git fetch --no-tags --depth=1 origin "${{ github.base_ref }}" || true\n          # Only scan',
  },
  {
    id: 'W3',
    subject: 'scan',
    claim: 'the workflow denylist stops matching inputs',
    anchor: 'inputs\\s*[.[]|',
    replacement: '',
  },
  {
    id: 'W4',
    subject: 'scan',
    claim: 'the workflow denylist stops matching github.event payload fields',
    anchor: 'github\\.event\\b(?!_)|',
    replacement: '',
  },
  {
    id: 'W5',
    subject: 'scan',
    claim: 'the workflow denylist stops matching github.head_ref',
    anchor: 'github\\.head_ref\\b|',
    replacement: '',
  },
  {
    id: 'W6',
    subject: 'scan',
    claim: 'the workflow denylist stops matching github.base_ref',
    anchor: 'github\\.base_ref\\b|',
    replacement: '',
  },
  {
    id: 'W7',
    subject: 'scan',
    claim: 'the workflow denylist stops matching github.ref_name',
    anchor: 'github\\.ref_name\\b|',
    replacement: '',
  },
  {
    id: 'W8',
    subject: 'scan',
    claim: 'the workflow scan reports nothing at all',
    anchor: 'if (!WORKFLOW_UNTRUSTED.test(expression)) continue;',
    replacement: 'continue;',
  },
  {
    id: 'W9',
    subject: 'scan',
    claim: 'workflow discovery stops reaching all but one workflow',
    anchor: 'e.isFile() && /\\.ya?ml$/.test(e.name)',
    replacement: "e.isFile() && e.name === 'ci.yml'",
  },
  {
    id: 'W10',
    subject: 'scan',
    claim: 'a workflow job whose steps are not a list passes silently',
    anchor:
      'throw new Error(`${file}: job ${jobId} has steps that are not a list; cannot be scanned`);',
    replacement: 'continue;',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/action-script-injection.test.ts',
  subjects: {
    kna: 'packages/kn-next-action/action.yml',
    root: 'action.yml',
    mirror: '.github/actions/docker-hub-mirror/action.yml',
    scan: 'scripts/lib/action-script-injection-scan.mjs',
    ci: '.github/workflows/ci.yml',
  },
});

console.log('=== mutation proof: composite-action script injection ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'kna',
  anchor: 'if [ -n "$KNEXT_TAG" ]; then DEPLOY_ARGS+=(--tag "$KNEXT_TAG"); fi',
  replacement: 'if [ -n "${{ inputs.tag }}" ]; then DEPLOY_ARGS+=(--tag "${{ inputs.tag }}"); fi',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
