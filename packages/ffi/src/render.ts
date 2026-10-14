/**
 * The TypeScript emitter: one typed, `server-only` module per library
 * (ADR-0069 D6–D9, D13, D15 step 2).
 *
 * {@link renderModule} is pure — a manifest in, the module's text out, no I/O —
 * so `knext ffi generate`, `knext ffi check` and the image build's drift check
 * (which renders from the library that ships and compares with the committed
 * file) all produce byte-identical output from the same manifest.
 *
 * What the emitted module guarantees, each pinned by render.test.ts and proven
 * against a real library by ffi-loader.test.ts:
 *
 * - `import 'server-only'` first; no `bun:ffi` import and no work at import
 *   time (a static `bun:ffi` import fails `next build` under Node). `bun:ffi`
 *   is obtained on the first call through `process.getBuiltinModule`.
 * - It type-checks with Node types only: the slice of `bun:ffi` it uses is
 *   declared locally, and it hashes with `node:crypto`, not `Bun.CryptoHasher`.
 *   It uses only erasable TypeScript, so Node's type stripping can import it
 *   (and then refuse the call with the Bun-only message).
 * - Loading is fail-closed: the library beside the executable must be listed
 *   in `native/.integrity.json` with a matching sha256; the development build
 *   is used only when `NODE_ENV !== 'production'`; every function's `_schema`
 *   value must match the one computed here; any failure is one cached
 *   `FfiLoadError`.
 * - The spike's binding rules (D13 item 6): `ptr()` only of an explicit
 *   `ArrayBuffer`; (ptr, len) read as two u32 halves; every (ptr, len)
 *   argument encoded into one scratch buffer BEFORE any pointer is computed
 *   from it; an empty one passed as JavaScript `null` (NULL: Bun passes an
 *   empty `Uint8Array` as a non-null pointer); integer arguments range-checked;
 *   every returned buffer copied, then freed in a `finally`.
 * - JSON carries no NaN or Infinity (`JSON.stringify` writes `null`, which
 *   Rust would read as `None`), so a non-finite float anywhere inside a JSON
 *   argument is a `TypeError` naming its path, before the call.
 */

import {
  type FnRecord,
  fnv1a64,
  type Manifest,
  manifestDigest,
  type RecordType,
  schemaString,
  type TypeDesc,
} from './manifest';

// The image build's drift check (knext ffi build) scans the library it is
// about to ship and renders from it; these are what it needs.
export { type Manifest, ManifestError, scanManifest } from './manifest';

/** `lib<name>.so` / `lib<name>.dylib` -> `<name>`, or `undefined`. */
export function libNameOf(fileName: string): string | undefined {
  return /^lib([A-Za-z0-9_]+)\.(so|dylib)$/.exec(fileName)?.[1];
}

export interface RenderOptions {
  /** The cdylib's file stem without `lib`: `zone` for `libzone.so`. */
  readonly libName: string;
  /** The crate directory relative to the app (the development fallback looks there). */
  readonly crate: string;
}

/** Single-quoted TS string literal. */
function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name));
const access = (obj: string, name: string) =>
  IDENT.test(name) ? `${obj}.${name}` : `${obj}[${JSON.stringify(name)}]`;
const noClose = (s: string) => s.replace(/\*\//g, '*\\/');

const INT_RANGE: Record<string, [number, number]> = {
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
};
const SIGNED_64 = new Set(['i64', 'isize']);
const UNSIGNED_64 = new Set(['u64', 'usize']);
const is64 = (t: string) => SIGNED_64.has(t) || UNSIGNED_64.has(t);

/** The bun:ffi argument type of a by-value scalar. */
const FFI_TYPE: Record<string, string> = {
  i8: 'i8',
  i16: 'i16',
  i32: 'i32',
  u8: 'u8',
  u16: 'u16',
  u32: 'u32',
  i64: 'i64',
  isize: 'i64',
  u64: 'u64',
  usize: 'u64',
  f32: 'f32',
  f64: 'f64',
  bool: 'bool',
};

/** How a by-value scalar return is read from the out slot (little-endian, native width). */
const READ: Record<string, string> = {
  i8: '$view.getInt8(0)',
  i16: '$view.getInt16(0, true)',
  i32: '$view.getInt32(0, true)',
  u8: '$view.getUint8(0)',
  u16: '$view.getUint16(0, true)',
  u32: '$view.getUint32(0, true)',
  i64: '$view.getBigInt64(0, true)',
  isize: '$view.getBigInt64(0, true)',
  u64: '$view.getBigUint64(0, true)',
  usize: '$view.getBigUint64(0, true)',
  f32: '$view.getFloat32(0, true)',
  f64: '$view.getFloat64(0, true)',
  bool: '$view.getUint8(0) !== 0',
};

/** Crosses by value (one C argument), as opposed to a (ptr, len) pair. */
const byValue = (d: TypeDesc) => d.t in FFI_TYPE;
/** Crosses as JSON text (D7). */
const isJson = (d: TypeDesc) =>
  d.t === 'record' || d.t === 'enum' || d.t === 'option' || d.t === 'vec';

/** The TS type of a descriptor. Inside JSON, bytes are `number[]` (D7). */
function tsType(d: TypeDesc, json: boolean): string {
  switch (d.t) {
    case 'record':
    case 'enum':
      return d.name;
    case 'option':
      return `${tsType(d.of, true)} | null`;
    case 'vec': {
      const inner = tsType(d.of, true);
      return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'bool':
      return 'boolean';
    case 'string':
      return 'string';
    case 'bytes':
      return json ? 'number[]' : 'Uint8Array';
    case 'unit':
      return 'void';
    default:
      return is64(d.t) ? 'bigint' : 'number';
  }
}

interface Expr {
  readonly code: string;
  /** No conversion: the value crosses as-is (so a container of it needs no walk). */
  readonly plain: boolean;
}

class Emitter {
  readonly used = new Set<string>();
  readonly encoders = new Set<string>();
  readonly decoders = new Set<string>();

  constructor(private readonly records: Map<string, RecordType>) {}

  /** Whether a JSON value of type `d` can hold a float, at any depth. */
  floaty(d: TypeDesc, seen: Set<string> = new Set()): boolean {
    if (d.t === 'f32' || d.t === 'f64') return true;
    if (d.t === 'option' || d.t === 'vec') return this.floaty(d.of, seen);
    if (d.t !== 'record' || seen.has(d.name)) return false;
    seen.add(d.name);
    return (this.records.get(d.name)?.fields ?? []).some((f) => this.floaty(f.type, seen));
  }

  /**
   * TS value -> JSON-ready value (64-bit integers become decimal strings, D7;
   * a non-finite float is a TypeError, as JSON would turn it into `null`).
   * `fn`/`at` are code for the export's name and the value's path, used only
   * on that error path (a container that holds no float gets neither).
   */
  enc(d: TypeDesc, expr: string, fn: string, at: string, depth: number): Expr {
    if (is64(d.t)) {
      this.used.add('$s64');
      return { code: `$s64(${expr})`, plain: false };
    }
    if (d.t === 'f32' || d.t === 'f64') {
      this.used.add('$efin');
      return {
        code: `(Number.isFinite(${expr}) ? ${expr} : $efin(${fn}, ${at}, ${expr}))`,
        plain: false,
      };
    }
    if (d.t === 'record') {
      this.needEncoder(d.name);
      const args = this.floaty(d) ? `${fn}, ${at}, ${expr}` : expr;
      return { code: `$e_${d.name}(${args})`, plain: false };
    }
    if (d.t === 'option' || d.t === 'vec') {
      const x = `$x${depth}`;
      const i = `$i${depth}`;
      const indexed = d.t === 'vec' && this.floaty(d.of);
      const inner = this.enc(d.of, x, fn, indexed ? `${at} + '[' + ${i} + ']'` : at, depth + 1);
      if (inner.plain) return { code: expr, plain: true };
      if (d.t === 'vec') {
        const params = indexed ? `${x}, ${i}` : x;
        return { code: `${expr}.map((${params}) => ${inner.code})`, plain: false };
      }
      this.used.add('$opt');
      return { code: `$opt(${expr}, (${x}) => ${inner.code})`, plain: false };
    }
    return { code: expr, plain: true };
  }

  /** Parsed JSON value -> TS value; `fn`/`at` name the export and the path for errors. */
  dec(d: TypeDesc, expr: string, fn: string, at: string, depth: number): Expr {
    if (is64(d.t)) {
      this.used.add('$d64');
      return { code: `$d64(${fn}, ${at}, ${expr})`, plain: false };
    }
    if (d.t === 'f32' || d.t === 'f64') {
      this.used.add('$fin');
      return { code: `$fin(${fn}, ${at}, ${expr})`, plain: false };
    }
    if (d.t === 'record') {
      this.needDecoder(d.name);
      return { code: `$d_${d.name}(${fn}, ${at}, ${expr})`, plain: false };
    }
    if (d.t === 'option') {
      const x = `$x${depth}`;
      const inner = this.dec(d.of, x, fn, at, depth + 1);
      if (inner.plain) return { code: `${expr} as ${tsType(d, true)}`, plain: true };
      this.used.add('$opt');
      return { code: `$opt(${expr}, (${x}) => ${inner.code})`, plain: false };
    }
    if (d.t === 'vec') {
      const x = `$x${depth}`;
      const a = `$at${depth}`;
      const inner = this.dec(d.of, x, fn, a, depth + 1);
      if (inner.plain) return { code: `${expr} as ${tsType(d, true)}`, plain: true };
      this.used.add('$vec');
      return { code: `$vec(${expr}, ${at}, (${x}, ${a}) => ${inner.code})`, plain: false };
    }
    return { code: `${expr} as ${tsType(d, true)}`, plain: true };
  }

  private needEncoder(name: string): void {
    if (this.encoders.has(name)) return;
    this.encoders.add(name);
    for (const f of this.records.get(name)?.fields ?? []) this.enc(f.type, 'x', 'fn', 'at', 0);
  }

  private needDecoder(name: string): void {
    if (this.decoders.has(name)) return;
    this.decoders.add(name);
    for (const f of this.records.get(name)?.fields ?? []) this.dec(f.type, 'x', 'fn', 'at', 0);
  }

  encoder(r: RecordType): string {
    const fields = r.fields.map(
      (f) =>
        `${key(f.name)}: ${this.enc(f.type, access('v', f.name), 'fn', `at + ${q(`.${f.name}`)}`, 0).code}`,
    );
    const params = this.floaty({ t: 'record', name: r.name }) ? 'fn: string, at: string, ' : '';
    return [
      `function $e_${r.name}(${params}v: ${r.name}): unknown {`,
      `  return { ${fields.join(', ')} };`,
      '}',
    ].join('\n');
  }

  decoder(r: RecordType): string {
    const fields = r.fields.map(
      (f) =>
        `${key(f.name)}: ${this.dec(f.type, `o[${q(f.name)}]`, 'fn', `at + ${q(`.${f.name}`)}`, 0).code}`,
    );
    return [
      `function $d_${r.name}(fn: string, at: string, v: unknown): ${r.name} {`,
      '  const o = v as Record<string, unknown>;',
      `  return { ${fields.join(', ')} };`,
      '}',
    ].join('\n');
  }

  /** One exported function. */
  fn(f: FnRecord): string {
    const lines: string[] = [];
    const name = q(f.name);
    const params = f.args.map((a) => `${a.name}: ${tsType(a.type, false)}`).join(', ');
    lines.push(`export function ${f.name}(${params}): ${tsType(f.ret.type, false)} {`);

    // 1. Validate every argument before anything else (D13 item 6).
    for (const a of f.args) {
      const t = a.type.t;
      const range = INT_RANGE[t];
      if (range) {
        this.used.add('$int');
        lines.push(`  $int(${name}, ${q(a.name)}, ${a.name}, ${range[0]}, ${range[1]});`);
      } else if (is64(t)) {
        const [lo, hi] = SIGNED_64.has(t) ? ['$I64_MIN', '$I64_MAX'] : ['$U64_MIN', '$U64_MAX'];
        this.used.add('$big');
        this.used.add(SIGNED_64.has(t) ? '$I64' : '$U64');
        lines.push(`  $big(${name}, ${q(a.name)}, ${a.name}, ${lo}, ${hi});`);
      } else if (t === 'f32' || t === 'f64') {
        this.used.add('$num');
        lines.push(`  $num(${name}, ${q(a.name)}, ${a.name});`);
      } else if (t === 'bool') {
        this.used.add('$bool');
        lines.push(`  $bool(${name}, ${q(a.name)}, ${a.name});`);
      } else if (t === 'string') {
        this.used.add('$str');
        lines.push(`  $str(${name}, ${q(a.name)}, ${a.name});`);
      } else if (t === 'bytes') {
        this.used.add('$bytes');
        lines.push(`  $bytes(${name}, ${q(a.name)}, ${a.name});`);
      }
    }
    lines.push('  if (!$ready) $load();');

    // 2. Encode every (ptr, len) argument into the scratch buffer, THEN take
    //    the pointer: a later argument may grow (replace) the buffer.
    const call: string[] = [];
    let buffers = 0;
    f.args.forEach((a, i) => {
      if (byValue(a.type)) {
        call.push(a.name);
        return;
      }
      buffers++;
      const value = isJson(a.type)
        ? `JSON.stringify(${this.enc(a.type, a.name, name, q(a.name), 0).code})`
        : a.name;
      lines.push(`  const $o${i} = $put(${value});`);
      lines.push(`  const $n${i} = $last;`);
      call.push(`$n${i} === 0 ? null : $scratch + $o${i}`, `$n${i}`);
    });
    if (buffers > 0) {
      this.used.add('$put');
      lines.push('  const $scratch = $base();');
    }
    call.push('$outPtr');
    lines.push(`  const $st = $lib.${f.symbol}(${call.join(', ')});`);
    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);

    // 3. Read the return.
    const rt = f.ret.type;
    if (rt.t === 'unit') {
      // nothing written
    } else if (rt.t === 'string') {
      lines.push('  return $takeString();');
    } else if (rt.t === 'bytes') {
      this.used.add('$takeBytes');
      lines.push('  return $takeBytes();');
    } else if (isJson(rt)) {
      lines.push('  const $r: unknown = JSON.parse($takeString());');
      lines.push(`  return ${this.dec(rt, '$r', name, q('result'), 0).code};`);
    } else {
      lines.push(`  return ${READ[rt.t]};`);
    }
    lines.push('}');
    return lines.join('\n');
  }
}

function docBlock(doc: string, extra: string[]): string {
  const body: string[] = [];
  if (doc.trim() !== '') body.push(...noClose(doc.trim()).split('\n'), '');
  body.push(...extra);
  while (body.at(-1) === '') body.pop();
  return ['/**', ...body.map((l) => (l === '' ? ' *' : ` * ${l}`)), ' */'].join('\n');
}

/** `a`, `a or b`, `a, b or c`. */
function orList(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

function fnDoc(f: FnRecord, e: Emitter): string {
  const sig = `${f.name}(${f.args.map((a) => `${a.name}: ${a.rust}`).join(', ')}) -> ${f.ret.rust}`;
  const extra = [`Rust: \`${noClose(sig)}\``, ''];
  if (f.err) {
    extra.push(
      `@throws {RustError} when the Rust function returns \`Err\` (\`${noClose(f.err.rust)}\`).`,
    );
  }
  // Scalars, strings and bytes are checked before the call; JSON arguments are
  // not, so a value Rust cannot decode comes back as status 3 ("invalid input").
  const checked = f.args.filter((a) => !isJson(a.type)).map((a) => `\`${a.name}\``);
  const unchecked = f.args.filter((a) => isJson(a.type)).map((a) => `\`${a.name}\``);
  if (checked.length > 0) {
    extra.push(
      `@throws {TypeError} when ${orList(checked)} has the wrong type or is out of range.`,
    );
  }
  if (unchecked.length > 0) {
    extra.push(
      `@throws {RustError} ("invalid input: …") when ${orList(unchecked)} is a value Rust cannot decode: record, enum, Option and Vec arguments are not checked in JavaScript.`,
    );
  }
  const floaty = f.args
    .filter((a) => isJson(a.type) && e.floaty(a.type))
    .map((a) => `\`${a.name}\``);
  if (floaty.length > 0) {
    extra.push(
      `@throws {TypeError} when a number inside ${orList(floaty)} is NaN or Infinity (JSON cannot carry them).`,
    );
  }
  extra.push(
    '@throws {RustPanicError} when the Rust function panics.',
    '@throws {FfiLoadError} when the Rust library cannot be loaded.',
  );
  return docBlock(f.doc, extra);
}

function typeDoc(doc: string): string {
  const d = noClose(doc.trim());
  if (d === '') return '';
  return d.includes('\n') ? `${docBlock(doc, [])}\n` : `/** ${d} */\n`;
}

// @upstream-shim bun-ffi-experimental
// The Beta label every generated module carries: `bun:ffi` is experimental
// upstream (Bun's own docs: "Do not rely on it in production"). It goes when
// that notice goes (ADR-0069 D19) — the upstream-retirement registry watches it.
export const BETA_LINE =
  'In-process Rust (Beta): calls go through bun:ffi, which Bun marks experimental, so this module runs only on Bun.';

const ERROR_CLASSES = `/** The Rust function returned \`Err\`, or rejected input it could not decode. */
export class RustError extends Error {
  /** The Rust export that failed. */
  readonly fn: string;
  constructor(fn: string, message: string) {
    super(message);
    this.name = 'RustError';
    this.fn = fn;
  }
}

/** The Rust function panicked. The process keeps running and the next call works. */
export class RustPanicError extends Error {
  /** The Rust export that panicked. */
  readonly fn: string;
  constructor(fn: string, message: string) {
    super(message);
    this.name = 'RustPanicError';
    this.fn = fn;
  }
}

/** The Rust library could not be loaded. Every later call throws this same error. */
export class FfiLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfiLoadError';
  }
}`;

const PRERENDER = [
  'In-process Rust runs only at request time.',
  'This call happened while `next build` was prerendering: Rust functions cannot be called during prerendering, from generateStaticParams, or from generateMetadata of a static route.',
  "Make the route dynamic: add `export const dynamic = 'force-dynamic'` to the route segment, or `await connection()` (from 'next/server') before the call.",
].join(' ');

/** The loader and the call helpers every module needs. */
function runtime(e: Emitter, schemas: string, scratch: boolean): string {
  const parts: string[] = [];
  parts.push(`type $Arg = number | bigint | boolean | null;
type $Native = (...args: $Arg[]) => unknown;
interface $BunFfi {
  dlopen(
    path: string,
    symbols: Record<string, { readonly args: readonly string[]; readonly returns: string }>,
  ): { symbols: Record<string, $Native> };
  ptr(buffer: ArrayBuffer): number;
  CString: new (ptr: number, byteOffset: number, byteLength: number) => { toString(): string };
  toArrayBuffer(ptr: number, byteOffset: number, byteLength: number): ArrayBuffer;
}

let $ready = false;
let $failed: FfiLoadError | undefined;
let $ffi = undefined as unknown as $BunFfi;
let $lib = undefined as unknown as $Symbols;
let $view = undefined as unknown as DataView;
let $outPtr = 0;
${
  scratch
    ? `let $buf = undefined as unknown as ArrayBuffer;
let $mem = new Uint8Array(0);
let $used = 0;
let $last = 0;
const $te = new TextEncoder();
`
    : ''
}
/** The first call loads the library; a failure is cached and rethrown on every later call. */
function $load(): void {
  if ($failed) throw $failed;
  try {
    $open();
    $ready = true;
  } catch (err) {
    $failed =
      err instanceof FfiLoadError
        ? err
        : new FfiLoadError(
            \`knext ffi: could not load the Rust library: \${err instanceof Error ? err.message : String(err)}\`,
          );
    throw $failed;
  }
}

function $open(): void {
  if (process.env['NEXT_PHASE'] === 'phase-production-build') {
    throw new FfiLoadError($PRERENDER);
  }
  if (!process.versions['bun']) {
    throw new FfiLoadError(
      \`In-process Rust (bun:ffi) runs only on Bun; this process is Node \${process.version}. Run the app with Bun (bun --bun next dev), or call this code through a zone function.\`,
    );
  }
  const ffi = process.getBuiltinModule('bun:ffi') as unknown as $BunFfi | undefined;
  if (!ffi) throw new FfiLoadError('knext ffi: this Bun has no bun:ffi module.');
  const path = $resolve();
  let symbols: Record<string, $Native>;
  try {
    symbols = ffi.dlopen(path, $SPEC).symbols;
  } catch (err) {
    throw new FfiLoadError(
      \`knext ffi: could not load \${path}: \${err instanceof Error ? err.message : String(err)}\\n\` +
        'If the library does not export a function this module calls, the module is stale: run \`knext ffi generate\` and commit the result.',
    );
  }
  // The symbol names carry each function's own signature; the records and
  // enums it uses are covered by its _schema value, checked once here.
  for (const [fn, symbol, expected] of $SCHEMAS) {
    const schema = symbols[\`\${symbol}_schema\`];
    const actual = schema ? String(schema()) : 'missing';
    if (actual !== expected) {
      throw new FfiLoadError(
        \`knext ffi: \${path} does not match this module: the records or enums \${fn}() uses have changed since it was generated (schema \${actual}, expected \${expected}). \` +
          'The module is stale: run \`knext ffi generate\` and commit the result.',
      );
    }
  }
  // The ArrayBuffer is created first and the pointer is taken of IT: the
  // pointer of a small typed array whose .buffer is read later can dangle
  // (JavaScriptCore moves that storage).
  const buf = new ArrayBuffer(16);
  $outPtr = ffi.ptr(buf);
  $view = new DataView(buf);
${
  scratch
    ? `  $buf = new ArrayBuffer(4096);
  $mem = new Uint8Array($buf);
`
    : ''
}  $ffi = ffi;
  $lib = symbols as unknown as $Symbols;
}

/** This process's Rust target triple. */
function $triple(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : '';
  if (arch !== '' && process.platform === 'darwin') return \`\${arch}-apple-darwin\`;
  if (arch !== '' && process.platform === 'linux') {
    return \`\${arch}-unknown-linux-\${$musl() ? 'musl' : 'gnu'}\`;
  }
  throw new FfiLoadError(\`knext ffi: no Rust library is built for \${process.platform}-\${process.arch}.\`);
}

/** musl or glibc: a glibc runtime reports its version; otherwise look for musl's loader. */
function $musl(): boolean {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
    if (typeof report.header?.glibcVersionRuntime === 'string') return false;
  } catch {
    // fall through to the file-system probe
  }
  try {
    if ($readdirSync('/lib').some((f) => f.startsWith('ld-musl-'))) return true;
  } catch {
    // no /lib
  }
  return $existsSync('/etc/alpine-release');
}

function $resolve(): string {
  const triple = $triple();
  const file = \`lib\${$LIB}.\${process.platform === 'darwin' ? 'dylib' : 'so'}\`;
  const native = $join($dirname(process.execPath), 'native');
  const staged = $join(native, 'ffi', triple, file);
  const tried = [staged];
  if ($existsSync(staged)) {
    $verify(native, \`ffi/\${triple}/\${file}\`, staged);
    return staged;
  }
  let others: string[] = [];
  try {
    others = $readdirSync($join(native, 'ffi')).filter((d) => d !== triple);
  } catch {
    // no native/ffi beside the executable
  }
  if (others.length > 0) {
    throw new FfiLoadError(
      \`knext ffi: \${$join(native, 'ffi')} holds Rust libraries for \${others.join(', ')}, but this process runs on \${triple}. Build the image for the platform it runs on.\`,
    );
  }
  if (process.env['NODE_ENV'] !== 'production') {
    const dev = ['release', 'debug'].map((p) => $join(process.cwd(), $CRATE, 'target', p, file));
    tried.push(...dev);
    const found = dev
      .filter((p) => $existsSync(p))
      .sort((a, b) => $statSync(b).mtimeMs - $statSync(a).mtimeMs);
    if (found[0] !== undefined) {
      console.warn(
        \`knext ffi: loading the development build \${found[0]} without an integrity check (NODE_ENV is not "production").\`,
      );
      return found[0];
    }
  }
  throw new FfiLoadError(
    \`knext ffi: cannot find the Rust library \${file} for \${triple}. Tried:\\n\${tried.map((p) => \`  \${p}\`).join('\\n')}\\n\` +
      'Images built by \`knext build\` stage it beside the server (knext ffi build); in development, run \`knext ffi generate\`.',
  );
}

/** Fail closed: the library must be listed in native/.integrity.json with a matching sha256. */
function $verify(native: string, rel: string, path: string): void {
  const manifest = $join(native, '.integrity.json');
  if (!$existsSync(manifest)) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${path}: there is no integrity manifest at \${manifest}. Images built by \\\`knext build\\\` carry one.\`,
    );
  }
  let files: unknown;
  try {
    const parsed = JSON.parse($readFileSync(manifest, 'utf8')) as { version?: unknown; files?: unknown };
    if (parsed.version !== 1) {
      throw new Error(\`unsupported version \${JSON.stringify(parsed.version)}\`);
    }
    files = parsed.files;
  } catch (err) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${path}: cannot read \${manifest} (\${err instanceof Error ? err.message : String(err)}).\`,
    );
  }
  const expected =
    typeof files === 'object' && files !== null ? (files as Record<string, unknown>)[rel] : undefined;
  if (typeof expected !== 'string') {
    throw new FfiLoadError(\`knext ffi: refusing to load \${path}: \${rel} is not listed in \${manifest}.\`);
  }
  const actual = $createHash('sha256').update($readFileSync(path)).digest('hex');
  if (actual !== expected) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${path}: sha256 mismatch\\n  expected \${expected}\\n  actual   \${actual}\`,
    );
  }
}

/** A Rust-owned (ptr, len) pair from the out slot, read as two u32 halves (no BigInt per call). */
function $takeString(): string {
  const len = $view.getUint32(8, true) + $view.getUint32(12, true) * 4294967296;
  if (len === 0) return '';
  const p = $view.getUint32(0, true) + $view.getUint32(4, true) * 4294967296;
  try {
    return new $ffi.CString(p, 0, len).toString();
  } finally {
    $lib.knext_ffi_v1_free(p, len);
  }
}

function $fail(fn: string, status: number): never {
  if (status === 1 || status === 2 || status === 3) {
    const message = $takeString();
    if (status === 2) throw new RustPanicError(fn, message);
    throw new RustError(fn, status === 3 ? \`invalid input: \${message}\` : message);
  }
  throw new Error(
    \`knext ffi: \${fn}() returned status \${status}, which ABI v1 does not define; this is a bug in the generated module or the knext-ffi crate.\`,
  );
}`);

  if (e.used.has('$takeBytes')) {
    parts.push(`function $takeBytes(): Uint8Array {
  const len = $view.getUint32(8, true) + $view.getUint32(12, true) * 4294967296;
  if (len === 0) return new Uint8Array(0);
  const p = $view.getUint32(0, true) + $view.getUint32(4, true) * 4294967296;
  try {
    return new Uint8Array($ffi.toArrayBuffer(p, 0, len)).slice();
  } finally {
    $lib.knext_ffi_v1_free(p, len);
  }
}`);
  }
  if (scratch) {
    parts.push(`/**
 * Phase 1 of a call: copy one (ptr, len) argument into the scratch buffer at
 * the next 8-byte-aligned offset, growing it as needed. Returns the OFFSET (the
 * length is left in $last); no pointer is taken here.
 */
function $put(v: string | Uint8Array): number {
  const at = Math.ceil($used / 8) * 8;
  const max = typeof v === 'string' ? v.length * 3 : v.byteLength;
  $last = 0;
  if (max === 0) return at;
  if (at + max > $mem.length) $grow(at + max);
  if (typeof v === 'string') {
    $last = $te.encodeInto(v, $mem.subarray(at)).written;
  } else {
    $mem.set(v, at);
    $last = v.byteLength;
  }
  $used = at + $last;
  return at;
}

/** A larger buffer with the bytes so far copied over. The old one is zeroed, so a pointer into it can never read a stale argument. */
function $grow(need: number): void {
  const next = new ArrayBuffer(Math.max(need, $mem.length * 2));
  const mem = new Uint8Array(next);
  mem.set($mem.subarray(0, $used));
  $mem.fill(0);
  $buf = next;
  $mem = mem;
}

/** Phase 2: the pointer of the FINAL scratch buffer, taken after every argument is in it; resets it for the next call. */
function $base(): number {
  $used = 0;
  return $ffi.ptr($buf);
}`);
  }

  const checks: Record<string, string> = {
    $int: `function $int(fn: string, arg: string, v: unknown, min: number, max: number): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new TypeError(\`\${fn}(): argument "\${arg}" must be an integer from \${min} to \${max}, got \${String(v)}\`);
  }
}`,
    $big: `function $big(fn: string, arg: string, v: unknown, min: bigint, max: bigint): void {
  if (typeof v !== 'bigint' || v < min || v > max) {
    throw new TypeError(\`\${fn}(): argument "\${arg}" must be a bigint from \${min} to \${max}, got \${typeof v} \${String(v)}\`);
  }
}`,
    $num: `function $num(fn: string, arg: string, v: unknown): void {
  if (typeof v !== 'number') throw new TypeError(\`\${fn}(): argument "\${arg}" must be a number, got \${typeof v}\`);
}`,
    $bool: `function $bool(fn: string, arg: string, v: unknown): void {
  if (typeof v !== 'boolean') throw new TypeError(\`\${fn}(): argument "\${arg}" must be a boolean, got \${typeof v}\`);
}`,
    $str: `function $str(fn: string, arg: string, v: unknown): void {
  if (typeof v !== 'string') throw new TypeError(\`\${fn}(): argument "\${arg}" must be a string, got \${typeof v}\`);
}`,
    $bytes: `function $bytes(fn: string, arg: string, v: unknown): void {
  if (!(v instanceof Uint8Array)) throw new TypeError(\`\${fn}(): argument "\${arg}" must be a Uint8Array\`);
}`,
    $s64: `/** A 64-bit integer crosses JSON as a decimal string. */
function $s64(v: bigint): string {
  return v.toString();
}`,
    $d64: `function $d64(fn: string, at: string, v: unknown): bigint {
  if (typeof v !== 'string' || !/^-?[0-9]+$/.test(v)) {
    throw new RustError(fn, \`\${at}: expected a 64-bit integer as a decimal string, got \${JSON.stringify(v)}\`);
  }
  return BigInt(v);
}`,
    $fin: `function $fin(fn: string, at: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RustError(
      fn,
      \`\${at}: expected a finite number, got \${v === null ? 'null (NaN and Infinity cannot cross as JSON)' : JSON.stringify(v)}\`,
    );
  }
  return v;
}`,
    $efin: `/** Called only for a value that is not a finite number: a NaN or Infinity cannot cross as JSON. */
function $efin(fn: string, at: string, v: unknown): unknown {
  if (typeof v === 'number') {
    throw new TypeError(\`\${fn}(): argument "\${at}" must be a finite number (JSON has no NaN or Infinity), got \${String(v)}\`);
  }
  return v;
}`,
    $opt: `function $opt<T, U>(v: T | null | undefined, f: (x: T) => U): U | null {
  return v === null || v === undefined ? null : f(v);
}`,
    $vec: `function $vec<U>(v: unknown, at: string, f: (x: unknown, at: string) => U): U[] {
  return (v as unknown[]).map((x, i) => f(x, \`\${at}[\${i}]\`));
}`,
  };
  if (e.used.has('$I64')) {
    parts.push(
      "const $I64_MIN = BigInt('-9223372036854775808');\nconst $I64_MAX = BigInt('9223372036854775807');",
    );
  }
  if (e.used.has('$U64')) {
    parts.push("const $U64_MIN = BigInt('0');\nconst $U64_MAX = BigInt('18446744073709551615');");
  }
  for (const [name, text] of Object.entries(checks)) if (e.used.has(name)) parts.push(text);
  parts.push(schemas);
  return parts.join('\n\n');
}

/**
 * Render the module for `manifest` (ADR-0069 D13). Pure: the same manifest and
 * options give the same text, whatever the order of records in the library.
 */
export function renderModule(manifest: Manifest, options: RenderOptions): string {
  if (!/^[A-Za-z0-9_]+$/.test(options.libName)) {
    throw new Error(`renderModule: "${options.libName}" is not a library name`);
  }
  const records = new Map(manifest.records.map((r) => [r.name, r]));
  const e = new Emitter(records);

  const fnBlocks = manifest.fns.map((f) => `${fnDoc(f, e)}\n${e.fn(f)}`);
  // Record codecs, in name order (the encoder/decoder sets grow transitively while emitting).
  const codecs: string[] = [];
  for (const r of manifest.records) {
    if (e.encoders.has(r.name)) codecs.push(e.encoder(r));
    if (e.decoders.has(r.name)) codecs.push(e.decoder(r));
  }
  const scratch = e.used.has('$put');

  const types = [
    ...manifest.records.map(
      (r) =>
        `${typeDoc(r.doc)}export interface ${r.name} {\n${r.fields
          .map((f) => `  ${key(f.name)}: ${tsType(f.type, true)};\n`)
          .join('')}}`,
    ),
    ...manifest.enums.map(
      (en) =>
        `${typeDoc(en.doc)}export type ${en.name} = ${
          en.variants.length === 0 ? 'never' : en.variants.map(q).join(' | ')
        };`,
    ),
  ];

  const spec = [
    "  knext_ffi_v1_free: { args: ['ptr', 'usize'], returns: 'void' },",
    ...manifest.fns.flatMap((f) => {
      const args = [
        ...f.args.flatMap((a) =>
          byValue(a.type) ? [q(FFI_TYPE[a.type.t] as string)] : ["'ptr'", "'usize'"],
        ),
        "'ptr'",
      ];
      return [
        `  ${f.symbol}: { args: [${args.join(', ')}], returns: 'i32' },`,
        `  ${f.symbol}_schema: { args: [], returns: 'u64' },`,
      ];
    }),
  ];
  const symbolsIface = [
    'interface $Symbols {',
    '  knext_ffi_v1_free(ptr: number, len: number): void;',
    ...manifest.fns.map((f) => `  ${f.symbol}(...args: $Arg[]): number;`),
    '}',
  ];
  const schemas = [
    '/** [export, symbol, expected FNV-1a 64 of its transitive schema]. */',
    'const $SCHEMAS: readonly (readonly [string, string, string])[] = [',
    ...manifest.fns.map(
      (f) =>
        `  [${q(f.name)}, ${q(f.symbol)}, ${q(fnv1a64(schemaString(f, manifest)).toString())}],`,
    ),
    '];',
  ].join('\n');

  const out = [
    '// Generated by `knext ffi generate`. Do not edit: change the Rust crate, then run `knext ffi generate`.',
    `// ${BETA_LINE}`,
    `// ABI: knext_ffi v1. Library: lib${options.libName} (crate ${options.crate}). From manifest sha256 ${manifestDigest(manifest)}.`,
    "import 'server-only';",
    "import { createHash as $createHash } from 'node:crypto';",
    'import {',
    '  existsSync as $existsSync,',
    '  readdirSync as $readdirSync,',
    '  readFileSync as $readFileSync,',
    '  statSync as $statSync,',
    "} from 'node:fs';",
    "import { dirname as $dirname, join as $join } from 'node:path';",
    '',
    ERROR_CLASSES,
    '',
    ...types.flatMap((t) => [t, '']),
    ...fnBlocks.flatMap((b) => [b, '']),
    '// ---------------------------------------------------------------------------',
    '// Internals. Nothing below runs at import time: the first call loads the library.',
    '// ---------------------------------------------------------------------------',
    '',
    `const $LIB = ${q(options.libName)};`,
    `const $CRATE = ${q(options.crate)};`,
    `const $PRERENDER = ${q(PRERENDER)};`,
    '',
    'const $SPEC = {',
    ...spec,
    '};',
    '',
    symbolsIface.join('\n'),
    '',
    runtime(e, schemas, scratch),
    ...codecs.flatMap((c) => ['', c]),
  ];
  return `${out.join('\n')}\n`;
}
