/**
 * Unused-export guard for `packages/kn-next/src`.
 *
 * An `export` that no other tracked file mentions is a leak of internals (and
 * `IMPORT_CONDITIONS` in `sidecar-runtime.mjs` had no reference anywhere). The
 * scan lives in `scripts/lib/unused-export-scan.mjs`; this spec has
 *
 *   - RED / GREEN fixtures for each rule, on an in-memory file map, so the
 *     scanner is proved to see red independent of the real tree;
 *   - a check that the public-surface exemption is GENERATED from the package
 *     manifest + tsup entry table (not a hand-written list);
 *   - the real-tree assertion: zero unused exports, zero unreadable constructs.
 *
 * `scripts/mutation-prove-unused-exports.mjs` proves the real-tree assertion
 * goes red when an unused export is planted in a shipped file.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  exportedNames,
  publicSourceFiles,
  readTrackedFiles,
  scanTree,
  scanUnusedExports,
} from '../scripts/lib/unused-export-scan.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PKG = 'packages/kn-next';
const SRC = `${PKG}/src`;

const scan = (files: Record<string, string>, pub: string[] = []) =>
  scanUnusedExports(new Map(Object.entries(files)), new Set(pub));
const names = (files: Record<string, string>, pub: string[] = []) =>
  scan(files, pub).violations.map((v) => v.name);

describe('exportedNames: the declaration shapes it reads', () => {
  it.each([
    ['export const', 'export const A = 1;', ['A']],
    ['export async function', 'export async function f() {}', ['f']],
    ['export function*', 'export function* g() {}', ['g']],
    ['export class', 'export class C {}', ['C']],
    ['export enum', 'export enum E { X }', ['E']],
    ['export const enum', 'export const enum E2 { X }', ['E2']],
    ['an export list', 'const a = 1, b = 2;\nexport { a, b };', ['a', 'b']],
    ['an aliased export', 'const a = 1;\nexport { a as renamed };', ['renamed']],
    ['a re-export', "export { x, y as z } from './m.js';", ['x', 'z']],
    ['a namespace re-export', "export * as ns from './m.js';", ['ns']],
  ])('%s', (_label, src, want) => {
    expect(exportedNames(src).names.map((n) => n.name)).toEqual(want);
  });

  it('does not read an export that only appears in a comment or a string', () => {
    const src =
      '// export const A = 1;\n/* export function f() {} */\nconst s = "export const B = 2";';
    expect(exportedNames(src).names).toEqual([]);
  });

  it('skips type-only exports (out of scope, stated in the module doc)', () => {
    const src =
      'export interface I {}\nexport type T = string;\nexport type { U } from "./m.js";\nexport { type V, w } from "./m.js";';
    expect(exportedNames(src).names.map((n) => n.name)).toEqual(['w']);
  });

  it('reports a destructuring export as unreadable instead of passing it', () => {
    expect(exportedNames('export const { a, b } = obj;').unreadable.length).toBe(1);
    expect(exportedNames('export const [a] = arr;').unreadable.length).toBe(1);
  });
});

describe('scanUnusedExports: RED fixtures', () => {
  it('flags an export referenced nowhere', () => {
    expect(names({ [`${SRC}/a.ts`]: 'export const ORPHAN = 1;' })).toEqual(['ORPHAN']);
  });

  it('flags an export used only inside its own file', () => {
    expect(
      names({ [`${SRC}/a.ts`]: 'export function helper() {}\nexport const x = helper();' }),
    ).toContain('helper');
  });

  it('does NOT count the declaration companion (.d.mts) as an importer', () => {
    expect(
      names({
        [`${SRC}/a.mjs`]: 'export const ORPHAN = 1;',
        [`${SRC}/a.d.mts`]: 'export const ORPHAN: number;',
      }),
    ).toEqual(['ORPHAN']);
  });

  it('flags an unused member of an export list and an aliased export', () => {
    expect(
      names({
        [`${SRC}/a.ts`]: 'const p = 1, q = 2;\nexport { p, q as shown };',
        [`${SRC}/b.ts`]: "import { p } from './a.js'; console.log(p);",
      }),
    ).toEqual(['shown']);
  });

  it('fails an unreadable destructuring export rather than passing it', () => {
    const r = scan({ [`${SRC}/a.ts`]: 'export const { a } = obj;' });
    expect(r.unreadable.length).toBe(1);
  });
});

describe('scanUnusedExports: stale declaration companions', () => {
  it('flags a name the .d.mts declares but the source no longer exports', () => {
    const r = scan({
      [`${SRC}/a.mjs`]: 'function hidden() {}\nexport const kept = hidden();',
      [`${SRC}/a.d.mts`]: 'export function hidden(): void;\nexport const kept: void;',
      [`${SRC}/b.ts`]: "import { kept } from './a.mjs'; kept;",
    });
    expect(r.staleDeclarations.map((d: { name: string }) => d.name)).toEqual(['hidden']);
  });

  it('passes a companion that declares exactly what the source exports', () => {
    const r = scan({
      [`${SRC}/a.mjs`]: 'export const kept = 1;',
      [`${SRC}/a.d.mts`]: 'export const kept: number;',
      [`${SRC}/b.ts`]: "import { kept } from './a.mjs'; kept;",
    });
    expect(r.staleDeclarations).toEqual([]);
  });
});

describe('scanUnusedExports: GREEN fixtures', () => {
  it('passes an export a test imports', () => {
    expect(
      names({
        [`${SRC}/a.ts`]: 'export const USED = 1;',
        [`${SRC}/__tests__/a.test.ts`]: "import { USED } from '../a.js'; USED;",
      }),
    ).toEqual([]);
  });

  it('passes an export a script, a doc or a workflow mentions', () => {
    for (const other of ['scripts/x.mjs', 'docs/x.md', '.github/workflows/x.yml']) {
      expect(
        names({ [`${SRC}/a.ts`]: 'export const USED_ELSEWHERE = 1;', [other]: 'USED_ELSEWHERE' }),
      ).toEqual([]);
    }
  });

  it('exempts the public surface (and only that)', () => {
    const files = {
      [`${SRC}/api.ts`]: 'export const PUBLIC_API = 1;',
      [`${SRC}/internal.ts`]: 'export const LEAK = 1;',
    };
    expect(names(files, [`${SRC}/api.ts`])).toEqual(['LEAK']);
  });

  it('ignores test files, fixtures and declaration files as scoped sources', () => {
    const r = scan({
      [`${SRC}/__tests__/t.ts`]: 'export const T = 1;',
      [`${SRC}/a.test.ts`]: 'export const T2 = 1;',
      [`${SRC}/a.d.ts`]: 'export const T3: number;',
      'packages/other/src/a.ts': 'export const NOT_MY_PACKAGE = 1;',
    });
    expect(r.violations).toEqual([]);
    expect(r.scoped).toBe(0);
  });
});

describe('the public-surface exemption is GENERATED, not hand-written', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/kn-next/package.json'), 'utf8'),
  );
  const tsup = readFileSync(resolve(REPO_ROOT, 'packages/kn-next/tsup.config.ts'), 'utf8');
  const tracked = readTrackedFiles(REPO_ROOT);
  const pub = publicSourceFiles(manifest, tsup, (p: string) => tracked.has(p));

  it('resolves every exports-map and bin target to a tracked source file', () => {
    expect(pub.unresolved).toEqual([]);
    for (const f of pub.files) expect(tracked.has(f)).toBe(true);
  });

  it('maps through the tsup entry table (an irregular name is not guessed)', () => {
    // ./adapters/cache-handler is built from cache-handler.public.js, not cache-handler.js
    expect(pub.files.has(`${SRC}/adapters/cache-handler.public.js`)).toBe(true);
    // the bin is built from deploy.ts
    expect(pub.files.has(`${SRC}/cli/deploy.ts`)).toBe(true);
    expect(pub.files.has(`${SRC}/config.ts`)).toBe(true);
  });

  it('takes its input from the manifest: a new subpath becomes public, an absent one does not', () => {
    const grown = publicSourceFiles(
      { exports: { './x': './dist/adapters/brand-new.js' }, bin: {} },
      "entry: { 'adapters/brand-new': 'src/adapters/brand-new.ts' }",
      () => false,
    );
    expect([...grown.files]).toEqual([`${PKG}/src/adapters/brand-new.ts`]);
    const none = publicSourceFiles({ exports: {}, bin: {} }, tsup, () => false);
    expect(none.files.size).toBe(0);
  });

  it('reports a target it cannot map instead of silently exempting nothing', () => {
    const r = publicSourceFiles({ exports: { './y': './dist/nowhere.js' } }, '', () => false);
    expect(r.unresolved).toEqual(['./dist/nowhere.js']);
  });
});

describe('the real tree', () => {
  const r = scanTree(REPO_ROOT);

  it('the scan actually reads the tree (floors, so an empty scan is not a pass)', () => {
    expect(r.scoped).toBeGreaterThan(150);
    expect(r.exportsSeen).toBeGreaterThan(500);
    expect(r.publicFiles.size).toBeGreaterThan(30);
    expect(r.unresolved).toEqual([]);
  });

  it('no shipped export is unreferenced outside its own file', () => {
    expect(
      r.violations.map(
        (v: { file: string; name: string; line: number }) => `${v.file}:${v.line} ${v.name}`,
      ),
    ).toEqual([]);
  });

  it('no declaration companion declares a name its source stopped exporting', () => {
    expect(
      r.staleDeclarations.map((d: { file: string; name: string }) => `${d.file} ${d.name}`),
    ).toEqual([]);
  });

  it('no export is unreadable by the scan', () => {
    expect(r.unreadable).toEqual([]);
  });

  it('IMPORT_CONDITIONS is gone from the sidecar runtime and its declaration', () => {
    for (const f of ['sidecar-runtime.mjs', 'sidecar-runtime.d.mts']) {
      expect(readFileSync(resolve(REPO_ROOT, SRC, 'adapters', f), 'utf8')).not.toContain(
        'IMPORT_CONDITIONS',
      );
    }
  });
});
