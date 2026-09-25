/**
 * The honest line denominator (#1248).
 *
 * bun's lcov emits `DA` records for lines that hold no executable code — blank
 * lines, comments, lone braces, type-annotation continuations, the inside of a
 * multi-line template literal. `scripts/lib/executable-lines.mjs` classifies
 * every source line with the TypeScript PARSER (never a regex) so the gate can
 * compute a second, honest line percentage over executable lines only.
 *
 * The invariant these tests exist to hold: a line that carries ANY executable
 * token stays in the denominator. Keeping noise is always acceptable; hiding
 * code is not. So most of this file is the "tricky executable" fixture — the
 * cases a naive filter gets wrong — and a repo-wide differential scan against an
 * independent oracle (TypeScript's own emitted JS + source map).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript-api';
import {
  classifyLines,
  honestCoverage,
  isExecutableClass,
} from '../scripts/lib/executable-lines.mjs';

const REPO_ROOT = resolve(import.meta.dir, '..');

/** 1-based line -> class, for a snippet. Fails loudly if the snippet did not parse. */
function classesOf(src: string, file = 'fixture.ts'): string[] {
  const res = classifyLines(src, file);
  if (!res.ok) throw new Error(`fixture did not parse: ${file}`);
  return res.classes;
}

/** Assert every line whose text contains `marker` is classified executable. */
function expectExecutable(src: string, markers: string[], file = 'fixture.ts') {
  const classes = classesOf(src, file);
  const lines = src.split('\n');
  for (const marker of markers) {
    const hits = lines.flatMap((l, i) => (l.includes(marker) ? [i] : []));
    // Each anchor must occur exactly once — an absent anchor would make the
    // assertion vacuous, a repeated one ambiguous.
    expect({ marker, occurrences: hits.length }).toEqual({ marker, occurrences: 1 });
    const idx = hits[0] as number;
    expect({ line: lines[idx], cls: classes[idx] }).toEqual({
      line: lines[idx],
      cls: 'executable',
    });
  }
}

describe('classifyLines — tricky executable lines are NEVER noise', () => {
  test('one-line arrow body, and an arrow body on its own continuation line', () => {
    const src = [
      'const f = (x: number) => x + 1; // ARROW1',
      'const g = (x: number): number =>',
      '  x * 2; // ARROWBODY',
      'items.forEach((i) => void i); // ARROW2',
    ].join('\n');
    expectExecutable(src, ['ARROW1', 'ARROWBODY', 'ARROW2']);
  });

  test('`} else {`, `} else if (…) {`, `} catch {`, `} finally {`', () => {
    const src = [
      'if (a) {',
      '  x();',
      '} else if (b) { // ELSEIF',
      '  y();',
      '} else { // PLAINELSE',
      '  z();',
      '}',
      'try {',
      '  w();',
      '} catch { // CATCH',
      '  v();',
      '} finally { // FINALLY',
      '  u();',
      '}',
    ].join('\n');
    expectExecutable(src, ['ELSEIF', 'PLAINELSE', 'CATCH', 'FINALLY']);
  });

  test('continuation lines carrying a call (method chains, arguments)', () => {
    const src = [
      'const r = items',
      '  .filter((i) => i.ok) // CHAIN1',
      '  .map(fn); // CHAIN2',
      'call(',
      '  a, // ARG1',
      '  other(), // ARG2',
      ');',
      'await client', // "await" line
      '  .send(cmd); // CHAIN3',
    ].join('\n');
    expectExecutable(src, ['CHAIN1', 'CHAIN2', 'ARG1', 'ARG2', 'CHAIN3']);
  });

  test('decorators on their own line (class and member)', () => {
    const src = [
      '@Injectable() // DECO1',
      'export class Svc {',
      '  @Input() // DECO2',
      '  name = "x";',
      '  @Log', // bare identifier decorator
      '  run() {}',
      '}',
    ].join('\n');
    expectExecutable(src, ['DECO1', 'DECO2', '@Log']);
  });

  test('`return` in a ternary, one-line and split across lines', () => {
    const src = [
      'function f(c: boolean) {',
      '  if (c) return c ? a() : b(); // RET1',
      '  return c // RET2',
      '    ? a() // TERN1',
      '    : b(); // TERN2',
      '}',
    ].join('\n');
    expectExecutable(src, ['RET1', 'RET2', 'TERN1', 'TERN2']);
  });

  test('`satisfies` and `as` keep their runtime operand', () => {
    const src = [
      'const c = { a: 1 } satisfies C; // SAT1',
      'function g() {',
      '  return value satisfies T; // SAT2',
      '}',
      'const d = raw as Foo; // AS1',
      'export default {',
      '  a: 1, // SATPROP',
      '} satisfies Config;',
    ].join('\n');
    expectExecutable(src, ['SAT1', 'SAT2', 'AS1', 'SATPROP', 'export default {']);
  });

  test('expressions that open on a line holding only a delimiter', () => {
    const src = [
      '(async () => {',
      '  await main();',
      '})(); // IIFECALL',
      'use(',
      '  [ // ARRAYLIT',
      '    1,',
      '  ],',
      '  { // OBJLIT',
      '    k: 1,',
      '  },',
      ');',
      'const v = obj',
      '  [key]; // ELEMACCESS',
    ].join('\n');
    expectExecutable(src, ['IIFECALL', 'ARRAYLIT', 'OBJLIT', 'ELEMACCESS']);
  });

  test('template-literal substitutions on a continuation line', () => {
    const src = [
      'const s = `line one',
      '  ${compute()} middle', // substitution line — executable
      'tail`;',
    ].join('\n');
    expectExecutable(src, ['${compute()}']);
  });

  test('statements that begin with a keyword', () => {
    const src = [
      'switch (k) {',
      "  case 'a': // CASE",
      '    break; // BREAK',
      '  default: // DEFAULT',
      '    throw new Error("x"); // THROW',
      '}',
      'enum E {',
      '  A = 1, // ENUMMEMBER',
      '}',
      'function* gen() {',
      '  yield 1; // YIELD',
      '}',
      'namespace N {',
      '  export const z = 1; // NSVALUE',
      '}',
      'for (const x of xs) continue; // FOROF',
      'do { a(); } while (b()); // DOWHILE',
    ].join('\n');
    expectExecutable(src, [
      'CASE',
      'BREAK',
      'DEFAULT',
      'THROW',
      'ENUMMEMBER',
      'YIELD',
      'NSVALUE',
      'FOROF',
      'DOWHILE',
    ]);
  });

  test('declarations with a runtime part, and code next to comments', () => {
    const src = [
      'const x: Foo = bar(); // TYPEDINIT',
      'class A',
      '  extends Base { // EXTCLAUSE',
      '  inner = class extends',
      '    mixin(Base) {}; // EXTENDSEXPR — the heritage expression alone on its line',
      '  private n = 1; // FIELDINIT',
      '  get g() { return 1; } // GETTER',
      '  constructor(private readonly dep: Dep) { super(); } // CTOR',
      '}',
      '/* lead */ doIt(); // AFTERBLOCK',
      'if (',
      '  cond(a) // IFCOND',
      ') {',
      '  tag`x${y}`; // TAGGED',
      '}',
      'export default function handler() {} // EXPDEFAULT',
    ].join('\n');
    expectExecutable(src, [
      'TYPEDINIT',
      'EXTCLAUSE',
      'EXTENDSEXPR',
      'FIELDINIT',
      'GETTER',
      'CTOR',
      'AFTERBLOCK',
      'IFCOND',
      'TAGGED',
      'EXPDEFAULT',
    ]);
  });

  test('JSX text and elements in a .tsx file', () => {
    const src = [
      'export function C() {',
      '  return (',
      '    <div>',
      '      Hello there',
      '      {name}',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    expectExecutable(src, ['<div>', 'Hello there', '{name}'], 'fixture.tsx');
  });

  test('the runtime `void` operator is not the `void` type (review round 2)', () => {
    const src = [
      'function f(p: Promise<void>) {',
      '  void ( // VOIDPAREN',
      '    p',
      '  );',
      '  void // LONEVOID',
      '    p;',
      '}',
    ].join('\n');
    expectExecutable(src, ['VOIDPAREN', 'LONEVOID']);
  });

  test('instantiation expressions used as values are runtime (review round 2)', () => {
    const src = [
      'const b = [',
      '  box<number>, // INSTELEM',
      '];',
      'use(box<string>); // INSTARG',
    ].join('\n');
    expectExecutable(src, ['INSTELEM', 'INSTARG']);
    const stmt = ['declare const box: <T>(x: T) => T;', 'box<string>; // INSTEXPRSTMT'].join('\n');
    expectExecutable(stmt, ['INSTEXPRSTMT']);
  });
});

describe('classifyLines — the noise it does remove', () => {
  test('blank and comment-only lines', () => {
    const src = [
      'a();',
      '',
      '// line comment LC',
      '/**',
      ' * jsdoc body JD',
      ' */',
      '/* block BC */',
    ].join('\n');
    const classes = classesOf(src);
    expect(classes).toEqual([
      'executable',
      'blank',
      'comment',
      'comment',
      'comment',
      'comment',
      'comment',
    ]);
  });

  test('lone closing delimiters and block-opening braces', () => {
    const src = [
      'function f(',
      '  a: number,',
      ') {',
      '  call(',
      '    a,',
      '  ); // CLOSECALL',
      '}',
    ].join('\n');
    const classes = classesOf(src);
    expect(classes[2]).toBe('punctuation'); // `) {`
    expect(classes[5]).toBe('punctuation'); // `);` + comment
    expect(classes[6]).toBe('punctuation'); // `}`
  });

  test('type-only declarations and annotation continuations', () => {
    const src = [
      "import type { A } from './a';",
      'export interface Opts {',
      '  a: string;',
      '}',
      'type T =',
      '  | { k: 1 }',
      '  | { k: 2 };',
      'export async function run(opts: {',
      '  verbose: boolean; // PARAMTYPE',
      '}): Promise<',
      '  void // RETTYPE',
      '> {',
      '  return;',
      '}',
      'class K implements Opts, // IMPL',
      '  Other {',
      '  a = "";',
      '}',
      'declare const g: number;',
      'function over(a: string): void;',
      'function over(a: unknown) {}',
      'export default {',
      '  a: 1,',
      '} satisfies Config;',
    ].join('\n');
    const classes = classesOf(src);
    const expectTypeOnly = [0, 1, 2, 4, 5, 6, 8, 10, 15, 18, 19, 23];
    for (const i of expectTypeOnly) {
      expect({ i, cls: classes[i] }).toEqual({
        i,
        cls: expect.stringMatching(/^(type-only|punctuation)$/),
      });
    }
    expect(classes[7]).toBe('executable'); // export async function run(...
    expect(classes[12]).toBe('executable'); // return;
    expect(classes[14]).toBe('executable'); // class K ...
    expect(classes[20]).toBe('executable'); // the implementation signature
  });

  test('continuation lines inside a multi-line template literal with no substitution', () => {
    const src = ['const s = `first', '  second', '  third`;'].join('\n');
    expect(classesOf(src)).toEqual(['executable', 'continuation', 'punctuation']);
  });

  test('a file that fails to parse is reported not-ok, so the caller keeps every line', () => {
    const res = classifyLines('function (\n{{{ ===', 'broken.ts');
    expect(res.ok).toBe(false);
  });

  test('only the `executable` class counts as executable', () => {
    expect(isExecutableClass('executable')).toBe(true);
    for (const c of ['blank', 'comment', 'continuation', 'punctuation', 'type-only']) {
      expect(isExecutableClass(c)).toBe(false);
    }
  });
});

describe('honestCoverage — filtering DA records', () => {
  const SRC = ['// header', 'export function f() {', '  return 1;', '}', ''].join('\n');

  function cov(lines: Array<[number, number]>) {
    return { lines: new Map(lines), fnFound: 1, fnHit: 1, fnNames: new Map() };
  }

  test('drops DA records on noise lines only, keeps hits unchanged', () => {
    const merged = new Map([
      [
        'p/a.ts',
        cov([
          [1, 0],
          [2, 1],
          [3, 1],
          [4, 0],
          [5, 0],
        ]),
      ],
    ]);
    const { files, noise } = honestCoverage(merged, () => SRC);
    expect([...(files.get('p/a.ts')?.lines ?? new Map())]).toEqual([
      [2, 1],
      [3, 1],
    ]);
    expect(noise).toEqual({ comment: 1, punctuation: 1, blank: 1 });
  });

  test('MUTATION: an uncovered executable line stays in the denominator', () => {
    // Line 3 is `return 1;` — executable. Make it uncovered.
    const merged = new Map([
      [
        'p/a.ts',
        cov([
          [1, 0],
          [2, 1],
          [3, 0],
          [4, 0],
        ]),
      ],
    ]);
    const { files } = honestCoverage(merged, () => SRC);
    const lines = files.get('p/a.ts')?.lines;
    expect(lines?.get(3)).toBe(0);
    expect(lines?.size).toBe(2);
  });

  test('an unreadable source keeps every DA record (fail toward noise, never toward hiding)', () => {
    const merged = new Map([
      [
        'p/gone.ts',
        cov([
          [1, 0],
          [2, 0],
        ]),
      ],
    ]);
    const { files, unclassified } = honestCoverage(merged, () => null);
    expect(files.get('p/gone.ts')?.lines.size).toBe(2);
    expect(unclassified).toEqual(['p/gone.ts']);
  });

  test('an unparseable source keeps every DA record', () => {
    const merged = new Map([
      [
        'p/bad.ts',
        cov([
          [1, 0],
          [2, 0],
          [3, 0],
        ]),
      ],
    ]);
    // Line 1 is a comment: were the parse errors ignored, the classifier would
    // call it noise and drop it. A broken tree must not be trusted at all.
    const { files, unclassified } = honestCoverage(
      merged,
      () => '// a comment\nfunction (\n{{{ ===',
    );
    expect(files.get('p/bad.ts')?.lines.size).toBe(3);
    expect(unclassified).toEqual(['p/bad.ts']);
  });

  test('a DA line past the end of the source is kept', () => {
    const merged = new Map([['p/a.ts', cov([[99, 0]])]]);
    const { files } = honestCoverage(merged, () => SRC);
    expect(files.get('p/a.ts')?.lines.get(99)).toBe(0);
  });

  test('does not mutate its input', () => {
    const merged = new Map([
      [
        'p/a.ts',
        cov([
          [1, 0],
          [2, 1],
        ]),
      ],
    ]);
    honestCoverage(merged, () => SRC);
    expect(merged.get('p/a.ts')?.lines.size).toBe(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Differential scan against an independent oracle.
 *
 * TypeScript's own emitter + source map is a second, independent notion of
 * "which original line produced runtime JS". For every tracked source file under
 * `packages/*\/src`, any line our classifier calls NOISE must map to generated
 * JS that is punctuation only. A noise line that emitted an identifier, keyword
 * or literal is executable code the classifier would hide — the one failure
 * this whole design exists to prevent.
 * ──────────────────────────────────────────────────────────────────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode a v3 source map's `mappings` into per-generated-line segments. */
function decodeMappings(mappings: string): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let srcLine = 0;
  for (const genLine of mappings.split(';')) {
    const segs: Array<[number, number]> = [];
    let genCol = 0;
    for (const seg of genLine.split(',')) {
      if (seg === '') continue;
      const vals: number[] = [];
      let shift = 0;
      let value = 0;
      for (const ch of seg) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          vals.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += vals[0] as number;
      if (vals.length >= 4) {
        srcLine += vals[2] as number;
        segs.push([genCol, srcLine]);
      }
    }
    out.push(segs);
  }
  return out;
}

/** original line (0-based) -> the generated JS text attributed to it. */
function emittedTextByLine(src: string, file: string): Map<number, string> {
  const out = ts.transpileModule(src, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: true,
      experimentalDecorators: true,
      removeComments: true,
    },
  });
  const map = JSON.parse(out.sourceMapText as string);
  const genLines = out.outputText.split('\n');
  const decoded = decodeMappings(map.mappings);
  const byLine = new Map<number, string>();
  decoded.forEach((segs, g) => {
    const text = genLines[g] ?? '';
    segs.forEach(([col, orig], k) => {
      const end = k + 1 < segs.length ? (segs[k + 1] as [number, number])[0] : text.length;
      byLine.set(orig, (byLine.get(orig) ?? '') + text.slice(col, end));
    });
  });
  return byLine;
}

function trackedSources(): string[] {
  const res = Bun.spawnSync(['git', 'ls-files', '-z', 'packages'], { cwd: REPO_ROOT });
  if (res.exitCode !== 0) throw new Error('git ls-files failed');
  return res.stdout
    .toString()
    .split('\0')
    .filter(
      (p) =>
        /^packages\/[^/]+\/src\/.*\.tsx?$/.test(p) &&
        !p.endsWith('.d.ts') &&
        !/\.test\.tsx?$/.test(p) &&
        !p.includes('/__tests__/') &&
        !p.includes('/__mocks__/'),
    );
}

describe('differential scan — no noise line emits runtime JS (independent oracle)', () => {
  test('every noise line in packages/*/src maps to punctuation-only emitted JS', () => {
    const files = trackedSources();
    // The scan must actually see the tree — an empty file list would pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    const violations: string[] = [];
    let noiseLines = 0;
    for (const path of files) {
      const src = readFileSync(join(REPO_ROOT, path), 'utf8');
      const res = classifyLines(src, path);
      if (!res.ok) continue; // unparseable files are kept whole by the gate
      const emitted = emittedTextByLine(src, path);
      res.classes.forEach((cls: string, i: number) => {
        if (cls === 'executable') return;
        noiseLines++;
        const js = emitted.get(i) ?? '';
        // Anything beyond delimiters/whitespace/operators-of-closure is runtime.
        if (/[A-Za-z0-9_$'"`]/.test(js)) {
          violations.push(`${path}:${i + 1} [${cls}] -> ${JSON.stringify(js.trim()).slice(0, 80)}`);
        }
      });
    }
    expect(noiseLines).toBeGreaterThan(1000);
    expect(violations).toEqual([]);
  });
});
