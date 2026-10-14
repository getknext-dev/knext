// Bun harness for the knext-ffi crates: loads the fixture cdylib through
// `bun:ffi` the way a generated wrapper does, and checks what only a real
// load can show. Test tooling only (not the generator, which lives in
// @getknext/ffi); it binds the fixture from the library's own embedded
// manifest, so it also proves the manifest is readable from the bytes.
//
//   bun crates/harness/ffi-harness.ts <mode> <path-to-lib> [--no-free]
//
// Modes (exit 0 = pass):
//   manifest   one KNEXTFFI1 record per #[export] and per #[record] in the
//              fixture source, symbol = knext_ffi_v1_<fn>_<fnv1a32(sig)>, sig
//              rebuilt from the descriptors, and every <symbol>_schema()
//              equal to FNV-1a 64 of the schema string rebuilt from the
//              manifest (the generator's side of the D4 check)
//   roundtrip  calls from Bun: unicode/emoji/NUL/empty/1 MiB strings, empty
//              Uint8Array as NULL, i64/u64 beyond 2^53, records, Err, and two
//              large string arguments that force the scratch buffer to grow
//   panic      1000 panicking calls in a row, each status 2 with its message;
//              the process survives and the next call is correct
//   leak       1e6 calls each of a String, a Vec<u8> and a record export; RSS
//              growth after Bun.gc(true) must stay under LEAK_BOUND_MB per
//              phase. Exit code = number of phases over the bound, so with
//              --no-free (the wrapper skips knext_ffi_v1_free: a deliberate
//              leak) the same check must exit 3 — proof that it can see one.

import { CString, dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HARNESS_ERROR = 10;
const LEAK_BOUND_MB = 48;
const LEAK_CALLS = 1_000_000;

type Desc =
  | { t: string }
  | { t: 'record' | 'enum'; name: string }
  | { t: 'option' | 'vec'; of: Desc };
interface FnRec {
  v: 1;
  kind: 'fn';
  name: string;
  symbol: string;
  sig: string;
  doc: string;
  args: { name: string; type: Desc; rust: string }[];
  ret: { type: Desc; rust: string };
  err: { rust: string } | null;
}
interface RecordRec {
  v: 1;
  kind: 'record';
  name: string;
  doc: string;
  fields: { name: string; type: Desc; rust: string }[];
}
interface EnumRec {
  v: 1;
  kind: 'enum';
  name: string;
  doc: string;
  variants: string[];
}
type Rec = FnRec | RecordRec | EnumRec;

function fail(msg: string): never {
  console.error(`ffi-harness: FAIL: ${msg}`);
  process.exit(HARNESS_ERROR);
}
function check(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

// ---- manifest scan (from the bytes; the library is never executed here) ----

const MAGIC = Buffer.from(['KNEXT', 'FFI1'].join(''));

export function scan(bytes: Buffer): Rec[] {
  const out: Rec[] = [];
  let at = bytes.indexOf(MAGIC);
  while (at !== -1) {
    const start = at + MAGIC.length;
    const end = bytes.indexOf(0, start);
    check(end !== -1, `unterminated record at byte ${at}`);
    const text = bytes.subarray(start, end).toString('utf8');
    try {
      out.push(JSON.parse(text) as Rec);
    } catch (e) {
      fail(`record at byte ${at} is not JSON: ${(e as Error).message}`);
    }
    at = bytes.indexOf(MAGIC, end);
  }
  return out;
}

function tok(d: Desc): string {
  if (d.t === 'record' || d.t === 'enum') return (d as { name: string }).name;
  if (d.t === 'option' || d.t === 'vec') return `${d.t}<${tok((d as { of: Desc }).of)}>`;
  return d.t;
}

function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s, 'utf8')) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

function named(d: Desc, acc: string[]): void {
  if (d.t === 'record' || d.t === 'enum') acc.push((d as { name: string }).name);
  else if (d.t === 'option' || d.t === 'vec') named((d as { of: Desc }).of, acc);
}

export function schemaString(f: FnRec, types: Map<string, RecordRec | EnumRec>): string {
  const seen = new Set<string>();
  const todo: string[] = [];
  for (const a of f.args) named(a.type, todo);
  named(f.ret.type, todo);
  while (todo.length > 0) {
    const n = todo.pop() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    const r = types.get(n);
    check(r, `${f.name} names ${n}, which has no record of its own`);
    if (r?.kind === 'record') for (const fl of r.fields) named(fl.type, todo);
  }
  const canon = (r: RecordRec | EnumRec) =>
    r.kind === 'record'
      ? `${r.name}{${r.fields.map((x) => `${x.name}:${tok(x.type)}`).join(',')}}`
      : `${r.name}[${r.variants.join('|')}]`;
  const names = [...seen].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return f.sig + names.map((n) => canon(types.get(n) as RecordRec | EnumRec)).join('');
}

// ---- binding (the generated wrapper's rules, ADR-0069 D13) --------------------

const SCALAR: Record<string, FFIType> = {
  i8: FFIType.i8,
  i16: FFIType.i16,
  i32: FFIType.i32,
  i64: FFIType.i64,
  isize: FFIType.i64,
  u8: FFIType.u8,
  u16: FFIType.u16,
  u32: FFIType.u32,
  u64: FFIType.u64,
  usize: FFIType.u64,
  f32: FFIType.f32,
  f64: FFIType.f64,
  bool: FFIType.bool,
};
const isBuf = (d: Desc) => !(d.t in SCALAR);

export class RustError extends Error {}
export class RustPanicError extends Error {}

function load(path: string, noFree: boolean) {
  const recs = scan(readFileSync(path));
  const fns = recs.filter((r): r is FnRec => r.kind === 'fn');
  const symbols: Record<string, { args: FFIType[]; returns: FFIType }> = {
    knext_ffi_v1_free: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
  };
  for (const f of fns) {
    const args: FFIType[] = [];
    for (const a of f.args) {
      if (isBuf(a.type)) args.push(FFIType.ptr, FFIType.u64);
      else args.push(SCALAR[a.type.t]);
    }
    args.push(FFIType.ptr);
    symbols[f.symbol] = { args, returns: FFIType.i32 };
    symbols[`${f.symbol}_schema`] = { args: [], returns: FFIType.u64 };
  }
  const lib = dlopen(path, symbols);
  const sym = lib.symbols as Record<string, (...a: unknown[]) => unknown>;

  // One out slot and one growable scratch buffer per module instance. Take
  // ptr() of the ArrayBuffer itself (never of a small typed array's .buffer).
  const OUT = new ArrayBuffer(16);
  const OUT_PTR = ptr(OUT);
  const OUT32 = new Uint32Array(OUT);
  const OUT_VIEW = new DataView(OUT);
  let scratch = new ArrayBuffer(4096);
  const enc = new TextEncoder();

  const take = (asString: boolean): string | Uint8Array => {
    const p = OUT32[0] + OUT32[1] * 2 ** 32;
    const len = OUT32[2] + OUT32[3] * 2 ** 32;
    if (p === 0 && len === 0) return asString ? '' : new Uint8Array(0);
    try {
      if (asString) return new CString(p as never, 0, len).toString();
      return new Uint8Array(toArrayBuffer(p as never, 0, len).slice(0));
    } finally {
      if (!noFree) sym.knext_ffi_v1_free(p, len);
    }
  };

  const call = (name: string, ...values: unknown[]): unknown => {
    const f = fns.find((x) => x.name === name);
    check(f, `no export ${name}`);
    const fr = f as FnRec;
    // 1. encode every buffer argument into the scratch buffer (growing it as
    //    needed), remembering offsets; 2. only then compute the pointers, so no
    //    pointer is taken before a later argument can grow the buffer.
    const enc_args = fr.args.map((a, i) => {
      const v = values[i];
      if (!isBuf(a.type)) return { scalar: v };
      if (a.type.t === 'bytes') return { bytes: v as Uint8Array };
      if (a.type.t === 'string') return { bytes: enc.encode(v as string) };
      return { bytes: enc.encode(JSON.stringify(v)) };
    });
    const total = enc_args.reduce((n, a) => n + (a.bytes ? a.bytes.length : 0), 0);
    if (total > scratch.byteLength) {
      scratch = new ArrayBuffer(Math.max(total, scratch.byteLength * 2));
    }
    const view = new Uint8Array(scratch);
    let off = 0;
    const offsets: number[] = [];
    for (const a of enc_args) {
      offsets.push(off);
      if (a.bytes) {
        view.set(a.bytes, off);
        off += a.bytes.length;
      }
    }
    const base = total > 0 ? ptr(scratch) : 0;
    const lowered: unknown[] = [];
    enc_args.forEach((a, i) => {
      if (!a.bytes) lowered.push(a.scalar);
      else if (a.bytes.length === 0) lowered.push(null, 0);
      else lowered.push(base + offsets[i], a.bytes.length);
    });
    const st = sym[fr.symbol](...lowered, OUT_PTR) as number;
    if (st === 1) throw new RustError(take(true) as string);
    if (st === 2) throw new RustPanicError(take(true) as string);
    if (st === 3) throw new RustError(`invalid input: ${take(true) as string}`);
    check(st === 0, `${name}: unexpected status ${st}`);
    const r = fr.ret.type;
    switch (r.t) {
      case 'unit':
        return undefined;
      case 'string':
        return take(true);
      case 'bytes':
        return take(false);
      case 'bool':
        return OUT_VIEW.getUint8(0) !== 0;
      case 'i8':
        return OUT_VIEW.getInt8(0);
      case 'u8':
        return OUT_VIEW.getUint8(0);
      case 'i16':
        return OUT_VIEW.getInt16(0, true);
      case 'u16':
        return OUT_VIEW.getUint16(0, true);
      case 'i32':
        return OUT_VIEW.getInt32(0, true);
      case 'u32':
        return OUT_VIEW.getUint32(0, true);
      case 'i64':
      case 'isize':
        return OUT_VIEW.getBigInt64(0, true);
      case 'u64':
      case 'usize':
        return OUT_VIEW.getBigUint64(0, true);
      case 'f32':
        return OUT_VIEW.getFloat32(0, true);
      case 'f64':
        return OUT_VIEW.getFloat64(0, true);
      default:
        return JSON.parse(take(true) as string);
    }
  };
  return { recs, fns, sym, call };
}

// ---- modes --------------------------------------------------------------------

function countIn(src: string, attr: string): number {
  return src.split('\n').filter((l) => l.trim() === attr).length;
}

function modeManifest(path: string): number {
  const { recs, fns, sym } = load(path, false);
  const src = readFileSync(join(import.meta.dir, '../knext-ffi-fixture/src/lib.rs'), 'utf8');
  const wantFns = countIn(src, '#[export]');
  const wantTypes = countIn(src, '#[record]');
  const types = new Map<string, RecordRec | EnumRec>();
  for (const r of recs) {
    check(r.v === 1, `unknown manifest version ${JSON.stringify(r)}`);
    if (r.kind !== 'fn') {
      check(!types.has(r.name), `duplicate record ${r.name}`);
      types.set(r.name, r);
    }
  }
  check(fns.length === wantFns, `fn records: ${fns.length}, #[export] in fixture: ${wantFns}`);
  check(
    types.size === wantTypes,
    `type records: ${types.size}, #[record] in fixture: ${wantTypes}`,
  );
  check(recs.length === wantFns + wantTypes, `stray KNEXTFFI1 records: ${recs.length}`);
  for (const f of fns) {
    const sig = `${f.name}(${f.args.map((a) => tok(a.type)).join(',')})->${tok(f.ret.type)}`;
    check(sig === f.sig, `${f.name}: sig ${f.sig} != rebuilt ${sig}`);
    const want = `knext_ffi_v1_${f.name}_${fnv32(f.sig).toString(16).padStart(8, '0')}`;
    check(f.symbol === want, `${f.name}: symbol ${f.symbol} != ${want}`);
    const expect = fnv64(schemaString(f, types));
    const got = sym[`${f.symbol}_schema`]() as bigint;
    check(got === expect, `${f.name}: _schema() ${got.toString(16)} != ${expect.toString(16)}`);
  }
  const greet = fns.find((f) => f.name === 'greet');
  check(greet?.doc === 'Says hello.', `doc comment carried: ${greet?.doc}`);
  console.log(`manifest: ${fns.length} fn + ${types.size} type records, symbols and schemas ok`);
  return 0;
}

function eq(a: unknown, b: unknown, what: string): void {
  const s = (x: unknown) =>
    JSON.stringify(x, (_k, v) =>
      typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v,
    );
  check(s(a) === s(b), `${what}: ${s(a)} != ${s(b)}`);
}

function throws(f: () => unknown, cls: typeof Error, msg: string, what: string): void {
  try {
    f();
  } catch (e) {
    check(e instanceof cls, `${what}: wrong error class ${(e as Error).constructor.name}`);
    check((e as Error).message.includes(msg), `${what}: message ${(e as Error).message}`);
    return;
  }
  fail(`${what}: did not throw`);
}

function point(label: string) {
  return {
    id: '18446744073709551615',
    delta: '-9007199254740993',
    size: '9007199254740993',
    offset: '-1',
    x: 1.5,
    y: -2.25,
    small: 7,
    label,
    tags: ['a', '日本'],
    maybe: null,
    color: 'Green',
    raw: [0, 255],
    child: { name: 'kid', flag: false },
    ids: ['9007199254740993'],
    count: '18446744073709551615' as string | null,
    deltas: ['-9223372036854775808', null, '9007199254740993', '-1'] as (string | null)[],
  };
}

function modeRoundtrip(path: string): number {
  const { call } = load(path, false);
  for (const s of ['World', '', 'héllo 👩‍👩‍👧‍👦 🦀', 'nul\0inside', 'x'.repeat(1 << 20)]) {
    eq(call('greet', s), `Hello, ${s}!`, 'greet(String)');
    eq(call('greet_ref', s), `Hello, ${s}!`, 'greet_ref(&str)');
    eq(call('echo_string', s), s, 'echo_string');
  }
  // Two large strings: the second forces the scratch buffer to grow after the
  // first was encoded; pointers are computed only after both are in place.
  const a = 'a'.repeat(3 << 20);
  const b = 'é'.repeat(1 << 20);
  eq(call('concat', a, b), a + b, 'concat(two large strings)');
  eq(call('concat', 'x', ''), 'x', 'concat with an empty second argument');
  eq(call('bytes_len', new Uint8Array(0)), 0n, 'empty Uint8Array passed as NULL');
  eq(call('echo_bytes', new Uint8Array(0)), new Uint8Array(0), 'empty bytes return is (0, 0)');
  const big = new Uint8Array(1 << 20).map((_, i) => i * 7);
  eq(call('echo_bytes', big), big, 'echo_bytes(1 MiB)');
  eq(call('sum_bytes', new Uint8Array([1, 2, 250])), 253n, 'sum_bytes(&[u8])');
  eq(call('echo_i64', -(2n ** 53n) - 1n), -(2n ** 53n) - 1n, 'i64 beyond 2^53');
  eq(call('echo_u64', 2n ** 64n - 1n), 2n ** 64n - 1n, 'u64::MAX');
  eq(call('echo_usize', 2n ** 53n + 1n), 2n ** 53n + 1n, 'usize beyond 2^53');
  eq(call('add', 2, 40), 42, 'add');
  eq(call('not', true), false, 'bool');
  eq(call('echo_f64', Math.PI), Math.PI, 'f64');
  eq(call('echo_point', point('p')), point('p'), 'record with 64-bit decimal strings');
  eq(
    call('echo_point', { ...point('n'), count: null, deltas: [] }),
    { ...point('n'), count: null, deltas: [] },
    'Option<usize> null and an empty Vec<Option<i64>> field',
  );
  throws(
    () => call('echo_point', { ...point('q'), count: 5 }),
    RustError,
    'invalid input',
    'JSON number in an Option<usize> field',
  );
  throws(
    () => call('echo_point', { ...point('q'), deltas: [null, -5] }),
    RustError,
    'invalid input',
    'JSON number in a Vec<Option<i64>> field',
  );
  eq(call('echo_opt_u64', '18446744073709551615'), '18446744073709551615', 'Option<u64>');
  eq(call('echo_vec_i64', ['-9223372036854775808']), ['-9223372036854775808'], 'Vec<i64>');
  eq(call('next_color', 'Blue'), 'Red', 'enum');
  eq(call('noop'), undefined, 'unit');
  throws(() => call('parse_i32', 'x'), RustError, 'invalid digit found in string', 'Err');
  throws(() => call('echo_opt_u64', 5), RustError, 'invalid input', 'JSON number for a u64');
  eq(call('parse_i32', '41'), 41, 'Ok after Err');
  console.log('roundtrip: ok');
  return 0;
}

function modePanic(path: string): number {
  const { call } = load(path, false);
  for (let i = 0; i < 1000; i++) {
    throws(() => call('boom', `boom ${i}`), RustPanicError, `boom ${i}`, `panic ${i}`);
  }
  throws(() => call('boom_any'), RustPanicError, 'panic with a non-string payload', 'panic_any');
  eq(call('add', 1, 2), 3, 'the call after 1000 panics');
  console.log('panic: 1000 panics caught, process alive, next call correct');
  return 0;
}

function rssMb(): number {
  Bun.gc(true);
  Bun.gc(true);
  return process.memoryUsage().rss / 2 ** 20;
}

const LEAK_PHASES = ['String', 'Vec<u8>', 'record'] as const;

// One phase in this process: warm up, then RSS growth over LEAK_CALLS calls.
// Exit 0 = under the bound, 1 = over it.
function modeLeakPhase(path: string, phase: string, noFree: boolean): number {
  const { call } = load(path, noFree);
  const s256 = 's'.repeat(256);
  const b256 = new Uint8Array(256).map((_, i) => i);
  const rec = point('leak');
  const f: () => unknown =
    phase === 'String'
      ? () => call('echo_string', s256)
      : phase === 'Vec<u8>'
        ? () => call('echo_bytes', b256)
        : phase === 'record'
          ? () => call('echo_point', rec)
          : fail(`unknown leak phase ${phase}`);
  for (let i = 0; i < 10_000; i++) f();
  const before = rssMb();
  for (let i = 0; i < LEAK_CALLS; i++) f();
  const growth = rssMb() - before;
  const over = growth > LEAK_BOUND_MB;
  const sign = growth >= 0 ? '+' : '';
  console.log(
    `leak: ${phase}: ${LEAK_CALLS} calls, RSS ${sign}${growth.toFixed(1)} MB (bound ${LEAK_BOUND_MB} MB) ${over ? 'OVER' : 'ok'}${noFree ? ' [--no-free]' : ''}`,
  );
  return over ? 1 : 0;
}

// Each phase runs in a fresh process, so one phase's leaked pages (which the
// OS may compress or swap out) cannot hide or inflate the next phase's growth.
function modeLeak(path: string, noFree: boolean): number {
  let over = 0;
  for (const phase of LEAK_PHASES) {
    const args = [import.meta.path, 'leak-phase', path, phase, ...(noFree ? ['--no-free'] : [])];
    const r = Bun.spawnSync([process.execPath, ...args], { stdout: 'inherit', stderr: 'inherit' });
    if (r.exitCode === 1) over++;
    else if (r.exitCode !== 0) fail(`leak phase ${phase} crashed (exit ${r.exitCode})`);
  }
  return over;
}

const [mode, lib, arg3, arg4] = process.argv.slice(2);
const flag = mode === 'leak-phase' ? arg4 : arg3;
if (!mode || !lib) fail('usage: ffi-harness.ts <manifest|roundtrip|panic|leak> <lib> [--no-free]');
const noFree = flag === '--no-free';
let code: number;
switch (mode) {
  case 'manifest':
    code = modeManifest(lib);
    break;
  case 'roundtrip':
    code = modeRoundtrip(lib);
    break;
  case 'panic':
    code = modePanic(lib);
    break;
  case 'leak':
    code = modeLeak(lib, noFree);
    break;
  case 'leak-phase':
    code = modeLeakPhase(lib, arg3, noFree);
    break;
  default:
    fail(`unknown mode ${mode}`);
}
process.exit(code);
