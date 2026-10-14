#!/usr/bin/env node
/**
 * Mutation proof for the in-process Rust docs guard
 * (`apps/docs/rust-in-process-doc.test.ts`, #2348).
 *
 * The page quotes messages a user acts on: the runtime refusals the generated
 * module throws, the build-time refusals, the reserved-name error, the
 * toolchain install commands and two Rust messages. The guard's claim is that
 * every one of them is bound to the code that prints it, compared WHOLE, so
 * changing any of those strings in the code reds the docs test until the page
 * is updated. Round 1 compared multi-line refusals on their first line only
 * and hard-coded the rest, so a changed second line, a changed install
 * command or a changed runtime message all left the guard green.
 *
 * Each mutation below changes one such string in the code and REQUIRES the
 * docs test to go red. Several change a line other than the first of a
 * multi-line message, which is what proves "whole" rather than "first line".
 *
 * Where the mutated text sits inside a string literal, the anchor runs past
 * the literal's closing delimiter and the residue marker is placed after it
 * by hand: a marker inside the literal would change the message too, and red
 * the guard for the wrong reason.
 *
 * The shared driver (`scripts/lib/guard-prover.mjs`) owns the discipline:
 * verdicts by EXIT CODE only, baseline green first, a canary that must go
 * red, anchors that must occur exactly once, sha256-verified byte-exact
 * restore, a clean tree between mutations.
 *
 * Usage:  node scripts/mutation-prove-ffi-docs-quotes.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'apps/docs/rust-in-process-doc.test.ts';
const MARK = `// ${MUTATION_MARKER}`;

const MUTATIONS = [
  // ── The generated module's runtime messages (render.ts) ────────────────
  {
    id: 'R1',
    expect: 'red',
    claim: 'the runtime Node refusal says "runs on Bun only" instead of "runs only on Bun"',
    subject: 'render',
    anchor: String.raw`runs only on Bun; this process is Node \${process.version}. Run the app with Bun (bun --bun next dev), or call this code through a zone function.\`,`,
    replacement: String.raw`runs on Bun only; this process is Node \${process.version}. Run the app with Bun (bun --bun next dev), or call this code through a zone function.\`,`,
  },
  {
    id: 'R2',
    expect: 'red',
    claim: 'the development-build notice is reworded',
    subject: 'render',
    anchor: String.raw`without an integrity check (NODE_ENV is not "production").\`,`,
    replacement: String.raw`without integrity checking (NODE_ENV is not "production").\`,`,
  },
  {
    id: 'R3',
    expect: 'red',
    claim: 'the integrity refusal says "checksum mismatch" instead of "sha256 mismatch"',
    subject: 'render',
    anchor: String.raw`sha256 mismatch\\n  expected \${expected}\\n  actual   \${actual}\`,`,
    replacement: String.raw`checksum mismatch\\n  expected \${expected}\\n  actual   \${actual}\`,`,
  },
  {
    id: 'R4',
    expect: 'red',
    claim: 'the THIRD line of the integrity refusal changes (whole message, not first line)',
    subject: 'render',
    anchor: String.raw`\\n  actual   \${actual}\`,`,
    replacement: String.raw`\\n  got      \${actual}\`,`,
  },
  {
    id: 'R5',
    expect: 'red',
    claim: 'the argument TypeError format changes ("received" for "got")',
    subject: 'render',
    anchor: String.raw`must be a string, got \${typeof v}\`);`,
    replacement: String.raw`must be a string, received \${typeof v}\`);`,
  },
  {
    id: 'R6',
    expect: 'red',
    claim: 'the "invalid input:" prefix of a decode failure changes',
    subject: 'render',
    anchor: String.raw`status === 3 ? \`invalid input: \${message}\` : message);`,
    replacement: String.raw`status === 3 ? \`bad input: \${message}\` : message);`,
  },
  // ── The toolchain install commands (build.ts) ──────────────────────────
  {
    id: 'B1',
    expect: 'red',
    claim: 'the cargo-zigbuild install hint drops --locked',
    subject: 'build',
    anchor: "  zigbuild: 'cargo install --locked cargo-zigbuild',",
    replacement: "  zigbuild: 'cargo install cargo-zigbuild',",
  },
  {
    id: 'B2',
    expect: 'red',
    claim: 'the missing-target hint names a different rustup command',
    subject: 'build',
    anchor: "  rustupTarget: 'rustup target add',",
    replacement: "  rustupTarget: 'rustup target install',",
  },
  {
    id: 'B3',
    expect: 'red',
    claim: 'the zig pip hint names a different package',
    subject: 'build',
    anchor: "  zigPip: 'pip install ziglang',",
    replacement: "  zigPip: 'pip install zig',",
  },
  // ── The build-time refusals (ffi-preflight.ts), past the first line ────
  {
    id: 'P1',
    expect: 'red',
    claim: 'FFI_NODE_REFUSAL loses "(Bun is the default)" on its seventh line',
    subject: 'preflight',
    anchor:
      ' (Bun is the default);\n    - or move this code to a zone function (knext add function <name> --lang rust),\n      which runs on both runtimes.`;',
    replacement: `;\n    - or move this code to a zone function (knext add function <name> --lang rust),\n      which runs on both runtimes.\`; ${MARK}`,
  },
  {
    id: 'P2',
    expect: 'red',
    claim: 'FFI_SELF_CONTAINED_REFUSAL changes a line in its fix list',
    subject: 'preflight',
    anchor:
      '      and drop --self-contained;\n    - or move this code to a zone function (knext add function <name> --lang rust),\n      which runs on both runtimes.`;',
    replacement: `      and stop passing --self-contained;\n    - or move this code to a zone function (knext add function <name> --lang rust),\n      which runs on both runtimes.\`; ${MARK}`,
  },
  // ── The reserved-name error and lists (manifest.ts) ────────────────────
  {
    id: 'N1',
    expect: 'red',
    claim: 'the reserved-name error no longer says "rename it in Rust"',
    subject: 'manifest',
    anchor:
      '      `"${name}" cannot be a generated ${what} name: rename it in Rust (it must be an identifier ` +',
    replacement:
      '      `"${name}" cannot be a generated ${what} name: rename it (it must be an identifier ` +',
  },
  {
    id: 'N2',
    expect: 'red',
    claim: 'the LAST clause of the reserved-name error changes (whole message, not a prefix)',
    subject: 'manifest',
    anchor: "        'or a name the generated module declares)',",
    replacement: "        'or a name the module declares)',",
  },
  {
    id: 'N3',
    expect: 'red',
    claim:
      'a type-operator keyword in RESERVED_TYPES changes, and the page still lists the old one',
    subject: 'manifest',
    anchor: "  'infer',",
    replacement: "  'satisfies',",
  },
  // ── The Rust messages (crate source) ───────────────────────────────────
  {
    id: 'C1',
    expect: 'red',
    claim: 'the `char` compile error gives different advice',
    subject: 'macroTypes',
    anchor: '"`char` has no TypeScript equivalent; pass a `String` or a `u32` code point",',
    replacement: '"`char` has no TypeScript equivalent; pass a `String`",',
  },
  {
    id: 'C2',
    expect: 'red',
    claim: 'every unsupported-type compile error is reworded',
    subject: 'macroTypes',
    anchor: '"knext-ffi: `{}` is not supported: {why}; {TABLE_HINT}",',
    replacement: '"knext-ffi: `{}` is unsupported: {why}; {TABLE_HINT}",',
  },
  {
    id: 'C3',
    expect: 'red',
    claim: 'the decode error says "could not be parsed" instead of "could not be decoded"',
    subject: 'ffiLib',
    anchor: '"knext-ffi: argument `{name}` could not be decoded: {e}"',
    replacement: '"knext-ffi: argument `{name}` could not be parsed: {e}"',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    render: 'packages/ffi/src/render.ts',
    build: 'packages/ffi/src/build.ts',
    preflight: 'packages/kn-next/src/cli/ffi-preflight.ts',
    manifest: 'packages/ffi/src/manifest.ts',
    macroTypes: 'crates/knext-ffi-macros/src/types.rs',
    ffiLib: 'crates/knext-ffi/src/lib.rs',
  },
});

console.log(`=== mutation proof: ${SPEC} (in-process Rust docs quotes) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'build',
  anchor: "  zigUrl: 'https://ziglang.org/download/',",
  replacement: "  zigUrl: 'https://ziglang.org/downloads/',",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
