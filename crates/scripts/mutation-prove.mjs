#!/usr/bin/env node
// Mutation prover for the knext-ffi crates' key guards (#2343).
//
// For each guard: remove the behaviour it protects (one textual mutation whose
// anchor must occur EXACTLY ONCE, or the prover aborts), run the test that
// guards it, and require it to go RED by exit code. The file is restored after
// every mutation, even on failure. Before any mutation, every command is run
// once on the clean tree and must be GREEN, so a red run means the mutation and
// not a broken environment.
//
//   cd crates && node scripts/mutation-prove.mjs
//
// Exit 0 = every mutation was caught; 1 = a mutation survived (the guard is
// decoration); 2 = the prover itself could not run (anchor drift, red baseline).
// Branches on exit codes only, never on output text.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATES = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = `target/release/libknext_ffi_fixture.${process.platform === 'darwin' ? 'dylib' : 'so'}`;

const cargoTest = (...a) => ['cargo', 'test', '--locked', ...a];
const harness = (mode) => [
  ['cargo', 'build', '--release', '--locked', '-p', 'knext-ffi-fixture'],
  ['bun', 'harness/ffi-harness.ts', mode, LIB],
];

const MUTATIONS = [
  {
    guard: 'panic = "abort" is a compile error',
    file: 'knext-ffi/src/lib.rs',
    anchor: '#[cfg(panic = "abort")]',
    replace: '#[cfg(any())]',
    run: [cargoTest('-p', 'knext-ffi', '--test', 'panic_abort')],
  },
  {
    guard: 'catch_unwind: a panic is status 2, not an abort',
    file: 'knext-ffi/src/lib.rs',
    anchor: 'let r = catch_unwind(AssertUnwindSafe(move || match f() {',
    replace: 'let r = Ok::<i32, Box<dyn Any + Send>>(std::convert::identity(match f() {',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'knext_ffi_v1_free releases the buffer (Rust ownership test)',
    file: 'knext-ffi/src/lib.rs',
    anchor: 'drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });',
    replace: 'let _ = len;',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'ownership')],
  },
  {
    guard: 'knext_ffi_v1_free releases the buffer (Bun RSS leak check)',
    file: 'knext-ffi/src/lib.rs',
    anchor: 'drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });',
    replace: 'let _ = len;',
    run: harness('leak'),
  },
  {
    guard: 'len == 0 never reaches slice::from_raw_parts (NULL pointer)',
    file: 'knext-ffi/src/lib.rs',
    anchor: 'if len == 0 {',
    replace: 'if false {',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'undecodable input is status 3',
    file: 'knext-ffi/src/lib.rs',
    anchor: '                STATUS_INVALID_INPUT\n',
    replace: '                STATUS_ERR\n',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: '_schema() covers transitive records',
    file: 'knext-ffi/src/lib.rs',
    anchor: 'while d < s.deps.len() {',
    replace: 'while d < s.deps.len() * 0 {',
    run: [cargoTest('-p', 'knext-ffi', '--lib')],
  },
  {
    guard: '64-bit integers are decimal strings in JSON',
    file: 'knext-ffi/src/wire.rs',
    anchor: 'decimal_string!(i64, u64, isize, usize);',
    replace: 'plain!(i64, u64, isize, usize);',
    run: [cargoTest('-p', 'knext-ffi-fixture', '--test', 'abi')],
  },
  {
    guard: 'symbol carries the signature hash',
    file: 'knext-ffi-macros/src/export.rs',
    anchor: 'fnv1a32(&canonical)',
    replace: 'fnv1a32(&name)',
    run: [cargoTest('-p', 'knext-ffi-macros')],
  },
  {
    guard: '`char` is a compile error naming the type',
    file: 'knext-ffi-macros/src/types.rs',
    anchor: '"char" => {',
    replace: '"__not_a_type" => {',
    run: [cargoTest('-p', 'knext-ffi', '--test', 'ui')],
  },
  {
    guard: 'one manifest record per #[record] survives LTO + strip',
    file: 'knext-ffi-macros/src/record.rs',
    anchor: 'let man = manifest(&name, "record", pieces);',
    replace: 'let man = { let _ = manifest(&name, "record", pieces); quote!() };',
    run: harness('manifest'),
  },
];

function exec(cmds) {
  for (const [bin, ...args] of cmds) {
    const r = spawnSync(bin, args, { cwd: CRATES, stdio: ['ignore', 'ignore', 'ignore'] });
    if (r.error) {
      console.error(`mutation-prove: cannot run ${bin}: ${r.error.message}`);
      process.exit(2);
    }
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

console.log(`mutation-prove: ${MUTATIONS.length} mutations declared`);

// Green baseline: every guard command passes on the clean tree.
const seen = new Set();
for (const m of MUTATIONS) {
  const key = JSON.stringify(m.run);
  if (seen.has(key)) continue;
  seen.add(key);
  const code = exec(m.run);
  if (code !== 0) {
    console.error(
      `mutation-prove: baseline RED for "${m.guard}" (exit ${code}); fix the tree first`,
    );
    process.exit(2);
  }
}
console.log('mutation-prove: baseline green');

let survived = 0;
let ran = 0;
for (const m of MUTATIONS) {
  const path = join(CRATES, m.file);
  const original = readFileSync(path, 'utf8');
  const count = original.split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `mutation-prove: anchor for "${m.guard}" occurs ${count} times in ${m.file}; aborting`,
    );
    process.exit(2);
  }
  let code;
  try {
    writeFileSync(path, original.replace(m.anchor, m.replace));
    code = exec(m.run);
  } finally {
    writeFileSync(path, original);
  }
  ran++;
  const caught = code !== 0;
  if (!caught) survived++;
  console.log(`${caught ? 'CAUGHT  ' : 'SURVIVED'} ${m.guard} (exit ${code})`);
}

if (ran !== MUTATIONS.length) {
  console.error(`mutation-prove: ran ${ran} of ${MUTATIONS.length} declared mutations`);
  process.exit(2);
}
console.log(`mutation-prove: ${ran - survived}/${ran} caught`);
process.exit(survived === 0 ? 0 : 1);
