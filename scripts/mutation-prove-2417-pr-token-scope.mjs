#!/usr/bin/env node
/**
 * Mutation prover for #2417: no job a pull request (or the merge queue) can run
 * holds a registry-write, OIDC or attestation credential.
 *
 * The guard is `tests/workflow-pr-token-scope.test.ts` over
 * `scripts/lib/workflow-token-scope.mjs`. Each row plants one regression and
 * requires the guard to go RED, by exit code:
 *
 *   W1  the read-only build/scan job of supply-chain.yml regains `packages: write`.
 *   W2  ... regains `id-token: write`.
 *   W3  the operator build/scan job regains `packages: write`.
 *   W4  ... regains `id-token: write`.
 *   W5  a workflow-level `permissions:` block with `id-token: write` lands on an
 *       unrelated PR-triggered workflow (the scan covers EVERY workflow).
 *   P1  supply-chain.yml's publish job loses its PR exclusion outright.
 *   P2  ... is excluded only by `!= 'pull_request'`, which admits merge_group.
 *   P3  ... is `main-only OR scan-succeeded`, so the right-hand side admits a PR.
 *   P4  the operator publish job loses its PR exclusion outright.
 *   P5  the operator publish job drops the scan job's `ready` requirement.
 *   P6  supply-chain.yml's publish job stops `needs`-ing the scan job.
 *   P7  the operator publish job stops `needs`-ing the scan job.
 *   D1  supply-chain.yml's publish job stops downloading the scanned layout.
 *   D2  ... stops comparing its digest to the one the scan job recorded.
 *   D3  the operator publish job stops comparing digests.
 *   D4  the build/scan job stops exporting the layout digest.
 *   L1  a registry login step is added to the read-only job.
 *   A1  the analyzer treats `event_name == 'merge_group'` as excluding PRs.
 *   A2  the analyzer's forbidden-grant list forgets `id-token`.
 *   N1  negative control: renaming the publish job's display name. The guard
 *       must stay GREEN, or the rows above would be reds for "any edit".
 *   N2  negative control: the publish job's `if:` conjuncts reordered. The
 *       evaluator must not depend on operand order.
 *
 * Every mutated YAML subject is checked to still PARSE before it is graded, so
 * each red is a red for the reason its row claims.
 *
 * Runs on the shared driver (`lib/guard-prover.mjs`): exit codes only, anchors
 * exactly once (preflight), green baseline, a canary red first, tree checked
 * clean between rows, partial run = failure.
 *
 *   node scripts/mutation-prove-2417-pr-token-scope.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/workflow-pr-token-scope.test.ts';

const parses = (text) => {
  try {
    parse(text);
    return undefined;
  } catch (err) {
    return `workflow is not valid YAML: ${err.message}`;
  }
};

const SC_BUILD_PERMS = '      contents: read\n    outputs:\n';
const OP_BUILD_PERMS = '      contents: read\n    outputs:\n';

const SC_IF =
  "    if: >-\n      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&\n      github.ref == 'refs/heads/main'";
const OP_NEEDS_IF =
  "    needs: [operator-image-supply-chain]\n    if: >-\n      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&\n      needs.operator-image-supply-chain.outputs.ready == 'true'";

const MUTATIONS = [
  {
    id: 'W1',
    claim: 'supply-chain.yml build/scan job regains packages: write',
    subject: 'sc',
    anchor: SC_BUILD_PERMS,
    replacement: '      contents: read\n      packages: write\n    outputs:\n',
  },
  {
    id: 'W2',
    claim: 'supply-chain.yml build/scan job regains id-token: write',
    subject: 'sc',
    anchor: SC_BUILD_PERMS,
    replacement: '      contents: read\n      id-token: write\n    outputs:\n',
  },
  {
    id: 'W3',
    claim: 'operator build/scan job regains packages: write',
    subject: 'op',
    anchor: OP_BUILD_PERMS,
    replacement: '      contents: read\n      packages: write\n    outputs:\n',
  },
  {
    id: 'W4',
    claim: 'operator build/scan job regains id-token: write',
    subject: 'op',
    anchor: OP_BUILD_PERMS,
    replacement: '      contents: read\n      id-token: write\n    outputs:\n',
  },
  {
    id: 'W5',
    claim: 'an unrelated PR-triggered workflow gains a workflow-level id-token: write',
    subject: 'other',
    anchor: '    branches: [main]\n\njobs:\n  resolve:\n',
    replacement: '    branches: [main]\n\npermissions:\n  id-token: write\n\njobs:\n  resolve:\n',
  },
  {
    id: 'P1',
    claim: 'supply-chain.yml publish job loses its PR exclusion',
    subject: 'sc',
    anchor: SC_IF,
    replacement: "    if: needs.image-supply-chain.result == 'success'",
  },
  {
    id: 'P2',
    claim:
      "supply-chain.yml publish job is excluded only by != 'pull_request' (admits merge_group)",
    subject: 'sc',
    anchor: SC_IF,
    replacement: "    if: github.event_name != 'pull_request'",
  },
  {
    id: 'P3',
    claim:
      'supply-chain.yml publish job is main-only OR scan-succeeded (the right side admits a PR)',
    subject: 'sc',
    anchor: SC_IF,
    replacement:
      "    if: github.ref == 'refs/heads/main' || needs.image-supply-chain.result == 'success'",
  },
  {
    id: 'P4',
    claim: 'operator publish job loses its PR exclusion',
    subject: 'op',
    anchor: OP_NEEDS_IF,
    replacement:
      "    needs: [operator-image-supply-chain]\n    if: needs.operator-image-supply-chain.outputs.ready == 'true'",
  },
  {
    id: 'P5',
    claim: "operator publish job drops the scan job's ready requirement",
    subject: 'op',
    anchor: OP_NEEDS_IF,
    replacement:
      "    needs: [operator-image-supply-chain]\n    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
  },
  {
    id: 'P6',
    claim: 'supply-chain.yml publish job stops needing the scan job',
    subject: 'sc',
    anchor: '    needs: [image-supply-chain]\n',
    replacement: '    needs: []\n',
  },
  {
    id: 'P7',
    claim: 'operator publish job stops needing the scan job',
    subject: 'op',
    anchor: '    needs: [operator-image-supply-chain]\n    if: >-',
    replacement: '    needs: []\n    if: >-',
  },
  {
    id: 'D1',
    claim: 'supply-chain.yml publish job stops downloading the scanned layout',
    subject: 'sc',
    anchor: 'uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
    replacement: 'run: echo "no download"',
  },
  {
    id: 'D2',
    claim: 'supply-chain.yml publish job stops comparing the layout digest',
    subject: 'sc',
    anchor: 'ACTUAL="$(sha256sum image-oci/index.json | cut -d\' \' -f1)"',
    replacement: 'ACTUAL="${EXPECTED}"',
  },
  {
    id: 'D3',
    claim: 'operator publish job stops comparing the layout digests',
    subject: 'op',
    anchor: 'actual="$(sha256sum "${dir}/index.json" | cut -d\' \' -f1)"',
    replacement: 'actual="${expected}"',
  },
  {
    id: 'D4',
    claim: 'supply-chain.yml build/scan job stops exporting the layout digest',
    subject: 'sc',
    anchor: '      layout_sha256: ${{ steps.layout.outputs.sha256 }}\n',
    replacement: '      layout_ref: ${{ steps.layout.outputs.sha256 }}\n',
  },
  {
    id: 'L1',
    claim: 'a registry login step is added to the read-only build/scan job',
    subject: 'sc',
    anchor: '      - name: Compute SOURCE_DATE_EPOCH (commit time)\n',
    replacement:
      '      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0\n        with:\n          registry: ghcr.io\n      - name: Compute SOURCE_DATE_EPOCH (commit time)\n',
  },
  {
    id: 'A1',
    claim: "the analyzer treats event_name == 'merge_group' as excluding PRs",
    subject: 'lib',
    anchor: 'if (event) return !PR_EVENTS.includes(event[1]);',
    replacement: "if (event) return event[1] !== 'pull_request';",
    validate: undefined,
  },
  {
    id: 'A2',
    claim: "the analyzer's forbidden-grant list forgets id-token",
    subject: 'lib',
    anchor: "export const FORBIDDEN_PR_GRANTS = ['packages', 'id-token', 'attestations'];",
    replacement: "export const FORBIDDEN_PR_GRANTS = ['packages', 'attestations'];",
    validate: undefined,
  },
  {
    id: 'N1',
    expect: 'green',
    claim: "renaming the publish job's display name",
    subject: 'sc',
    anchor: '    name: Publish + cosign sign (main only)\n',
    replacement: '    name: Publish and sign (main only)\n',
  },
  {
    id: 'N2',
    expect: 'green',
    claim: "the publish job's if: conjuncts reordered (the evaluator is order-insensitive)",
    subject: 'sc',
    anchor: SC_IF,
    replacement:
      "    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
  },
].map((m) => ({
  expect: 'red',
  validate: m.subject === 'lib' ? undefined : parses,
  ...m,
}));

// A real mutation of a real subject, distinct from every row, so it also proves
// the runner reads the workflows under proof.
const CANARY = {
  subject: 'op',
  anchor: OP_BUILD_PERMS,
  replacement: '      contents: write\n      packages: write\n    outputs:\n',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    sc: '.github/workflows/supply-chain.yml',
    op: '.github/workflows/operator-supply-chain.yml',
    other: '.github/workflows/scaffold-resolve-check.yml',
    lib: 'scripts/lib/workflow-token-scope.mjs',
  },
});

console.log('=== mutation proof: PR-reachable jobs hold no write/OIDC credential (#2417) ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
