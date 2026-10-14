/**
 * The TS emitter (ADR-0069 D6, D7, D8, D13): golden snippets per type-mapping
 * row, the record/enum/Option/Vec JSON codecs, the error classes, the lazy
 * loader's shape, and the spike's binding rules. The behaviour of the emitted
 * code is proven by ffi-loader.test.ts against a real library; this file pins what
 * is emitted, and one full golden file pins all of it at once.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { fnv1a64, type Manifest, RESERVED, scanManifest, schemaString } from '../manifest';
import { renderModule } from '../render';
import { blob, D, enumRecord, fn, KITCHEN_SINK, PKG_DIR, record } from './helpers';

const OPTS = { libName: 'zone', crate: 'rust' };
const render = (records: Record<string, unknown>[]) =>
  renderModule(scanManifest(blob(records)), OPTS);

/** The emitted body of `export function <name>`. */
function body(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  expect(start, `export function ${name} missing`).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

interface Row {
  t: string;
  ts: string;
  ffi: string;
  check: string | null;
  read: string;
}

/** D6, by-value rows: TS type, bun:ffi type, argument check, return read. */
const SCALARS: Row[] = [
  {
    t: 'i8',
    ts: 'number',
    ffi: 'i8',
    check: "$int('f', 'x', x, -128, 127)",
    read: '$view.getInt8(0)',
  },
  {
    t: 'i16',
    ts: 'number',
    ffi: 'i16',
    check: "$int('f', 'x', x, -32768, 32767)",
    read: '$view.getInt16(0, true)',
  },
  {
    t: 'i32',
    ts: 'number',
    ffi: 'i32',
    check: "$int('f', 'x', x, -2147483648, 2147483647)",
    read: '$view.getInt32(0, true)',
  },
  {
    t: 'u8',
    ts: 'number',
    ffi: 'u8',
    check: "$int('f', 'x', x, 0, 255)",
    read: '$view.getUint8(0)',
  },
  {
    t: 'u16',
    ts: 'number',
    ffi: 'u16',
    check: "$int('f', 'x', x, 0, 65535)",
    read: '$view.getUint16(0, true)',
  },
  {
    t: 'u32',
    ts: 'number',
    ffi: 'u32',
    check: "$int('f', 'x', x, 0, 4294967295)",
    read: '$view.getUint32(0, true)',
  },
  {
    t: 'i64',
    ts: 'bigint',
    ffi: 'i64',
    check: "$big('f', 'x', x, $I64_MIN, $I64_MAX)",
    read: '$view.getBigInt64(0, true)',
  },
  {
    t: 'isize',
    ts: 'bigint',
    ffi: 'i64',
    check: "$big('f', 'x', x, $I64_MIN, $I64_MAX)",
    read: '$view.getBigInt64(0, true)',
  },
  {
    t: 'u64',
    ts: 'bigint',
    ffi: 'u64',
    check: "$big('f', 'x', x, $U64_MIN, $U64_MAX)",
    read: '$view.getBigUint64(0, true)',
  },
  {
    t: 'usize',
    ts: 'bigint',
    ffi: 'u64',
    check: "$big('f', 'x', x, $U64_MIN, $U64_MAX)",
    read: '$view.getBigUint64(0, true)',
  },
  {
    t: 'f32',
    ts: 'number',
    ffi: 'f32',
    check: "$num('f', 'x', x)",
    read: '$view.getFloat32(0, true)',
  },
  {
    t: 'f64',
    ts: 'number',
    ffi: 'f64',
    check: "$num('f', 'x', x)",
    read: '$view.getFloat64(0, true)',
  },
  {
    t: 'bool',
    ts: 'boolean',
    ffi: 'bool',
    check: "$bool('f', 'x', x)",
    read: '$view.getUint8(0) !== 0',
  },
];

describe('D6 golden rows — by-value scalars, argument and return', () => {
  for (const row of SCALARS) {
    it(`${row.t} → ${row.ts}`, () => {
      const src = render([fn('f', [['x', D.t(row.t)]], D.t(row.t))]);
      const f = body(src, 'f');
      expect(f).toContain(`export function f(x: ${row.ts}): ${row.ts} {`);
      expect(f).toContain(row.check as string);
      expect(f).toContain('$lib.knext_ffi_v1_f_0badc0de(x, $outPtr)');
      expect(f).toContain(`return ${row.read};`);
      expect(src).toContain(
        `knext_ffi_v1_f_0badc0de: { args: ['${row.ffi}', 'ptr'], returns: 'i32' }`,
      );
    });
  }

  it('64-bit integers are bigint and range-checked against the full 64-bit range', () => {
    const src = render([fn('f', [['x', D.t('i64')]], D.t('unit'))]);
    expect(src).toContain("const $I64_MIN = BigInt('-9223372036854775808');");
    expect(src).toContain("const $I64_MAX = BigInt('9223372036854775807');");
    // No bigint literals: an app tsconfig targeting ES2017 (Next.js's default) rejects them.
    expect(src).not.toMatch(/\d+n\b/);
  });

  it('a non-integer or out-of-range number throws a TypeError naming the argument', () => {
    const src = render([fn('f', [['x', D.t('i32')]], D.t('unit'))]);
    expect(src).toContain(
      'function $int(fn: string, arg: string, v: unknown, min: number, max: number): void {',
    );
    expect(src).toContain('throw new TypeError(');
    expect(src).toMatch(/Number\.isInteger\(v\)/);
  });
});

describe('D6 golden rows — buffers, unit, JSON types', () => {
  it('String/&str → string: UTF-8 (ptr, len) in, copied and freed out', () => {
    const src = render([fn('f', [['s', D.t('string'), '&str']], D.t('string'))]);
    const f = body(src, 'f');
    expect(f).toContain('export function f(s: string): string {');
    expect(f).toContain("$str('f', 's', s);");
    expect(f).toContain('const $o0 = $put(s);\n  const $n0 = $last;\n  const $scratch = $base();');
    expect(f).toContain(
      '$lib.knext_ffi_v1_f_0badc0de($n0 === 0 ? null : $scratch + $o0, $n0, $outPtr)',
    );
    expect(f).toContain('return $takeString();');
    expect(src).toContain(
      "knext_ffi_v1_f_0badc0de: { args: ['ptr', 'usize', 'ptr'], returns: 'i32' }",
    );
  });

  it('Vec<u8>/&[u8] → Uint8Array: copied into the scratch buffer (an empty one passed as NULL), copied out', () => {
    const src = render([fn('f', [['data', D.t('bytes'), '&[u8]']], D.t('bytes'))]);
    const f = body(src, 'f');
    expect(f).toContain('export function f(data: Uint8Array): Uint8Array {');
    expect(f).toContain("$bytes('f', 'data', data);");
    expect(f).toContain('const $o0 = $put(data);');
    expect(f).toContain(
      '$lib.knext_ffi_v1_f_0badc0de($n0 === 0 ? null : $scratch + $o0, $n0, $outPtr)',
    );
    expect(f).toContain('return $takeBytes();');
    expect(f).not.toContain('ptr(');
  });

  it('() → void', () => {
    const f = body(render([fn('f', [], D.t('unit'))]), 'f');
    expect(f).toContain('export function f(): void {');
    expect(f).toContain('$lib.knext_ffi_v1_f_0badc0de($outPtr)');
    expect(f).not.toContain('return $');
  });

  it('records → interfaces; unit enums → string-literal unions; both cross as JSON', () => {
    const src = render([
      fn('f', [['p', D.rec('P')]], D.en('C')),
      record(
        'P',
        [
          ['id', D.t('u64')],
          ['name', D.t('string')],
          ['c', D.en('C')],
        ],
        'A point.',
      ),
      enumRecord('C', ['Red', 'Green'], 'A colour.'),
    ]);
    expect(src).toContain(
      '/** A point. */\nexport interface P {\n  id: bigint;\n  name: string;\n  c: C;\n}',
    );
    expect(src).toContain("/** A colour. */\nexport type C = 'Red' | 'Green';");
    const f = body(src, 'f');
    expect(f).toContain('export function f(p: P): C {');
    expect(f).toContain('const $o0 = $put(JSON.stringify($e_P(p)));');
    expect(f).toContain('const $r: unknown = JSON.parse($takeString());');
    expect(f).toContain('return $r as C;');
    expect(src).toContain('function $e_P(v: P): unknown {');
    expect(src).toContain('id: $s64(v.id)');
  });

  it('Option<T> → T | null, Vec<T> → T[] (T ≠ u8), JSON', () => {
    const src = render([
      fn(
        'f',
        [
          ['a', D.opt(D.t('string'))],
          ['b', D.vec(D.t('i32'))],
        ],
        D.vec(D.opt(D.t('f64'))),
      ),
    ]);
    const f = body(src, 'f');
    expect(f).toContain('export function f(a: string | null, b: number[]): (number | null)[] {');
    expect(f).toContain('const $o0 = $put(JSON.stringify(a));');
    expect(f).toContain('const $o1 = $put(JSON.stringify(b));');
    expect(f).toContain(
      "$vec($r, 'result', ($x0, $at0) => $opt($x0, ($x1) => $fin('f', $at0, $x1)))",
    );
  });

  it('a Vec<u8> inside a JSON type is number[] (raw bytes only cross at the top level)', () => {
    const src = render([fn('f', [], D.rec('P')), record('P', [['b', D.t('bytes')]])]);
    expect(src).toContain('export interface P {\n  b: number[];\n}');
  });

  it('64-bit integers in EVERY JSON position travel as decimal strings and decode to bigint', () => {
    const src = render([
      fn(
        'f',
        [
          ['a', D.opt(D.t('u64'))],
          ['b', D.vec(D.t('i64'))],
          ['p', D.rec('P')],
        ],
        D.opt(D.t('usize')),
      ),
      record('P', [['xs', D.vec(D.opt(D.t('isize')))]]),
    ]);
    const f = body(src, 'f');
    expect(f).toContain('JSON.stringify($opt(a, ($x0) => $s64($x0)))');
    expect(f).toContain('JSON.stringify(b.map(($x0) => $s64($x0)))');
    expect(f).toContain("return $opt($r, ($x0) => $d64('f', 'result', $x0));");
    expect(src).toContain('xs: v.xs.map(($x0) => $opt($x0, ($x1) => $s64($x1)))');
    expect(src).toContain('function $d64(fn: string, at: string, v: unknown): bigint {');
    expect(src).not.toContain('$d_P');
    const g = body(
      render([fn('g', [], D.rec('P')), record('P', [['xs', D.vec(D.opt(D.t('isize')))]])]),
      'g',
    );
    expect(g).toContain("return $d_P('g', 'result', $r);");
  });

  it('floats inside JSON must be finite: a null where the schema says f64 is a RustError naming the field', () => {
    const src = render([fn('f', [], D.rec('P')), record('P', [['x', D.t('f64')]])]);
    expect(src).toContain("x: $fin(fn, at + '.x', o['x'])");
    expect(src).toContain('function $fin(fn: string, at: string, v: unknown): number {');
    expect(src).toMatch(/throw new RustError\(\s*fn,\s*`\$\{at\}: expected a finite number/);
  });

  it('Result<T, E> → T; Err throws RustError (documented in TSDoc)', () => {
    const src = render([
      fn('parse', [['s', D.t('string'), '&str']], D.t('i32'), {
        err: 'ParseIntError',
        retRust: 'Result<i32, ParseIntError>',
      }),
    ]);
    expect(body(src, 'parse')).toContain('export function parse(s: string): number {');
    expect(src).toContain(
      '@throws {RustError} when the Rust function returns `Err` (`ParseIntError`).',
    );
  });

  it('Rust doc comments are carried to TSDoc, with the Rust signature', () => {
    const src = render([
      fn('greet', [['name', D.t('string'), '&str']], D.t('string'), {
        doc: 'Says hello.\n\nUses */ safely.',
        retRust: 'String',
      }),
    ]);
    expect(src).toContain(
      '/**\n * Says hello.\n *\n * Uses *\\/ safely.\n *\n * Rust: `greet(name: &str) -> String`\n *\n',
    );
    expect(src).toContain(' * @throws {RustPanicError} when the Rust function panics.\n');
    expect(src).toContain(' * @throws {FfiLoadError} when the Rust library cannot be loaded.\n');
  });
});

describe('TSDoc says what is checked in JavaScript and what is not', () => {
  const src = render([
    fn(
      'f',
      [
        ['p', D.rec('P'), 'P'],
        ['n', D.t('i32')],
        ['c', D.en('C'), 'C'],
        ['s', D.t('string'), '&str'],
      ],
      D.t('unit'),
      { retRust: '()' },
    ),
    fn('g', [['p', D.rec('P'), 'P']], D.t('unit'), { retRust: '()' }),
    record('P', [['id', D.t('u64')]]),
    enumRecord('C', ['Red']),
  ]);
  const doc = (name: string) => {
    const at = src.indexOf(`export function ${name}(`);
    return src.slice(src.lastIndexOf('/**', at), at);
  };

  it('TypeError is promised only for the arguments the module checks, by name', () => {
    expect(doc('f')).toContain(
      ' * @throws {TypeError} when `n` or `s` has the wrong type or is out of range.\n',
    );
    expect(doc('g')).not.toContain('TypeError');
    expect(src).not.toContain('when an argument has the wrong type');
  });

  it('record and enum arguments are documented as unchecked in JavaScript: Rust rejects them as invalid input', () => {
    expect(doc('f')).toContain(
      ' * @throws {RustError} ("invalid input: …") when `p` or `c` is a value Rust cannot decode: record, enum, Option and Vec arguments are not checked in JavaScript.\n',
    );
    expect(doc('g')).toContain(
      ' * @throws {RustError} ("invalid input: …") when `p` is a value Rust cannot decode: record, enum, Option and Vec arguments are not checked in JavaScript.\n',
    );
  });
});

describe('generated names never collide with Rust names', () => {
  /** Names a binding pattern declares. */
  const bound = (n: ts.BindingName): string[] =>
    ts.isIdentifier(n)
      ? [n.text]
      : n.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bound(e.name)));

  /** An identifier that names a property or member, not a binding. */
  const isPropertyName = (id: ts.Identifier): boolean => {
    const p = id.parent;
    return (
      (ts.isPropertyAccessExpression(p) && p.name === id) ||
      (ts.isQualifiedName(p) && p.right === id) ||
      ((ts.isPropertyAssignment(p) ||
        ts.isPropertySignature(p) ||
        ts.isMethodSignature(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isMethodDeclaration(p)) &&
        p.name === id) ||
      (ts.isImportSpecifier(p) && p.propertyName === id)
    );
  };

  /**
   * Scan a rendered module with the TypeScript compiler (no lib, so anything
   * not declared in the module itself resolves to nothing — a global):
   * - `locals`: every binding an exported function's BODY declares (variables,
   *   nested-function parameters), as `<export>: <name>`;
   * - `moduleNames`: every module-scope name the generator declares itself
   *   (imports, helpers, classes) — the manifest's own names excluded;
   * - `globals`: every name the module references but does not declare.
   * Nothing is enumerated by hand: a new local, helper or import is covered.
   */
  function scan(src: string, m: Manifest) {
    const file = '/m.ts';
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const host: ts.CompilerHost = {
      getSourceFile: (f) => (f === file ? sf : undefined),
      writeFile: () => {},
      getDefaultLibFileName: () => '/lib.d.ts',
      useCaseSensitiveFileNames: () => true,
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => '/',
      getNewLine: () => '\n',
      fileExists: (f) => f === file,
      readFile: (f) => (f === file ? src : undefined),
    };
    const checker = ts
      .createProgram([file], { noLib: true, noResolve: true, types: [] }, host)
      .getTypeChecker();

    const userNames = new Set([
      ...m.fns.map((f) => f.name),
      ...m.records.map((r) => r.name),
      ...m.enums.map((e) => e.name),
    ]);
    const exports = new Set(m.fns.map((f) => f.name));
    const locals: string[] = [];
    const moduleNames: string[] = [];
    const globals = new Set<string>();

    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        const c = st.importClause;
        if (c?.name) moduleNames.push(c.name.text);
        const nb = c?.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) moduleNames.push(nb.name.text);
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) moduleNames.push(e.name.text);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) moduleNames.push(...bound(d.name));
      } else if (
        (ts.isFunctionDeclaration(st) ||
          ts.isClassDeclaration(st) ||
          ts.isInterfaceDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) ||
          ts.isEnumDeclaration(st)) &&
        st.name &&
        !userNames.has(st.name.text)
      ) {
        moduleNames.push(st.name.text);
      }

      if (ts.isFunctionDeclaration(st) && st.name && exports.has(st.name.text) && st.body) {
        const fn = st.name.text;
        const visit = (n: ts.Node): void => {
          if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
            for (const name of bound(n.name)) locals.push(`${fn}: ${name}`);
          } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) {
            locals.push(`${fn}: ${n.name.text}`);
          }
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(st.body, visit);
      }
    }

    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !isPropertyName(n)) {
        const sym = checker.getSymbolAtLocation(n);
        const declaredHere = sym?.declarations?.some((d) => d.getSourceFile() === sf) ?? false;
        if (!declaredHere) globals.add(n.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return { locals, moduleNames, globals: [...globals].sort() };
  }

  const SINK = scanManifest(blob(KITCHEN_SINK));
  const SRC = renderModule(SINK, OPTS);
  const scanned = scan(SRC, SINK);

  it('the scan sees what it is meant to see (it is not vacuous)', () => {
    expect(scanned.locals.length).toBeGreaterThan(10);
    expect(scanned.locals.some((l) => l.startsWith('concat: '))).toBe(true);
    expect(scanned.locals.some((l) => l.startsWith('ids: '))).toBe(true);
    expect(scanned.moduleNames).toContain('RustError');
    expect(scanned.globals).toContain('process');
    expect(scanned.globals).toContain('JSON');
  });

  it("every local an export's body declares is $-prefixed: a Rust identifier cannot contain $", () => {
    expect(scanned.locals.filter((l) => !l.split(': ')[1]?.startsWith('$'))).toEqual([]);
  });

  it('every module-scope name the generator declares is $-prefixed or one the scanner refuses as a Rust name', () => {
    expect(scanned.moduleNames.filter((n) => !n.startsWith('$') && !RESERVED.has(n))).toEqual([]);
  });

  it('every global the module references is $-prefixed or one the scanner refuses as a Rust name', () => {
    expect(scanned.globals.filter((n) => !n.startsWith('$') && !RESERVED.has(n))).toEqual([]);
  });

  it('a module whose arguments are named r, st, base, o0, n0 and whose export is named join parses', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    expect(() => transpiler.transformSync(SRC)).not.toThrow();
    const only = render([
      fn('scale', [['r', D.t('f64')]], D.rec('P'), { retRust: 'P' }),
      fn(
        'join',
        ['st', 'base', 'o0', 'n0', 'x0', 'at0', 'r'].map(
          (n): [string, Record<string, unknown>, string] => [n, D.t('string'), '&str'],
        ),
        D.vec(D.opt(D.t('i64'))),
        { retRust: 'Vec<Option<i64>>' },
      ),
      record('P', [['id', D.t('u64')]]),
    ]);
    expect(() => transpiler.transformSync(only)).not.toThrow();
  });

  it('a Rust name the module needs for itself is refused at generate time, naming it', () => {
    for (const name of scanned.globals.filter((n) => !n.startsWith('$'))) {
      expect(() => render([fn(name, [], D.t('unit'))]), name).toThrow(
        `"${name}" cannot be a generated function name`,
      );
    }
  });
});

describe('generated output carries no internal references (it lands in user apps)', () => {
  const src = render(KITCHEN_SINK);
  it('no ADR, issue or PR numbers, design-decision labels or review-round labels', () => {
    expect(src).not.toMatch(/ADR-\d/);
    expect(src).not.toMatch(/#\d+/);
    expect(src).not.toMatch(/\bD\d+\b/);
    expect(src).not.toMatch(/\bround \d/i);
  });
});

describe('D8 — the three error classes', () => {
  const src = render([fn('f', [], D.t('unit'))]);
  for (const cls of ['RustError', 'RustPanicError', 'FfiLoadError']) {
    it(`exports ${cls} extends Error with its own name`, () => {
      expect(src).toContain(`export class ${cls} extends Error {`);
      expect(src).toContain(`this.name = '${cls}';`);
    });
  }
  it('status 1 → RustError, 2 → RustPanicError, 3 → RustError "invalid input", else a wrapper bug', () => {
    expect(src).toContain('function $fail(fn: string, status: number): never {');
    expect(src).toContain('if (status === 2) throw new RustPanicError(fn, message);');
    expect(src).toContain(
      'throw new RustError(fn, status === 3 ? `invalid input: $' + '{message}` : message);',
    );
    expect(src).toContain('which ABI v1 does not define');
  });
});

describe('D13 — the module contract', () => {
  const src = render(KITCHEN_SINK);
  const code = src
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n');

  it('header: generated notice, Beta line, ABI version, manifest digest, do not edit', () => {
    const head = src.split('\n').slice(0, 4).join('\n');
    expect(head).toContain('Generated by `knext ffi generate`. Do not edit');
    expect(head).toContain('In-process Rust (Beta)');
    expect(head).toContain('ABI: knext_ffi v1');
    expect(head).toMatch(/manifest sha256 [0-9a-f]{64}/);
  });

  it("`import 'server-only'` is the first statement", () => {
    expect(code.trimStart().startsWith("import 'server-only';")).toBe(true);
  });

  it('no top-level bun:ffi import: obtained lazily through process.getBuiltinModule', () => {
    expect(src).not.toMatch(/from\s+['"]bun:ffi['"]/);
    expect(src).not.toMatch(/import\s*\(\s*['"]bun:ffi['"]/);
    expect(src).not.toMatch(/require\s*\(\s*['"]bun:ffi['"]/);
    expect(src).toContain("process.getBuiltinModule('bun:ffi')");
    const load = src.indexOf("process.getBuiltinModule('bun:ffi')");
    expect(src.lastIndexOf('function $open(', load)).toBeGreaterThan(-1);
  });

  it('type-checks without @types/bun: no Bun global, hashes with node:crypto createHash', () => {
    expect(code).not.toMatch(/\bBun\./);
    expect(src).toContain("import { createHash as $createHash } from 'node:crypto';");
    expect(src).toContain("$createHash('sha256')");
  });

  it('the Node guard message of D15 step 2', () => {
    expect(src).toContain(
      'In-process Rust (bun:ffi) runs only on Bun; this process is Node $' +
        '{process.version}. Run the app with Bun (bun --bun next dev), or call this code through a zone function.',
    );
  });

  it('a load failure is cached, so later calls fail the same way without retrying', () => {
    expect(src).toContain('if ($failed) throw $failed;');
  });

  it('every symbol the wrapper calls is in the dlopen list, plus knext_ffi_v1_free', () => {
    expect(src).toContain("knext_ffi_v1_free: { args: ['ptr', 'usize'], returns: 'void' }");
    for (const r of KITCHEN_SINK.filter((x) => x.kind === 'fn')) {
      expect(src).toContain(`${r.symbol as string}: { args: [`);
    }
  });

  it('path resolution: native/ffi/<triple> beside the executable first, dev fallback gated on NODE_ENV', () => {
    expect(src).toContain("$join($dirname(process.execPath), 'native')");
    expect(src).toContain("process.env['NODE_ENV'] !== 'production'");
    expect(src).toContain("const $LIB = 'zone';");
    expect(src).toContain("const $CRATE = 'rust';");
    expect(src).not.toMatch(/process\.env\.KNEXT_/);
  });

  it('a not-found library names prerendering and how to make the route dynamic (ADR-0069 round 2)', () => {
    const notFound = src.slice(src.indexOf('function $resolve('), src.indexOf('function $verify('));
    for (const s of ['$PRERENDER', 'knext ffi build', 'Tried:']) expect(notFound).toContain(s);
    for (const s of [
      'prerendering',
      'generateStaticParams',
      'generateMetadata',
      'force-dynamic',
      'await connection()',
    ]) {
      expect(src).toContain(s);
    }
  });
});

describe('D4 round 2 — the transitive _schema check at load', () => {
  const m = scanManifest(blob(KITCHEN_SINK));
  const src = renderModule(m, OPTS);

  it('binds <symbol>_schema() -> u64 for every export', () => {
    for (const f of m.fns) {
      expect(src).toContain(`  ${f.symbol}_schema: { args: [], returns: 'u64' },`);
    }
  });

  it("records the FNV-1a 64 of each export's transitive schema string", () => {
    for (const f of m.fns) {
      expect(src).toContain(
        `  ['${f.name}', '${f.symbol}', '${fnv1a64(schemaString(f, m)).toString()}'],`,
      );
    }
  });

  it('a mismatch (or a missing _schema) is the stale-wrapper FfiLoadError', () => {
    expect(src).toContain("const actual = schema ? String(schema()) : 'missing';");
    expect(src).toContain('The module is stale: run `knext ffi generate` and commit the result.');
  });
});

describe('D13 step 5 round 2 — prerendering is detected before the Bun check', () => {
  const src = render([fn('f', [], D.t('unit'))]);
  it("NEXT_PHASE === 'phase-production-build' throws the prerender FfiLoadError first", () => {
    const phase = src.indexOf("process.env['NEXT_PHASE'] === 'phase-production-build'");
    expect(phase).toBeGreaterThan(-1);
    expect(phase).toBeLessThan(src.indexOf("if (!process.versions['bun'])"));
    for (const s of [
      'prerendering',
      'generateStaticParams',
      'generateMetadata',
      'await connection()',
    ]) {
      expect(src).toContain(s);
    }
  });
});
describe('D13 item 6 — the spike binding rules', () => {
  const src = render(KITCHEN_SINK);

  it('ptr() is only ever taken of an explicit ArrayBuffer (the out slot, the scratch buffer)', () => {
    expect(src.match(/[\w$]*\.ptr\([^)]*\)/g)).toEqual(['ffi.ptr(buf)', '$ffi.ptr($buf)']);
    // The only other `ptr(` is the local type declaration of bun:ffi's ptr.
    expect(src.match(/\bptr\(/g)).toHaveLength(3);
    expect(src).toContain('  ptr(buffer: ArrayBuffer): number;');
    expect(src).toContain('$buf = new ArrayBuffer(4096);');
    expect(src).toContain('const next = new ArrayBuffer(');
    expect(src).toContain('const buf = new ArrayBuffer(16);');
    expect(src).toContain('$outPtr = ffi.ptr(buf);');
    expect(src.indexOf('const buf = new ArrayBuffer(16);')).toBeLessThan(
      src.indexOf('$outPtr = ffi.ptr(buf);'),
    );
  });

  it('(ptr, len) pairs are read as two u32 halves, never through a BigInt', () => {
    expect(src).toContain('$view.getUint32(0, true) + $view.getUint32(4, true) * 4294967296');
    expect(src).toContain('$view.getUint32(8, true) + $view.getUint32(12, true) * 4294967296');
  });

  it('returned strings are a length-bounded CString read; bytes are copied; both freed in finally', () => {
    expect(src).toContain('return new $ffi.CString(p, 0, len).toString();');
    expect(src).toContain('return new Uint8Array($ffi.toArrayBuffer(p, 0, len)).slice();');
    expect(src.match(/\} finally \{\n\s+\$lib\.knext_ffi_v1_free\(p, len\);/g)).toHaveLength(2);
  });

  it('an empty argument is passed as NULL, never through ptr()', () => {
    // Measured on Bun 1.4.2: an empty Uint8Array passed as a ptr argument
    // arrives NON-null; JavaScript null arrives as NULL.
    const f = body(src, 'sum');
    expect(f).toContain(
      '$lib.knext_ffi_v1_sum_0badc0de($n0 === 0 ? null : $scratch + $o0, $n0, $outPtr)',
    );
    expect(src).toContain('if (max === 0) return at;');
    expect(src).toContain('type $Arg = number | bigint | boolean | null;');
  });

  it('multi-argument marshalling: every argument is encoded before the pointer is taken (ADR-0069 round 2)', () => {
    for (const r of KITCHEN_SINK.filter((x) => x.kind === 'fn')) {
      const f = body(src, r.name as string);
      if (!f.includes('$put(')) continue;
      expect(f.indexOf('const $scratch = $base();'), r.name as string).toBeGreaterThan(
        f.lastIndexOf('$put('),
      );
      expect(f.indexOf('const $scratch = $base();')).toBeLessThan(f.indexOf('$lib.'));
    }
    const concat = body(src, 'concat');
    expect(concat).toContain('const $o0 = $put(a);');
    expect(concat).toContain('const $o1 = $put(b);');
    // Offsets are 8-byte aligned; a grow copies the bytes so far and zeroes the old buffer.
    expect(src).toContain('const at = Math.ceil($used / 8) * 8;');
    expect(src).toContain('mem.set($mem.subarray(0, $used));\n  $mem.fill(0);');
  });

  it('integer arguments are range-checked before the call', () => {
    const f = body(src, 'add');
    expect(f.indexOf('$int(')).toBeLessThan(f.indexOf('$lib.'));
  });
});

describe('the full golden module (the fixture app type-checks it with Node types only)', () => {
  const GOLDEN = join(PKG_DIR, 'fixtures', 'app', 'src', 'generated', 'ffi', 'index.ts');
  it('renderModule(KITCHEN_SINK) equals fixtures/app/src/generated/ffi/index.ts', () => {
    const src = renderModule(scanManifest(blob(KITCHEN_SINK)), {
      libName: 'fixture',
      crate: 'rust',
    });
    if (process.env.KNEXT_FFI_UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, src);
    expect(existsSync(GOLDEN)).toBe(true);
    expect(src).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('is deterministic and independent of record order in the library', () => {
    const a = renderModule(scanManifest(blob(KITCHEN_SINK)), OPTS);
    const b = renderModule(scanManifest(blob([...KITCHEN_SINK].reverse())), OPTS);
    expect(a).toBe(b);
  });

  it('only emits the helpers it uses', () => {
    const src = render([fn('f', [['x', D.t('i32')]], D.t('i32'))]);
    for (const h of [
      '$takeBytes',
      '$put',
      '$base',
      '$d64',
      '$fin',
      '$opt',
      '$vec',
      '$s64',
      '$big',
      '$I64_MIN',
    ]) {
      expect(src, h).not.toContain(h);
    }
  });
});
