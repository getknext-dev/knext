#!/usr/bin/env node
/**
 * Mutation prover for #2249 (agent half) and #2381: every long-lived release
 * line gets post-merge CI and enforce-grade Trivy, and the critical jobs are
 * not skipped there.
 *
 * The guard is `tests/integration-line-ci-triggers.test.ts`. Each row below
 * plants one regression in `ci.yml` or `supply-chain.yml` and requires the
 * guard to go RED, by exit code:
 *
 *   T1  ci.yml's push trigger narrowed back to `[main]`.
 *   T2  supply-chain.yml's push trigger narrowed back to `[main]`.
 *   T3  today's lines listed by name instead of a glob (the synthetic
 *       `integration/v3` must still be covered before it exists).
 *   T4  ci.yml's `push` trigger removed outright.
 *   T5  a `paths` filter added to the push trigger (a run that can be skipped).
 *   T6  `branches-ignore` excluding the integration lines.
 *   T7  ci.yml's docs-closure Trivy step reverted to main-only enforcement.
 *   T8  supply-chain.yml's file-manager Trivy step reverted to main-only.
 *   T9  supply-chain.yml's built-image Trivy step reverted to main-only.
 *   T10 a Trivy gate rewritten into an expression outside the modelled grammar
 *       (the evaluator must throw, not guess).
 *   T11 ci.yml made unparseable YAML (the read must throw, not skip).
 *   J1  a job-level `if:` that skips Lint & Test on integration pushes (#2381).
 *   J2  a job-level `if:` that skips the root Typecheck on integration pushes.
 *   J3  a job-level `if:` that skips the supply-chain image scan on pushes
 *       that are not to main.
 *   J4  Lint & Test made to `needs:` a PR-only job, so it is skipped
 *       transitively on every push.
 *   N1  negative control: a job-level `if:` that still RUNS on every push. The
 *       guard must stay GREEN, or J1–J3 would be reds for "any `if:` at all".
 *
 * Every mutated subject except T11's is checked to still PARSE as YAML before
 * it is graded, and T11's is checked to NOT parse, so each red is a red for the
 * reason its row claims.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-2249-integration-line-ci.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/integration-line-ci-triggers.test.ts';
const CI = '.github/workflows/ci.yml';
const SUPPLY_CHAIN = '.github/workflows/supply-chain.yml';

/** A mutated workflow must still be YAML, or its red is a red for the wrong reason. */
const parses = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `workflow is not valid YAML: ${err.message}`;
  }
};
/** T11's whole point is a parse error; if it still parses, the row proves nothing. */
const doesNotParse = (text) => (parses(text) ? undefined : 'the mutated workflow still parses');

const PUSH_LINE = "    branches: [main, 'integration/**']";
const ENFORCE =
  "continue-on-error: ${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/integration/') }}";
const MAIN_ONLY = "continue-on-error: ${{ github.ref != 'refs/heads/main' }}";

const MUTATIONS = [
  {
    id: 'T1',
    claim: 'ci.yml push trigger narrowed to [main]',
    subject: 'ci',
    anchor: `  push:\n${PUSH_LINE}\n`,
    replacement: '  push:\n    branches: [main]\n',
  },
  {
    id: 'T2',
    claim: 'supply-chain.yml push trigger narrowed to [main]',
    subject: 'sc',
    anchor: `  push:\n${PUSH_LINE}\n`,
    replacement: '  push:\n    branches: [main]\n',
  },
  {
    id: 'T3',
    claim: "today's integration lines listed by name (the next line is not covered)",
    subject: 'ci',
    anchor: `  push:\n${PUSH_LINE}\n`,
    replacement: '  push:\n    branches: [main, integration/v1.3, integration/v2]\n',
  },
  {
    id: 'T4',
    claim: 'ci.yml push trigger removed',
    subject: 'ci',
    anchor: `  push:\n${PUSH_LINE}\n`,
    replacement: `  # ${MUTATION_MARKER}: push trigger removed\n`,
  },
  {
    id: 'T5',
    claim: 'a paths filter added to the push trigger',
    subject: 'ci',
    anchor: `  push:\n${PUSH_LINE}\n`,
    replacement: `  push:\n${PUSH_LINE}\n    paths: ['packages/**']\n`,
  },
  {
    id: 'T6',
    claim: 'branches-ignore excludes the integration lines',
    subject: 'sc',
    anchor: `  push:\n${PUSH_LINE}\n`,
    replacement: "  push:\n    branches-ignore: ['integration/**']\n",
  },
  {
    id: 'T7',
    claim: 'ci.yml docs-closure Trivy step reverted to main-only enforcement',
    subject: 'ci',
    anchor: ENFORCE,
    replacement: MAIN_ONLY,
  },
  {
    id: 'T8',
    claim: 'supply-chain.yml file-manager Trivy step reverted to main-only enforcement',
    subject: 'sc',
    anchor: `base-image CVE can't block an unrelated PR, while every line stays gated.\n        ${ENFORCE}`,
    replacement: `base-image CVE can't block an unrelated PR, while every line stays gated.\n        ${MAIN_ONLY} # ${MUTATION_MARKER}`,
  },
  {
    id: 'T9',
    claim: 'supply-chain.yml built-image Trivy step reverted to main-only enforcement',
    subject: 'sc',
    anchor: `rollout as the file-manager built-image gate.\n        ${ENFORCE}`,
    replacement: `rollout as the file-manager built-image gate.\n        ${MAIN_ONLY} # ${MUTATION_MARKER}`,
  },
  {
    id: 'T10',
    claim: 'a Trivy gate expression outside the modelled grammar (must throw, not guess)',
    subject: 'ci',
    anchor: ENFORCE,
    replacement:
      "continue-on-error: ${{ github.ref != 'refs/heads/main' && !contains(github.ref, 'refs/heads/integration/') }}",
  },
  {
    id: 'T11',
    claim: 'ci.yml is unparseable YAML (the read must throw, not skip)',
    subject: 'ci',
    anchor: `  push:\n${PUSH_LINE}\n`,
    replacement: "  push:\n    branches: [main, 'integration/**'\n",
    validate: doesNotParse,
  },
  {
    id: 'J1',
    claim: 'a job-level if: skips Lint & Test on integration pushes',
    subject: 'ci',
    anchor: '  lint-and-test:\n    name: Lint & Test\n',
    replacement:
      "  lint-and-test:\n    name: Lint & Test\n    if: github.event_name != 'push' || github.ref == 'refs/heads/main'\n",
  },
  {
    id: 'J2',
    claim: 'a job-level if: skips the root Typecheck on integration pushes',
    subject: 'ci',
    anchor: '  typecheck-root:\n    name: Typecheck (root tests/)\n',
    replacement:
      "  typecheck-root:\n    name: Typecheck (root tests/)\n    if: ${{ !startsWith(github.ref, 'refs/heads/integration/') }}\n",
  },
  {
    id: 'J3',
    claim: 'a job-level if: skips the supply-chain image scan on non-main pushes',
    subject: 'sc',
    anchor: '  image-supply-chain:\n    name: SBOM + Trivy (+ cosign sign on main)\n',
    replacement:
      "  image-supply-chain:\n    name: SBOM + Trivy (+ cosign sign on main)\n    if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'\n",
  },
  {
    id: 'J4',
    claim: 'Lint & Test needs a PR-only job, so it is skipped transitively on push',
    subject: 'ci',
    anchor: '  lint-and-test:\n    name: Lint & Test\n',
    replacement: '  lint-and-test:\n    name: Lint & Test\n    needs: [docs-drift-reminder]\n',
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'a job-level if: that still runs Lint & Test on every push',
    subject: 'ci',
    anchor: '  lint-and-test:\n    name: Lint & Test\n',
    replacement:
      "  lint-and-test:\n    name: Lint & Test\n    if: github.event_name != 'merge_group' || github.ref == 'refs/heads/main'\n",
  },
].map((m) => ({ expect: 'red', validate: parses, ...m }));

// A real mutation of a real subject, distinct from every row, so it also
// proves the runner reads the workflow under proof.
const CANARY = {
  subject: 'sc',
  anchor: '  built-image-trivy:\n    name: Trivy — shipped images (BUILT, enforce on main)\n',
  replacement:
    "  built-image-trivy:\n    name: Trivy — shipped images (BUILT, enforce on main)\n    if: github.event_name == 'pull_request'\n",
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { ci: CI, sc: SUPPLY_CHAIN },
});

console.log(
  '=== mutation proof: release-line CI triggers, Trivy enforcement, job skips (#2249, #2381) ===',
);
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
