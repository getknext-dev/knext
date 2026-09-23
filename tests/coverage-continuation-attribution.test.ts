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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('a parenthesised `return (` chain, after a leading `${identifier}` line', () => {
    const src = [
      'export function g(name: string): string {',
      '  return ( // RET',
      '    `hello ${name}, ` + // SUBST',
      "    'pure one ' + // P1",
      '    `pure two` // P2',
      '  );',
      '}',
    ].join('\n');
    expectAttributed(src, '// P1', '// RET');
    expectAttributed(src, '// P2', '// RET');
  });

  test('a `const` initializer', () => {
    const src = ['const msg = // DECL', "  'a' +", "  'b'; // TAIL"].join('\n');
    expectAttributed(src, '// TAIL', '// DECL');
  });

  test('a string passed to a function (identifier callee) spanning lines', () => {
    const src = [
      'declare function report(a: string, b: string): void;',
      'report( // CALL',
      "  'part one ' + // ARG1",
      "    'part two', // ARG2",
      "  'second argument', // ARG3",
      ');',
    ].join('\n');
    expectAttributed(src, '// ARG1', '// CALL');
    expectAttributed(src, '// ARG2', '// CALL');
    expectAttributed(src, '// ARG3', '// CALL');
  });
});

describe('continuationAnchors — the HARD INVARIANT: never attribute what could fail to run', () => {
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
    const src = [
      'let y = "";',
      'function h(x: string | undefined): string {',
      '  return (',
      "    (x || 'dflt') +",
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
    const src = ['console.log( // CALL', "  'a ' +", "    'b', // PROPCALL", ');'].join('\n');
    expectNotAttributed(src, '// PROPCALL');
  });

  test('an OPTIONAL call (`fn?.(`) blocks attribution — its args may never evaluate', () => {
    const src = [
      'declare const fn: ((s: string) => void) | undefined;',
      'fn?.(',
      "  'a ' +",
      "    'b', // OPTCALL",
      ');',
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

// ── Repo-wide: an INDEPENDENT oracle over every attributed line ───────────────

describe('repo-wide: every attributed line holds ONLY literal / `+` / closer tokens', () => {
  // The oracle is TypeScript's SCANNER over the line's own text — independent of
  // the AST walk the module uses. A template substitution scans as TemplateHead,
  // a call as Identifier + `(`: any of those on an attributed line is a defect.
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

  test('the scan is meaningful: it finds attributed lines in the tree', () => {
    let total = 0;
    for (const f of files) {
      const res = continuationAnchors(readFileSync(join(REPO_ROOT, f), 'utf8'), f);
      if (res.ok) total += res.anchors.size;
    }
    expect(total).toBeGreaterThan(20);
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

// ── (end to end) the gate, fed the two-report merge, at the floor boundary ────

describe('scripts/check-coverage.mjs — attribution decides the honest floor', () => {
  /** A REAL tracked source, read by the checker from disk. */
  const REAL = 'packages/kn-next/src/cli/cr-builder.ts';
  /** Not on disk: unclassifiable, so every record is kept as given. */
  const FAKE = 'packages/kn-next/src/zz-continuation-gate-fixture.ts';
  const src = readFileSync(join(REPO_ROOT, REAL), 'utf8');
  const subst = lineOf(src, 'is not digest-pinned. ');
  const throwLine = subst - 1;
  const pure = [subst + 1, subst + 2, subst + 3];
  const close = subst + 4;

  const floor = Math.max(HONEST_THRESHOLDS.lines, HONEST_PER_PATH_THRESHOLDS[CORE_GLOB].lines);
  const T = 2003;
  const hitNeeded = Math.ceil((floor * T) / 100);
  const realFound = 5; // throw + substitution + 3 pure continuations (the `);` is punctuation)

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

  // The importer: every line of the block at 0.
  const importer = record(
    REAL,
    [throwLine, subst, ...pure, close].map((l) => [l, 0] as [number, number]),
  );

  test('the fixture is what it claims: the block shape and its anchors', () => {
    const lines = src.split('\n');
    expect(lines[throwLine - 1]).toContain('throw new Error(');
    expect(lines[close - 1]?.trim()).toBe(');');
    const res = continuationAnchors(src, REAL);
    expect(res.ok).toBe(true);
    expect(pure.map((l) => res.anchors.get(l))).toEqual([throwLine, throwLine, throwLine]);
    expect(res.anchors.get(subst)).toBeUndefined();
  });

  test('two-report merge, statement ran: the pure lines count as hit — GREEN at the floor', () => {
    // The runner: the statement line and the substitution line hit, NO record
    // for the three pure continuations — exactly what bun emits.
    const runner = record(REAL, [
      [throwLine, 1],
      [subst, 1],
    ]);
    // With attribution the real file is 5/5, so the total sits exactly at the floor.
    // Without it the file is 2/5 and the total is three hits short — RED.
    expect(runChecker([importer, runner, fake(hitNeeded - realFound)])).toBe(0);
  });

  test('the `${image}` line is NEVER attributed: its own 0 still counts — RED one below', () => {
    // Same, but the substitution line is not hit by anyone. Correct attribution
    // gives 4/5, one hit below the floor. Attributing the substitution line too
    // would lift it to the floor and hide an uncovered expression — so this must be RED.
    const runner = record(REAL, [[throwLine, 1]]);
    expect(runChecker([importer, runner, fake(hitNeeded - realFound)])).not.toBe(0);
  });
});
