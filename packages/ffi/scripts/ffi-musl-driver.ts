// The musl load matrix's caller (ADR-0069 D20): the GENERATED wrapper of the
// knext-ffi-fixture crate, loaded on Alpine (musl) from `native/ffi/<triple>/`
// beside the running executable, through the production path only
// (NODE_ENV=production: integrity-checked, no development fallback).
//
// stage-musl-load.ts copies this file next to the generated module as
// `driver.ts` (the static import below is then `./src/generated/ffi/index.ts`)
// and the workflow runs it two ways inside oven/bun:1.4.2-alpine with a
// read-only root file system and a read-only TMPDIR:
//   - `bun --conditions=react-server driver.ts`, with native/ mounted beside
//     the bun binary (process.execPath);
//   - compiled with `bun build --compile` and run with native/ beside the exe.
//
// What it asserts, each a hard failure (exit 1):
//   1. the environment really is the one claimed: musl, NODE_ENV=production,
//      the root file system and TMPDIR both refuse a write;
//   2. EVERY function the generated module exports is called (the set of
//      exports and the set of cases must be equal, so a new fixture export
//      with no case fails here), with each result checked;
//   3. the Err paths throw RustError with the Rust message, the panic paths
//      throw RustPanicError (so a panic unwound through the library's own
//      unwinder into catch_unwind) 1000 times in a row, and the process then
//      still answers correctly;
//   4. the leak check (`leak <phase>`, one phase per process): after 1e6
//      warm-up calls, RSS growth over 1e6 more calls of a String, a Vec<u8> or
//      a record export (after a full GC) stays under LEAK_BOUND_MB; exit 3 when
//      it does not. The workflow also runs it against a MUTATED wrapper that
//      never frees a returned buffer (stage-musl-load.ts, app-leak/): that run
//      must exit 3, which proves the check sees a real native leak.
// It prints one `KNEXT_FFI_SUMMARY {json}` line (timings, RSS numbers) for the
// job summary.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as m from './src/generated/ffi/index.ts';

const LEAK_CALLS = 1_000_000;
const LEAK_BOUND_MB = 48;
const PANICS = 1000;
const TIMING_CALLS = 200_000;

const summary: Record<string, unknown> = {
  bun: process.versions.bun,
  arch: process.arch,
  execPath: process.execPath,
};

function fail(msg: string): never {
  console.error(`ffi-musl-driver: FAIL: ${msg}`);
  process.exit(1);
}

function refusesWrite(dir: string): string | null {
  const probe = join(dir, `.knext-ffi-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'x');
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'error';
  }
}

// ---- 1. the environment -------------------------------------------------------

function checkEnvironment(): void {
  // Bracket access, as the generated wrapper reads it: `bun build --compile`
  // inlines the dotted `process.env.NODE_ENV` as "development" (measured on
  // 1.4.2), so the dotted form would test the bundler, not the environment.
  // biome-ignore lint/complexity/useLiteralKeys: the dotted form is inlined at compile time.
  if (process.env['NODE_ENV'] !== 'production') fail('NODE_ENV must be "production"');
  const musl =
    existsSync('/etc/alpine-release') || readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  if (!musl) fail('not a musl system');
  const root = refusesWrite('/');
  if (root === null) fail('the root file system accepted a write; run with --read-only');
  const tmp = refusesWrite(tmpdir());
  if (tmp === null) fail(`TMPDIR (${tmpdir()}) accepted a write; it must be read-only`);
  summary.readOnly = { root, tmpdir: tmpdir(), tmp };
}

// ---- 2. every export ----------------------------------------------------------

const point = (label: string): m.Point => ({
  id: 2n ** 64n - 1n,
  delta: -(2n ** 63n),
  size: 2n ** 53n + 1n,
  offset: -7n,
  x: 1.25,
  y: 0.5,
  small: 255,
  label,
  tags: ['a', 'é', '🦀'],
  maybe: null,
  color: 'Blue',
  raw: [0, 1, 255],
  child: { name: 'kid', flag: true },
  ids: [0n, 2n ** 63n],
  count: 9n,
  deltas: [null, -1n],
});

function throwsClass(fn: () => unknown, cls: unknown, message: string, what: string): void {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof (cls as new (...a: never[]) => Error))) {
      fail(
        `${what}: threw ${(err as Error)?.name} (${(err as Error)?.message}), wanted ${(cls as { name: string }).name}`,
      );
    }
    if ((err as Error).message !== message) {
      fail(
        `${what}: message ${JSON.stringify((err as Error).message)}, wanted ${JSON.stringify(message)}`,
      );
    }
    return;
  }
  fail(`${what}: did not throw`);
}

const bytes = (u: Uint8Array) => Array.from(u);
const big1MiB = 'z'.repeat(1 << 20);
const scratchFits = 'a'.repeat(3000);
const scratchGrows = 'b'.repeat(200_000);

// One case per export, by name. The keys must equal the module's exported
// functions exactly (checked below).
const CASES: Record<string, () => void> = {
  echo_i8: () => {
    assert.equal(m.echo_i8(-128), -128);
    assert.equal(m.echo_i8(127), 127);
    throwsClass(
      () => m.echo_i8(128),
      TypeError,
      'echo_i8(): argument "v" must be an integer from -128 to 127, got 128',
      'echo_i8 out of range',
    );
  },
  echo_i16: () => assert.equal(m.echo_i16(-32768), -32768),
  echo_i32: () => assert.equal(m.echo_i32(-2147483648), -2147483648),
  echo_u8: () => assert.equal(m.echo_u8(255), 255),
  echo_u16: () => assert.equal(m.echo_u16(65535), 65535),
  echo_u32: () => assert.equal(m.echo_u32(4294967295), 4294967295),
  echo_i64: () => {
    assert.equal(m.echo_i64(-(2n ** 63n)), -(2n ** 63n));
    assert.equal(m.echo_i64(2n ** 63n - 1n), 2n ** 63n - 1n);
  },
  echo_u64: () => assert.equal(m.echo_u64(2n ** 64n - 1n), 2n ** 64n - 1n),
  echo_isize: () => assert.equal(m.echo_isize(-(2n ** 63n)), -(2n ** 63n)),
  echo_usize: () => assert.equal(m.echo_usize(2n ** 64n - 1n), 2n ** 64n - 1n),
  echo_f32: () => assert.equal(m.echo_f32(1.5), 1.5),
  echo_f64: () => assert.equal(m.echo_f64(Math.PI), Math.PI),
  not: () => {
    assert.equal(m.not(true), false);
    assert.equal(m.not(false), true);
  },
  add: () => {
    assert.equal(m.add(2, 3), 5);
    assert.equal(m.add(2147483647, 1), -2147483648);
  },
  greet: () => assert.equal(m.greet('Alpine'), 'Hello, Alpine!'),
  greet_ref: () => assert.equal(m.greet_ref('é🦀'), 'Hello, é🦀!'),
  echo_string: () => {
    assert.equal(m.echo_string('a\0b'), 'a\0b');
    assert.equal(m.echo_string(''), '');
    assert.equal(m.echo_string(big1MiB), big1MiB);
  },
  str_len: () => assert.equal(m.str_len('é🦀'), 6n),
  concat: () => {
    const r = m.concat(scratchFits, scratchGrows);
    assert.equal(r.length, scratchFits.length + scratchGrows.length);
    assert.ok(
      r === scratchFits + scratchGrows,
      'concat: bytes differ after the scratch buffer grew',
    );
  },
  empty_string: () => assert.equal(m.empty_string(), ''),
  make_string: () => assert.equal(m.make_string(5), 'xxxxx'),
  echo_bytes: () => {
    assert.deepEqual(bytes(m.echo_bytes(new Uint8Array([0, 1, 255]))), [0, 1, 255]);
    assert.equal(m.echo_bytes(new Uint8Array(0)).length, 0);
  },
  sum_bytes: () => assert.equal(m.sum_bytes(new Uint8Array([1, 2, 3, 250])), 256n),
  bytes_len: () => {
    assert.equal(m.bytes_len(new Uint8Array(0)), 0n);
    assert.equal(m.bytes_len(new Uint8Array(4096)), 4096n);
  },
  empty_bytes: () => assert.equal(m.empty_bytes().length, 0),
  make_bytes: () => {
    const b = m.make_bytes(300);
    assert.equal(b.length, 300);
    assert.equal(b[299], 299 % 256);
  },
  noop: () => assert.equal(m.noop(), undefined),
  unit_ret: () => assert.equal(m.unit_ret(7), undefined),
  echo_point: () => assert.deepEqual(m.echo_point(point('p')), point('p')),
  mid: () => {
    const a = point('a');
    const b = { ...point('b'), x: 3.25, y: 1.5 };
    assert.deepEqual(m.mid(a, b), { ...a, x: 2.25, y: 1 });
  },
  next_color: () => assert.equal(m.next_color('Blue'), 'Red'),
  echo_opt_i64: () => {
    assert.equal(m.echo_opt_i64(null), null);
    assert.equal(m.echo_opt_i64(-(2n ** 62n)), -(2n ** 62n));
  },
  echo_opt_u64: () => assert.equal(m.echo_opt_u64(2n ** 64n - 1n), 2n ** 64n - 1n),
  echo_opt_string: () => {
    assert.equal(m.echo_opt_string(null), null);
    assert.equal(m.echo_opt_string('s'), 's');
  },
  echo_vec_point: () =>
    assert.deepEqual(m.echo_vec_point([point('x'), point('y')]), [point('x'), point('y')]),
  echo_vec_i64: () => assert.deepEqual(m.echo_vec_i64([-1n, 2n ** 62n]), [-1n, 2n ** 62n]),
  echo_vec_usize: () =>
    assert.deepEqual(m.echo_vec_usize([0n, 2n ** 64n - 1n]), [0n, 2n ** 64n - 1n]),
  echo_vec_string: () => assert.deepEqual(m.echo_vec_string(['a', '', 'é']), ['a', '', 'é']),
  echo_opt_color: () => {
    assert.equal(m.echo_opt_color(null), null);
    assert.equal(m.echo_opt_color('Green'), 'Green');
  },
  parse_i32: () => {
    assert.equal(m.parse_i32(' 42 '), 42);
    throwsClass(
      () => m.parse_i32('x'),
      m.RustError,
      'invalid digit found in string',
      'parse_i32 Err',
    );
  },
  fallible_unit: () => {
    assert.equal(m.fallible_unit(false), undefined);
    throwsClass(() => m.fallible_unit(true), m.RustError, 'failed on purpose', 'fallible_unit Err');
  },
  fallible_point: () => {
    assert.deepEqual(m.fallible_point(false, point('ok')), point('ok'));
    throwsClass(
      () => m.fallible_point(true, point('nope')),
      m.RustError,
      'no point for nope',
      'fallible_point Err',
    );
  },
  boom: () => throwsClass(() => m.boom('kaboom'), m.RustPanicError, 'kaboom', 'boom panic'),
  boom_static: () =>
    throwsClass(() => m.boom_static(), m.RustPanicError, 'static boom', 'boom_static panic'),
  boom_any: () =>
    throwsClass(
      () => m.boom_any(),
      m.RustPanicError,
      'panic with a non-string payload',
      'boom_any panic',
    ),
};

function checkEveryExport(): void {
  const errorClasses = new Set(['RustError', 'RustPanicError', 'FfiLoadError']);
  const exported = Object.entries(m)
    .filter(([k, v]) => typeof v === 'function' && !errorClasses.has(k))
    .map(([k]) => k)
    .sort();
  const cased = Object.keys(CASES).sort();
  const missing = exported.filter((k) => !cased.includes(k));
  const extra = cased.filter((k) => !exported.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `exports and cases differ: no case for [${missing.join(', ')}], no export for [${extra.join(', ')}]`,
    );
  }
  for (const name of cased) {
    try {
      (CASES[name] as () => void)();
    } catch (err) {
      fail(`${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
  }
  summary.exportsCalled = cased.length;
}

// ---- 3. panics in a row -------------------------------------------------------

function checkPanics(): void {
  for (let i = 0; i < PANICS; i++) {
    throwsClass(() => m.boom(`panic ${i}`), m.RustPanicError, `panic ${i}`, `panic #${i}`);
  }
  assert.equal(m.greet('after the panics'), 'Hello, after the panics!');
  summary.panicsSurvived = PANICS;
}

// ---- timings -------------------------------------------------------------------

function nsPerCall(f: () => unknown): number {
  for (let i = 0; i < 10_000; i++) f();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < TIMING_CALLS; i++) f();
  return Number(process.hrtime.bigint() - t0) / TIMING_CALLS;
}

function timings(): void {
  const p = point('t');
  const buf = new Uint8Array(1024);
  summary.nsPerCall = {
    noop: Math.round(nsPerCall(() => m.noop())),
    add: Math.round(nsPerCall(() => m.add(1, 2))),
    greet: Math.round(nsPerCall(() => m.greet('timing'))),
    sum_bytes_1KiB: Math.round(nsPerCall(() => m.sum_bytes(buf))),
    echo_point: Math.round(nsPerCall(() => m.echo_point(p))),
  };
}

// ---- 4. the leak check -------------------------------------------------------

type BunGlobal = { gc(force: boolean): void; sleepSync(ms: number): void };
const bun = (globalThis as { Bun?: BunGlobal }).Bun;
const rssMb = () => process.memoryUsage().rss / (1024 * 1024);

/**
 * RSS after a full collection. Garbage the phase produced (the returned JS
 * strings and arrays) can take a few collections to give its pages back, so
 * settle up to ten times and keep the LOWEST reading: freed memory comes back
 * on a later pass, a leak never does.
 */
function settledRssMb(before: number): number {
  let low = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 10; i++) {
    bun?.gc(true);
    bun?.gc(true);
    low = Math.min(low, rssMb());
    if (low - before < LEAK_BOUND_MB / 4) break;
    bun?.sleepSync(50);
  }
  return low;
}

function leakPhase(name: string, call: () => unknown): { name: string; growthMb: number } {
  // Warm up with as many calls as are measured: the JS heap's own high-water
  // mark (garbage it keeps between collections) is reached here, so the
  // measured window sees only growth that scales with calls — a leak — and
  // not the plateau any 1e6 short-lived results produce (measured: a String
  // phase plateaus at ~125 MB on Bun 1.4.2/macOS from 3e5 calls to 3e6, with
  // every buffer freed).
  for (let i = 0; i < LEAK_CALLS; i++) call();
  const before = settledRssMb(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < LEAK_CALLS; i++) call();
  const growthMb = Math.round((settledRssMb(before) - before) * 10) / 10;
  return { name, growthMb };
}

const LEAK_PHASES: Record<string, (p: m.Point) => () => unknown> = {
  String: () => () => m.make_string(256),
  'Vec<u8>': () => () => m.make_bytes(256),
  record: (p) => () => m.echo_point(p),
};

/** One leak phase in this process. Returns 0 under the bound, 3 over it. */
function leakCheck(phase: string): number {
  const make = LEAK_PHASES[phase];
  if (!make) fail(`unknown leak phase "${phase}" (one of: ${Object.keys(LEAK_PHASES).join(', ')})`);
  const result = leakPhase(phase, make(point('leak')));
  const over = result.growthMb > LEAK_BOUND_MB;
  summary.leak = {
    phase,
    calls: LEAK_CALLS,
    boundMb: LEAK_BOUND_MB,
    growthMb: result.growthMb,
    over,
  };
  return over ? 3 : 0;
}

// ---- main ------------------------------------------------------------------------
//
//   driver all                       environment, every export, panics, timings
//   driver leak <phase>              one leak phase (String | Vec<u8> | record);
//                                    exit 0 under the bound, 3 over it.
// Each leak phase runs in its own process (as crates/harness does), so garbage
// from the checks above or from another phase cannot hide or inflate it.

const mode = process.argv[2];
checkEnvironment();
// The first call loads the library; a load failure is an FfiLoadError naming
// every path tried (and a wrong-triple staging names the triple it found).
try {
  m.noop();
} catch (err) {
  fail(
    `the library did not load: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
  );
}
if (mode === 'all') {
  checkEveryExport();
  checkPanics();
  timings();
  console.log(`KNEXT_FFI_SUMMARY ${JSON.stringify(summary)}`);
  console.log('ffi-musl-driver: PASS');
} else if (mode === 'leak') {
  const code = leakCheck(process.argv[3] ?? '');
  console.log(`KNEXT_FFI_SUMMARY ${JSON.stringify(summary)}`);
  console.log(
    `ffi-musl-driver: leak ${process.argv[3]}: ${code === 0 ? 'under' : 'OVER'} the ${LEAK_BOUND_MB} MB bound`,
  );
  process.exit(code);
} else {
  fail('usage: driver all | driver leak <String|Vec<u8>|record>');
}
