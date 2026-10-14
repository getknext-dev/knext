/**
 * The hygiene of the generated module, kept in its own file so a mutation
 * prover can run it without the full golden in render.test.ts (which reds on
 * any change to the output, and would make every mutation look caught):
 *
 * - no name the generator declares or references can collide with a name
 *   that comes from Rust (an export, an argument, a record or an enum);
 * - the TSDoc promises only the checks the module actually makes;
 * - the output, which lands in user apps, carries no internal references.
 *
 * scripts/mutation-prove-ffi-generator.mjs proves each of these goes red
 * when the behaviour it guards is removed.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';
import { type Manifest, RESERVED, scanManifest } from '../manifest';
import { renderModule } from '../render';
import { blob, D, enumRecord, fn, KITCHEN_SINK, PKG_DIR, record } from './helpers';

const OPTS = { libName: 'zone', crate: 'rust' };
const render = (records: Record<string, unknown>[]) =>
  renderModule(scanManifest(blob(records)), OPTS);

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

describe('whatever legal names Rust uses, the module type-checks with zero diagnostics', () => {
  const APP = join(PKG_DIR, 'fixtures', 'app');

  /**
   * Type-check modules with the TypeScript compiler under the fixture app's
   * own tsconfig (strict, Node types only, the dom + esnext libs, what a
   * Next.js app has) and return every diagnostic, by module.
   */
  function typecheck(modules: Record<string, string>): string[] {
    const cfg = ts.readConfigFile(join(APP, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, APP);
    const files = new Map(
      Object.entries(modules).map(([n, src]) => [join(APP, 'src', 'adversarial', `${n}.ts`), src]),
    );
    const host = ts.createCompilerHost(parsed.options);
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.getSourceFile = (f, lang, ...rest) => {
      const src = files.get(f);
      return src === undefined
        ? getSourceFile(f, lang, ...rest)
        : ts.createSourceFile(f, src, lang, true, ts.ScriptKind.TS);
    };
    host.fileExists = (f) => files.has(f) || fileExists(f);
    host.readFile = (f) => files.get(f) ?? readFile(f);
    const program = ts.createProgram(
      [...files.keys(), join(APP, 'server-only.d.ts')],
      parsed.options,
      host,
    );
    return ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file ? `${d.file.fileName.split('/').at(-1)}: ` : '';
      const line =
        d.file && d.start !== undefined
          ? `${d.file.text.split('\n')[d.file.getLineAndCharacterOfPosition(d.start).line]?.trim()} -> `
          : '';
      return `${where}${line}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
  }

  /**
   * The names to try, none enumerated by hand: every TypeScript keyword (from
   * the compiler's own token table), every name an object inherits from
   * Object.prototype or a function from Function.prototype, and every
   * identifier the generated module itself mentions (its helpers, parameters,
   * imports, the globals and lib types it references, the properties it reads).
   */
  const candidates = (() => {
    const names = new Set<string>();
    for (let k = ts.SyntaxKind.FirstKeyword; k <= ts.SyntaxKind.LastKeyword; k++) {
      const s = ts.tokenToString(k);
      if (s) names.add(s);
    }
    for (const n of Object.getOwnPropertyNames(Object.prototype)) names.add(n);
    for (const n of Object.getOwnPropertyNames(Function.prototype)) names.add(n);
    for (const n of Object.getOwnPropertyNames(class {})) names.add(n); // + prototype
    const sink = renderModule(scanManifest(blob(KITCHEN_SINK)), OPTS);
    const sf = ts.createSourceFile('/m.ts', sink, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !n.text.startsWith('$')) names.add(n.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    // The fixed names the role manifests below use themselves.
    for (const n of ['Rec', 'Inner', 'Ev', 'p', 'q', 'A', 'B']) names.delete(n);
    return [...names].sort();
  })();

  /** Does the scanner accept this manifest? Only a ManifestError counts as a refusal. */
  const accepts = (records: Record<string, unknown>[]): boolean => {
    try {
      scanManifest(blob(records));
      return true;
    } catch (err) {
      if ((err as Error).name !== 'ManifestError') throw err;
      expect((err as Error).message).toContain('rename it in Rust');
      return false;
    }
  };

  const SCALAR_MIX = [
    D.rec('Rec'),
    D.t('string'),
    D.t('i64'),
    D.vec(D.t('u64')),
    D.opt(D.rec('Rec')),
    D.t('bytes'),
    D.t('i32'),
    D.t('f64'),
    D.t('bool'),
    D.en('Ev'),
  ];
  const mix = (i: number) => SCALAR_MIX[i % SCALAR_MIX.length] as Record<string, unknown>;
  const BASE = [
    record('Rec', [
      ['id', D.t('u64')],
      ['inner', D.opt(D.rec('Inner'))],
    ]),
    record('Inner', [['n', D.t('i64')]]),
    enumRecord('Ev', ['A', 'B']),
  ];

  /** Per role, the one-name manifest that tries `n` there. */
  const ROLES: Record<string, (n: string, i: number) => Record<string, unknown>[]> = {
    function: (n, i) => [fn(n, [['p', mix(i)]], mix(i + 1)), ...BASE],
    argument: (n, i) => [fn(`a${i}`, [[n, mix(i)]], mix(i + 3)), ...BASE],
    record: (n, i) => [
      fn(
        `r${i}`,
        [
          ['p', D.rec(n)],
          ['q', D.vec(D.rec(n))],
        ],
        D.opt(D.rec(n)),
      ),
      record(n, [
        ['id', D.t('u64')],
        ['tags', D.vec(D.t('i64'))],
        ['inner', D.opt(D.rec('Inner'))],
      ]),
      ...BASE,
    ],
    enum: (n, i) => [
      fn(`e${i}`, [['p', D.en(n)]], D.vec(D.en(n))),
      enumRecord(n, ['A', 'B']),
      ...BASE,
    ],
    field: (n, i) => [
      fn('echo', [['p', D.rec(`F${i}`)]], D.rec(`F${i}`)),
      record(`F${i}`, [[n, mix(i)]]),
      ...BASE,
    ],
  };

  /** Per role: the accepted names, rendered together in one module (all at once, so they also meet each other). */
  const accepted: Record<string, string[]> = {};
  const modules: Record<string, string> = {};
  for (const [role, one] of Object.entries(ROLES)) {
    const ok = candidates.filter((n, i) => accepts(one(n, i)));
    accepted[role] = ok;
    const all: Record<string, unknown>[] =
      role === 'function'
        ? ok.map((n, i) => fn(n, [['p', mix(i)]], mix(i + 1)))
        : role === 'argument'
          ? [
              ...ok.map((n, i) => fn(`a${i}`, [[n, mix(i)]], mix(i + 3))),
              fn(
                'all',
                ok.map((n, i): [string, Record<string, unknown>] => [n, mix(i)]),
                D.t('unit'),
              ),
            ]
          : role === 'record'
            ? ok.flatMap((n, i) =>
                (ROLES.record as (n: string, i: number) => Record<string, unknown>[])(n, i).slice(
                  0,
                  2,
                ),
              )
            : role === 'enum'
              ? ok.flatMap((n, i) => [
                  fn(`e${i}`, [['p', D.en(n)]], D.vec(D.en(n))),
                  enumRecord(n, ['A', 'B']),
                ])
              : [
                  fn('echo', [['p', D.rec('Fld')]], D.rec('Fld')),
                  record(
                    'Fld',
                    ok.map((n, i): [string, Record<string, unknown>] => [n, mix(i)]),
                  ),
                ];
    modules[role] = renderModule(scanManifest(blob([...all, ...BASE])), OPTS);
  }

  it('the candidates and the acceptance are not vacuous', () => {
    expect(candidates.length).toBeGreaterThan(150);
    for (const n of ['string', 'type', 'constructor', 'toString', 'Uint8Array', 'getUint32', 'v']) {
      expect(candidates).toContain(n);
    }
    // Keywords are legal property names and Rust raw identifiers (r#type) arrive bare.
    for (const n of ['type', 'new', 'class', 'constructor', 'toString', 'prototype']) {
      expect(accepted.field).toContain(n);
    }
    for (const role of ['function', 'argument', 'record', 'enum']) {
      expect(accepted[role]?.length ?? 0, role).toBeGreaterThan(50);
    }
  });

  it('the type-check can see red: a TypeScript built-in type name declared as an interface is a diagnostic', () => {
    const diags = typecheck({ red: 'export interface string {\n  id: number;\n}\n' });
    expect(diags.some((d) => d.includes('TS2427'))).toBe(true);
  });

  it('the committed golden (the kitchen sink) type-checks with zero diagnostics', () => {
    expect(typecheck({ sink: renderModule(scanManifest(blob(KITCHEN_SINK)), OPTS) })).toEqual([]);
  });

  it('every accepted function, argument, record, enum and field name renders a module with zero diagnostics', () => {
    expect(typecheck(modules)).toEqual([]);
  }, 60_000);

  it('a TypeScript built-in type name is refused as a record or enum name, naming it', () => {
    for (const n of [
      'string',
      'number',
      'boolean',
      'bigint',
      'symbol',
      'object',
      'unknown',
      'never',
      'any',
    ]) {
      expect(() => render([fn('f', [], D.t('unit')), record(n, [['id', D.t('u64')]])]), n).toThrow(
        `"${n}" cannot be a generated type name: rename it in Rust`,
      );
      expect(() => render([fn('f', [], D.t('unit')), enumRecord(n, ['A'])]), n).toThrow(
        `"${n}" cannot be a generated type name: rename it in Rust`,
      );
    }
  });
});

describe('a record field always becomes an own property of the object', () => {
  it('a field named __proto__ is refused at generate time (an object literal would set the prototype and drop the field)', () => {
    expect(() =>
      render([fn('f', [], D.t('unit')), record('P', [['__proto__', D.t('string')]])]),
    ).toThrow('"__proto__" cannot be a generated field name: rename it in Rust');
  });

  it('a field name that is not an identifier is refused, naming it', () => {
    expect(() => render([fn('f', [], D.t('unit')), record('P', [['a-b', D.t('string')]])])).toThrow(
      '"a-b" cannot be a generated field name: rename it in Rust',
    );
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
