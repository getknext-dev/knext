/**
 * Configuration, launcher and DIAGNOSIS for the ci.yml blocking-gate mutation
 * proof.
 *
 * Split out of `scripts/mutation-prove-ci-blocking-gates.mjs` (#672 round 5) so
 * `tests/ci-blocking-gate-proof-runnable.test.ts` can assert the proof is still
 * RUNNABLE without importing the script — importing the script would run all 25
 * mutations. #680 moved the "why did nothing run" attribution here for the same
 * reason: it is the part that has been WRONG three times, so it has to be
 * testable without paying for the mutations. Nothing here executes anything on
 * import.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { blankNonCode } from './blank-non-code.mjs';

/**
 * The name every converted blocking-gate assertion carries. The proof runs ONLY
 * that test (`vitest -t`), which is not a convenience — it is what keeps the
 * result attributable.
 *
 * `tests/mutation-residue-scan.test.ts` proved that the hard way: it also scans
 * every tracked file for the residue marker, and the harness stamps that marker
 * into `ci.yml` on every mutation. Run whole, that spec goes RED under all five
 * disarms — including ones it cannot see — because the marker it just found is
 * its own. A proof that cannot tell "the gate is disarmed" from "the mutation
 * marker is present" proves nothing, so the run is narrowed to the one assertion
 * whose subject is being removed.
 *
 * Selecting by name means a RENAME silently disarms the proof (`vitest -t` with
 * a name matching nothing exits 0), so the correspondence is asserted by
 * `tests/ci-blocking-gate-proof-runnable.test.ts` rather than discovered the
 * next time someone runs the prover.
 */
export const GATE_TEST_NAME = 'runs unconditionally on a PR and its failure fails the run';

/** The workflow every gate lived in until #677 added one that does not. */
export const CI_YML = '.github/workflows/ci.yml';

/**
 * A ci.yml job that CAN skip, used for the `needs:` disarm.
 *
 * `docs-drift-reminder` carries `if: github.event_name == 'pull_request'`, so it
 * is skipped on a push — and a job that `needs:` a skipped job is itself
 * skipped, and a skipped job does not fail the run.
 */
const CI_SKIPPABLE_JOB = 'docs-drift-reminder';

/**
 * Every job whose guard claims it is a blocking gate, and the spec that makes
 * the claim. Adding a converted guard here is what keeps this proof from
 * describing only the jobs someone remembered.
 *
 * Per-gate fields, all defaulted for the ci.yml majority:
 *   - `workflow`   — repo-relative path. Defaults to ci.yml.
 *   - `testName`   — the assertion the proof selects with `vitest -t`. Defaults
 *     to `GATE_TEST_NAME`. It is NOT one shared string any more, and that is a
 *     correctness point rather than a convenience: the image-pin gate is
 *     deliberately `paths:`-scoped, so naming its assertion "runs
 *     unconditionally on a PR" to match the others would make the proof's own
 *     selector a false claim about what is being proved.
 *   - `needsDisarm` — the `needs:` disarm's injected text, plus any job
 *     definition it needs. `image-pin-resolution-nightly.yml` has exactly two
 *     jobs and the other one `needs:` the gate, so pointing the gate at it would
 *     be a CYCLE — not a valid workflow, and a proof resting on an invalid
 *     mutation proves nothing. It therefore injects its own skippable job.
 */
export const GATES = [
  { jobId: 'compile-cache-bun-probe', spec: 'tests/compile-cache-health-bun-ci.test.ts' },
  { jobId: 'typecheck-root', spec: 'tests/root-typecheck-gate.test.ts' },
  { jobId: 'lint-and-test', spec: 'tests/mutation-residue-scan.test.ts' },
  { jobId: 'bun-exec-hardcap', spec: 'tests/bun-exec-hardcap-ci.test.ts' },
  { jobId: 'bun-exec-alpine-image', spec: 'tests/bun-exec-alpine-image-ci.test.ts' },
  {
    jobId: 'resolve-image-pins',
    spec: 'tests/operator-image-pin-resolution.test.ts',
    workflow: '.github/workflows/image-pin-resolution-nightly.yml',
    testName: 'runs on every PR that can introduce a pin and its failure fails the run',
    needsDisarm: {
      define:
        "  proof-skippable:\n    if: github.event_name == 'schedule'\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n",
      inject: '    needs: proof-skippable',
    },
  },
].map((gate) => ({
  workflow: CI_YML,
  testName: GATE_TEST_NAME,
  needsDisarm: { define: '', inject: `    needs: ${CI_SKIPPABLE_JOB}` },
  ...gate,
}));

/**
 * Locate a test runner that can actually start, as `{ command, args }`.
 *
 * The prover used `pnpm exec vitest`, which resolves nothing in a tree that has
 * no `node_modules` of its own — a git worktree, or a fresh clone before
 * install. `pnpm exec` then failed with `Command "vitest" not found`, the
 * prover saw zero tests run, and reported it as a RENAMED ASSERTION. Wrong
 * cause, wrong next step, and the proof was offline for a whole PR.
 *
 * So resolve the binary the way node itself resolves modules: walk up from the
 * repo root for `node_modules/.bin/vitest` and spawn it directly. `pnpm exec`
 * remains the fallback for a tree where the bin shim is absent but the package
 * manager can still find it.
 */
export function resolveTestRunner(repoRoot) {
  let dir = resolve(repoRoot);
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin', 'vitest');
    if (existsSync(bin)) return { command: bin, args: [] };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { command: 'pnpm', args: ['exec', 'vitest'] };
}

/**
 * Every literal test title DECLARED in a spec's source — code only.
 *
 * Deliberately source-level: it answers "what does this file declare", which is
 * what `vitest -t` matches against, without running the file.
 *
 * The scan runs over `blankNonCode(source)`, not the raw source, because the raw
 * scan was satisfied by an occurrence in a COMMENT or a STRING (#680 item 2):
 * renaming the real assertion in `tests/root-typecheck-gate.test.ts` while
 * appending `// historical: it('runs unconditionally on a PR …')` left the
 * PR-time guard 7/7 GREEN. Blanking preserves offsets and keeps quote
 * characters, so the match is located in the code-only view and the title text
 * is then sliced out of the ORIGINAL source.
 *
 * A template literal is reported by its raw text (`$spec templated`), which is
 * what `it.each` declares before interpolation and therefore what a `-t`
 * substring would have to be checked against by hand.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function declaredTestTitles(source) {
  const code = blankNonCode(source);
  const titles = [];
  // The optional `\(...\)` covers the CURRIED form `it.each(CASES)('title', …)`,
  // whose title sits in the SECOND call — `tests/ci-blocking-gate-proof-runnable`
  // declares its per-gate assertion that way, so a pattern without it would
  // report "declares no titles" for a spec that plainly does.
  const pattern = /\b(?:it|test)(?:\.\w+)*(?:\([^()]*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/dg;
  for (const match of code.matchAll(pattern)) {
    const span = match.indices?.[2];
    if (span) titles.push(source.slice(span[0], span[1]));
  }
  return titles;
}

/**
 * vitest 4's banner, printed before it collects anything. Its ABSENCE is the
 * positive evidence that the runner never started — not an inference from the
 * absence of a summary, which is what previously blamed the runner for a spec
 * that was merely missing.
 */
const RUNNER_BANNER = /\bRUN\b\s+v\d+\.\d+/;

/**
 * What vitest 4 prints when the file filter matches nothing.
 *
 * MEASURED against the running version (4.0.18), not assumed:
 *   `vitest run tests/does-not-exist.test.ts -t x` →
 *   `No test files found, exiting with code 1`.
 * The previous detection tested for `no tests`, a string vitest 4 never emits,
 * which is exactly why a moved spec fell through to the runner branch (#680).
 */
const NO_TEST_FILES = /No test files found/;

/** A collection summary — vitest got as far as loading at least one file. */
const TEST_FILES_SUMMARY = /Test Files\s+\d+/;

/**
 * Run the ONE blocking-gate assertion in `spec`.
 *
 * Returns how many tests actually ran alongside the verdict, because `vitest -t`
 * with a name that matches nothing exits 0 — so "green" and "there was nothing
 * to run" are the same status code. The observations that let `ran === 0` be
 * ATTRIBUTED (`launched`, `collected`, `noTestFiles`) are returned rather than
 * collapsed into a verdict, because every misattribution so far came from a
 * branch deciding the cause on too little evidence.
 */
export function runGateTest(repoRoot, spec, name = GATE_TEST_NAME) {
  const runner = resolveTestRunner(repoRoot);
  const res = spawnSync(runner.command, [...runner.args, 'run', spec, '-t', name], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  // SGR colour codes, built with `String.fromCharCode(27)` rather than `\x1b` in
  // a regex literal: biome's `noControlCharactersInRegex` is an ERROR here, and
  // the point of that rule (a control character nobody intended) does not apply
  // to a deliberate ANSI strip.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(ansi, '');
  const passed = Number(out.match(/Tests\s+(\d+) passed/)?.[1] ?? 0);
  const failed = Number(out.match(/Tests\s+.*?(\d+) failed/)?.[1] ?? 0);
  const collected = TEST_FILES_SUMMARY.test(out);
  const noTestFiles = NO_TEST_FILES.test(out);
  // `launched` = the runner produced recognisable vitest output. A run whose
  // filter matched nothing HAS launched; conflating that with a dead runner is
  // the third misattribution #680 closed.
  const launched = RUNNER_BANNER.test(out) || collected || noTestFiles;
  return {
    ok: res.status === 0,
    ran: passed + failed,
    launched,
    collected,
    noTestFiles,
    out,
    runner,
  };
}

/**
 * The causes of "nothing ran" this diagnosis can RECOGNISE.
 *
 * Enumerated so `undetermined` is a real fourth outcome rather than a comment:
 * three causes have now been misattributed here, every one of them by a branch
 * that DEFAULTED to the most common. A default that guesses is the defect, so
 * anything outside this list is reported as not determined.
 */
export const NOTHING_RAN_CAUSES = Object.freeze([
  // The spec vitest was pointed at was never collected — moved, renamed, or
  // excluded by the vitest config. Reported FIRST because it is the cause that
  // used to masquerade as a dead runner.
  'spec-not-collected',
  // The runner binary never produced vitest output at all.
  'runner-never-started',
  // vitest ran the file, but `-t <name>` selected nothing: a rename.
  'assertion-not-declared',
]);

/**
 * What was OBSERVED about a `ran === 0` run, as printable lines.
 *
 * Printed on every diagnosis, not just the undetermined one, so a reader can
 * check the conclusion against the evidence instead of trusting it.
 */
function observations(repoRoot, spec, result) {
  const specPath = resolve(repoRoot, spec);
  return [
    `  spec:      ${specPath}`,
    `  spec file: ${existsSync(specPath) ? 'exists on disk' : 'MISSING from disk'}`,
    `  runner:    ${result.runner.command} ${result.runner.args.join(' ')}`.trimEnd(),
    `  runner on disk: ${existsSync(result.runner.command) ? 'yes' : 'no (resolved from PATH, or absent)'}`,
    `  vitest launched: ${result.launched ? 'yes' : 'no'}; collected a file: ${result.collected ? 'yes' : 'no'}; "No test files found": ${result.noTestFiles ? 'yes' : 'no'}`,
    `  output tail: ${result.out.trim().split('\n').slice(-4).join(' | ') || '(empty)'}`,
  ];
}

/**
 * Attribute a `ran === 0` run to one of `NOTHING_RAN_CAUSES`, or to
 * `'undetermined'`.
 *
 * Each cause needs POSITIVE evidence; none is a fallback for the others.
 *
 * @returns {{ cause: 'spec-not-collected' | 'runner-never-started' | 'assertion-not-declared' | 'undetermined', detail: string[] }}
 */
export function diagnoseNothingRan(repoRoot, spec, result, name = GATE_TEST_NAME) {
  const specPath = resolve(repoRoot, spec);
  const detail = observations(repoRoot, spec, result);

  if (result.noTestFiles || !existsSync(specPath)) {
    return { cause: 'spec-not-collected', detail };
  }
  // Positive evidence, not "the summary was missing": vitest printed nothing
  // recognisable, so it never got as far as saying anything about the spec.
  if (!result.launched) return { cause: 'runner-never-started', detail };
  if (result.collected) {
    const titles = declaredTestTitles(readFileSync(specPath, 'utf8'));
    if (!titles.some((title) => title.includes(name))) {
      return { cause: 'assertion-not-declared', detail };
    }
  }
  return { cause: 'undetermined', detail };
}

/**
 * Say WHY nothing ran, naming what was expected and what was found — or say the
 * cause was not determined and print the observations.
 *
 * The first version printed a bare `FATAL: <spec> has no test named "…"` for
 * every cause. It was the wrong one: the assertion had never been renamed, the
 * RUNNER had failed to start. The second version added the runner cause but made
 * it the DEFAULT, so a MOVED SPEC was reported as `fix: install dependencies` —
 * while printing a runner path that plainly exists. Both misattributions had the
 * same shape, so the fix is structural: a cause is claimed only on positive
 * evidence, and "I don't know" is a legal answer (#680).
 */
export function explainNothingRan(repoRoot, spec, result, name = GATE_TEST_NAME) {
  const specPath = resolve(repoRoot, spec);
  const { cause, detail } = diagnoseNothingRan(repoRoot, spec, result, name);

  if (cause === 'spec-not-collected') {
    return [
      `FATAL: vitest collected NO test file for ${spec}, so NOTHING was proved.`,
      `  looked for: ${specPath}`,
      `  fix: the spec moved or was renamed — update GATES in scripts/lib/ci-blocking-gate-proof.mjs,`,
      `       or check that vitest.config.ts still includes it. This is NOT a dependency problem.`,
      ...detail,
    ].join('\n');
  }
  if (cause === 'runner-never-started') {
    return [
      `FATAL: the test runner never started, so NOTHING was proved.`,
      `  fix: install dependencies in ${repoRoot} (a git worktree has no node_modules of its own)`,
      ...detail,
    ].join('\n');
  }
  if (cause === 'assertion-not-declared') {
    const titles = declaredTestTitles(readFileSync(specPath, 'utf8'));
    return [
      `FATAL: ${spec} declares no test whose name contains the one this proof selects.`,
      `  expected (substring): ${JSON.stringify(name)}`,
      `  found in ${spec}:`,
      ...titles.map((t) => `    - ${JSON.stringify(t)}`),
      `  fix: restore the name, or update this gate's \`testName\` (GATE_TEST_NAME by default) in scripts/lib/ci-blocking-gate-proof.mjs`,
      ...detail,
    ].join('\n');
  }
  return [
    `FATAL: nothing ran — cause not determined. Do NOT assume any of the known ones.`,
    `  known causes checked: ${NOTHING_RAN_CAUSES.join(', ')}`,
    `  what was observed:`,
    ...detail,
    `  full output follows so the fourth cause can be named rather than guessed:`,
    result.out.trimEnd(),
  ].join('\n');
}
