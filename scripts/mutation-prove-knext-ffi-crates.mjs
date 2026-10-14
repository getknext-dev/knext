#!/usr/bin/env node
/**
 * Mutation prover for the knext-ffi Rust crates' key guards (#2343).
 *
 * For each guard: remove the behaviour it protects (one textual mutation whose
 * anchor must occur EXACTLY ONCE in its subject, via `lib/mutation-harness.mjs`,
 * which also plants the residue marker and restores byte-identically), run the
 * test that guards it, and require it to go RED by exit code. Before any
 * mutation every distinct command runs once on the clean tree and must be
 * GREEN, so a red run means the mutation and not a broken environment.
 *
 *   node scripts/mutation-prove-knext-ffi-crates.mjs
 *
 * NOT A JS TEST SUITE. The guards here are `cargo test` targets (unit tests,
 * the trybuild compile-fail cases, the ABI and ownership tests) and the Bun
 * harness against the release-profile fixture library, so there is no vitest
 * runner to resolve: this file is path-listed in `NON_JS_TEST_SUITE_PROVERS`
 * (`lib/prover-lane.mjs`) and spawns only `cargo` and `bun`, run in `crates/`.
 * Needs the Rust toolchain from `crates/rust-toolchain.toml` and Bun on PATH;
 * the nightly lane installs both.
 *
 * Exit 0 = every mutation was caught; 1 = a mutation survived (the guard is
 * decoration); 2 = the prover itself could not run (anchor drift, red
 * baseline, missing tool). Branches on exit codes only, never on output text.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The cargo workspace (the commands' cwd), not a mutation subject: kept out of
// the `resolve(REPO_ROOT, …)` subject shape the anchor scanners read.
const CRATES = `${REPO_ROOT}/crates`;
const RUNTIME = resolve(REPO_ROOT, 'crates/knext-ffi/src/lib.rs');
const WIRE = resolve(REPO_ROOT, 'crates/knext-ffi/src/wire.rs');
const EXPORT = resolve(REPO_ROOT, 'crates/knext-ffi-macros/src/export.rs');
const TYPES = resolve(REPO_ROOT, 'crates/knext-ffi-macros/src/types.rs');
const RECORD = resolve(REPO_ROOT, 'crates/knext-ffi-macros/src/record.rs');
const LIB = `target/release/libknext_ffi_fixture.${process.platform === 'darwin' ? 'dylib' : 'so'}`;

const cargoTest = (...a) => ['cargo', 'test', '--locked', ...a];
const harness = (mode) => [
  ['cargo', 'build', '--release', '--locked', '-p', 'knext-ffi-fixture'],
  ['bun', 'harness/ffi-harness.ts', mode, LIB],
];
// The @getknext/ffi generator against the real fixture library (#2357).
const generated = (mode) => [
  ['cargo', 'build', '--release', '--locked', '-p', 'knext-ffi-fixture'],
  ['bun', 'harness/ffi-generated.ts', mode, LIB],
];

const MUTATIONS = [
  {
    guard: 'panic = "abort" is a compile error',
    subject: 'runtime',
    anchor: '#[cfg(panic = "abort")]',
    replacement: '#[cfg(any())]',
    run: [cargoTest('-p', 'knext-ffi', '--test', 'panic_abort')],
  },
  {
    guard: 'catch_unwind: a panic is status 2, not an abort',
    subject: 'runtime',
    anchor: 'let r = catch_unwind(AssertUnwindSafe(move || match f() {',
    replacement: 'let r = Ok::<i32, Box<dyn Any + Send>>(std::convert::identity(match f() {',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'knext_ffi_v1_free releases the buffer (Rust ownership test)',
    subject: 'runtime',
    anchor: 'drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });',
    replacement: 'let _ = len;',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'ownership')],
  },
  {
    guard: 'knext_ffi_v1_free releases the buffer (Bun RSS leak check)',
    subject: 'runtime',
    anchor: 'drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });',
    replacement: 'let _ = len;',
    run: harness('leak'),
  },
  {
    guard: 'len == 0 never reaches slice::from_raw_parts (NULL pointer)',
    subject: 'runtime',
    anchor: 'if len == 0 {',
    replacement: 'if false {',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'undecodable input is status 3',
    subject: 'runtime',
    anchor:
      '            Err(Invalid(msg)) => {\n                unsafe { write_buf(out, msg.into_bytes()) };\n                STATUS_INVALID_INPUT\n',
    replacement:
      '            Err(Invalid(msg)) => {\n                unsafe { write_buf(out, msg.into_bytes()) };\n                STATUS_ERR\n',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'a JSON return value that cannot be encoded is status 3, not OK (#2357)',
    subject: 'runtime',
    anchor:
      '                Err(Invalid(msg)) => {\n                    unsafe { write_buf(out, msg.into_bytes()) };\n                    STATUS_INVALID_INPUT\n',
    replacement:
      '                Err(Invalid(msg)) => {\n                    unsafe { write_buf(out, msg.into_bytes()) };\n                    STATUS_OK\n',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'a non-finite float in any JSON position is refused, never serialized as null (#2357)',
    subject: 'wire',
    anchor: '                if self.is_finite() {',
    replacement: '                if true {',
    run: [
      cargoTest('-p', 'knext-ffi', '--lib'),
      cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi'),
    ],
  },
  {
    guard: 'the same refusal seen from Bun through the generated wrapper (real library, #2357)',
    subject: 'wire',
    anchor: '                if self.is_finite() {',
    replacement: '                if true {',
    run: generated('wrapper'),
  },
  {
    guard: 'a number that does not fit a finite f32 is refused on the way in (#2357)',
    subject: 'wire',
    anchor: '                if v.is_finite() {',
    replacement: '                if true {',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'a refused Vec element names its index (#2357)',
    subject: 'wire',
    anchor: '                .map_err(|e| at(format_args!("[{i}]"), e))?;',
    replacement: '?;',
    run: [cargoTest('-p', 'knext-ffi', '--lib')],
  },
  {
    guard: 'a refused record field names the field (#2357)',
    subject: 'wire',
    anchor: '            .map_err(|e| at(format_args!(".{}", self.0), e))',
    replacement: '',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: '_schema() covers transitive records',
    subject: 'runtime',
    anchor: 'while d < s.deps.len() {',
    replacement: 'while d < s.deps.len() * 0 {',
    run: [cargoTest('-p', 'knext-ffi', '--lib')],
  },
  {
    guard:
      '64-bit integers are decimal strings in JSON (incl. Option<usize>, Vec<Option<i64>> fields)',
    subject: 'wire',
    anchor: 'decimal_string!(i64, u64, isize, usize);',
    replacement: 'plain!(i64, u64, isize, usize);',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'symbol carries the signature hash',
    subject: 'export',
    anchor: 'fnv1a32(&canonical)',
    replacement: 'fnv1a32(&name)',
    run: [cargoTest('-p', 'knext-ffi-macros')],
  },
  {
    guard: '`char` is a compile error naming the type',
    subject: 'types',
    anchor: '"char" => {',
    replacement: '"__not_a_type" => {',
    run: [cargoTest('-p', 'knext-ffi', '--test', 'ui')],
  },
  {
    guard: 'compile errors point at the public docs page, not an internal design record (#2357)',
    subject: 'types',
    anchor:
      '"supported types are listed at https://knext-platform.dev/docs/rust-in-process#type-mapping"',
    replacement:
      '"supported types are listed in the knext-ffi type table (ADR-0069 D6, crates/README.md)"',
    run: [cargoTest('-p', 'knext-ffi', '--test', 'ui')],
  },
  {
    guard: 'a nested Option<Option<T>> is a compile error naming the type (trybuild)',
    subject: 'types',
    anchor: 'if matches!(d, Desc::Option(_)) {',
    replacement: 'if false {',
    run: [cargoTest('-p', 'knext-ffi', '--test', 'ui')],
  },
  {
    guard: 'one manifest record per #[record] survives LTO + strip',
    subject: 'record',
    anchor: 'let man = manifest(&name, "record", pieces);',
    replacement: 'let man = { let _ = manifest(&name, "record", pieces); quote!() };',
    run: harness('manifest'),
  },
];

const PROVER = {
  subjects: { runtime: RUNTIME, wire: WIRE, export: EXPORT, types: TYPES, record: RECORD },
  mutations: MUTATIONS,
};

function exec(cmds) {
  for (const [bin, ...args] of cmds) {
    const r = spawnSync(bin, args, { cwd: CRATES, stdio: ['ignore', 'ignore', 'ignore'] });
    if (r.error) {
      console.error(`mutation-prove-knext-ffi-crates: cannot run ${bin}: ${r.error.message}`);
      process.exit(2);
    }
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

declareMutations(PROVER.mutations.length);
console.log(`mutation-prove-knext-ffi-crates: ${PROVER.mutations.length} mutations declared`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of PROVER.mutations) {
  const path = PROVER.subjects[m.subject];
  if (path === undefined) {
    console.error(`mutation-prove-knext-ffi-crates: "${m.guard}" names no subject ${m.subject}`);
    process.exit(2);
  }
  const text = snapshot(path).bytes.toString('utf8');
  const count = text.split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove-knext-ffi-crates: anchor for "${m.guard}" occurs ${count} times in ${path}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline: every guard command passes on the clean tree.
const seen = new Set();
for (const m of PROVER.mutations) {
  const key = JSON.stringify(m.run);
  if (seen.has(key)) continue;
  seen.add(key);
  const code = exec(m.run);
  if (code !== 0) {
    console.error(
      `mutation-prove-knext-ffi-crates: baseline RED for "${m.guard}" (exit ${code}); fix the tree first`,
    );
    process.exit(2);
  }
}
console.log('mutation-prove-knext-ffi-crates: baseline green');

let survived = 0;
for (const m of PROVER.mutations) {
  const snap = snapshot(PROVER.subjects[m.subject]);
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    code = exec(m.run);
  } finally {
    restore(snap);
  }
  recordMutation();
  const caught = code !== 0;
  if (!caught) survived++;
  console.log(`${caught ? 'CAUGHT  ' : 'SURVIVED'} ${m.guard} (exit ${code})`);
}

console.log(
  `mutation-prove-knext-ffi-crates: ${PROVER.mutations.length - survived}/${PROVER.mutations.length} caught`,
);
process.exit(survived === 0 ? 0 : 1);
