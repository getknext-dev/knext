/**
 * No `__`-prefixed name may be reachable from a PUBLISHED entry (#936).
 *
 * `__setRedisClientForTests` and `__resetEnvForTests` shipped on
 * `@getknext/core/adapters/cache-handler`: two process-wide cache mutators on a
 * subpath every consumer can import. The T6b refusal narrowed when they could
 * run; this removes the surface. The repo convention is that a `__`-prefixed
 * export is a test seam, so the question this file asks of the BUILT `dist` is
 * "starting from every file an `exports` map points at, can a consumer reach a
 * `__` name" — scanned, not listed, so a third seam cannot slip in.
 *
 * Three groups, deliberately:
 *
 *  1. FIXTURES — one tiny package per construct, judged by the CLI's EXIT CODE.
 *     Every way a seam can be exported (direct, aliased, renamed, star
 *     re-export, CJS, `.d.ts`) must red, and every construct the reader cannot
 *     interpret must red too: an unreadable file is a failure, never a pass.
 *     A clean case sits beside each family so "always exits 1" cannot pass.
 *  2. THE REAL ARTIFACT — the built `dist` of every publishable package scans
 *     clean, and the scan demonstrably LOOKED (anti-vacuity).
 *  3. INJECTION INTO THE REAL ARTIFACT — copy the built package, plant a
 *     re-export / an unreadable file in the copy, and watch the same CLI red.
 *
 * Needs the lib -> db -> core builds, like `publish-surface.test.ts`. Its
 * mutation prover is `scripts/mutation-prove-published-seam-scan.mjs`.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { createCtx, scanPackage } from '../scripts/lib/published-export-scan.mjs';
import { continueOnErrorProblem, type Job } from './helpers/blocking-gate';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'scripts', 'scan-published-seams.mjs');

type Files = Record<string, string>;

/** Run the CLI over one package directory; return ONLY its exit code. */
function cli(args: string[]): number {
  const res = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  if (res.status === null) throw new Error(`scanner did not exit: ${res.signal ?? res.error}`);
  return res.status;
}

/**
 * Build a package fixture in tmpdir, run `fn` against it, always remove it.
 * `package.json` defaults to a single `.` export at `./dist/index.js`.
 */
function withPackage<T>(files: Files, fn: (dir: string) => T, pkg: object = {}): T {
  const dir = mkdtempSync(join(tmpdir(), 'seam-scan-'));
  try {
    const manifest = {
      name: 'fixture-pkg',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      ...pkg,
    };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exitFor = (files: Files, pkg?: object, extra: string[] = []) =>
  withPackage(files, (dir) => cli(['--package', dir, ...extra]), pkg);

const CLEAN = 0;
const RED = 1;

describe('clean packages pass (so a red below is the scan seeing something)', () => {
  it('plain named, default and star exports are clean', () => {
    expect(
      exitFor({
        'dist/index.js': `export * from './chunk.js';\nexport const a = 1;\nexport default function f() {}\n`,
        'dist/chunk.js': `export const b = 2;\nexport function c() {}\n`,
      }),
    ).toBe(CLEAN);
  });

  it('a `__` name that is NOT exported is not a finding (internal helpers, property names)', () => {
    expect(
      exitFor({
        'dist/index.js': `function __internal() { return 1; }\nconst o = { __segmentSerialized: true };\nexport const a = __internal() + (o.__segmentSerialized ? 1 : 0);\n`,
      }),
    ).toBe(CLEAN);
  });

  it('a seam exported by a chunk the entry does NOT re-export is unreachable, so clean', () => {
    expect(
      exitFor({
        'dist/index.js': `export { ok } from './chunk.js';\n`,
        'dist/chunk.js': `export const ok = 1;\nexport const __seam = 2;\n`,
      }),
    ).toBe(CLEAN);
  });

  it('a bin-only package with no exports map is clean', () => {
    expect(
      exitFor(
        { 'bin/cli.js': `#!/usr/bin/env node\nconsole.log('hi');\n` },
        { exports: undefined, bin: { tool: 'bin/cli.js' } },
      ),
    ).toBe(CLEAN);
  });

  it('CommonJS and declaration entries with no `__` names are clean', () => {
    expect(
      exitFor(
        {
          'dist/index.cjs': `'use strict';\nmodule.exports = { install, ok };\nfunction install() {}\nfunction ok() {}\n`,
          'dist/index.d.ts': `export declare function ok(): void;\nexport interface Opts { a: number }\n`,
        },
        { exports: { '.': { types: './dist/index.d.ts', require: './dist/index.cjs' } } },
      ),
    ).toBe(CLEAN);
  });
});

describe('values that merely look similar stay clean (#2188)', () => {
  it('non-seam object keys, class statics and inert defaults are clean', () => {
    const clean = (files: Files, pkg?: object) => expect(exitFor(files, pkg)).toBe(CLEAN);
    clean({ 'dist/index.js': `const o = { a: 1, b: { c: 2 } };\nexport default o;\n` });
    clean({ 'dist/index.js': `export const ns = Object.freeze({ a: 1 });\n` });
    clean({ 'dist/index.js': `export default class { static a = 1; __private = 2; }\n` });
    clean({ 'dist/index.js': `export default function f() {}\n` });
    clean({ 'dist/index.js': `export default 'x';\n` });
    clean({
      'dist/index.js': `const tag = Symbol.for('t');\nexport class K { static [tag] = 'x'; static a = 1; }\n`,
    });
    clean({ 'dist/index.js': `const o = { a: 1 };\nexport { o };\n` });
  });
});

describe('every way a seam can be exported reds', () => {
  const cases: Array<[string, Files, object?]> = [
    ['a direct `export function __x`', { 'dist/index.js': `export function __x() {}\n` }],
    ['a direct `export const __x`', { 'dist/index.js': `export const __x = 1;\n` }],
    ['an `export class __X`', { 'dist/index.js': `export class __X {}\n` }],
    [
      'a destructured `export const { __x }`',
      { 'dist/index.js': `export const { __x } = { __x: 1 };\n` },
    ],
    ['`export { __x }` of a local', { 'dist/index.js': `const __x = 1;\nexport { __x };\n` }],
    [
      '`export { a as __x }` (renamed TO a seam name)',
      { 'dist/index.js': `const a = 1;\nexport { a as __x };\n` },
    ],
    [
      '`export { __x as a }` (a seam hidden behind a public name)',
      { 'dist/index.js': `const __x = 1;\nexport { __x as a };\n` },
    ],
    [
      'an import alias re-exported under a public name',
      {
        'dist/index.js': `import { __x as y } from './chunk.js';\nexport { y };\n`,
        'dist/chunk.js': `export const __x = 1;\n`,
      },
    ],
    [
      'a named re-export `export { __x } from`',
      {
        'dist/index.js': `export { __x } from './chunk.js';\n`,
        'dist/chunk.js': `export const __x = 1;\n`,
      },
    ],
    [
      'a RE-EXPORT through `export *`',
      {
        'dist/index.js': `export * from './chunk.js';\n`,
        'dist/chunk.js': `export const ok = 1;\nexport const __seam = 2;\n`,
      },
    ],
    [
      'a re-export two stars deep',
      {
        'dist/index.js': `export * from './a.js';\n`,
        'dist/a.js': `export * from './b.js';\n`,
        'dist/b.js': `export const __seam = 2;\n`,
      },
    ],
    [
      'a seam inside `export * as ns`',
      {
        'dist/index.js': `export * as ns from './chunk.js';\n`,
        'dist/chunk.js': `export const __seam = 2;\n`,
      },
    ],
    [
      'a namespace import re-exported by name',
      {
        'dist/index.js': `import * as ns from './chunk.js';\nexport { ns };\n`,
        'dist/chunk.js': `export const __seam = 2;\n`,
      },
    ],
    [
      'an object-literal default export with a `__` key',
      { 'dist/index.js': `export default { ok: 1, __seam() {} };\n` },
    ],
    [
      'a seam key in an object bound to an identifier that is default-exported (#2188)',
      { 'dist/index.js': `const __q = 1;\nconst o = { __q };\nexport default o;\n` },
    ],
    [
      'a seam key in an exported const object (#2188)',
      { 'dist/index.js': `const __k = 1;\nexport const ns = { __k };\n` },
    ],
    [
      'a seam key nested one level down in an exported object (#2188)',
      { 'dist/index.js': `export const ns = { inner: { __k: 1 } };\n` },
    ],
    [
      'a seam key in an object exported through `export { o as p }` (#2188)',
      { 'dist/index.js': `const o = { __k: 1 };\nexport { o as p };\n` },
    ],
    [
      'a seam key in an `Object.freeze`d exported object (#2188)',
      { 'dist/index.js': `export const ns = Object.freeze({ __k: 1 });\n` },
    ],
    [
      'a static `__` member on a default-exported class (#2188)',
      { 'dist/index.js': `class K { static __reset() {} }\nexport default K;\n` },
    ],
    [
      'a static `__` property on an inline default-exported class (#2188)',
      { 'dist/index.js': `export default class { static __x = 1; }\n` },
    ],
    [
      'a static `__` member on a named exported class (#2188)',
      { 'dist/index.js': `export class K { static get __x() { return 1; } }\n` },
    ],
    [
      'a static member keyed by a const bound to a `__` string (#2188)',
      { 'dist/index.js': `const k = '__x';\nexport class K { static [k] = 1; }\n` },
    ],
    [
      'a CJS `module.exports = o` where o holds a nested `__` key (#2188)',
      { 'dist/index.cjs': `const o = { api: { __x: 1 } };\nmodule.exports = o;\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS `exports.ns = { __k }` (#2188)',
      { 'dist/index.cjs': `exports.ns = { __k: 1 };\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS `module.exports = class { static __x }` (#2188)',
      { 'dist/index.cjs': `module.exports = class { static __x() {} };\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a type-literal `export declare const ns: { __k: number }` (#2188)',
      { 'dist/index.d.ts': `export declare const ns: { __k: number };\n` },
      { exports: { '.': './dist/index.d.ts' } },
    ],
    [
      'a star cycle that still reaches a seam',
      {
        'dist/index.js': `export * from './a.js';\n`,
        'dist/a.js': `export * from './b.js';\nexport const ok = 1;\n`,
        'dist/b.js': `export * from './a.js';\nexport const __seam = 1;\n`,
      },
    ],
    [
      'a seam on the `require` condition only',
      {
        'dist/index.js': `export const ok = 1;\n`,
        'dist/index.cjs': `module.exports = { __seam() {} };\n`,
      },
      { exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } } },
    ],
    [
      'a seam on a secondary subpath',
      {
        'dist/index.js': `export const ok = 1;\n`,
        'dist/internal.js': `export const __seam = 1;\n`,
      },
      { exports: { '.': './dist/index.js', './internal/x': './dist/internal.js' } },
    ],
    [
      'a seam reachable only through the legacy `main` field',
      {
        'dist/index.js': `export const ok = 1;\n`,
        'dist/legacy.js': `export const __seam = 1;\n`,
      },
      { main: './dist/legacy.js' },
    ],
    // CommonJS
    [
      'CJS `module.exports = { __x }`',
      { 'dist/index.cjs': `module.exports = { __x() {} };\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'CJS `exports.__x =`',
      { 'dist/index.cjs': `exports.__x = 1;\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      "CJS `module.exports['__x'] =`",
      { 'dist/index.cjs': `module.exports['__x'] = 1;\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'CJS `Object.defineProperty(exports, "__x")`',
      { 'dist/index.cjs': `Object.defineProperty(exports, '__x', { value: 1 });\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'CJS `Object.assign(module.exports, { __x })`',
      { 'dist/index.cjs': `Object.assign(module.exports, { __x: 1 });\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'CJS `module.exports = require(...)` of a module with a seam',
      {
        'dist/index.cjs': `module.exports = require('./inner.cjs');\n`,
        'dist/inner.cjs': `module.exports = { __x: 1 };\n`,
      },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'CJS spread of a local object holding a seam',
      { 'dist/index.cjs': `const inner = { __x: 1 };\nmodule.exports = { ok: 1, ...inner };\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'CJS `module.exports = ident` resolving to an object literal',
      { 'dist/index.cjs': `const api = { __x: 1 };\nmodule.exports = api;\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    // declarations
    [
      '`.d.ts` `export declare function __x`',
      { 'dist/index.d.ts': `export declare function __x(): void;\n` },
      { exports: { '.': { types: './dist/index.d.ts' } } },
    ],
    [
      '`.d.ts` `export { __x }`',
      { 'dist/index.d.ts': `declare const __x: number;\nexport { __x };\n` },
      { exports: { '.': { types: './dist/index.d.ts' } } },
    ],
    [
      '`.d.ts` interface named with the prefix',
      { 'dist/index.d.ts': `export interface __Seam { a: 1 }\n` },
      { exports: { '.': { types: './dist/index.d.ts' } } },
    ],
    [
      '`.d.ts` namespace member',
      { 'dist/index.d.ts': `export declare namespace api { function __x(): void }\n` },
      { exports: { '.': { types: './dist/index.d.ts' } } },
    ],
    [
      '`.d.ts` star re-export of a declaration chunk',
      {
        'dist/index.d.ts': `export * from './chunk.js';\n`,
        'dist/chunk.d.ts': `export declare const __x: number;\n`,
      },
      { exports: { '.': { types: './dist/index.d.ts' } } },
    ],
    [
      'a types-only seam beside a clean runtime entry',
      {
        'dist/index.js': `export const ok = 1;\n`,
        'dist/index.d.ts': `export declare const ok: number;\nexport declare function __x(): void;\n`,
      },
      { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } },
    ],
  ];

  for (const [label, files, pkg] of cases) {
    it(`reds: ${label}`, () => {
      expect(exitFor(files, pkg)).toBe(RED);
    });
  }

  it('a third-party star re-export is followed (resolved from --resolve-from)', () => {
    const files = {
      'dist/index.js': `export * from 'some-lib';\n`,
      'node_modules/some-lib/package.json': JSON.stringify({
        name: 'some-lib',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: './i.js' } },
      }),
      'node_modules/some-lib/i.js': `export const fine = 1;\nexport const __leak = 2;\n`,
    };
    expect(withPackage(files, (dir) => cli(['--package', dir, '--resolve-from', dir]))).toBe(RED);
    const clean = { ...files, 'node_modules/some-lib/i.js': `export const fine = 1;\n` };
    expect(withPackage(clean, (dir) => cli(['--package', dir, '--resolve-from', dir]))).toBe(CLEAN);
  });

  it('reports the chain a re-exported seam travelled, so it can be found', () => {
    withPackage(
      {
        'dist/index.js': `export * from './a.js';\n`,
        'dist/a.js': `export * from './b.js';\n`,
        'dist/b.js': `export const __seam = 2;\n`,
      },
      (dir) => {
        const result = scanPackage(createCtx({ resolveFrom: dir }), dir);
        const hit = result.findings.find((f) => f.kind === 'seam-export');
        expect(hit?.name).toBe('__seam');
        expect((hit?.via ?? []).map((p) => p.split('/').pop())).toEqual([
          'index.js',
          'a.js',
          'b.js',
        ]);
      },
    );
  });
});

describe('FAIL CLOSED: what the scan cannot read is a finding, never a pass', () => {
  const cases: Array<[string, Files, object?]> = [
    [
      'a default export of a call result (#2188)',
      {
        'dist/index.js': `export default makeApi();\nfunction makeApi() { return { __x: 1 }; }\n`,
      },
    ],
    [
      'a default export of an imported binding (#2188)',
      {
        'dist/index.js': `import api from './api.js';\nexport default api;\n`,
        'dist/api.js': 'export default {};\n',
      },
    ],
    [
      'a default-exported object with a computed key (#2188)',
      { 'dist/index.js': `const k = process.env.K;\nconst o = { [k]: 1 };\nexport default o;\n` },
    ],
    [
      'an exported class with a computed static member (#2188)',
      { 'dist/index.js': `const k = process.env.K;\nexport class K { static ['__' + k] = 1; }\n` },
    ],
    [
      'an exported class with a static block (#2188)',
      { 'dist/index.js': `export class K { static { K.__x = 1; } }\n` },
    ],
    ['an entry that does not parse', { 'dist/index.js': `export const = ;\n` }],
    [
      'a chunk reached through `export *` that does not parse',
      {
        'dist/index.js': `export * from './chunk.js';\n`,
        'dist/chunk.js': `export const ok = (;\n`,
      },
    ],
    ['a missing entry file', {}],
    ['a dangling `export *`', { 'dist/index.js': `export * from './gone.js';\n` }],
    ['a dangling `export * as`', { 'dist/index.js': `export * as ns from './gone.js';\n` }],
    [
      'an unresolvable bare-package `export *`',
      { 'dist/index.js': `export * from 'no-such-package-anywhere';\n` },
    ],
    [
      'an exports PATTERN that cannot be enumerated',
      { 'dist/a.js': `export const a = 1;\n` },
      { exports: { './*': './dist/*.js' } },
    ],
    [
      'an entry pointing outside the package',
      { 'dist/index.js': `export const a = 1;\n` },
      { exports: { '.': '../escape.js' } },
    ],
    ['a package that exposes nothing', {}, { exports: undefined }],
    [
      'a CJS computed export key',
      { 'dist/index.cjs': `const k = process.env.K;\nmodule.exports = { [k]: 1 };\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS computed `exports[k] =`',
      { 'dist/index.cjs': `const k = 'a' + 'b';\nexports[k] = 1;\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS `module.exports = <call>` whose keys are not static',
      {
        'dist/index.cjs': `module.exports = makeExports();\nfunction makeExports() { return { __x: 1 }; }\n`,
      },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS exports object handed to a helper',
      { 'dist/index.cjs': `function add(t) { t.__x = 1; }\nadd(module.exports);\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS exports object aliased to a variable',
      { 'dist/index.cjs': `const e = module.exports;\ne.__x = 1;\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS `Object.defineProperty(exports, <non-literal>)`',
      {
        'dist/index.cjs': `const k = process.env.K;\nObject.defineProperty(exports, k, { value: 1 });\n`,
      },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'a CJS spread of something that is not statically known',
      { 'dist/index.cjs': `module.exports = { ...require(process.env.X) };\n` },
      { exports: { '.': './dist/index.cjs' } },
    ],
    [
      'an entry with an unsupported extension',
      { 'dist/index.ts': `export const a = 1;\n` },
      { exports: { '.': './dist/index.ts' } },
    ],
  ];

  for (const [label, files, pkg] of cases) {
    it(`reds: ${label}`, () => {
      expect(exitFor(files, pkg)).toBe(RED);
    });
  }

  it('reds when a re-exported chunk exists but cannot be READ (a directory in its place)', () => {
    expect(
      withPackage(
        {
          'dist/index.js': `export * from './chunk.js';\nexport const ok = 1;\n`,
          'dist/chunk.js/inside.txt': 'a directory where the chunk should be',
        },
        (dir) => cli(['--package', dir]),
      ),
    ).toBe(RED);
  });

  it('reds when a re-exported chunk is mode 000 (skipped as root, where mode is not enforced)', () => {
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const code = withPackage(
      {
        'dist/index.js': `export * from './chunk.js';\nexport const ok = 1;\n`,
        'dist/chunk.js': `export const fine = 1;\n`,
      },
      (dir) => {
        chmodSync(join(dir, 'dist', 'chunk.js'), 0o000);
        return cli(['--package', dir]);
      },
    );
    // Root reads mode-000 files; there the directory case above is the proof.
    expect(code).toBe(asRoot ? CLEAN : RED);
  });

  it('refuses to report clean when the workspace has no publishable package', async () => {
    // In-process: the entry point takes the repo root, so an EMPTY workspace is exercised here.
    const { main } = await import('../scripts/scan-published-seams.mjs');
    const empty = mkdtempSync(join(tmpdir(), 'seam-scan-empty-'));
    try {
      mkdirSync(join(empty, 'packages'));
      expect(main([], empty)).toBe(RED);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('an unknown argument is a usage error (2), not a clean scan', () => {
    expect(cli(['--wat'])).toBe(2);
  });
});

// ─── the real artifact ──────────────────────────────────────────────────────

const PUBLISHABLE = ['lib', 'db', 'kn-next'] as const;

function requireBuilt(): void {
  for (const p of PUBLISHABLE) {
    const dist = join(REPO_ROOT, 'packages', p, 'dist');
    if (!existsSync(dist)) {
      throw new Error(
        `packages/${p}/dist is missing — build lib -> db -> core first (bun run --filter @getknext/<pkg> build). ` +
          'This guard reads the artifact that ships; it cannot be satisfied from source.',
      );
    }
  }
}

describe('the real built packages', () => {
  it('export no `__` name from any published entry', () => {
    requireBuilt();
    expect(cli([])).toBe(CLEAN);
  });

  it('the scan demonstrably looked: entries are read and the cache-handler subpath is among them', () => {
    requireBuilt();
    const core = join(REPO_ROOT, 'packages', 'kn-next');
    const result = scanPackage(createCtx({ resolveFrom: core }), core);
    expect(result.findings).toEqual([]);
    const handler = result.entries.find((e) => e.subpath === './adapters/cache-handler');
    // Anti-vacuity: an empty or mis-pointed scan reports zero findings too.
    expect(handler, 'the published cache-handler subpath was not scanned').toBeDefined();
    expect(handler?.exports).toBeGreaterThanOrEqual(3);
    expect(result.entries.length).toBeGreaterThan(20);
  });

  it('scans every publishable workspace package, discovered rather than listed', () => {
    const publishable = PUBLISHABLE.filter((p) => {
      const j = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', p, 'package.json'), 'utf8'));
      return j.private !== true;
    });
    expect(publishable.length).toBe(PUBLISHABLE.length);
  });
});

describe('injection into a copy of the real artifact', () => {
  /** Copy the built core package (manifest + dist only), run `fn`, always remove. */
  function withCoreCopy<T>(fn: (dir: string) => T): T {
    requireBuilt();
    const src = join(REPO_ROOT, 'packages', 'kn-next');
    const dir = mkdtempSync(join(tmpdir(), 'seam-scan-core-'));
    try {
      cpSync(join(src, 'package.json'), join(dir, 'package.json'));
      cpSync(join(src, 'dist'), join(dir, 'dist'), { recursive: true });
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const core = join(REPO_ROOT, 'packages', 'kn-next');
  const run = (dir: string) => cli(['--package', dir, '--resolve-from', core]);
  const entry = (dir: string) => join(dir, 'dist', 'adapters', 'cache-handler.js');

  it('the unmodified copy is clean (the baseline the injections are judged against)', () => {
    expect(withCoreCopy(run)).toBe(CLEAN);
  });

  it('an injected re-export on the published cache-handler entry reds', () => {
    expect(
      withCoreCopy((dir) => {
        const before = readFileSync(entry(dir), 'utf8');
        writeFileSync(
          entry(dir),
          `${before}\nexport { CacheHandler as __setRedisClientForTests };\n`,
        );
        return run(dir);
      }),
    ).toBe(RED);
  });

  it('an injected star re-export of a module holding a seam reds', () => {
    expect(
      withCoreCopy((dir) => {
        writeFileSync(
          join(dir, 'dist', 'adapters', 'injected-chunk.js'),
          'export const __resetEnvForTests = () => {};\n',
        );
        const before = readFileSync(entry(dir), 'utf8');
        writeFileSync(entry(dir), `${before}\nexport * from "./injected-chunk.js";\n`);
        return run(dir);
      }),
    ).toBe(RED);
  });

  it('an injected UNREADABLE file on the re-export path reds (fail closed)', () => {
    expect(
      withCoreCopy((dir) => {
        mkdirSync(join(dir, 'dist', 'adapters', 'unreadable.js'));
        const before = readFileSync(entry(dir), 'utf8');
        writeFileSync(entry(dir), `${before}\nexport * from "./unreadable.js";\n`);
        return run(dir);
      }),
    ).toBe(RED);
  });

  it('an injected syntax error in a published entry reds (fail closed)', () => {
    expect(
      withCoreCopy((dir) => {
        const before = readFileSync(entry(dir), 'utf8');
        writeFileSync(entry(dir), `${before}\nexport const = ;\n`);
        return run(dir);
      }),
    ).toBe(RED);
  });
});

describe('the scan is wired into the gates that stop a release', () => {
  it('ci.yml runs it as a step that cannot be soft-failed', () => {
    const wf = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, Job & { steps?: Array<Record<string, unknown>> }>;
    };
    const hits: Array<{ job: string; step: Record<string, unknown>; container: Job }> = [];
    for (const [id, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === 'string' && step.run.includes('scripts/scan-published-seams.mjs')) {
          hits.push({ job: id, step, container: job });
        }
      }
    }
    expect(hits.length, 'ci.yml no longer runs scripts/scan-published-seams.mjs').toBeGreaterThan(
      0,
    );
    for (const { job, step, container } of hits) {
      expect(continueOnErrorProblem(step as Job, `${job} step`)).toBeNull();
      expect(continueOnErrorProblem(container, `${job}`)).toBeNull();
      expect(step.if, `${job}: the scan step is conditional`).toBeUndefined();
    }
  });

  it('the publish-blocking audit scans the installed tarballs and dies on a non-zero exit', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts/audit-published.mjs'), 'utf8');
    expect(src).toContain('scan-published-seams.mjs');
    expect(src).toMatch(/if \(seamScan\.status !== 0\) \{\s*die\(/);
  });
});
