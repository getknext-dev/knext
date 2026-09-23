/**
 * Continuation-line attribution for the honest line % (#1262, ADR-0057 Amendment 1).
 *
 * THE ARTIFACT. `scripts/bun-test.mjs` runs one bun process per test file and
 * the gate merges their lcov reports. A process that imports a module WITHOUT
 * running a branch emits `DA:<n>,0` for every line of it, the 2nd+ physical
 * lines of a `+`-joined multi-line string literal included. A process that DOES
 * run the branch emits NO record for (some of) those continuation lines. The
 * merge keeps the 0, so the line reads uncovered forever even though the
 * statement runs — and no test can raise it, which invites padding.
 *
 * THE FIX (`scripts/lib/continuation-attribution.mjs`). A line that is PURELY a
 * string-literal / `+` continuation takes its hit count from the first line of
 * its enclosing statement. The HARD INVARIANT these tests hold: a line that
 * carries anything that could independently fail to run is NEVER attributed —
 * and neither is a pure line whose evaluation could be skipped by something
 * before it (a short-circuit, a conditional, a call that may throw).
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import {
  attributeContinuations,
  continuationAnchors,
} from '../scripts/lib/continuation-attribution.mjs';
import { HONEST_PER_PATH_THRESHOLDS, HONEST_THRESHOLDS } from '../scripts/lib/coverage-policy.mjs';
import { honestCoverage } from '../scripts/lib/executable-lines.mjs';
import { mergeLcov } from '../scripts/lib/lcov.mjs';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-coverage.mjs');
const CORE_GLOB = 'packages/kn-next/src/**';

/** The 1-based line holding `marker`, which must occur exactly once. */
function lineOf(src: string, marker: string): number {
  const hits = src.split('\n').flatMap((l, i) => (l.includes(marker) ? [i + 1] : []));
  expect({ marker, occurrences: hits.length }).toEqual({ marker, occurrences: 1 });
  return hits[0] as number;
}

/** anchors() for a snippet; fails loudly if the snippet did not parse. */
function anchorsOf(src: string): Map<number, number> {
  const res = continuationAnchors(src, 'fixture.ts');
  if (!res.ok) throw new Error('fixture did not parse');
  return res.anchors;
}

function expectAttributed(src: string, marker: string, anchorMarker: string) {
  const line = lineOf(src, marker);
  expect({ marker, anchor: anchorsOf(src).get(line) }).toEqual({
    marker,
    anchor: lineOf(src, anchorMarker),
  });
}

function expectNotAttributed(src: string, marker: string) {
  const line = lineOf(src, marker);
  expect({ marker, anchor: anchorsOf(src).get(line) }).toEqual({ marker, anchor: undefined });
}

function record(file: string, da: Array<[number, number]>, fn = 0): string {
  return [
    'TN:',
    `SF:${file}`,
    `FNF:${fn}`,
    `FNH:${fn}`,
    ...da.map(([l, h]) => `DA:${l},${h}`),
    'end_of_record',
  ].join('\n');
}

// ── (1) Reproduce the artifact: the two-report merge ──────────────────────────

const REPRO_FILE = 'packages/kn-next/src/zz-continuation-repro.ts';
const REPRO = [
  'export function f(x: string): void {', // 1
  '  if (x) {', // 2
  '    throw new Error( // ANCHOR', // 3
  "      'first ' + // C1", // 4
  "        'second ' + // C2", // 5
  "        'third', // C3", // 6
  '    );', // 7
  '  }', // 8
  '}', // 9
].join('\n');

describe('the artifact, reproduced: a two-report merge', () => {
  // The importer never ran the branch: a 0 on EVERY line, continuations included.
  const importer = record(
    REPRO_FILE,
    Array.from({ length: 9 }, (_, i) => [i + 1, 0] as [number, number]),
  );
  // The runner ran it: the statement's first line is hit, but the 2nd+ physical
  // lines of the string carry NO record at all.
  const runner = record(REPRO_FILE, [
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 1],
  ]);
  const merged = mergeLcov([importer, runner]);
  const read = (p: string) => (p === REPRO_FILE ? REPRO : null);

  test('the merge keeps the 0, and the honest classifier (rightly) keeps the line', () => {
    const honest = honestCoverage(merged, read);
    const lines = honest.files.get(REPRO_FILE)?.lines;
    expect(lines?.get(3)).toBe(1);
    // THE ARTIFACT: the statement ran, yet its continuation lines read uncovered.
    expect(lines?.get(5)).toBe(0);
    expect(lines?.get(6)).toBe(0);
  });

  test('attribution: the pure continuation lines take the statement line’s hit', () => {
    const honest = honestCoverage(merged, read);
    const out = attributeContinuations(honest.files, read);
    const lines = out.files.get(REPRO_FILE)?.lines;
    expect(lines?.get(5)).toBe(1);
    expect(lines?.get(6)).toBe(1);
    expect(out.attributed).toBe(2);
  });

  test('a statement that never ran attributes nothing — the 0 stays', () => {
    const onlyImporter = mergeLcov([importer]);
    const out = attributeContinuations(honestCoverage(onlyImporter, read).files, read);
    const lines = out.files.get(REPRO_FILE)?.lines;
    expect([lines?.get(4), lines?.get(5), lines?.get(6)]).toEqual([0, 0, 0]);
    expect(out.attributed).toBe(0);
  });
});

// ── (2) The classifier of "purely a continuation" ─────────────────────────────

describe('continuationAnchors — what IS attributable', () => {
  test('a `+`-joined literal inside `throw new Error(`', () => {
    expectAttributed(REPRO, '// C2', '// ANCHOR');
    expectAttributed(REPRO, '// C3', '// ANCHOR');
  });

  test('a parenthesised `return (` chain, after a leading literal-only template line', () => {
    const src = [
      'export function g(): string {',
      '  return ( // RET',
      '    `hello, ` + // LEAD',
      "    'pure one ' + // P1",
      '    `pure two` // P2',
      '  );',
      '}',
    ].join('\n');
    expectAttributed(src, '// P1', '// RET');
    expectAttributed(src, '// P2', '// RET');
  });

  test('a `const` initializer, first statement of a function', () => {
    const src = [
      'function m(): string {',
      '  const msg = // DECL',
      "    'a' +",
      "    'b'; // TAIL",
      '  return msg;',
      '}',
    ].join('\n');
    expectAttributed(src, '// TAIL', '// DECL');
  });

  test('rule 5: after an `if` / loop / `switch` / `try` boundary, or a literal-only `const`', () => {
    for (const [lead, extra] of [
      ['  if (x) return;', ''],
      ['  for (const c of "ab") if (c === "z") return;', ''],
      ['  switch (x) {', '  }'],
      ['  try {', '  } finally {}'],
      ["  const k = 'lit';", ''],
    ]) {
      const src = [
        'function m(x: boolean): void {',
        lead,
        extra,
        '  throw new Error( // ANCHOR5',
        "    'a ' +",
        "      'b', // AFTER5",
        '  );',
        '}',
      ].join('\n');
      expectAttributed(src, '// AFTER5', '// ANCHOR5');
    }
  });

  test('a string passed to a function (identifier callee) spanning lines', () => {
    const src = [
      'declare function report(a: string, b: string): void;',
      'function m(): void {',
      '  report( // CALL',
      "    'part one ' + // ARG1",
      "      'part two', // ARG2",
      "    'second argument', // ARG3",
      '  );',
      '}',
    ].join('\n');
    expectAttributed(src, '// ARG1', '// CALL');
    expectAttributed(src, '// ARG2', '// CALL');
    expectAttributed(src, '// ARG3', '// CALL');
  });
});

describe('continuationAnchors — rule 5: the first line may be hit on an UNRELATED path', () => {
  test("the review's repro: a throwing call earlier in the SAME basic block", () => {
    const src = [
      'declare function boom(): never;',
      'function h(): void {',
      '  boom();',
      "  throw new Error('first ' +",
      "    'second ' + // BLK2",
      "    'third'); // BLK3",
      '}',
    ].join('\n');
    expectNotAttributed(src, '// BLK2');
    expectNotAttributed(src, '// BLK3');
  });

  test('`using` / `await using` before the anchor can throw (measured) — `const` still passes', () => {
    for (const decl of ['using', 'await using']) {
      const src = [
        'async function h(): Promise<void> {',
        `  ${decl} u = 'str' as unknown as Disposable;`,
        '  throw new Error(',
        "    'a ' +",
        "      'b', // AFTERUSING",
        '  );',
        '}',
      ].join('\n');
      expectNotAttributed(src, '// AFTERUSING');
    }
    const ok = [
      'function h(): void {',
      "  const u = 'str'; // INERT-DECL",
      '  throw new Error( // ANCHORC',
      "    'a ' +",
      "      'b', // AFTERCONSTDECL",
      '  );',
      '}',
    ].join('\n');
    expectAttributed(ok, '// AFTERCONSTDECL', '// ANCHORC');
  });

  test('a constructor is a block entry ONLY when its entry runs nothing (measured)', () => {
    const body = [
      '  constructor() {',
      '    throw new Error( // CTORANCHOR',
      "      'a ' +",
      "        'b', // CTORCONT",
      '    );',
      '  }',
    ];
    const clean = ['class C {', '  static s = 1;', '  m(): void {}', ...body, '}'].join('\n');
    expectAttributed(clean, '// CTORCONT', '// CTORANCHOR');
    for (const member of [
      '  f = 1;', // instance field initializer — runs at entry
      '  f: string;', // a field with no initializer is still defined at entry
      '  accessor a = 1;',
      '  #p(): void {}', // private brand installed at entry
    ]) {
      expectNotAttributed(['class C {', member, ...body, '}'].join('\n'), '// CTORCONT');
    }
    const paramProp = [
      'class C {',
      '  constructor(private readonly x: string) {',
      '    throw new Error(',
      "      'a ' +",
      "        'b', // PARAMPROP",
      '    );',
      '  }',
      '}',
    ].join('\n');
    expectNotAttributed(paramProp, '// PARAMPROP');
  });

  test('a bare nested `{ }` block does not start a basic block (measured)', () => {
    const src = [
      'declare function boom(): never;',
      'function h(): void {',
      '  boom();',
      '  {',
      '    throw new Error(',
      "      'a ' +",
      "        'b', // NESTED",
      '    );',
      '  }',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// NESTED');
  });

  test('a non-inert statement between the boundary and the anchor', () => {
    const src = [
      'declare function note(): void;',
      'function h(x: boolean): void {',
      '  if (x) return;',
      '  note();',
      "  const k = 'lit';",
      '  throw new Error(',
      "    'a ' +",
      "      'b', // AFTERNOTE",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// AFTERNOTE');
  });

  test('unmeasured block entries are refused: a `case` clause and module top level', () => {
    const src = [
      'function h(n: number): void {',
      '  switch (n) {',
      '    case 1:',
      '      throw new Error(',
      "        'a ' +",
      "          'b', // INCASE",
      '      );',
      '  }',
      '}',
      'throw new Error(',
      "  'top ' +",
      "    'level', // TOPLEVEL",
      ');',
    ].join('\n');
    expectNotAttributed(src, '// INCASE');
    expectNotAttributed(src, '// TOPLEVEL');
  });
});

describe('continuationAnchors — the HARD INVARIANT: never attribute what could fail to run', () => {
  test('a string-converted identifier before the literal (`${name}`, `name +`) blocks it', () => {
    const src = [
      'function h(name: string): string {',
      '  if (name === "") {',
      '    return (',
      '      `hello ${name}, ` +',
      "      'after substitution' // AFTERSUBST",
      '    );',
      '  }',
      '  return (',
      '    name +',
      "    'after operand' // AFTEROPERAND",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// AFTERSUBST');
    expectNotAttributed(src, '// AFTEROPERAND');
  });

  test('a continuation carrying a `${expr}` substitution keeps its own record', () => {
    const src = [
      'function h(v: string) {',
      '  throw new Error(',
      "    'a ' +",
      '      `with ${v} inside ` + // SUBSTLINE',
      "      'tail',",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// SUBSTLINE');
  });

  test('a pure line AFTER a `${call()}` substitution is not attributed (the call may throw)', () => {
    const src = [
      'declare function risky(): string;',
      'function h() {',
      '  throw new Error(',
      '    `a ${risky()} ` +',
      "      'after the call', // AFTERCALL",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// AFTERCALL');
  });

  test('`foo() +` — the call line, and the pure line after it, both keep their records', () => {
    const src = [
      'declare function foo(): string;',
      'function h() {',
      '  return (',
      "    'lead ' +",
      '    foo() + // CALLLINE',
      "    'after foo' // AFTERFOO",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// CALLLINE');
    expectNotAttributed(src, '// AFTERFOO');
  });

  test('a literal and a call on the SAME continuation line keeps its record', () => {
    const src = [
      'declare function render(): string;',
      'function h() {',
      '  return (',
      "    'lead ' +",
      "    'x: ' + render() + // MIXED",
      "    'tail'",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// MIXED');
  });

  test('a ternary split across lines: no branch literal is attributed', () => {
    const src = [
      'function h(cond: boolean): string {',
      '  return cond',
      "    ? 'yes ' + // Q1",
      "      'still yes' // Q2",
      "    : 'no ' + // Q3",
      "      'still no'; // Q4",
      '}',
    ].join('\n');
    expectNotAttributed(src, '// Q2');
    expectNotAttributed(src, '// Q4');
  });

  test('a short-circuit before the chain (`||`, `??`, `&&`) blocks attribution', () => {
    for (const op of ['||', '??', '&&']) {
      const src = [
        'function h(x: string | undefined): string {',
        `  return x ${op}`,
        "    'fallback ' +",
        "    'tail'; // SC",
        '}',
      ].join('\n');
      expectNotAttributed(src, '// SC');
    }
  });

  test('a short-circuit or an assignment BEFORE the chain (in a group) blocks attribution', () => {
    // Each fixture fails ONE rule only (every other rule passes), so the guard
    // it names is observed on its own: `'' ||` holds no identifier, and the
    // function has nothing before its first statement.
    const src = [
      'let y = "";',
      'function h(): string {',
      '  return (',
      "    ('' || 'dflt') +",
      "    'after or' // AFTEROR",
      '  );',
      '}',
      'function k(): string {',
      '  return (',
      "    (y = 'v') +",
      "    'after assign' // AFTERASSIGN",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// AFTEROR');
    expectNotAttributed(src, '// AFTERASSIGN');
  });

  test('a property-access callee (`console.log(`) blocks attribution', () => {
    const src = [
      'function h(): void {',
      '  console.log( // CALL',
      "    'a ' +",
      "      'b', // PROPCALL",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// PROPCALL');
  });

  test('an OPTIONAL call (`fn?.(`) blocks attribution — its args may never evaluate', () => {
    const src = [
      'declare const fn: ((s: string) => void) | undefined;',
      'function h(): void {',
      '  fn?.(',
      "    'a ' +",
      "      'b', // OPTCALL",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// OPTCALL');
  });

  test('a statement that is NOT first on its line (`if (x) throw …`) blocks attribution', () => {
    const src = [
      'function h(x: boolean) {',
      '  if (x) throw new Error(',
      "    'a ' +",
      "      'b', // AFTERIF",
      '  );',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// AFTERIF');
  });

  test('an arrow body, a compound assignment, and a substitution body are not statements', () => {
    const src = [
      'const f = () => // ARROW',
      "  'a ' +",
      "  'b'; // ARROWTAIL",
      "let m = '';",
      'm +=',
      "  'c ' +",
      "  'd'; // PLUSEQ",
      'const t = `${',
      "  'inner' // INSUBST",
      '}`;',
    ].join('\n');
    expectNotAttributed(src, '// ARROWTAIL');
    expectNotAttributed(src, '// PLUSEQ');
    expectNotAttributed(src, '// INSUBST');
  });

  test('the climb alone refuses a literal inside a `${…}` body (every other rule passes)', () => {
    // First statement of a function (rule 5), nothing but `const t =` and a
    // TemplateHead before the literal (rule 4), a pure line (rule 1): only the
    // climb (rule 2) stops at the TemplateSpan. Isolates that guard.
    const src = [
      'function h(): string {',
      '  const t = `${',
      "    'inner' // CLIMBONLY",
      '  }`;',
      '  return t;',
      '}',
    ].join('\n');
    expectNotAttributed(src, '// CLIMBONLY');
  });

  test('a source with parse errors is not analysed at all', () => {
    expect(continuationAnchors("throw new Error(\n 'a' +\n 'b'", 'x.ts').ok).toBe(false);
  });
});

// ── attributeContinuations: the map-level contract ────────────────────────────

describe('attributeContinuations — the map-level contract', () => {
  const read = (p: string) => (p === REPRO_FILE ? REPRO : null);
  const cov = (lines: Array<[number, number]>) => ({
    lines: new Map(lines),
    fnFound: 0,
    fnHit: 0,
    fnNames: new Map(),
  });

  test('never mutates its input', () => {
    const input = new Map([
      [
        REPRO_FILE,
        cov([
          [3, 4],
          [5, 0],
        ]),
      ],
    ]);
    attributeContinuations(input, read);
    expect(input.get(REPRO_FILE)?.lines.get(5)).toBe(0);
  });

  test('never ADDS a record for a line the report did not carry', () => {
    const out = attributeContinuations(new Map([[REPRO_FILE, cov([[3, 4]])]]), read);
    expect(out.files.get(REPRO_FILE)?.lines.has(5)).toBe(false);
    expect(out.files.get(REPRO_FILE)?.lines.size).toBe(1);
  });

  test('an anchor line with no record attributes nothing', () => {
    const out = attributeContinuations(new Map([[REPRO_FILE, cov([[5, 0]])]]), read);
    expect(out.files.get(REPRO_FILE)?.lines.get(5)).toBe(0);
  });

  test('a line that already has hits is left alone', () => {
    const out = attributeContinuations(
      new Map([
        [
          REPRO_FILE,
          cov([
            [3, 4],
            [5, 9],
          ]),
        ],
      ]),
      read,
    );
    expect(out.files.get(REPRO_FILE)?.lines.get(5)).toBe(9);
    expect(out.attributed).toBe(0);
  });

  test('an unreadable source is carried over unchanged', () => {
    const other = 'packages/kn-next/src/zz-missing.ts';
    const out = attributeContinuations(
      new Map([
        [
          other,
          cov([
            [3, 4],
            [5, 0],
          ]),
        ],
      ]),
      read,
    );
    expect(out.files.get(other)?.lines.get(5)).toBe(0);
  });
});

// ── Repo-wide: a re-check of RULE 1 ONLY over every attributed line ───────────

describe('repo-wide rule-1 re-check: every attributed line holds ONLY literal / `+` / closer tokens', () => {
  // SCOPE, stated honestly: this re-derives RULE 1 (what may start on the line)
  // with TypeScript's SCANNER over the line's own text, instead of the AST walk
  // the module uses. It says NOTHING about rules 2-5 — the climb, the anchor's
  // line, what runs before the literal, basic-block entry. Those are covered by
  // the fixtures above and by the real-bun ground-truth check below.
  const ALLOWED = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.PlusToken,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CommaToken,
    ts.SyntaxKind.SemicolonToken,
  ]);
  const files = execFileSync('git', ['ls-files', 'packages/*/src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !f.endsWith('.d.ts'));

  test('the scan is meaningful: it finds attributable lines in the tree', () => {
    let total = 0;
    for (const f of files) {
      const res = continuationAnchors(readFileSync(join(REPO_ROOT, f), 'utf8'), f);
      if (res.ok) total += res.anchors.size;
    }
    expect(total).toBeGreaterThan(10);
  });

  test('no attributed line carries any other token, and every anchor precedes its line', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(REPO_ROOT, f), 'utf8');
      const res = continuationAnchors(src, f);
      if (!res.ok) continue;
      const lines = src.split('\n');
      for (const [line, anchor] of res.anchors) {
        if (!(anchor < line)) bad.push(`${f}:${line} anchor ${anchor} does not precede it`);
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
        scanner.setText(lines[line - 1]);
        let literals = 0;
        for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
          if (!ALLOWED.has(k)) bad.push(`${f}:${line} carries ${ts.SyntaxKind[k]}`);
          if (
            k === ts.SyntaxKind.StringLiteral ||
            k === ts.SyntaxKind.NoSubstitutionTemplateLiteral
          )
            literals++;
        }
        if (literals === 0) bad.push(`${f}:${line} carries no literal`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── Real bun, ground truth by construction (rules 3 and 5) ────────────────────

describe('real bun lcov from two processes: attribution never outruns ground truth', () => {
  // INDEPENDENT of the module: each shape's outcome is fixed by construction, and
  // the runner process ASSERTS it (a chain that runs throws 'first second third';
  // one that does not throws 'boom' or returns). Then two real bun processes (an
  // importer that runs nothing, a runner) produce lcov exactly as the gate sees it.
  //
  // ONE FILE PER SHAPE, each in its own directory with its own two processes: the
  // #1268 re-review found that mixing shapes in one source file perturbs bun's line
  // mapping, so a multi-shape fixture can pass or fail for the wrong reason.
  //
  // Checked per shape: `raised` (did attribution lift any of the continuation lines
  // the merge left at 0?) equals the expected value, and NO shape whose chain did
  // not run is ever raised. Shapes marked `raised: false, runs: true` are ones the
  // rule conservatively refuses.
  const BOOM = 'function boom(): never { throw new Error("boom"); }';
  const chain = (ind: string) => [
    `${ind}throw new Error(`,
    `${ind}  'first ' +`,
    `${ind}    'second ' + // C2`,
    `${ind}    'third', // C3`,
    `${ind});`,
  ];
  type Shape = { name: string; src: string[]; runs: boolean; raised: boolean };
  const SHAPES: Shape[] = [
    // ── the chain NEVER runs: nothing may be raised ──
    {
      // The #1268 review's repro, VERBATIM.
      name: 'REVIEW',
      src: [
        BOOM,
        'export function f(): void {',
        '  boom();',
        "  throw new Error('first ' +",
        "    'second ' + // C2",
        "    'third'); // C3",
        '}',
      ],
      runs: false,
      raised: false,
    },
    {
      name: 'BLOCKSIB',
      src: [BOOM, 'export function f(): void {', '  boom();', ...chain('  '), '}'],
      runs: false,
      raised: false,
    },
    {
      name: 'NESTED',
      src: [BOOM, 'export function f(): void {', '  boom();', '  {', ...chain('    '), '  }', '}'],
      runs: false,
      raised: false,
    },
    {
      name: 'SAMELINE',
      src: [
        'function g(x: boolean): void {',
        '  if (x) throw new Error(',
        "    'first ' +",
        "      'second ' + // C2",
        "      'third', // C3",
        '  );',
        '}',
        'export function f(): void { g(false); }',
      ],
      runs: false,
      raised: false,
    },
    {
      name: 'AFTERIFUNRUN',
      src: [
        'function g(x: boolean): void {',
        '  if (x) return;',
        ...chain('  '),
        '}',
        'export function f(): void { g(true); }',
      ],
      runs: false,
      raised: false,
    },
    {
      // #1268 round 3: `using` throws a TypeError for a non-disposable value.
      name: 'USING',
      src: [
        'export function f(): void {',
        "  using u = 'str' as unknown as Disposable;",
        ...chain('  '),
        '}',
      ],
      runs: false,
      raised: false,
    },
    {
      // #1268 round 3: an instance field initializer runs at constructor entry.
      name: 'CTORFIELD',
      src: [
        BOOM,
        'class T {',
        '  f = boom();',
        '  constructor() {',
        ...chain('    '),
        '  }',
        '}',
        'export function f(): void { new T(); }',
      ],
      runs: false,
      raised: false,
    },
    {
      // A throwing parameter default: measured NOT to share the body's block, so
      // the body's first line reads 0 and nothing is raised.
      name: 'DEFAULTPARAMTHROW',
      src: [
        BOOM,
        'function g(a: string = boom()): void {',
        ...chain('  '),
        '}',
        'export function f(): void { g(); }',
      ],
      runs: false,
      raised: false,
    },
    // ── the chain runs in a sound shape: it IS raised (not vacuous) ──
    {
      name: 'IFFIRST',
      src: [
        'function g(x: boolean): void {',
        '  if (x) {',
        ...chain('    '),
        '  }',
        '}',
        'export function f(): void { g(true); }',
      ],
      runs: true,
      raised: true,
    },
    {
      name: 'AFTERIF',
      src: [
        'function g(x: boolean): void {',
        '  if (x) return;',
        ...chain('  '),
        '}',
        'export function f(): void { g(false); }',
      ],
      runs: true,
      raised: true,
    },
    {
      name: 'AFTERCONST',
      src: ['export function f(): void {', "  const k = 'lit';", ...chain('  '), '}'],
      runs: true,
      raised: true,
    },
    {
      name: 'FNEXPR',
      src: ['export const f = function (): void {', ...chain('  '), '};'],
      runs: true,
      raised: true,
    },
    {
      name: 'ARROW',
      src: ['export const f = (): void => {', ...chain('  '), '};'],
      runs: true,
      raised: true,
    },
    {
      name: 'METHOD',
      src: [
        'class M {',
        '  m(): void {',
        ...chain('    '),
        '  }',
        '}',
        'export function f(): void { new M().m(); }',
      ],
      runs: true,
      raised: true,
    },
    {
      name: 'GETTER',
      src: [
        'class G {',
        '  get v(): string {',
        ...chain('    '),
        '  }',
        '}',
        'export function f(): void { void new G().v; }',
      ],
      runs: true,
      raised: true,
    },
    {
      name: 'SETTER',
      src: [
        'class S {',
        '  set v(_x: string) {',
        ...chain('    '),
        '  }',
        '}',
        "export function f(): void { new S().v = 'x'; }",
      ],
      runs: true,
      raised: true,
    },
    // ── every accepted BOUNDARY, both ways: reached after it → raised; the code
    //    before it throws so the statement after it never runs → not raised ──
    ...(
      [
        ['FOR', '  for (let i = 0; i < 1; i++) {', '  }'],
        ['FOROF', "  for (const c of 'a') {", '  }'],
        ['WHILE', '  let n = 1;\n  while (n > 0) {\n    n--;', '  }'],
        ['SWITCH', '  switch (1 as number) {\n    case 1:', '  }'],
        ['TRY', '  try {', '  } finally {\n  }'],
      ] as const
    ).flatMap(([name, open, close]): Shape[] => [
      {
        name: `${name}_RUN`,
        src: [BOOM, 'export function f(): void {', open, close, ...chain('  '), '}'],
        runs: true,
        raised: true,
      },
      {
        name: `${name}_UNRUN`,
        src: [BOOM, 'export function f(): void {', open, '    boom();', close, ...chain('  '), '}'],
        runs: false,
        raised: false,
      },
    ]),
    ...[true, false].map(
      (runs): Shape => ({
        name: runs ? 'ELSE_RUN' : 'ELSE_UNRUN',
        src: [
          'function g(x: boolean): void {',
          '  if (x) {',
          '    return;',
          '  } else {',
          ...chain('    '),
          '  }',
          '}',
          `export function f(): void { g(${!runs}); }`,
        ],
        runs,
        raised: runs,
      }),
    ),
    {
      name: 'CTORCLEAN',
      src: [
        'class C {',
        '  m(): void {}',
        '  constructor() {',
        ...chain('    '),
        '  }',
        '}',
        'export function f(): void { new C(); }',
      ],
      runs: true,
      raised: true,
    },
    {
      name: 'DEFAULTPARAM',
      src: [
        "function g(a: string = 'x'): void {",
        '  void a;',
        ...chain('  '),
        '}',
        'export function f(): void { g(); }',
      ],
      // `void a;` is an expression statement, so rule 5 conservatively refuses.
      runs: true,
      raised: false,
    },
  ];

  function bunLcov(dir: string, testFile: string, out: string): string {
    const res = spawnSync(
      process.execPath,
      ['test', '--coverage', '--coverage-reporter=lcov', `--coverage-dir=${out}`, testFile],
      { cwd: dir, encoding: 'utf8', timeout: 60_000 },
    );
    // Exit code only: a non-zero runner means the GROUND TRUTH itself failed.
    expect({ dir, testFile, status: res.status }).toEqual({ dir, testFile, status: 0 });
    return readFileSync(join(dir, out, 'lcov.info'), 'utf8');
  }

  test('each fixture shape, in its own file and its own two bun processes', () => {
    const root = mkdtempSync(join(tmpdir(), 'knext-cont-bun-'));
    try {
      const verdicts = SHAPES.map((s) => {
        const dir = join(root, s.name.toLowerCase());
        mkdirSync(dir);
        const src = `${s.src.join('\n')}\n`;
        writeFileSync(join(dir, 'shape.ts'), src);
        writeFileSync(
          join(dir, 'runner.test.ts'),
          [
            "import { expect, test } from 'bun:test';",
            "import { f } from './shape';",
            "test('ground truth', () => {",
            s.runs
              ? "  expect(() => f()).toThrow('first second third');"
              : "  let m = ''; try { f(); } catch (e) { m = (e as Error).message; } expect(m).not.toContain('first');",
            '});',
            '',
          ].join('\n'),
        );
        writeFileSync(
          join(dir, 'importer.test.ts'),
          [
            "import { expect, test } from 'bun:test';",
            "import { f } from './shape';",
            "test('import only', () => { expect(typeof f).toBe('function'); });",
            '',
          ].join('\n'),
        );
        const merged = mergeLcov([
          bunLcov(dir, 'importer.test.ts', 'cov-importer'),
          bunLcov(dir, 'runner.test.ts', 'cov-runner'),
        ]);
        const read = (p: string) => (p.endsWith('shape.ts') ? src : null);
        const honest = honestCoverage(merged, read);
        const before = [...honest.files.values()][0]?.lines;
        const after = [...attributeContinuations(honest.files, read).files.values()][0]?.lines;
        // The continuation lines the MERGE left at 0. bun itself sometimes puts a
        // positive raw count on a continuation line whose chain never ran (the REVIEW
        // shape's last line, measured in its own file) — that is bun's, not
        // attribution's, so only the lines at 0 are judged.
        const zeros = ['// C2', '// C3']
          .map((m) => lineOf(src, m))
          .filter((l) => before?.get(l) === 0);
        return {
          shape: s.name,
          mergedZero: zeros.length > 0,
          raised: zeros.some((l) => (after?.get(l) ?? 0) > 0),
        };
      });
      expect(verdicts).toEqual(
        SHAPES.map((s) => ({ shape: s.name, mergedZero: true, raised: s.raised })),
      );
      // The invariant, stated on its own: a chain that did not run is never raised.
      const outran = SHAPES.filter((s, i) => !s.runs && verdicts[i]?.raised).map((s) => s.name);
      expect(outran).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
// ── (end to end) the gate, fed the two-report merge, at the floor boundary ────

describe('scripts/check-coverage.mjs — attribution decides the honest floor', () => {
  /** REAL tracked sources, read by the checker from disk. */
  const DEPLOY = 'packages/kn-next/src/cli/deploy.ts';
  const CR = 'packages/kn-next/src/cli/cr-builder.ts';
  /** Not on disk: unclassifiable, so every record is kept as given. */
  const FAKE = 'packages/kn-next/src/zz-continuation-gate-fixture.ts';

  const floor = Math.max(HONEST_THRESHOLDS.lines, HONEST_PER_PATH_THRESHOLDS[CORE_GLOB].lines);
  const T = 2003;
  const hitNeeded = Math.ceil((floor * T) / 100);
  const realFound = 5; // statement line + lead line + 3 continuations (the `);` is punctuation)

  /** A block: `<statement>(` / lead literal line / 3 continuations / `);`. */
  function block(file: string, leadMarker: string) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    const lead = lineOf(src, leadMarker);
    return {
      file,
      src,
      stmt: lead - 1,
      lead,
      pure: [lead + 1, lead + 2, lead + 3],
      close: lead + 4,
    };
  }
  // `throw new UsageError(` whose lead line is a plain literal — attributable.
  const OK = block(DEPLOY, '"--bucket overrides storage.bucket, but kn-next.config.ts has " +');
  // `throw new Error(` whose lead line converts `${image}` — NOT attributable.
  const SUBST = block(CR, 'is not digest-pinned. ');

  function runChecker(reports: string[]): number {
    const dir = mkdtempSync(join(tmpdir(), 'knext-cont-'));
    try {
      const args = reports.map((r, i) => {
        const p = join(dir, `r${i}.info`);
        writeFileSync(p, `${r}\n`);
        return `--lcov=${p}`;
      });
      const res = spawnSync(process.execPath, [CHECKER, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      if (res.status === null) throw new Error(`checker did not exit: ${res.error?.message}`);
      return res.status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function fake(hits: number): string {
    const lines = T - realFound;
    return record(
      FAKE,
      Array.from({ length: lines }, (_, i) => [i + 1, i < hits ? 1 : 0] as [number, number]),
      10,
    );
  }

  /** The importer (every line at 0) and the runner (statement + lead hit, NO record after). */
  function twoReports(b: ReturnType<typeof block>): string[] {
    return [
      record(
        b.file,
        [b.stmt, b.lead, ...b.pure, b.close].map((l) => [l, 0] as [number, number]),
      ),
      record(b.file, [
        [b.stmt, 1],
        [b.lead, 1],
      ]),
    ];
  }

  test('the fixtures are what they claim: block shapes and their anchors', () => {
    for (const b of [OK, SUBST]) {
      const lines = b.src.split('\n');
      expect(lines[b.stmt - 1]).toMatch(/throw new (Usage)?Error\($/);
      expect(lines[b.close - 1]?.trim()).toBe(');');
    }
    const ok = continuationAnchors(OK.src, OK.file);
    expect(OK.pure.map((l) => ok.anchors.get(l))).toEqual([OK.stmt, OK.stmt, OK.stmt]);
    const subst = continuationAnchors(SUBST.src, SUBST.file);
    expect([SUBST.lead, ...SUBST.pure].map((l) => subst.anchors.get(l))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('two-report merge, statement ran: the pure lines count as hit — GREEN at the floor', () => {
    // With attribution the real file is 5/5, so the total sits exactly at the floor.
    // Without it the file is 2/5 and the total is three hits short — RED.
    expect(runChecker([...twoReports(OK), fake(hitNeeded - realFound)])).toBe(0);
  });

  test('after a `${image}` conversion the pure lines stay 0 — RED at the same boundary', () => {
    // Same numbers, but the lead line string-converts an identifier, which could
    // throw before the literals run. Attributing them would lift the file to 5/5
    // and hide three possibly-unrun lines — so this must be RED.
    expect(runChecker([...twoReports(SUBST), fake(hitNeeded - realFound)])).not.toBe(0);
  });
});
