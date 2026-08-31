import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

  it('every enumerated cause is REACHED by a real observation, and so is the fallback', () => {
    // This used to compare `new Set(NOTHING_RAN_CAUSES)` against a hard-coded
    // set — a restatement of the constant, under a title that claimed
    // reachability (#684 item 3). #675 shipped `re.source.length > 0` under the
    // same shape of title and it took a review round to catch, so the assertion
    // is made to earn its name: each cause is paired with an observation that
    // must actually PRODUCE it. An entry added to the vocabulary with no code
    // path behind it now reds here instead of reading as covered.
    const reaching: Record<string, { spec: string; res: ReturnType<typeof result> }> = {
      'spec-not-collected': {
        spec: 'tests/definitely-not-here.test.ts',
        res: result({ out: NO_TEST_FILES, noTestFiles: true, launched: true }),
      },
      'runner-never-started': {
        spec: GATES[0].spec,
        res: result({ ok: false, out: 'sh: vitest: command not found\n', launched: false }),
      },
      'assertion-not-declared': {
        spec: 'tests/compat-matrix.test.ts',
        res: result({
          out: `${RUN_BANNER} Test Files  1 passed (1)\n`,
          launched: true,
          collected: true,
        }),
      },
    };

    for (const cause of NOTHING_RAN_CAUSES) {
      const observation = reaching[cause];
      expect(
        observation,
        `${cause} is enumerated but no observation here reaches it`,
      ).toBeDefined();
      expect(diagnoseNothingRan(REPO_ROOT, observation.spec, observation.res).cause).toBe(cause);
    }
    // ...and the reverse: an observation whose cause left the vocabulary would
    // otherwise sit here proving something the prover no longer reports.
    expect(new Set(Object.keys(reaching))).toEqual(new Set(NOTHING_RAN_CAUSES));

    // The fallback is a fourth OUTCOME, deliberately outside the vocabulary: if
    // it were enumerated it would read as a recognised cause, and if it were
    // unreachable the guessing default would be back.
    expect(NOTHING_RAN_CAUSES).not.toContain('undetermined');
    const incoherent = result({
      out: `${RUN_BANNER} Test Files  1 passed (1)\n`,
      launched: true,
      collected: true,
    });
    expect(diagnoseNothingRan(REPO_ROOT, GATES[0].spec, incoherent).cause).toBe('undetermined');
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
    testName,
  }) => {
    // The blanking tokenizer must not eat a REAL declaration in any of the specs
    // the proof selects — a false negative here would red the prover. Selected
    // per gate since #677: the paths-scoped image-pin gate declares a different
    // name, because "runs unconditionally on a PR" is not what it proves.
    const titles = declaredTestTitles(readFileSync(resolve(REPO_ROOT, spec), 'utf8'));
    expect(titles.some((t) => t.includes(testName))).toBe(true);
  });
});

describe('blankNonCode is defined in exactly one file', () => {
  it('no second definition of `blankNonCode*` exists under tests/ or scripts/', () => {
    // #680 says reuse the tokenizer, not write a third one. Scan rather than
    // enumerate: a new copy anywhere under tests/ or scripts/ fails this.
    //
    // The title says only what the scan checks (#684 item 2). What it does NOT
    // check, measured rather than supposed: the #682 review planted
    // `const stripNonCode` under tests/ and it stayed GREEN, because this is a
    // NAME scan. Only the copy-paste path — `blankNonCode`, `blankNonCode2` —
    // is caught; a renamed copy is not.
    //
    // The second blanker this comment used to name is GONE (#689):
    // `scripts/scan-half-scan-candidates.mjs` exported `maskLiterals`, an
    // independent length-preserving, regex-aware blanker carrying the same
    // shebang bug #684 fixed here plus one of its own, and it now imports
    // `blankNonCode` instead. Measured before deleting it, over `tests/` +
    // `scripts/`: the reporter's findings are unchanged in its default `read`
    // variant (80) and in `sourcey` (352); `broad` gains exactly one, a block
    // `maskLiterals` had been losing. So the describe block's title is now true
    // of every blanker this scan can see.
    //
    // What it still cannot see is the RENAMED copy above. Widening the regex by
    // name shape (blank|strip|mask + noncode|comment|literal) was measured and
    // reds on five unrelated `stripComments` helpers — i.e. it would need an
    // allowlist, which is the enumeration this scan exists to avoid. That
    // residual is recorded, not closed.
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
      /(?:function|const|let|var|class)\s+blankNonCode/.test(readFileSync(f, 'utf8')),
    );
    expect(definitions.map((f) => f.slice(REPO_ROOT.length + 1))).toEqual([
      'scripts/lib/blank-non-code.mjs',
    ]);
  });
});
