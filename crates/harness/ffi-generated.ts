// The @getknext/ffi generator against REAL Rust libraries built from these
// crates: the half of the generator's tests that needs cargo, so it runs in the
// Rust crates lane, not in the bun suite (whose checkout has no pinned Rust
// toolchain). The bun suite proves the same generated code against a C
// stand-in (packages/ffi/fixtures/abi-v1/fixture.c); this proves it against
// what the macros actually emit.
//
//   bun crates/harness/ffi-generated.ts wrapper <path-to-fixture-lib>
//   bun crates/harness/ffi-generated.ts init
//
// Modes (exit 0 = pass, 1 = a check failed, 10 = the harness could not run):
//   wrapper  scan the release-profile fixture library with the generator's own
//            scanner (every #[export] and #[record] in the fixture source is
//            there), render the module, stage the library the way an image does
//            (native/ffi/<triple>/ + a sha256 integrity manifest, NODE_ENV=
//            production) and call through the generated module: scalars,
//            strings, bytes, records with 64-bit fields, enums, Option/Vec,
//            Err, a panic, and the non-finite float rule in every JSON position
//            (refused by the wrapper on the way out, by Rust on the way back)
//   init     `knext ffi init` with the knext-ffi revision this @getknext/ffi
//            records, the written Cargo.toml checked for the exact git+rev
//            line, then `knext ffi generate` builds that crate AS WRITTEN (cargo
//            fetches knext-ffi from GitHub at that revision), `knext ffi check`
//            passes, sees a drifted wrapper, and the generated module calls the
//            development build.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runGenerate } from '../../packages/ffi/src/generate';
import { CRATE_GIT, recordedCrateRev, runInit } from '../../packages/ffi/src/init';
import { scanManifest } from '../../packages/ffi/src/manifest';
import { libNameOf, renderModule } from '../../packages/ffi/src/render';

const HARNESS_ERROR = 10;
const FIXTURE_SRC = resolve(import.meta.dir, '..', 'knext-ffi-fixture', 'src', 'lib.rs');
const scratch: string[] = [];
let failures = 0;

function die(msg: string): never {
  console.error(`ffi-generated: cannot run: ${msg}`);
  cleanup();
  process.exit(HARNESS_ERROR);
}
function check(cond: unknown, msg: string): void {
  if (cond) return;
  failures++;
  console.error(`ffi-generated: FAIL: ${msg}`);
}
function same(actual: unknown, expected: unknown, what: string): void {
  check(
    isDeepStrictEqual(actual, expected),
    `${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
  );
}
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `knext-ffi-gen-${prefix}-`));
  scratch.push(d);
  return d;
}
function cleanup(): void {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
}

/** The triple the generated module computes for this host (same rule as its $triple). */
function hostTriple(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  let musl = false;
  try {
    musl = readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {}
  return `${arch}-unknown-linux-${musl || existsSync('/etc/alpine-release') ? 'musl' : 'gnu'}`;
}

/** An app directory with Next's `server-only` (resolvable under react-server only). */
function app(dir: string): void {
  writeFileSync(join(dir, 'package.json'), '{"type":"module","private":true}\n');
  const so = join(dir, 'node_modules', 'server-only');
  mkdirSync(so, { recursive: true });
  writeFileSync(
    join(so, 'package.json'),
    JSON.stringify({
      name: 'server-only',
      exports: { '.': { 'react-server': './empty.js', default: './index.js' } },
    }),
  );
  writeFileSync(join(so, 'empty.js'), '');
  writeFileSync(join(so, 'index.js'), 'throw new Error("server-only");\n');
}

const CHILD = `// Runs BODY(m, c) against the generated module; prints RESULT <json>.
const fake = process.env.FAKE_EXEC;
if (fake) process.execPath = fake;
const m = await import('./src/generated/ffi/index.ts');
const c = (f) => {
  try {
    return { ok: f() };
  } catch (e) {
    const cls = e instanceof m.FfiLoadError ? 'FfiLoadError'
      : e instanceof m.RustPanicError ? 'RustPanicError'
      : e instanceof m.RustError ? 'RustError'
      : e instanceof TypeError ? 'TypeError' : 'other';
    return { cls, message: e.message };
  }
};
const result = await (0, eval)('(' + process.env.BODY + ')')(m, c);
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v instanceof Uint8Array ? { bytes: Array.from(v) } : v === undefined ? '<undefined>' : v);
console.log('RESULT ' + JSON.stringify(result, replacer));
`;

/** Run `body` in a fresh Bun process (the module caches its first load) under react-server. */
function inBun(
  dir: string,
  // biome-ignore lint/suspicious/noExplicitAny: the body runs in another process, untyped.
  body: (m: any, c: (f: () => unknown) => unknown) => unknown,
  env: Record<string, string>,
): unknown {
  writeFileSync(join(dir, 'child.ts'), CHILD);
  const r = spawnSync(process.execPath, ['--conditions=react-server', 'child.ts'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NEXT_PHASE: '', BODY: body.toString(), ...env },
    timeout: 120_000,
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (r.status !== 0 || line === undefined) {
    check(false, `the child process failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
    return undefined;
  }
  return JSON.parse(line.slice(7));
}

// ---- wrapper: the fixture library ---------------------------------------------------

function wrapper(libPath: string): void {
  if (!existsSync(libPath)) die(`${libPath} does not exist (build the fixture first)`);
  const libName = libNameOf(basename(libPath));
  if (libName === undefined) die(`${basename(libPath)} is not lib<name>.so/.dylib`);

  // The scanner reads every record the macros embedded, from the bytes alone.
  const manifest = scanManifest(readFileSync(libPath));
  const src = readFileSync(FIXTURE_SRC, 'utf8');
  const exports = [...src.matchAll(/#\[export\]\s*(?:\/\/\/[^\n]*\n\s*)*pub fn (\w+)/g)].map(
    (x) => x[1] as string,
  );
  check(exports.length > 30, `only ${exports.length} #[export]s found in ${FIXTURE_SRC}`);
  same(
    manifest.fns.map((f) => f.name),
    [...exports].sort(),
    'the scanned functions are exactly the fixture source #[export]s',
  );
  same(
    manifest.records.map((r) => r.name),
    ['Child', 'Point', 'Reading'],
    'records',
  );
  same(
    manifest.enums.map((e) => e.name),
    ['Color'],
    'enums',
  );

  // Stage it the way an image does: production, integrity-checked.
  const dir = tempDir('wrapper');
  app(dir);
  mkdirSync(join(dir, 'src', 'generated', 'ffi'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'generated', 'ffi', 'index.ts'),
    renderModule(manifest, { libName, crate: 'rust' }),
  );
  const image = join(dir, 'image');
  const triple = hostTriple();
  const rel = `ffi/${triple}/${basename(libPath)}`;
  mkdirSync(join(image, 'native', 'ffi', triple), { recursive: true });
  copyFileSync(libPath, join(image, 'native', rel));
  writeFileSync(
    join(image, 'native', '.integrity.json'),
    JSON.stringify({
      version: 1,
      algorithm: 'sha256',
      packages: {},
      files: {
        [rel]: createHash('sha256')
          .update(readFileSync(join(image, 'native', rel)))
          .digest('hex'),
      },
    }),
  );

  const result = inBun(
    dir,
    (m, c) => {
      const two = (n: number) => BigInt(2) ** BigInt(n);
      const point = {
        id: two(64) - BigInt(1),
        delta: -two(62),
        size: two(53) + BigInt(1),
        offset: BigInt(-5),
        x: 1.25,
        y: 0.5,
        small: 255,
        label: 'héllo 🌍',
        tags: ['a', ''],
        maybe: null,
        color: 'Blue',
        raw: [0, 255],
        child: { name: 'kid', flag: true },
        ids: [two(60), BigInt(0)],
        count: two(63),
        deltas: [BigInt(-1), null],
      };
      return {
        greet: [m.greet('World'), m.greet_ref(''), m.concat('a', 'é'.repeat(3000)).length],
        add: m.add(2, 3),
        u64: m.echo_u64(two(64) - BigInt(1)),
        f64: m.echo_f64(Number.NaN),
        not: m.not(false),
        bytes: [m.echo_bytes(new Uint8Array([0, 255, 7])), m.sum_bytes(new Uint8Array(0))],
        noop: m.noop(),
        point: m.echo_point(point),
        mid: m.mid(point, { ...point, x: 3.25 }).x,
        color: m.next_color('Blue'),
        opt: [m.echo_opt_u64(two(64) - BigInt(1)), m.echo_opt_u64(null)],
        vec: [m.echo_vec_i64([-two(63), two(53) + BigInt(1)]), m.echo_vec_string(['', 'x'])],
        parse: [m.parse_i32(' 42 '), c(() => m.parse_i32('x'))],
        fallible: c(() => m.fallible_unit(true)),
        boom: c(() => m.boom('kaboom')),
        afterBoom: m.add(1, 1),
        // Floats inside JSON: finite ones cross, in every position.
        optF64: [m.echo_opt_f64(1.5), m.echo_opt_f64(null)],
        reading: m.echo_reading({ value: 2.5, samples: [0.5, null, -3] }),
        // Refused by the wrapper before the call: never sent as null.
        wrapNaN: c(() => m.echo_opt_f64(Number.NaN)),
        wrapInf: c(() => m.echo_reading({ value: null, samples: [1, Number.NEGATIVE_INFINITY] })),
        wrapField: c(() => m.echo_point({ ...point, x: Number.POSITIVE_INFINITY })),
        // Refused by Rust: a number that does not fit a finite f32, and a
        // non-finite float Rust returns inside an Option or a record.
        f32Overflow: c(() => m.echo_reading({ value: null, samples: [1e300] })),
        rustNaN: c(() => m.non_finite_opt(0)),
        rustInf: c(() => m.non_finite_opt(1)),
        rustReading: c(() => m.non_finite_reading()),
        afterRefusals: m.echo_opt_f64(0.25),
      };
    },
    { FAKE_EXEC: join(image, 'server'), NODE_ENV: 'production' },
  ) as Record<string, unknown> | undefined;
  if (result === undefined) return;

  const refusedJs = (fn: string, at: string, got: string) => ({
    cls: 'TypeError',
    message: `${fn}(): argument "${at}" must be a finite number (JSON has no NaN or Infinity), got ${got}`,
  });
  const refusedRust = (fn: string, path: string, t: string, shown: string) => ({
    cls: 'RustError',
    message: `invalid input: knext-ffi: the return value cannot cross as JSON: ${path}: ${t} ${shown} is not finite (JSON has no NaN or Infinity)`,
  });
  const f32Overflow = result.f32Overflow as { cls: string; message: string };
  delete result.f32Overflow;
  same(f32Overflow.cls, 'RustError', 'a number that does not fit an f32 is a RustError');
  check(
    f32Overflow.message.startsWith(
      'invalid input: knext-ffi: argument `r` could not be decoded: the number does not fit a finite f32',
    ),
    `f32 overflow message: ${f32Overflow.message}`,
  );
  same(
    result,
    {
      greet: ['Hello, World!', 'Hello, !', 3001],
      add: 5,
      u64: '18446744073709551615n',
      f64: null, // NaN, through JSON.stringify of the RESULT line: a raw f64 crosses intact
      not: true,
      bytes: [{ bytes: [0, 255, 7] }, '0n'],
      noop: '<undefined>',
      point: {
        id: '18446744073709551615n',
        delta: '-4611686018427387904n',
        size: '9007199254740993n',
        offset: '-5n',
        x: 1.25,
        y: 0.5,
        small: 255,
        label: 'héllo 🌍',
        tags: ['a', ''],
        maybe: null,
        color: 'Blue',
        raw: [0, 255],
        child: { name: 'kid', flag: true },
        ids: ['1152921504606846976n', '0n'],
        count: '9223372036854775808n',
        deltas: ['-1n', null],
      },
      mid: 2.25,
      color: 'Red',
      opt: ['18446744073709551615n', null],
      vec: [
        ['-9223372036854775808n', '9007199254740993n'],
        ['', 'x'],
      ],
      parse: [42, { cls: 'RustError', message: 'invalid digit found in string' }],
      fallible: { cls: 'RustError', message: 'failed on purpose' },
      boom: { cls: 'RustPanicError', message: 'kaboom' },
      afterBoom: 2,
      optF64: [1.5, null],
      reading: { value: 2.5, samples: [0.5, null, -3] },
      wrapNaN: refusedJs('echo_opt_f64', 'v', 'NaN'),
      wrapInf: refusedJs('echo_reading', 'r.samples[1]', '-Infinity'),
      wrapField: refusedJs('echo_point', 'p.x', 'Infinity'),
      rustNaN: refusedRust('non_finite_opt', 'result', 'f64', 'NaN'),
      rustInf: refusedRust('non_finite_opt', 'result', 'f64', 'Infinity'),
      rustReading: refusedRust('non_finite_reading', 'result.samples[2]', 'f32', 'NaN'),
      afterRefusals: 0.25,
    },
    'calls through the generated module against the real fixture library',
  );
}

// ---- init: the crate `knext ffi init` writes, built as written ----------------------

async function init(): Promise<void> {
  const rev = recordedCrateRev();
  if (rev === null || !/^[0-9a-f]{40}$/.test(rev)) {
    check(false, `@getknext/ffi records no full knext-ffi revision (got ${String(rev)})`);
    return;
  }
  const dir = tempDir('init');
  let err = '';
  const io = {
    stdout: (s: string) => {
      process.stdout.write(s);
    },
    stderr: (s: string) => {
      err += s;
      process.stderr.write(s);
    },
  };
  same(runInit({ cwd: dir, io }), 0, 'knext ffi init exits 0');
  const cargoToml = readFileSync(join(dir, 'rust', 'Cargo.toml'), 'utf8');
  check(
    cargoToml.includes(`knext-ffi = { git = "${CRATE_GIT}", rev = "${rev}" }`),
    `rust/Cargo.toml does not pin knext-ffi to ${rev}:\n${cargoToml}`,
  );
  app(dir);

  // generate: cargo builds the crate exactly as written (no patch, no path
  // override), fetching knext-ffi at the recorded revision.
  same(await runGenerate({ cwd: dir, io }), 0, 'knext ffi generate exits 0');
  const index = join(dir, 'src', 'generated', 'ffi', 'index.ts');
  check(existsSync(index), 'knext ffi generate wrote src/generated/ffi/index.ts');
  same(await runGenerate({ cwd: dir, io, check: true }), 0, 'knext ffi check passes');
  appendFileSync(index, '// drift\n');
  err = '';
  same(await runGenerate({ cwd: dir, io, check: true }), 1, 'knext ffi check sees a drift');
  check(err.includes('out of date'), `knext ffi check names the drift: ${err}`);
  same(await runGenerate({ cwd: dir, io }), 0, 'knext ffi generate repairs it');

  const greeting = inBun(dir, (m) => m.greet('World'), { NODE_ENV: 'development' });
  same(greeting, 'Hello, World!', 'the starter greet() through the generated module');
}

function finish(): never {
  cleanup();
  if (failures > 0) {
    console.error(`ffi-generated: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('ffi-generated: ok');
  process.exit(0);
}

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === 'wrapper' && arg !== undefined) wrapper(resolve(arg));
  else if (mode === 'init') await init();
  else die('usage: bun crates/harness/ffi-generated.ts wrapper <lib> | init');
} catch (e) {
  die(e instanceof Error ? (e.stack ?? e.message) : String(e));
}
finish();
