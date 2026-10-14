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
import ts from 'typescript';
import { type Manifest, RESERVED, scanManifest } from '../manifest';
import { renderModule } from '../render';
import { blob, D, enumRecord, fn, KITCHEN_SINK, record } from './helpers';

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

describe('generated output carries no internal references (it lands in user apps)', () => {
  const src = render(KITCHEN_SINK);
  it('no ADR, issue or PR numbers, design-decision labels or review-round labels', () => {
    expect(src).not.toMatch(/ADR-\d/);
    expect(src).not.toMatch(/#\d+/);
    expect(src).not.toMatch(/\bD\d+\b/);
    expect(src).not.toMatch(/\bround \d/i);
  });
});
