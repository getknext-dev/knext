#!/usr/bin/env node
/**
 * Mutation proof for `knext add function --lang rust` (the Rust scaffold):
 * what is copied from templates/rust, how the crate and service are renamed,
 * the crate-name checks, the generation pipeline failing closed, rollback on a
 * failed step, and the packaging that ships the template.
 *
 * One guard, `add-function-rust.test.ts`; each mutation removes ONE behaviour
 * and requires it to go red:
 *
 *   X1  the exclude list is not applied for one file (README.md is copied)
 *   X2  a template file is silently dropped (not on the exclude list)
 *   X3  an unreviewed entry is added to the exclude list
 *   X4  the crate (package and bin target) is not renamed
 *   X5  Cargo.lock is not re-sorted after the rename (--locked would refuse it)
 *   X6  the scaffold keeps the repository-only feature in Cargo.toml
 *   X10 the scaffold keeps the cfg'd repository-only test modules
 *   X7  the scaffold does not write a .gitignore (npm drops the template's)
 *   X8  Rust keywords and toolchain names are accepted as a function name
 *   X9  a function name that shadows a template dependency is accepted
 *   K1  a copied script loses its executable bit
 *   F1  a missing Rust toolchain no longer stops the run
 *   F2  a failed plugin install no longer stops the run
 *   F3  a failed `buf generate` no longer stops the run
 *   L1  the temporary link to the plugin cache stays in the project
 *   T1  turbo no longer declares the template as a build output (a cache hit
 *       would ship a tarball without it)
 *   T2  turbo no longer declares templates/rust as a build input (an edit to
 *       the template would never invalidate the cache)
 *   S1  a source run prefers the stale, gitignored package copy
 *   R1  a failed step is no longer rolled back
 *
 * Verdicts are by EXIT CODE only (the shared driver,
 * `scripts/lib/guard-prover.mjs`): every anchor occurs exactly once (preflight
 * first), the baseline must be green, a canary must go red before any green is
 * trusted, and every restore is content-verified. The tree must be clean (the
 * work committed) before it runs.
 *
 * The guard runs `cargo` for its real-generation tests (it skips them only
 * where cargo is absent and CI is unset), so the lane that runs this needs the
 * Rust toolchain; set KNEXT_RUST_CODEGEN_DIR to a persistent directory to keep
 * the code generators between runs.
 *
 * Usage:  node scripts/mutation-prove-2489-rust-scaffold.mjs
 * Exit 0 = every row behaved as required; 1 = one did not or the run was partial.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// JSON has no comments: the residue marker rides in as a key or an element of its own.
const JSON_KEY_MARK = `"//${MUTATION_MARKER}": "mutated"`;
const JSON_ELEMENT_MARK = `"//${MUTATION_MARKER}"`;

const COPIED = 'return walkFiles(dir, RUST_TEMPLATE_EXCLUDES);';

const MUTATIONS = [
  {
    id: 'X1',
    subject: 'scaffold',
    claim: 'the exclude list is not applied for README.md: the maintainer README is copied',
    anchor: COPIED,
    replacement:
      "return walkFiles(dir, RUST_TEMPLATE_EXCLUDES.filter((e) => e.path !== 'README.md'));",
  },
  {
    id: 'X2',
    subject: 'scaffold',
    claim: 'a template file is silently dropped without being on the exclude list',
    anchor: COPIED,
    replacement:
      "return walkFiles(dir, RUST_TEMPLATE_EXCLUDES).filter((f) => f !== 'src/main.rs');",
  },
  {
    id: 'X3',
    subject: 'scaffold',
    claim: 'an unreviewed entry is added to the exclude list',
    anchor: "  { path: 'target', why: 'build output of a local cargo run (git-ignored)' },",
    replacement:
      "  { path: 'Dockerfile', why: 'x' },\n  { path: 'target', why: 'build output of a local cargo run (git-ignored)' },",
  },
  {
    id: 'X4',
    subject: 'scaffold',
    claim: 'the package and bin target keep the template crate name',
    anchor: 'out.replaceAll(\'name = "function"\', `name = "${s.name}"`)',
    replacement: 'out.replaceAll(\'name = "function"\', \'name = "function"\')',
  },
  {
    id: 'X5',
    subject: 'scaffold',
    claim: 'Cargo.lock keeps the renamed package out of order',
    anchor: '    const [bn, bv] = key(b) as [string, string];',
    replacement: '    const [bn, bv] = key(b) as [string, string];\n    if (bn) return 0;',
  },
  {
    id: 'X6',
    subject: 'scaffold',
    claim: 'the scaffold keeps the repository-only feature in Cargo.toml (--all-features breaks)',
    anchor:
      'return stripVectorGate(rel, out.replaceAll(\'name = "function"\', `name = "${s.name}"`));',
    replacement: 'return out.replaceAll(\'name = "function"\', `name = "${s.name}"`);',
  },
  {
    id: 'X10',
    subject: 'scaffold',
    claim: 'the scaffold keeps the cfg-gated repository-only test modules in the source',
    anchor: 'if (VECTOR_GATE_FILES.includes(rel)) out = stripVectorGate(rel, out);',
    replacement: ';',
  },
  {
    id: 'N1',
    subject: 'scaffold',
    claim: '`gen` (reserved in edition 2024) is accepted as a function name',
    anchor: "  'gen',\n  'macro',\n",
    replacement: "  'macro',\n",
  },
  {
    id: 'N2',
    subject: 'scaffold',
    claim: 'a relative KNEXT_RUST_CODEGEN_DIR is accepted (plugins would land in the project)',
    anchor: 'if (!isAbsolute(own)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'N3',
    subject: 'scaffold',
    claim: 'a relative XDG_CACHE_HOME is honoured instead of ignored',
    anchor: "const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache');",
    replacement: "const base = xdg ? xdg : join(homedir(), '.cache');",
  },
  {
    id: 'M1',
    subject: 'scaffold',
    claim: 'a failed `cargo fmt` no longer stops the run',
    anchor: 'if (fmt.status !== 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'X7',
    subject: 'scaffold',
    claim: 'the scaffold writes no .gitignore',
    anchor: "extraFiles: { '.gitignore': RUST_GITIGNORE },",
    replacement: 'extraFiles: {},',
  },
  {
    id: 'X8',
    subject: 'scaffold',
    claim: 'Rust keywords and toolchain names are accepted as a function name',
    anchor: 'if (RESERVED_CRATES.has(ident)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'X9',
    subject: 'scaffold',
    claim: 'a function name that shadows a template dependency is accepted',
    anchor: 'if (taken.some((n) => asCrateIdent(n) === ident)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'K1',
    subject: 'template',
    claim: 'a copied script (codegen.sh) loses its executable bit',
    anchor: 'chmodSync(dest, statSync(from).mode & 0o777);',
    replacement: ';',
  },
  {
    id: 'F1',
    subject: 'scaffold',
    claim: 'a missing Rust toolchain no longer stops the run',
    anchor: 'if (cargo.status !== 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'F2',
    subject: 'scaffold',
    claim: 'a failed plugin install no longer stops the run',
    anchor: 'if (install.status !== 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'F3',
    subject: 'scaffold',
    claim: 'a failed `buf generate` no longer stops the run',
    anchor: 'if (gen.status !== 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'L1',
    subject: 'scaffold',
    claim: 'the temporary link to the plugin cache stays in the project',
    anchor: 'rmSync(link, { force: true });',
    replacement: ';',
  },
  {
    id: 'T1',
    subject: 'turbo',
    claim: 'turbo does not cache the template as a build output',
    anchor: '"outputs": ["$TURBO_EXTENDS$", "templates/**"]',
    replacement: `"outputs": ["$TURBO_EXTENDS$"], ${JSON_KEY_MARK}`,
  },
  {
    id: 'T2',
    subject: 'turbo',
    claim: 'turbo does not hash templates/rust as a build input',
    anchor: '"$TURBO_ROOT$/templates/rust/**"',
    replacement: JSON_ELEMENT_MARK,
  },
  {
    id: 'S1',
    subject: 'template',
    claim: 'a source run prefers the stale package copy of the template',
    anchor: "const fromSource = moduleFile.endsWith('.ts');",
    replacement: 'const fromSource = false;',
  },
  {
    id: 'R1',
    subject: 'add',
    claim: 'a failed step is no longer rolled back',
    anchor: 'for (const u of undo.reverse()) {',
    replacement: 'for (const u of [] as Array<() => void>) {',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/grpc/src/__tests__/add-function-rust.test.ts',
  subjects: {
    scaffold: 'packages/grpc/src/scaffold-rust.ts',
    template: 'packages/grpc/src/scaffold-template.ts',
    add: 'packages/grpc/src/add-function.ts',
    turbo: 'packages/grpc/turbo.json',
  },
});

console.log('=== mutation proof: knext add function --lang rust ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'add',
  anchor: "if (!existsSync(join(cwd, 'buf.yaml'))) write('buf.yaml', BUF_YAML);",
  replacement: ';',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
