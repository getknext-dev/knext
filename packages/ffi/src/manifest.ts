/**
 * The manifest a knext-ffi library carries inside itself (ADR-0069 D5), and
 * the scanner that reads it.
 *
 * For each `#[knext_ffi::export]` function and each `#[knext_ffi::record]`
 * type, the macro embeds the 9-byte magic `KNEXTFFI1`, one JSON object and a
 * NUL. The scanner reads the library file's BYTES — it never loads the
 * library — so a musl `.so` cross-built on a macOS host scans exactly like the
 * host's own `.dylib`, and the wrapper derived from it is the same.
 *
 * Pure: no I/O. Every refusal is a {@link ManifestError} naming what is wrong.
 */

import { createHash } from 'node:crypto';

export const MAGIC = 'KNEXTFFI1';
export const MANIFEST_VERSION = 1;

export const SCALARS = [
  'i8',
  'i16',
  'i32',
  'i64',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'usize',
  'f32',
  'f64',
  'bool',
  'string',
  'bytes',
  'unit',
] as const;
export type Scalar = (typeof SCALARS)[number];

export type TypeDesc =
  | { readonly t: Scalar }
  | { readonly t: 'record'; readonly name: string }
  | { readonly t: 'enum'; readonly name: string }
  | { readonly t: 'option'; readonly of: TypeDesc }
  | { readonly t: 'vec'; readonly of: TypeDesc };

export interface Arg {
  readonly name: string;
  readonly type: TypeDesc;
  readonly rust: string;
}

export interface FnRecord {
  readonly name: string;
  readonly symbol: string;
  readonly sig: string;
  readonly doc: string;
  readonly args: readonly Arg[];
  readonly ret: { readonly type: TypeDesc; readonly rust: string };
  readonly err: { readonly rust: string } | null;
}

export interface RecordType {
  readonly name: string;
  readonly doc: string;
  readonly fields: readonly Arg[];
}

export interface EnumType {
  readonly name: string;
  readonly doc: string;
  readonly variants: readonly string[];
}

/** A scanned manifest, every list sorted by name. */
export interface Manifest {
  readonly fns: readonly FnRecord[];
  readonly records: readonly RecordType[];
  readonly enums: readonly EnumType[];
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

/**
 * Words a generated identifier may not be: JavaScript/TypeScript reserved
 * words (a function or parameter named `new` does not parse), the names the
 * generated module declares itself without a `$` prefix, and the globals it
 * references (an export named `process` would shadow the one the loader reads).
 * Everything else the module declares is `$`-prefixed, which a Rust identifier
 * cannot be. ffi-render-hygiene.test.ts scans a rendered module for every name
 * it declares or references, so this list cannot fall behind the emitter.
 */
export const RESERVED: ReadonlySet<string> = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'arguments',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
  'RustError',
  'RustPanicError',
  'FfiLoadError',
  // Globals the generated module references.
  'ArrayBuffer',
  'BigInt',
  'DataView',
  'Error',
  'JSON',
  'Math',
  'Number',
  'Record',
  'String',
  'TextEncoder',
  'TypeError',
  'Uint8Array',
  'console',
  'process',
  // ...and the ones its slow-call counter references.
  'Map',
  'Symbol',
  'globalThis',
  'performance',
]);

/**
 * Words a generated record or enum name may not be, on top of {@link RESERVED}:
 * TypeScript's built-in type names (`export interface string` does not
 * compile) and the type-operator keywords that do not parse where a type is
 * expected (`p: keyof`). ffi-render-hygiene.test.ts tries every TypeScript
 * keyword as a type name and type-checks the result, so this list cannot fall
 * behind the compiler.
 */
export const RESERVED_TYPES: ReadonlySet<string> = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'number',
  'object',
  'string',
  'symbol',
  'unknown',
  'as',
  'infer',
  'keyof',
  'readonly',
  'unique',
]);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkIdent(name: string, what: 'function' | 'argument' | 'type'): void {
  if (!IDENT.test(name) || RESERVED.has(name) || (what === 'type' && RESERVED_TYPES.has(name))) {
    throw new ManifestError(
      `"${name}" cannot be a generated ${what} name: rename it in Rust (it must be an identifier ` +
        `that is not a JavaScript reserved word${what === 'type' ? ', a TypeScript built-in type name' : ''} ` +
        'or a name the generated module declares)',
    );
  }
}

/** A Rust field name (XID_Start XID_Continue*, `r#` already stripped by the macro). */
const FIELD = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;

/**
 * A field becomes an object key and a property name, where keywords are legal
 * (`r#type` arrives as `type`). One key is not: `{ __proto__: x }` sets the
 * object's prototype instead of creating a property, so the field would never
 * reach Rust and would be missing from every decoded object.
 */
function checkField(name: string): void {
  if (!FIELD.test(name) || name === '__proto__') {
    throw new ManifestError(
      `"${name}" cannot be a generated field name: rename it in Rust (it must be an identifier, ` +
        'and not __proto__, which an object literal treats as the prototype, not a property)',
    );
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse a type descriptor, or `undefined` if its shape is wrong. Unknown scalars are kept for a named error. */
function parseDesc(raw: unknown): TypeDesc | undefined {
  if (!isObj(raw) || typeof raw.t !== 'string') return undefined;
  const t = raw.t;
  if (t === 'record' || t === 'enum') {
    return typeof raw.name === 'string' ? { t, name: raw.name } : undefined;
  }
  if (t === 'option' || t === 'vec') {
    const of = parseDesc(raw.of);
    return of ? { t, of } : undefined;
  }
  return { t: t as Scalar };
}

function parseArgs(raw: unknown): Arg[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Arg[] = [];
  for (const a of raw) {
    if (!isObj(a) || typeof a.name !== 'string' || typeof a.rust !== 'string') return undefined;
    const type = parseDesc(a.type);
    if (!type) return undefined;
    out.push({ name: a.name, type, rust: a.rust });
  }
  return out;
}

type Parsed =
  | { kind: 'fn'; fn: FnRecord }
  | { kind: 'record'; record: RecordType }
  | { kind: 'enum'; enum: EnumType };

function parseRecord(obj: Record<string, unknown>, at: number): Parsed {
  const label = `${String(obj.kind)} "${String(obj.name)}"`;
  const malformed = () =>
    new ManifestError(
      `manifest record at byte ${at} (${label}) is malformed; is the knext-ffi crate the version this @getknext/ffi expects?`,
    );
  if (typeof obj.name !== 'string' || typeof obj.doc !== 'string') throw malformed();
  if (obj.kind === 'fn') {
    const args = parseArgs(obj.args);
    const ret = isObj(obj.ret) ? obj.ret : undefined;
    const retType = ret ? parseDesc(ret.type) : undefined;
    const err = obj.err;
    if (
      typeof obj.symbol !== 'string' ||
      typeof obj.sig !== 'string' ||
      !args ||
      !ret ||
      !retType ||
      typeof ret.rust !== 'string' ||
      !(err === null || (isObj(err) && typeof err.rust === 'string'))
    ) {
      throw malformed();
    }
    return {
      kind: 'fn',
      fn: {
        name: obj.name,
        symbol: obj.symbol,
        sig: obj.sig,
        doc: obj.doc,
        args,
        ret: { type: retType, rust: ret.rust },
        err: err === null ? null : { rust: (err as { rust: string }).rust },
      },
    };
  }
  if (obj.kind === 'record') {
    const fields = parseArgs(obj.fields);
    if (!fields) throw malformed();
    return { kind: 'record', record: { name: obj.name, doc: obj.doc, fields } };
  }
  if (obj.kind === 'enum') {
    const v = obj.variants;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw malformed();
    return { kind: 'enum', enum: { name: obj.name, doc: obj.doc, variants: v as string[] } };
  }
  throw malformed();
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Scan a library's bytes for its manifest. Throws a {@link ManifestError} on
 * no functions, an unknown manifest version, a truncated or non-JSON record
 * (naming the byte offset, which also catches a false-positive magic in user
 * data), a duplicate export or type name, a malformed or unknown type, or a
 * function or record that names a type the library has no record for.
 */
export function scanManifest(bytes: Uint8Array): Manifest {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = Buffer.from(MAGIC, 'latin1');
  const seen = new Set<string>();
  const fns = new Map<string, FnRecord>();
  const types = new Map<string, Parsed>();

  for (let i = buf.indexOf(magic); i !== -1; ) {
    const start = i + magic.length;
    const end = buf.indexOf(0, start);
    if (end === -1) {
      throw new ManifestError(
        `truncated manifest record at byte ${i}: no NUL before the end of the file`,
      );
    }
    const json = buf.toString('utf8', start, end);
    if (!seen.has(json)) {
      seen.add(json);
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch (err) {
        throw new ManifestError(
          `manifest record at byte ${i} is not valid JSON (${(err as Error).message}). ` +
            `If this library is not a knext-ffi library, the bytes "${MAGIC}" occurred in other data.`,
        );
      }
      if (!isObj(raw)) {
        throw new ManifestError(`manifest record at byte ${i} is not a JSON object`);
      }
      if (raw.v !== MANIFEST_VERSION) {
        throw new ManifestError(
          `unsupported manifest version ${JSON.stringify(raw.v)} at byte ${i}; this @getknext/ffi reads ` +
            `version ${MANIFEST_VERSION}. Use a knext-ffi crate and an @getknext/ffi that match.`,
        );
      }
      const parsed = parseRecord(raw, i);
      if (parsed.kind === 'fn') {
        if (fns.has(parsed.fn.name)) {
          throw new ManifestError(
            `duplicate export "${parsed.fn.name}": two different functions in one library have the same name`,
          );
        }
        fns.set(parsed.fn.name, parsed.fn);
      } else {
        const name = parsed.kind === 'record' ? parsed.record.name : parsed.enum.name;
        if (types.has(name)) {
          throw new ManifestError(
            `duplicate type "${name}": two different records or enums have the same name`,
          );
        }
        types.set(name, parsed);
      }
    }
    i = buf.indexOf(magic, end);
  }

  if (fns.size === 0) {
    throw new ManifestError('no exported functions found; is this the right library?');
  }

  const records = [...types.values()]
    .flatMap((p) => (p.kind === 'record' ? [p.record] : []))
    .sort(byName);
  const enums = [...types.values()]
    .flatMap((p) => (p.kind === 'enum' ? [p.enum] : []))
    .sort(byName);

  const check = (d: TypeDesc, owner: string, what: string, topReturn: boolean): void => {
    switch (d.t) {
      case 'record':
      case 'enum': {
        const found = types.get(d.name);
        if (!found) {
          throw new ManifestError(
            `${owner}: ${what} names ${d.t} "${d.name}", but the library has no ${d.t} for it`,
          );
        }
        if (found.kind !== d.t) {
          throw new ManifestError(
            `${owner}: ${what} names ${d.t} "${d.name}", but "${d.name}" is an ${found.kind}`,
          );
        }
        return;
      }
      case 'option':
      case 'vec':
        check(d.of, owner, what, false);
        return;
      case 'unit':
        if (!topReturn) throw new ManifestError(`${owner}: ${what} cannot be unit`);
        return;
      default:
        if (!(SCALARS as readonly string[]).includes(d.t)) {
          throw new ManifestError(`${owner}: ${what} has unknown type "${d.t}"`);
        }
    }
  };

  for (const f of fns.values()) {
    checkIdent(f.name, 'function');
    const symbol = new RegExp(`^knext_ffi_v1_${f.name}_[0-9a-f]{8}$`);
    if (!symbol.test(f.symbol)) {
      throw new ManifestError(
        `${f.name}: symbol "${f.symbol}" is not knext_ffi_v1_${f.name}_<8 hex digits> (ABI v1)`,
      );
    }
    for (const a of f.args) {
      checkIdent(a.name, 'argument');
      check(a.type, f.name, `argument "${a.name}"`, false);
    }
    check(f.ret.type, f.name, 'the return type', true);
  }
  for (const r of records) {
    checkIdent(r.name, 'type');
    for (const fl of r.fields) {
      checkField(fl.name);
      check(fl.type, r.name, `field "${fl.name}"`, false);
    }
  }
  for (const e of enums) checkIdent(e.name, 'type');

  return { fns: [...fns.values()].sort(byName), records, enums };
}

/** The canonical JSON of a manifest (sorted), for its digest. */
function canonical(m: Manifest): string {
  return JSON.stringify(m);
}

/** sha256 of the manifest's canonical form: record order and file layout do not change it. */
export function manifestDigest(m: Manifest): string {
  return createHash('sha256').update(canonical(m)).digest('hex');
}

/** The type token the macro uses in `sig` and the schema string (ADR-0069 D4). */
export function typeToken(d: TypeDesc): string {
  if (d.t === 'record' || d.t === 'enum') return d.name;
  if (d.t === 'option' || d.t === 'vec') return `${d.t}<${typeToken(d.of)}>`;
  return d.t;
}

/**
 * The canonical schema string of a function (ADR-0069 D4): its `sig`, then
 * every record and enum it can reach (transitively, deduplicated, sorted by
 * name byte-wise), concatenated with no separator. A record is
 * `Name{field:tok,…}` in declaration order; an enum is `Name[A|B|…]`.
 */
export function schemaString(f: FnRecord, m: Manifest): string {
  const records = new Map(m.records.map((r) => [r.name, r]));
  const enums = new Map(m.enums.map((e) => [e.name, e]));
  const reached = new Map<string, string>();
  const visit = (d: TypeDesc): void => {
    if (d.t === 'option' || d.t === 'vec') {
      visit(d.of);
    } else if (d.t === 'record' && !reached.has(d.name)) {
      const r = records.get(d.name);
      if (!r) return;
      reached.set(
        r.name,
        `${r.name}{${r.fields.map((x) => `${x.name}:${typeToken(x.type)}`).join(',')}}`,
      );
      for (const x of r.fields) visit(x.type);
    } else if (d.t === 'enum' && !reached.has(d.name)) {
      const e = enums.get(d.name);
      if (e) reached.set(e.name, `${e.name}[${e.variants.join('|')}]`);
    }
  };
  for (const a of f.args) visit(a.type);
  visit(f.ret.type);
  const names = [...reached.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return f.sig + names.map((n) => reached.get(n)).join('');
}

const FNV64_OFFSET = BigInt('0xcbf29ce484222325');
const FNV64_PRIME = BigInt('0x100000001b3');
const U64_MASK = BigInt('0xffffffffffffffff');

/** FNV-1a, 64-bit, over the UTF-8 bytes of `s` (what the `_schema` symbol returns). */
export function fnv1a64(s: string): bigint {
  let h = FNV64_OFFSET;
  for (const byte of Buffer.from(s, 'utf8')) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & U64_MASK;
  }
  return h;
}
