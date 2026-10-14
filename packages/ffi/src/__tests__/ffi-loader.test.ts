/**
 * The GENERATED module, run against a REAL shared library (ADR-0069 D13, D15
 * step 2, D20): every path-resolution branch, the fail-closed integrity check,
 * the development fallback, the wrong-platform and stale-wrapper refusals, the
 * prerender refusal, the Node guard, and the calls themselves (marshalling,
 * 64-bit values above 2^53, JSON records, errors, panics, frees).
 *
 * The library is fixtures/abi-v1/fixture.c — ABI v1 implemented in C and
 * built with the system `cc` — carrying the kitchen-sink manifest. The same
 * generated code is scanned from and called against a REAL Rust library (the
 * crates/knext-ffi-fixture cdylib, and the crate `knext ffi init` writes) by
 * crates/harness/ffi-generated.ts, in the Rust crates CI lane: that half needs
 * cargo, which this suite's checkout does not provide.
 *
 * Each scenario runs in a fresh process — `bun --conditions=react-server`
 * (Next's server condition, so `import 'server-only'` resolves), or `node`
 * for the Node guard — because the module caches its first load.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fnv1a64, type Manifest, scanManifest, schemaString } from '../manifest';
import { renderModule } from '../render';
import { blob, emptyDir, KITCHEN_SINK, PKG_DIR, removeScratchDirs } from './helpers';

const FIXTURE_C = join(PKG_DIR, 'fixtures', 'abi-v1', 'fixture.c');
const EXT = process.platform === 'darwin' ? 'dylib' : 'so';
const LIB = `libfixture.${EXT}`;

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
const TRIPLE = hostTriple();

let work: string;
let app: string;
let manifest: Manifest;
const libs: Record<string, string> = {};

function header(m: Manifest): string {
  const out: string[] = ['#pragma once', '#include <stdint.h>'];
  for (const f of m.fns) {
    out.push(`#define SYM_${f.name} ${f.symbol}`);
    out.push(
      `uint64_t ${f.symbol}_schema(void) { return ${fnv1a64(schemaString(f, m)).toString()}ULL` +
        '\n#ifdef BAD_SCHEMA\n + 1\n#endif\n; }',
    );
  }
  KITCHEN_SINK.forEach((r, i) => {
    const c = JSON.stringify(`KNEXTFFI1${JSON.stringify(r)}`);
    out.push(`__attribute__((used)) const char knext_manifest_${i}[] = ${c};`);
  });
  return `${out.join('\n')}\n`;
}

function cc(name: string, flags: string[]): string {
  const dir = join(work, 'build', name);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, LIB);
  const r = spawnSync(
    'cc',
    ['-shared', '-fPIC', '-O1', '-I', work, ...flags, '-o', out, FIXTURE_C],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`cc ${name} failed: ${r.error?.message ?? ''}${r.stderr}`);
  return out;
}

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** A fresh "image": <dir>/server (the fake execPath) with native/ffi/<triple>/libfixture beside it. */
function image(
  opts: {
    lib?: string;
    triple?: string;
    integrity?: 'ok' | 'mismatch' | 'unlisted' | 'absent' | 'v2';
  } = {},
): string {
  const dir = emptyDir('image');
  const native = join(dir, 'native');
  const triple = opts.triple ?? TRIPLE;
  const rel = `ffi/${triple}/${LIB}`;
  mkdirSync(join(native, 'ffi', triple), { recursive: true });
  copyFileSync(opts.lib ?? (libs.good as string), join(native, rel));
  const integrity = opts.integrity ?? 'ok';
  const files: Record<string, string> = {};
  if (integrity === 'ok' || integrity === 'v2') files[rel] = sha256(join(native, rel));
  if (integrity === 'mismatch') files[rel] = '0'.repeat(64);
  if (integrity === 'unlisted') files['ffi/other.so'] = '0'.repeat(64);
  if (integrity !== 'absent') {
    writeFileSync(
      join(native, '.integrity.json'),
      JSON.stringify({
        version: integrity === 'v2' ? 2 : 1,
        algorithm: 'sha256',
        packages: {},
        files,
      }),
    );
  }
  return join(dir, 'server');
}

interface Run {
  status: number | null;
  result: unknown;
  stdout: string;
  stderr: string;
}

/** Run `body(m, c, fixture)` in a fresh Bun process with the generated module imported as `m`. */
function inBun(
  // biome-ignore lint/suspicious/noExplicitAny: the body runs in another process, untyped.
  body: (m: any, c: (f: () => unknown) => unknown, fixture: any) => unknown,
  env: Record<string, string | undefined> = {},
  args: string[] = ['--conditions=react-server'],
): Run {
  const r = spawnSync(process.execPath, [...args, 'harness.ts'], {
    cwd: app,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', NEXT_PHASE: '', BODY: body.toString(), ...env },
    timeout: 60_000,
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return {
    status: r.status,
    result: line ? JSON.parse(line.slice(7)) : undefined,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

const HARNESS = `// Runs one scenario: BODY is a function (m, c, fixture) => result.
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
    return { cls, message: e.message, fn: e.fn };
  }
};
let fixture;
if (process.env.LIBPATH) {
  const ffi = process.getBuiltinModule('bun:ffi');
  fixture = ffi.dlopen(process.env.LIBPATH, {
    fixture_live: { args: [], returns: 'i64' },
    fixture_last_null: { args: [], returns: 'i32' },
  }).symbols;
}
const result = await (0, eval)('(' + process.env.BODY + ')')(m, c, fixture);
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v instanceof Uint8Array ? { bytes: Array.from(v) } : v === undefined ? '<undefined>' : v);
console.log('RESULT ' + JSON.stringify(result, replacer));
`;

const NODE_HARNESS = `// The Node guard: import (no fs, no bun:ffi), then call.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const touched = [];
for (const k of ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync', 'accessSync', 'realpathSync']) {
  const orig = fs[k];
  fs[k] = function (...a) { touched.push(k + ' ' + String(a[0])); return orig.apply(this, a); };
}
syncBuiltinESMExports();
const getBuiltin = process.getBuiltinModule;
const asked = [];
process.getBuiltinModule = (id) => { asked.push(id); return getBuiltin.call(process, id); };
const m = await import('./src/generated/ffi/index.ts');
const atImport = { touched: [...touched], asked: [...asked], exports: Object.keys(m).sort() };
let call;
try { m.greet('x'); call = { ok: true }; } catch (e) { call = { cls: e instanceof m.FfiLoadError ? 'FfiLoadError' : e.name, message: e.message }; }
let again;
try { m.add(1, 2); } catch (e) { again = e.message === call.message; }
console.log('RESULT ' + JSON.stringify({ atImport, call, again }));
`;

beforeAll(() => {
  work = emptyDir('loader');
  manifest = scanManifest(blob(KITCHEN_SINK));
  writeFileSync(join(work, 'manifest.h'), header(manifest));
  libs.good = cc('good', []);
  libs.debug = cc('debug', ['-DGREETING="Debug"']);
  libs.omit = cc('omit', ['-DOMIT_GREET']);
  libs.badSchema = cc('bad-schema', ['-DBAD_SCHEMA']);

  app = emptyDir('app');
  writeFileSync(join(app, 'package.json'), '{"type":"module","private":true}\n');
  // Next.js's own `server-only`: throws unless resolved under the react-server condition.
  const so = join(app, 'node_modules', 'server-only');
  mkdirSync(so, { recursive: true });
  writeFileSync(
    join(so, 'package.json'),
    JSON.stringify({
      name: 'server-only',
      exports: { '.': { 'react-server': './empty.js', default: './index.js' } },
    }),
  );
  writeFileSync(join(so, 'empty.js'), '');
  writeFileSync(
    join(so, 'index.js'),
    'throw new Error("This module cannot be imported from a Client Component module. It should only be used from a Server Component.");\n',
  );
  mkdirSync(join(app, 'src', 'generated', 'ffi'), { recursive: true });
  writeFileSync(
    join(app, 'src', 'generated', 'ffi', 'index.ts'),
    renderModule(manifest, { libName: 'fixture', crate: 'rust' }),
  );
  writeFileSync(join(app, 'harness.ts'), HARNESS);
  writeFileSync(join(app, 'harness-node.mjs'), NODE_HARNESS);
  writeFileSync(
    join(app, 'count-builtins.ts'),
    'const seen: string[] = [];\n' +
      '(globalThis as unknown as { __knextBuiltins: string[] }).__knextBuiltins = seen;\n' +
      'const orig = process.getBuiltinModule.bind(process);\n' +
      '(process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule = (id: string) => {\n' +
      '  seen.push(id);\n' +
      '  return orig(id as never);\n' +
      '};\n',
  );
}, 120_000);

afterAll(removeScratchDirs);

describe('the fixture library is a faithful stand-in', () => {
  it('the scanner reads the manifest out of the built library, as it would a Rust one', () => {
    const scanned = scanManifest(readFileSync(libs.good as string));
    expect(scanned).toEqual(manifest);
  });
});

describe('path 1 — native/ffi/<triple> beside the executable, integrity required', () => {
  it('every call crosses correctly, every buffer is freed exactly once', () => {
    const exe = image();
    const r = inBun(
      (m, c, fixture) => {
        const two = (n: number) => BigInt(2) ** BigInt(n);
        const out: Record<string, unknown> = {};
        out.greet = [m.greet('World'), m.greet(''), m.greet('héllo 🌍 👩‍💻'), m.greet('a\u0000b')];
        out.add = m.add(2, 3);
        m.add(-1, 0); // leaves 0xFF in bytes 1..3 of the out slot
        out.tiny = [m.tiny(5), m.tiny(-5)];
        m.add(-1, 0);
        out.flag = [m.flag(true), m.flag(false)];
        out.big = [m.big(two(60) + BigInt(7)), m.big(-two(63))];
        out.half = m.half(3);
        out.sum = m.sum(new Uint8Array([1, 2, 3]));
        out.sumEmpty = [m.sum(new Uint8Array(0)), fixture.fixture_last_null()];
        out.bytes = [m.echo_bytes(new Uint8Array([0, 255, 7]))];
        out.bytesEmpty = [m.echo_bytes(new Uint8Array(0)), fixture.fixture_last_null()];
        const a = 'x'.repeat(1000);
        const b = 'é'.repeat(3000); // its worst case does not fit the 4 KiB buffer: grows between the two
        out.concat = m.concat(a, b) === a + b;
        out.concatAgain = m.concat('left', '') === 'left';
        const p = {
          id: two(64) - BigInt(1),
          x: 1.25,
          label: 'p',
          tags: [two(53) + BigInt(1), BigInt(0)],
          inner: { n: -two(62), when: two(60) },
          color: 'Green',
        };
        out.point = m.echo_point(p);
        out.pointNull = m.echo_point({ ...p, inner: null }).inner;
        out.maybe = [m.maybe(two(60)), m.maybe(null)];
        out.ids = m.ids([-two(62), two(53) + BigInt(1)]);
        out.color = m.color('Green');
        out.parse = [m.parse('42'), c(() => m.parse('x'))];
        out.boom = c(() => m.boom());
        out.afterBoom = m.add(1, 1);
        out.strict = [c(() => m.strict('bad')), m.strict('ok')];
        out.badPoint = c(() => m.bad_point());
        out.nop = m.nop();
        out.typeErrors = [
          c(() => m.add(1.5, 0)),
          c(() => m.add(2 ** 31, 0)),
          c(() => m.tiny(200)),
          c(() => m.big(two(70))),
          c(() => m.big(5)),
          c(() => m.flag(1)),
          c(() => m.greet(5)),
          c(() => m.sum([1, 2])),
        ];
        out.live = fixture.fixture_live();
        return out;
      },
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.stderr).not.toContain('development build');
    expect(r.result, r.stderr).toEqual({
      greet: ['Hello, World!', 'Hello, !', 'Hello, héllo 🌍 👩‍💻!', 'Hello, a\u0000b!'],
      add: 5,
      tiny: [5, -5],
      flag: [false, true],
      big: ['1152921504606846983n', '-9223372036854775808n'],
      half: 1.5,
      sum: '6n',
      sumEmpty: ['0n', 1],
      bytes: [{ bytes: [0, 255, 7] }],
      bytesEmpty: [{ bytes: [] }, 1],
      concat: true,
      concatAgain: true,
      point: {
        id: '18446744073709551615n',
        x: 1.25,
        label: 'p',
        tags: ['9007199254740993n', '0n'],
        inner: { n: '-4611686018427387904n', when: '1152921504606846976n' },
        color: 'Green',
      },
      pointNull: null,
      maybe: ['1152921504606846976n', null],
      ids: ['-4611686018427387904n', '9007199254740993n'],
      color: 'Green',
      parse: [42, { cls: 'RustError', message: 'invalid digit found in string', fn: 'parse' }],
      boom: { cls: 'RustPanicError', message: 'boom from c', fn: 'boom' },
      afterBoom: 2,
      strict: [
        { cls: 'RustError', message: 'invalid input: s: invalid UTF-8', fn: 'strict' },
        'ok',
      ],
      badPoint: {
        cls: 'RustError',
        message:
          'result.x: expected a finite number, got null (NaN and Infinity cannot cross as JSON)',
        fn: 'bad_point',
      },
      nop: '<undefined>',
      typeErrors: [
        {
          cls: 'TypeError',
          message: 'add(): argument "a" must be an integer from -2147483648 to 2147483647, got 1.5',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message:
            'add(): argument "a" must be an integer from -2147483648 to 2147483647, got 2147483648',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'tiny(): argument "x" must be an integer from -128 to 127, got 200',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message:
            'big(): argument "x" must be a bigint from -9223372036854775808 to 9223372036854775807, got bigint 1180591620717411303424',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message:
            'big(): argument "x" must be a bigint from -9223372036854775808 to 9223372036854775807, got number 5',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'flag(): argument "b" must be a boolean, got number',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'greet(): argument "name" must be a string, got number',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'sum(): argument "data" must be a Uint8Array',
          fn: '<undefined>',
        },
      ],
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('Rust argument names never collide with what the generated body declares (r, st, base, o0, n0), nor an export with an import (join)', () => {
    const exe = image();
    const r = inBun(
      (m, _c, fixture) => ({
        scale: m.scale(1.25),
        join: m.join('a', 'bb', 'ccc', '', 'd-é'),
        joinAgain: m.join('', '', '', '', ''),
        live: fixture.fixture_live(),
      }),
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.stderr).not.toContain('SyntaxError');
    expect(r.result, r.stderr).toEqual({
      scale: { id: '7n', x: 2.5, label: 'scaled', tags: [], inner: null, color: 'Red' },
      join: ['a', 'bb', 'ccc', '', 'd-é'],
      joinAgain: ['', '', '', '', ''],
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('record fields named like Object.prototype members or keywords (constructor, toString, prototype, new, type) cross as own properties, both ways', () => {
    const exe = image();
    const r = inBun(
      (m, _c, fixture) => {
        const odd = {
          constructor: BigInt(2) ** BigInt(60),
          toString: 'ts',
          valueOf: 1.5,
          hasOwnProperty: null,
          prototype: [BigInt(1), BigInt(2)],
          new: true,
          type: 'Green',
          __defineGetter__: 'dg',
        };
        const back = m.echo_odd(odd);
        return {
          back,
          own: Object.keys(back),
          proto: Object.getPrototypeOf(back) === Object.prototype,
          some: m.echo_odd({ ...odd, hasOwnProperty: BigInt(-7) }).hasOwnProperty,
          live: fixture.fixture_live(),
        };
      },
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.result, r.stderr).toEqual({
      back: {
        constructor: '1152921504606846976n',
        toString: 'ts',
        valueOf: 1.5,
        hasOwnProperty: null,
        prototype: ['1n', '2n'],
        new: true,
        type: 'Green',
        __defineGetter__: 'dg',
      },
      own: [
        'constructor',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'prototype',
        'new',
        'type',
        '__defineGetter__',
      ],
      proto: true,
      some: '-7n',
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('a NaN or ±Infinity in ANY JSON argument position (Option, Vec, record field) is a TypeError naming its path, never a silent null', () => {
    const exe = image();
    const r = inBun(
      (m, c, fixture) => {
        const p = {
          id: BigInt(1),
          x: 1.5,
          label: 'p',
          tags: [],
          inner: null,
          color: 'Red',
        };
        return {
          ok: [m.opt_f(1.5), m.opt_f(null), m.floats([0.5, null, -2])],
          optNaN: c(() => m.opt_f(Number.NaN)),
          optInf: c(() => m.opt_f(Number.POSITIVE_INFINITY)),
          vecNegInf: c(() => m.floats([1, null, Number.NEGATIVE_INFINITY])),
          field: c(() => m.echo_point({ ...p, x: Number.POSITIVE_INFINITY })),
          afterRefusals: m.opt_f(2.5),
          live: fixture.fixture_live(),
        };
      },
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    const refused = (fn: string, at: string, got: string) => ({
      cls: 'TypeError',
      message: `${fn}(): argument "${at}" must be a finite number (JSON has no NaN or Infinity), got ${got}`,
      fn: '<undefined>',
    });
    expect(r.result, r.stderr).toEqual({
      ok: [1.5, null, [0.5, null, -2]],
      optNaN: refused('opt_f', 'x', 'NaN'),
      optInf: refused('opt_f', 'x', 'Infinity'),
      vecNegInf: refused('floats', 'xs[2]', '-Infinity'),
      field: refused('echo_point', 'p.x', 'Infinity'),
      afterRefusals: 2.5,
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('a 64-bit integer that arrives as a JSON number is a RustError naming its path, and the buffer is still freed', () => {
    const exe = image();
    const r = inBun(
      (m, c, fixture) => ({
        id: c(() => m.bad_id()),
        tag: c(() => m.bad_tag()),
        live: fixture.fixture_live(),
      }),
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.result, r.stderr).toEqual({
      id: {
        cls: 'RustError',
        message: 'result.id: expected a 64-bit integer as a decimal string, got 1',
        fn: 'bad_id',
      },
      tag: {
        cls: 'RustError',
        message: 'result.tags[1]: expected a 64-bit integer as a decimal string, got 3',
        fn: 'bad_tag',
      },
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  const refused = (integrity: 'mismatch' | 'unlisted' | 'absent' | 'v2', expected: RegExp) => {
    for (const nodeEnv of ['production', 'development']) {
      const r = inBun((m, c) => [c(() => m.greet('x')), c(() => m.add(1, 2))], {
        FAKE_EXEC: image({ integrity }),
        NODE_ENV: nodeEnv,
      });
      const [first, second] = r.result as { cls: string; message: string }[];
      expect(first?.cls, r.stderr).toBe('FfiLoadError');
      expect(first?.message).toMatch(expected);
      // Cached: the second call fails the same way, without retrying.
      expect(second).toEqual(first as { cls: string; message: string });
    }
  };

  it('a sha256 mismatch is fatal, in production and in development', () => {
    refused(
      'mismatch',
      /refusing to load .*libfixture\.\w+: sha256 mismatch\n {2}expected 0{64}\n {2}actual {3}[0-9a-f]{64}/,
    );
  });
  it('a library not listed in native/.integrity.json is fatal', () => {
    refused('unlisted', /is not listed in .*\.integrity\.json/);
  });
  it('an absent integrity manifest is fatal (no warn-and-load exception)', () => {
    refused('absent', /there is no integrity manifest at .*\.integrity\.json/);
  });
  it('an integrity manifest of an unknown schema version is fatal', () => {
    refused('v2', /cannot read .*\.integrity\.json \(unsupported version 2\)/);
  });

  it('a failed load is cached: fixing the cause does not make a later call in the same process retry', () => {
    const exe = image({ integrity: 'mismatch' });
    const r = inBun(
      (m, c) => {
        const first = c(() => m.greet('x'));
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const native = path.join(path.dirname(process.execPath), 'native');
        const manifest = JSON.parse(fs.readFileSync(path.join(native, '.integrity.json'), 'utf8'));
        const rel = Object.keys(manifest.files)[0];
        const hash = process
          .getBuiltinModule('node:crypto')
          .createHash('sha256')
          .update(fs.readFileSync(path.join(native, rel)))
          .digest('hex');
        manifest.files[rel] = hash;
        fs.writeFileSync(path.join(native, '.integrity.json'), JSON.stringify(manifest));
        return [first, c(() => m.greet('x'))];
      },
      { FAKE_EXEC: exe },
    );
    const [first, second] = r.result as { cls: string }[];
    expect(first?.cls, r.stderr).toBe('FfiLoadError');
    expect(second).toEqual(first as { cls: string });
  });

  it('a wrong-platform directory is refused by name', () => {
    const r = inBun((m, c) => c(() => m.greet('x')), {
      FAKE_EXEC: image({ triple: 'riscv64gc-unknown-linux-musl' }),
      NODE_ENV: 'development',
    });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain('holds Rust libraries for riscv64gc-unknown-linux-musl');
    expect(out.message).toContain(`this process runs on ${TRIPLE}`);
  });

  it('a library missing a symbol the wrapper binds (a stale wrapper) is an FfiLoadError naming knext ffi generate', () => {
    const r = inBun((m, c) => c(() => m.add(1, 2)), { FAKE_EXEC: image({ lib: libs.omit }) });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain('could not load');
    expect(out.message).toContain('the module is stale: run `knext ffi generate`');
  });

  it('a _schema mismatch (a record changed under an unchanged signature) is the stale-wrapper FfiLoadError', () => {
    const r = inBun((m, c) => c(() => m.add(1, 2)), { FAKE_EXEC: image({ lib: libs.badSchema }) });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toMatch(
      /the records or enums \w+\(\) uses have changed since it was generated/,
    );
    expect(out.message).toContain('The module is stale: run `knext ffi generate`');
  });
});

describe('path 2 — the development fallback, only when NODE_ENV !== production', () => {
  function devApp(): void {
    for (const p of ['release', 'debug']) {
      mkdirSync(join(app, 'rust', 'target', p), { recursive: true });
    }
    copyFileSync(libs.good as string, join(app, 'rust', 'target', 'release', LIB));
    copyFileSync(libs.debug as string, join(app, 'rust', 'target', 'debug', LIB));
  }
  const noImage = () => join(emptyDir('no-image'), 'server');

  it('loads the newest host build from <crate>/target/{release,debug}, with a one-line notice and no integrity check', () => {
    devApp();
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(app, 'rust', 'target', 'release', LIB), old, old);
    const debugNewest = inBun((m) => m.greet('dev'), {
      FAKE_EXEC: noImage(),
      NODE_ENV: 'development',
    });
    expect(debugNewest.result, debugNewest.stderr).toBe('Debug, dev!');
    expect(debugNewest.stderr).toContain('knext ffi: loading the development build');
    expect(debugNewest.stderr).toContain('without an integrity check');

    utimesSync(join(app, 'rust', 'target', 'debug', LIB), old, old);
    const now = new Date();
    utimesSync(join(app, 'rust', 'target', 'release', LIB), now, now);
    const releaseNewest = inBun((m) => m.greet('dev'), {
      FAKE_EXEC: noImage(),
      NODE_ENV: 'development',
    });
    expect(releaseNewest.result, releaseNewest.stderr).toBe('Hello, dev!');
  });

  it('is never used in production: the error lists every path tried and names knext ffi build', () => {
    devApp();
    const exe = noImage();
    const r = inBun((m, c) => c(() => m.greet('x')), { FAKE_EXEC: exe, NODE_ENV: 'production' });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain(join(exe, '..', 'native', 'ffi', TRIPLE, LIB));
    expect(out.message).not.toContain(join('rust', 'target'));
    expect(out.message).toContain('knext ffi build');
    // At request time the call is not prerendering: the message must not say it is.
    expect(out.message).not.toContain('prerender');
    expect(out.message).not.toContain('force-dynamic');
  });

  it('in development with no build at all, the error lists the staged path and both development paths', () => {
    rmSync(join(app, 'rust'), { recursive: true, force: true });
    const exe = noImage();
    const r = inBun((m, c) => c(() => m.greet('x')), { FAKE_EXEC: exe, NODE_ENV: 'development' });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain(join(exe, '..', 'native', 'ffi', TRIPLE, LIB));
    expect(out.message).toContain(join(app, 'rust', 'target', 'release', LIB));
    expect(out.message).toContain(join(app, 'rust', 'target', 'debug', LIB));
  });
});

describe('prerendering (ADR-0069 round 2): calls work in dynamic contexts only', () => {
  it('during next build with no library anywhere, the error is the prerender one, not "cannot find the Rust library"', () => {
    const r = inBun((m, c) => c(() => m.greet('x')), {
      FAKE_EXEC: join(emptyDir('no-image'), 'server'),
      NEXT_PHASE: 'phase-production-build',
    });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain('This call happened while `next build` was prerendering');
    expect(out.message).toContain('force-dynamic');
    expect(out.message).not.toContain('cannot find the Rust library');
  });

  it('NEXT_PHASE=phase-production-build wins over a perfectly good library', () => {
    const r = inBun((m, c) => c(() => m.greet('x')), {
      FAKE_EXEC: image(),
      NEXT_PHASE: 'phase-production-build',
    });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    for (const s of [
      'prerendering',
      'generateStaticParams',
      'generateMetadata',
      "export const dynamic = 'force-dynamic'",
      'await connection()',
    ]) {
      expect(out.message).toContain(s);
    }
  });
});

describe('the module is server-only and does nothing at import time', () => {
  it('without the react-server condition, importing it throws (server-only is real)', () => {
    const r = inBun((m) => m.greet('x'), { FAKE_EXEC: image() }, []);
    expect(r.result).toBeUndefined();
    expect(r.stderr).toContain('cannot be imported from a Client Component module');
  });

  it('under Bun, importing it never asks for bun:ffi', () => {
    const r = inBun(
      () => (globalThis as unknown as { __knextBuiltins: string[] }).__knextBuiltins,
      {},
      ['--conditions=react-server', '--preload', './count-builtins.ts'],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.result).toEqual([]);
  });

  it('under Node: imports with no throw, no file-system access and no bun:ffi; the call is the D15 Node refusal', () => {
    const r = spawnSync('node', ['--conditions=react-server', 'harness-node.mjs'], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', NEXT_PHASE: '', NODE_OPTIONS: '' },
      timeout: 60_000,
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, r.stderr).toBeDefined();
    const out = JSON.parse((line as string).slice(7));
    // Node's own ESM loader opens the two modules being imported; nothing else
    // (no native/, no .integrity.json, no crate, no /lib) is touched.
    for (const t of out.atImport.touched as string[]) {
      expect(t).toMatch(/(src\/generated\/ffi\/index\.ts|node_modules\/server-only\/empty\.js)$/);
    }
    expect(out.atImport.asked).toEqual([]);
    expect(out.atImport.exports).toContain('greet');
    expect(out.atImport.exports).toContain('FfiLoadError');
    expect(out.call.cls).toBe('FfiLoadError');
    expect(out.call.message).toBe(
      `In-process Rust (bun:ffi) runs only on Bun; this process is Node ${spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim()}. Run the app with Bun (bun --bun next dev), or call this code through a zone function.`,
    );
    expect(out.again).toBe(true);
  });

  it('under Node during next build, the prerender message wins over the Node refusal', () => {
    const r = spawnSync('node', ['--conditions=react-server', 'harness-node.mjs'], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, NEXT_PHASE: 'phase-production-build', NODE_OPTIONS: '' },
      timeout: 60_000,
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    const out = JSON.parse((line as string).slice(7));
    expect(out.call.message).toContain('prerendering');
    expect(out.call.message).not.toContain('runs only on Bun');
  });
});
