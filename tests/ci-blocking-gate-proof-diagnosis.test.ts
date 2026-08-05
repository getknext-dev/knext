import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  declaredTestTitles,
  diagnoseNothingRan,
  explainNothingRan,
  GATE_TEST_NAME,
  GATES,
  NOTHING_RAN_CAUSES,
} from '../scripts/lib/ci-blocking-gate-proof.mjs';

/**
 * The prover must not misattribute "nothing ran" (#680 item 1), and its PR-time
 * proxy must not be satisfied by a title that only appears in a comment or a
 * string (#680 item 2).
 *
 * Three causes of "nothing ran" have now been misattributed in this repo, each
 * time by a branch that DEFAULTED to the most common one. So what is asserted
 * here is not only that the third cause (a moved/uncollected spec) reports
 * itself, but that an UNRECOGNISED observation says so rather than guessing.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** The banner vitest 4 prints before it collects anything. */
const RUN_BANNER = 'RUN  v4.0.18 /repo\n';

/** What vitest 4.0.18 actually prints when a filter matches no file — measured. */
const NO_TEST_FILES = `${RUN_BANNER}No test files found, exiting with code 1\n\nfilter:  tests/gone.test.ts\n`;

const runnerOnDisk = { command: '/repo/node_modules/.bin/vitest', args: [] as string[] };

const result = (over: Record<string, unknown>) => ({
  ok: true,
  ran: 0,
  launched: false,
  collected: false,
  noTestFiles: false,
  out: '',
  runner: runnerOnDisk,
  ...over,
});

describe('the prover says WHY nothing ran, or says it does not know', () => {
  it('reports a moved/uncollected spec as its own cause, naming the path', () => {
    const spec = 'tests/definitely-not-here.test.ts';
    const res = result({ out: NO_TEST_FILES, noTestFiles: true, launched: true });
    expect(diagnoseNothingRan(REPO_ROOT, spec, res).cause).toBe('spec-not-collected');

    const message = explainNothingRan(REPO_ROOT, spec, res);
    // The path it looked for, absolute — a relative spec id is what let the
    // reader assume the file was there and blame the environment instead.
    expect(message).toContain(resolve(REPO_ROOT, spec));
    // ...and NOT the runner story, which is the misattribution being fixed.
    expect(message).not.toMatch(/install dependencies/);
  });

  it("matches vitest 4's real `No test files found` wording, not the `no tests` that never matched", () => {
    // The bug: `launched` tested for `|no tests`, which vitest 4 never prints,
    // so a missing spec fell through to the runner-never-started branch while
    // printing a runner path that plainly exists.
    expect(NO_TEST_FILES).not.toMatch(/no tests/);
    const res = diagnoseNothingRan(
      REPO_ROOT,
      'tests/definitely-not-here.test.ts',
      result({ out: NO_TEST_FILES, noTestFiles: true, launched: true }),
    );
    expect(res.cause).not.toBe('runner-never-started');
  });

  it('still reports a dead runner as a dead runner', () => {
    const res = result({
      ok: false,
      out: 'sh: vitest: command not found\n',
      launched: false,
      runner: { command: 'pnpm', args: ['exec', 'vitest'] },
    });
    const d = diagnoseNothingRan(REPO_ROOT, GATES[0].spec, res);
    expect(d.cause).toBe('runner-never-started');
    expect(explainNothingRan(REPO_ROOT, GATES[0].spec, res)).toMatch(/install dependencies/);
  });

  it('still reports a renamed assertion as a renamed assertion', () => {
    // A spec that exists and was collected, but declares no title containing the
    // one `vitest -t` selects — i.e. the assertion was renamed.
    const spec = 'tests/compat-matrix.test.ts';
    const res = result({
      out: `${RUN_BANNER} Test Files  1 passed (1)\n`,
      launched: true,
      collected: true,
    });
    expect(diagnoseNothingRan(REPO_ROOT, spec, res).cause).toBe('assertion-not-declared');
    expect(explainNothingRan(REPO_ROOT, spec, res)).toContain(GATE_TEST_NAME);
  });

  it('says "cause not determined" — and prints what it observed — when nothing matches', () => {
    // The whole point of #680: a fourth cause must NOT be reported as the most
    // common of the first three. This observation is deliberately incoherent:
    // vitest started and collected a file, and the spec DOES declare the
    // assertion, yet nothing ran.
    const res = result({
      out: `${RUN_BANNER} Test Files  1 passed (1)\n`,
      launched: true,
      collected: true,
    });
    const spec = GATES[0].spec;
    expect(diagnoseNothingRan(REPO_ROOT, spec, res).cause).toBe('undetermined');

    const message = explainNothingRan(REPO_ROOT, spec, res);
    expect(message).toMatch(/cause not determined/i);
    // "prints what it observed" — the observations, not a guess.
    expect(message).toContain(runnerOnDisk.command);
    expect(message).toContain(spec);
    expect(message).toMatch(/collected/);
    expect(message).toMatch(/RUN {2}v4\.0\.18/);
  });

  it('enumerates its causes so the fallback is reachable, not decorative', () => {
    // If `undetermined` were dropped from the vocabulary the guessing default
    // would be back; if the recognised causes were dropped, every diagnosis
    // would degrade to "don't know".
    expect(new Set(NOTHING_RAN_CAUSES)).toEqual(
      new Set(['spec-not-collected', 'runner-never-started', 'assertion-not-declared']),
    );
  });
});

describe('declaredTestTitles is satisfied only by a real declaration', () => {
  it('ignores a title that appears only in a comment', () => {
    const src = [
      "it('a real one', () => {});",
      `// historical: it('${GATE_TEST_NAME}')`,
      `/* it('${GATE_TEST_NAME}') */`,
    ].join('\n');
    expect(declaredTestTitles(src)).toEqual(['a real one']);
  });

  it('ignores a title that appears only inside a string literal', () => {
    const src = ['const doc = "it(\'runs unconditionally\')";', "const t = `it('also not')`;"].join(
      '\n',
    );
    expect(declaredTestTitles(src)).toEqual([]);
  });

  it('keeps every real declaration, including it.each / test.skip', () => {
    const src = [
      "it('plain', () => {});",
      "test.skip('skipped', () => {});",
      'it.each(GATES)(`$spec templated`, () => {});',
    ].join('\n');
    expect(declaredTestTitles(src)).toEqual(['plain', 'skipped', '$spec templated']);
  });

  it('does not desync on a regex literal containing a quote', () => {
    // Measured, not hypothetical: `/KNEXT_REQUIRE_BUN:\s*['"]?1['"]?/` appears in
    // tests/compile-cache-health-bun-ci.test.ts, and a blanker without regex
    // support read that apostrophe as a string opener and blanked the code that
    // followed — two of the five gate specs then declared NO titles at all.
    const src = [
      'expect(x).toMatch(/KNEXT_REQUIRE_BUN:\\s*[\'"]?1[\'"]?/);',
      "it('after the regex', () => {});",
    ].join('\n');
    expect(declaredTestTitles(src)).toEqual(['after the regex']);
  });

  it('still treats a division as division, not as a regex opener', () => {
    const src = ['const half = (a + b) / 2;', "it('after the division', () => {});"].join('\n');
    expect(declaredTestTitles(src)).toEqual(['after the division']);
  });

  it.each(GATES)('$spec still declares the selected assertion under the code-only view', ({
    spec,
  }) => {
    // The blanking tokenizer must not eat a REAL declaration in any of the five
    // specs the proof selects — a false negative here would red the prover.
    const titles = declaredTestTitles(readFileSync(resolve(REPO_ROOT, spec), 'utf8'));
    expect(titles.some((t) => t.includes(GATE_TEST_NAME))).toBe(true);
  });
});

describe('there is ONE non-code blanker in the tree', () => {
  it('nothing reimplements blankNonCode', () => {
    // #680 says reuse the tokenizer, not write a third one. Scan rather than
    // enumerate: a new copy anywhere under tests/ or scripts/ fails this.
    const roots = [join(REPO_ROOT, 'tests'), join(REPO_ROOT, 'scripts')];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(m?[jt]s)$/.test(entry.name)) files.push(full);
      }
    };
    for (const root of roots) walk(root);

    const definitions = files.filter((f) =>
      /(?:function|const)\s+blankNonCode\b/.test(readFileSync(f, 'utf8')),
    );
    expect(definitions.map((f) => f.slice(REPO_ROOT.length + 1))).toEqual([
      'scripts/lib/blank-non-code.mjs',
    ]);
  });
});
