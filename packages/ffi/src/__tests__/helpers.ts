/**
 * Shared test scaffolding: scratch directories, captured CLI output, synthetic
 * manifest blobs (ADR-0069 D5) and the kitchen-sink manifest every suite uses.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

export const PKG_DIR = resolve(import.meta.dir, '..', '..');

const scratchDirs: string[] = [];

/** An empty scratch directory, removed by {@link removeScratchDirs}. */
export function emptyDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `knext-ffi-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/** Remove every scratch directory this file created. Call from `afterAll`. */
export function removeScratchDirs(): void {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  scratchDirs.length = 0;
}

/** Every file under `dir`, as relative path -> contents, sorted by path. */
export function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

export interface Captured {
  readonly io: { stdout: (s: string) => void; stderr: (s: string) => void };
  readonly out: () => string;
  readonly err: () => string;
}

export function capture(): Captured {
  let o = '';
  let e = '';
  return {
    io: {
      stdout: (s) => {
        o += s;
      },
      stderr: (s) => {
        e += s;
      },
    },
    out: () => o,
    err: () => e,
  };
}

const MAGIC = 'KNEXTFFI1';

/**
 * A synthetic "library": arbitrary bytes with one `KNEXTFFI1<json>\0` record
 * per entry, the way the macro embeds them (D5). `junk` pads before, between
 * and after the records so the scanner cannot rely on alignment.
 */
export function blob(records: readonly (object | string)[], junk = 'xx\u0001\u0002'): Uint8Array {
  const parts: string[] = [junk];
  for (const r of records) {
    parts.push(`${MAGIC}${typeof r === 'string' ? r : JSON.stringify(r)}\u0000`, junk);
  }
  return new TextEncoder().encode(parts.join(''));
}

type Desc = Record<string, unknown>;
const t = (s: string): Desc => ({ t: s });
const rec = (name: string): Desc => ({ t: 'record', name });
const en = (name: string): Desc => ({ t: 'enum', name });
const opt = (of: Desc): Desc => ({ t: 'option', of });
const vec = (of: Desc): Desc => ({ t: 'vec', of });

export const D = { t, rec, en, opt, vec };

/** The canonical type token #2343's macro writes into `sig` (ADR-0069 D4). */
export function tok(d: Desc): string {
  const t = String(d.t);
  if (t === 'record' || t === 'enum') return String(d.name);
  if (t === 'option' || t === 'vec') return `${t}<${tok(d.of as Desc)}>`;
  return t;
}

/** A fn manifest record (D5). The hash is arbitrary: the generator copies it. */
export function fn(
  name: string,
  args: [string, Desc, string?][],
  ret: Desc,
  opts: { doc?: string; err?: string; hash?: string; retRust?: string } = {},
): Record<string, unknown> {
  const hash = opts.hash ?? '0badc0de';
  return {
    v: 1,
    kind: 'fn',
    name,
    symbol: `knext_ffi_v1_${name}_${hash}`,
    sig: `${name}(${args.map((a) => tok(a[1])).join(',')})->${tok(ret)}`,
    doc: opts.doc ?? '',
    args: args.map(([n, type, rust]) => ({ name: n, type, rust: rust ?? String(type.t) })),
    ret: { type: ret, rust: opts.retRust ?? String(ret.t) },
    err: opts.err ? { rust: opts.err } : null,
  };
}

export function record(name: string, fields: [string, Desc][], doc = ''): Record<string, unknown> {
  return {
    v: 1,
    kind: 'record',
    name,
    doc,
    fields: fields.map(([n, type]) => ({ name: n, type, rust: String(type.t) })),
  };
}

export function enumRecord(name: string, variants: string[], doc = ''): Record<string, unknown> {
  return { v: 1, kind: 'enum', name, doc, variants };
}

/**
 * The kitchen sink: every D6 row the runtime tests exercise, plus records,
 * an enum, Option/Vec JSON types (with 64-bit integers in every JSON
 * position) and a Result. The C fixture library (fixtures/abi-v1/fixture.c)
 * implements exactly these exports.
 */
export const KITCHEN_SINK: Record<string, unknown>[] = [
  fn(
    'add',
    [
      ['a', t('i32')],
      ['b', t('i32')],
    ],
    t('i32'),
  ),
  fn('big', [['x', t('i64')]], t('i64')),
  fn('boom', [], t('unit'), { retRust: '()' }),
  fn('color', [['c', en('Color'), 'Color']], en('Color'), { retRust: 'Color' }),
  fn(
    'concat',
    [
      ['a', t('string'), '&str'],
      ['b', t('string'), '&str'],
    ],
    t('string'),
    {
      retRust: 'String',
    },
  ),
  fn('echo_bytes', [['data', t('bytes'), 'Vec<u8>']], t('bytes'), { retRust: 'Vec<u8>' }),
  fn('echo_point', [['p', rec('Point'), 'Point']], rec('Point'), { retRust: 'Point' }),
  fn('bad_point', [], rec('Point'), { retRust: 'Point' }),
  fn('flag', [['b', t('bool')]], t('bool')),
  fn('greet', [['name', t('string'), '&str']], t('string'), {
    doc: 'Says hello.\n\nThe greeting is built in Rust.',
    retRust: 'String',
  }),
  fn('half', [['x', t('f64')]], t('f64')),
  fn('ids', [['v', vec(t('i64')), 'Vec<i64>']], vec(t('i64')), { retRust: 'Vec<i64>' }),
  fn('maybe', [['x', opt(t('u64')), 'Option<u64>']], opt(t('u64')), { retRust: 'Option<u64>' }),
  fn('nop', [], t('unit'), { retRust: '()' }),
  // Floats inside JSON: a NaN or Infinity there must be refused, never sent as null.
  fn('opt_f', [['x', opt(t('f64')), 'Option<f64>']], opt(t('f64')), { retRust: 'Option<f64>' }),
  fn('floats', [['xs', vec(opt(t('f64'))), 'Vec<Option<f64>>']], vec(opt(t('f64'))), {
    retRust: 'Vec<Option<f64>>',
  }),
  fn('parse', [['s', t('string'), '&str']], t('i32'), {
    err: 'ParseIntError',
    retRust: 'Result<i32, ParseIntError>',
    doc: 'Parses a decimal integer.',
  }),
  fn('strict', [['s', t('string'), '&str']], t('string'), { retRust: 'String' }),
  fn('sum', [['data', t('bytes'), '&[u8]']], t('u64')),
  fn('tiny', [['x', t('i8')]], t('i8')),
  // Argument names the generated function body must not shadow or redeclare:
  // each is (or was) a name the emitter itself declares inside an export, and
  // `join` is (or was) an import of the generated module.
  fn('scale', [['r', t('f64')]], rec('Point'), { retRust: 'Point' }),
  fn(
    'join',
    [
      ['st', t('string'), '&str'],
      ['base', t('string'), '&str'],
      ['o0', t('string'), '&str'],
      ['n0', t('string'), '&str'],
      ['r', t('string'), '&str'],
    ],
    vec(t('string')),
    { retRust: 'Vec<String>' },
  ),
  // A library that sends a 64-bit integer as a JSON number, at the top of a
  // record and inside a Vec in it: the decoder must refuse both, naming the path.
  // Field names that are Object.prototype members or keywords (Rust's
  // `r#type`, `r#new` arrive bare): each must still be an own property.
  fn('echo_odd', [['o', rec('Odd'), 'Odd']], rec('Odd'), { retRust: 'Odd' }),
  fn('bad_id', [], rec('Point'), { retRust: 'Point' }),
  fn('bad_tag', [], rec('Point'), { retRust: 'Point' }),
  record(
    'Point',
    [
      ['id', t('u64')],
      ['x', t('f64')],
      ['label', t('string')],
      ['tags', vec(t('u64'))],
      ['inner', opt(rec('Inner'))],
      ['color', en('Color')],
    ],
    'A point with an id.',
  ),
  record('Inner', [
    ['n', t('i64')],
    ['when', opt(t('usize'))],
  ]),
  enumRecord('Color', ['Red', 'Green'], 'A colour.'),
  record('Odd', [
    ['constructor', t('u64')],
    ['toString', t('string')],
    ['valueOf', t('f64')],
    ['hasOwnProperty', opt(t('i64'))],
    ['prototype', vec(t('u64'))],
    ['new', t('bool')],
    ['type', en('Color')],
    ['__defineGetter__', t('string')],
  ]),
];
