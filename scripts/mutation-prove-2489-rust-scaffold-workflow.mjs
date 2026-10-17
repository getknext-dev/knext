#!/usr/bin/env node
/**
 * Mutation proof for the workflow half of the Rust scaffold gate: that
 * `.github/workflows/rust-template.yml` builds, lints and tests a freshly
 * scaffolded function outside the template directory, with the right path
 * filters, and that the template keeps the tests the scaffold drops.
 *
 * One guard, `tests/rust-template-contract.test.ts`; each mutation removes ONE
 * behaviour and requires it to go red:
 *
 *   W1  the scaffold step runs inside the template directory (not a copy)
 *   W2  the scaffold step no longer runs the scaffold's tests
 *   W3  the scaffold step no longer builds and lints the scaffold
 *   W4  a change to scaffold-rust.ts does not re-run the workflow on a pull request
 *   W5  a change to scaffold-rust.ts does not re-run the workflow on a push
 *   W7  the scaffold step no longer checks that the copy is rustfmt-clean
 *   W8  the scaffold step no longer checks every feature combination compiles
 *   W6  the scaffold step generates with a second, unpinned plugin install
 *   C1  the template no longer runs the repository-only tests by default
 *
 * Verdicts are by EXIT CODE only (the shared driver,
 * `scripts/lib/guard-prover.mjs`): every anchor occurs exactly once (preflight
 * first), the baseline must be green, a canary must go red before any green is
 * trusted, and every restore is content-verified. The tree must be clean (the
 * work committed) before it runs.
 *
 * Usage:  node scripts/mutation-prove-2489-rust-scaffold-workflow.mjs
 * Exit 0 = every row behaved as required; 1 = one did not or the run was partial.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ON_HEAD = `    paths:
      - 'templates/rust/**'
      - '.github/workflows/rust-template.yml'
      - 'packages/grpc/proto/**'
      - 'packages/grpc/testdata/z7-token-vectors.json'
      - 'packages/grpc/src/add-function.ts'
`;
const SCAFFOLD_LINE = "      - 'packages/grpc/src/scaffold-rust.ts'\n";

const MUTATIONS = [
  {
    id: 'W1',
    subject: 'workflow',
    claim: 'the scaffold step runs inside the template directory, so it builds the template itself',
    anchor:
      '        working-directory: .\n        env:\n          KNEXT_RUST_CODEGEN_DIR: ${{ github.workspace }}/templates/rust/.codegen\n',
    replacement:
      '        env:\n          KNEXT_RUST_CODEGEN_DIR: ${{ github.workspace }}/templates/rust/.codegen\n',
  },
  {
    id: 'W2',
    subject: 'workflow',
    claim: "the scaffold step no longer runs the scaffold's tests",
    anchor:
      '          cargo clippy --all-targets --features e2e --locked -- -D warnings\n          cargo test --locked\n',
    replacement: '          cargo clippy --all-targets --features e2e --locked -- -D warnings\n',
  },
  {
    id: 'W3',
    subject: 'workflow',
    claim: 'the scaffold step no longer builds and lints the scaffold',
    anchor:
      '          cargo build --locked --all-targets\n          cargo check --locked --all-features --all-targets\n          cargo clippy --all-targets --features e2e --locked -- -D warnings\n',
    replacement: '          true\n',
  },
  {
    id: 'W4',
    subject: 'workflow',
    claim: 'a change to scaffold-rust.ts does not re-run the workflow on a pull request',
    anchor: `  pull_request:\n${ON_HEAD}${SCAFFOLD_LINE}`,
    replacement: `  pull_request:\n${ON_HEAD}`,
  },
  {
    id: 'W5',
    subject: 'workflow',
    claim: 'a change to scaffold-rust.ts does not re-run the workflow on a push',
    anchor: `    branches: [main, 'integration/**']\n${ON_HEAD}${SCAFFOLD_LINE}`,
    replacement: `    branches: [main, 'integration/**']\n${ON_HEAD}`,
  },
  {
    id: 'W6',
    subject: 'workflow',
    claim: 'the scaffold step generates with its own plugin install rather than the pinned cache',
    anchor:
      '        env:\n          KNEXT_RUST_CODEGEN_DIR: ${{ github.workspace }}/templates/rust/.codegen\n',
    replacement: '        env:\n          KNEXT_UNUSED: unused\n',
  },
  {
    id: 'W7',
    subject: 'workflow',
    claim: 'the scaffold step no longer checks that the copy is rustfmt-clean',
    anchor: '          cargo fmt --check\n          cargo build --locked --all-targets\n',
    replacement: '          cargo build --locked --all-targets\n',
  },
  {
    id: 'W8',
    subject: 'workflow',
    claim: 'the scaffold step no longer checks every feature combination compiles',
    anchor:
      '          cargo check --locked --all-features --all-targets\n          cargo clippy --all-targets --features e2e --locked -- -D warnings\n',
    replacement: '          cargo clippy --all-targets --features e2e --locked -- -D warnings\n',
  },
  {
    id: 'C1',
    subject: 'cargo',
    claim: 'the template no longer runs the repository-only tests by default',
    anchor: 'default = ["shared-vectors"]',
    replacement: 'default = []',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/rust-template-contract.test.ts',
  subjects: {
    workflow: '.github/workflows/rust-template.yml',
    cargo: 'templates/rust/Cargo.toml',
  },
});

console.log('=== mutation proof: the Rust scaffold workflow gate ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'workflow',
  anchor: '        run: cargo audit --deny warnings\n',
  replacement: '        run: "true"\n',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
