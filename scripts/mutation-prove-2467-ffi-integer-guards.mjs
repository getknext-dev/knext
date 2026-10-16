#!/usr/bin/env node
/**
 * Mutation proof for the in-process Rust integer-argument guards (#2467) and the
 * "no Stable claim while ADR-0069 says Beta" guard (#2468 part 2).
 *
 * bun:ffi corrupts some integer arguments (a double to an i32 arrives as 0; only
 * the low 32 bits cross), so the generated wrapper must refuse, before the native
 * call, everything a width cannot hold. Each mutation below removes one piece of
 * that behaviour and the guard that pins it must go red:
 *
 *   - ffi-loader.test.ts   the behaviour: the same 10-width matrix the Rust
 *                          crates harness runs, against a real shared library
 *                          with an `echo_<width>` export per width (needs a
 *                          system `cc`), plus the message hygiene cases;
 *   - render.test.ts       the emitted text: every width's guard and range;
 *   - ffi-stage-claims.test.ts  the stage-claim guard: the scanner, the file
 *                          classes it covers, the ADR reader, and a claim
 *                          planted in the REAL docs and changeset.
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), each
 * baseline must be green, a canary must go red before any green is trusted, and
 * every restore is content-verified.
 *
 * What this does not prove: the crates harness (crates/harness/ffi-generated.ts)
 * running the same matrix against the real Rust fixture crate, which needs a
 * cargo toolchain (the Rust crates lane runs it).
 *
 * Usage:  node scripts/mutation-prove-2467-ffi-integer-guards.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const INT_CHECK = '!Number.isInteger(v) || v < min || v > max';
const BIG_CHECK = "typeof v !== 'bigint' || v < min || v > max";

const LOADER = [
  {
    id: 'L01',
    subject: 'render',
    claim: 'a fraction, NaN or Infinity is no longer refused for a 32-bit-or-narrower argument',
    anchor: INT_CHECK,
    replacement: 'v < min || v > max',
  },
  {
    id: 'L02',
    subject: 'render',
    claim: 'the lower bound of an integer argument is no longer checked',
    anchor: INT_CHECK,
    replacement: '!Number.isInteger(v) || v > max',
  },
  {
    id: 'L03',
    subject: 'render',
    claim: 'the upper bound of an integer argument is no longer checked',
    anchor: INT_CHECK,
    replacement: '!Number.isInteger(v) || v < min',
  },
  {
    id: 'L04',
    subject: 'render',
    claim: 'a 64-bit argument no longer has to be a bigint (a number in range crosses)',
    anchor: BIG_CHECK,
    replacement: 'v < min || v > max',
  },
  {
    id: 'L05',
    subject: 'render',
    claim: 'the lower bound of a 64-bit argument is no longer checked',
    anchor: BIG_CHECK,
    replacement: "typeof v !== 'bigint' || v > max",
  },
  {
    id: 'L06',
    subject: 'render',
    claim: 'the upper bound of a 64-bit argument is no longer checked',
    anchor: BIG_CHECK,
    replacement: "typeof v !== 'bigint' || v < min",
  },
  {
    id: 'L07',
    subject: 'render',
    claim: 'the emitter stops guarding the 8/16/32-bit arguments',
    anchor: '      if (range) {',
    replacement: '      if (range && !range) {',
  },
  {
    id: 'L08',
    subject: 'render',
    claim: 'the emitter stops guarding the 64-bit arguments',
    anchor: '} else if (is64(t)) {',
    replacement: '} else if (is64(t) && !is64(t)) {',
  },
  {
    id: 'L09',
    subject: 'render',
    claim: 'u32 admits 2^32 (the value whose low 32 bits are 0)',
    anchor: 'u32: [0, 4294967295],',
    replacement: 'u32: [0, 4294967296],',
  },
  {
    id: 'L10',
    subject: 'render',
    claim: 'i16 admits one below its minimum',
    anchor: 'i16: [-32768, 32767],',
    replacement: 'i16: [-32769, 32767],',
  },
  {
    id: 'L11',
    subject: 'render',
    claim: 'u8 admits one above its maximum',
    anchor: 'u8: [0, 255],',
    replacement: 'u8: [0, 256],',
  },
  {
    id: 'L12',
    subject: 'render',
    claim: 'i8 admits one above its maximum',
    anchor: 'i8: [-128, 127],',
    replacement: 'i8: [-128, 128],',
  },
  {
    id: 'L13',
    subject: 'render',
    claim: 'u16 admits one above its maximum',
    anchor: 'u16: [0, 65535],',
    replacement: 'u16: [0, 65536],',
  },
  {
    id: 'L14',
    subject: 'render',
    claim: 'i32 admits one below its minimum',
    anchor: 'i32: [-2147483648, 2147483647],',
    replacement: 'i32: [-2147483649, 2147483647],',
  },
  {
    id: 'L15',
    subject: 'render',
    claim: 'u64 and usize admit 2^64 (one above the 64-bit unsigned maximum)',
    anchor: "BigInt('18446744073709551615')",
    replacement: "BigInt('18446744073709551616')",
  },
  {
    id: 'L16',
    subject: 'render',
    claim: 'i64 and isize admit 2^63 (one above the 64-bit signed maximum)',
    anchor: "BigInt('9223372036854775807')",
    replacement: "BigInt('9223372036854775808')",
  },
  {
    id: 'L17',
    subject: 'render',
    claim: 'an enormous bigint is echoed in full instead of as a bit count',
    anchor: 'return hex > 24',
    replacement: 'return hex > 24000000000',
  },
  {
    id: 'L18',
    subject: 'render',
    claim: 'the message stringifies an arbitrary value (runs its toString)',
    anchor: "typeof v === 'number' ? $shown(v) : typeof v",
    replacement: 'String(v)',
  },
  {
    id: 'L19',
    subject: 'render',
    claim: 'a negative zero given to a 64-bit argument is no longer shown as -0',
    anchor: "v === 0 && 1 / v < 0 ? '-0' : String(v)",
    replacement: 'String(v)',
  },
];

const RENDER = [
  {
    id: 'R01',
    subject: 'render',
    claim: 'the emitter stops guarding the 8/16/32-bit arguments',
    anchor: '      if (range) {',
    replacement: '      if (range && !range) {',
  },
  {
    id: 'R02',
    subject: 'render',
    claim: 'the emitter stops guarding the 64-bit arguments',
    anchor: '} else if (is64(t)) {',
    replacement: '} else if (is64(t) && !is64(t)) {',
  },
  {
    id: 'R03',
    subject: 'render',
    claim: 'u32 admits 2^32',
    anchor: 'u32: [0, 4294967295],',
    replacement: 'u32: [0, 4294967296],',
  },
  {
    id: 'R04',
    subject: 'render',
    claim: 'the shared message helper is dropped (the message stringifies the value itself)',
    anchor: 'function $shown(v: number | bigint): string {',
    replacement: 'function $shownOld(v: number | bigint): string {',
  },
  {
    id: 'R05',
    subject: 'render',
    claim: 'the integer check stops requiring an integer',
    anchor: INT_CHECK,
    replacement: 'v < min || v > max',
  },
];

const GUARD = [
  {
    id: 'G01',
    subject: 'lib',
    claim: 'the scanner never reports a claim',
    anchor: 'if (SUBJECT.test(s) || (pronoun && SUBJECT.test(prev))) hits.push(s.trim());',
    replacement: 'if (false && SUBJECT.test(s) && pronoun && prev) hits.push(s.trim());',
  },
  {
    id: 'G02',
    subject: 'lib',
    claim: 'a negation or condition no longer excuses a sentence',
    anchor: 'if (!hasClaim(s) || HEDGE.test(s)) continue;',
    replacement: 'if (!hasClaim(s)) continue;',
  },
  {
    id: 'G03',
    subject: 'lib',
    claim: '"stable" is no longer a claim word',
    anchor: '/\\b(?:stable|production[- ](?:ready|grade)',
    replacement: '/\\b(?:stabl|production[- ](?:ready|grade)',
  },
  {
    id: 'G04',
    subject: 'lib',
    claim: '"GA" is no longer a claim word',
    anchor: 'const CLAIM_GA = /\\bGA\\b/;',
    replacement: 'const CLAIM_GA = /\\bGAX\\b/;',
  },
  {
    id: 'G05',
    subject: 'lib',
    claim: 'the docs content is no longer scanned',
    anchor: "if (rel.startsWith('apps/docs/content/') && /\\.mdx?$/.test(rel)) return true;",
    replacement: "if (rel.startsWith('apps/docs/content/') && false) return true;",
  },
  {
    id: 'G06',
    subject: 'lib',
    claim: 'changesets are no longer scanned',
    anchor:
      "if (/^\\.changeset\\/.+\\.md$/.test(rel) && rel !== '.changeset/README.md') return true;",
    replacement: 'if (/^\\.changeset\\/.+\\.md$/.test(rel) && false) return true;',
  },
  {
    id: 'G07',
    subject: 'lib',
    claim: 'CHANGELOG release notes are no longer scanned',
    anchor: 'if (/(^|\\/)CHANGELOG\\.md$/.test(rel)) return true;',
    replacement: 'if (/(^|\\/)CHANGELOG\\.md$/.test(rel) && false) return true;',
  },
  {
    id: 'G08',
    subject: 'lib',
    claim: 'the guard enforces when the ADR graduates the feature and relaxes while it is Beta',
    anchor: 'return { stage, enforce: !GRADUATED.test(stage) };',
    replacement: 'return { stage, enforce: GRADUATED.test(stage) };',
  },
  {
    id: 'G09',
    subject: 'lib',
    claim: 'an ADR with no readable stage relaxes the guard instead of failing it',
    anchor: 'if (!m) {',
    replacement: "if (!m) {\n    return { stage: 'unknown', enforce: false };",
  },
  {
    id: 'G10',
    subject: 'lib',
    claim: 'a title and Status block that disagree are no longer refused',
    anchor: 'if (!status.includes(stage)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'G11',
    subject: 'docs',
    claim: 'the real docs page calls in-process Rust stable while the ADR says Beta',
    anchor: '## Type mapping',
    replacement: 'In-process Rust is stable and production-ready.\n\n## Type mapping',
    options: { commentPrefix: '<!--' },
  },
  {
    id: 'G12',
    subject: 'changeset',
    claim: 'a real changeset calls in-process Rust production-ready while the ADR says Beta',
    anchor: 'In-process Rust (Beta): the module',
    replacement: 'In-process Rust is now production-ready: the module',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const loader = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/ffi-loader.test.ts',
  subjects: { render: 'packages/ffi/src/render.ts' },
});
const render = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/render.test.ts',
  subjects: { render: 'packages/ffi/src/render.ts' },
});
const guard = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/ffi-stage-claims.test.ts',
  subjects: {
    lib: 'scripts/lib/ffi-stage-claims.mjs',
    docs: 'apps/docs/content/docs/rust-in-process.mdx',
    changeset: '.changeset/ffi-integer-arg-guards.md',
  },
});

console.log(
  '=== mutation proof: in-process Rust integer-argument guards (#2467) + stage claims (#2468) ===',
);
loader.preflight(LOADER);
render.preflight(RENDER);
guard.preflight(GUARD);
declareMutations(LOADER.length + RENDER.length + GUARD.length);

console.log('\n=== the behaviour, every width, against a real library (ffi-loader.test.ts) ===');
loader.baseline();
loader.proveCanSeeRed({
  subject: 'render',
  anchor: INT_CHECK,
  replacement: 'v < min || v > max',
});
for (const m of LOADER) {
  loader.run({ ...m, expect: 'red' });
  recordMutation();
}
loader.finish(LOADER.length);

console.log('\n=== the emitted text (render.test.ts) ===');
render.baseline();
render.proveCanSeeRed({
  subject: 'render',
  anchor: '      if (range) {',
  replacement: '      if (range && !range) {',
});
for (const m of RENDER) {
  render.run({ ...m, expect: 'red' });
  recordMutation();
}
render.finish(RENDER.length);

console.log('\n=== no Stable claim while ADR-0069 says Beta (ffi-stage-claims.test.ts) ===');
guard.baseline();
guard.proveCanSeeRed({
  subject: 'lib',
  anchor: 'return { stage, enforce: !GRADUATED.test(stage) };',
  replacement: 'return { stage, enforce: GRADUATED.test(stage) };',
});
for (const m of GUARD) {
  guard.run({ ...m, expect: 'red' });
  recordMutation();
}
guard.finish(GUARD.length);
