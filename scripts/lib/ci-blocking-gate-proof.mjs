/**
 * Configuration and launcher for the ci.yml blocking-gate mutation proof.
 *
 * Split out of `scripts/mutation-prove-ci-blocking-gates.mjs` (#672 round 5) so
 * `tests/ci-blocking-gate-proof-runnable.test.ts` can assert the proof is still
 * RUNNABLE without importing the script — importing the script would run all 25
 * mutations. Nothing here executes anything on import.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Every ci.yml job whose guard claims it is a blocking gate, and the spec that
 * makes the claim. Adding a converted guard here is what keeps this proof from
 * describing only the jobs someone remembered.
 */
export const GATES = [
  { jobId: 'compile-cache-bun-probe', spec: 'tests/compile-cache-health-bun-ci.test.ts' },
  { jobId: 'typecheck-root', spec: 'tests/root-typecheck-gate.test.ts' },
  { jobId: 'lint-and-test', spec: 'tests/mutation-residue-scan.test.ts' },
  { jobId: 'bun-exec-hardcap', spec: 'tests/bun-exec-hardcap-ci.test.ts' },
  { jobId: 'bun-exec-alpine-image', spec: 'tests/bun-exec-alpine-image-ci.test.ts' },
];

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
 * Every literal test title declared in a spec's source.
 *
 * Deliberately source-level: it answers "what does this file DECLARE", which is
 * what `vitest -t` matches against, without running the file. Template literals
 * with interpolation are skipped — they have no literal title to compare.
 */
export function declaredTestTitles(source) {
  const titles = [];
  const pattern = /\b(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(pattern)) titles.push(match[2]);
  return titles;
}

/**
 * Run the ONE blocking-gate assertion in `spec`.
 *
 * Returns how many tests actually ran alongside the verdict, because `vitest -t`
 * with a name that matches nothing exits 0 — so "green" and "there was nothing
 * to run" are the same status code. The two causes of "nothing ran" are
 * DISTINGUISHED (`launched`), because conflating them is what sent the last
 * reader looking for a rename that had never happened.
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
  // A run that produced no summary line at all never got as far as collecting.
  const launched = /Test Files\s+\d+|no tests/.test(out);
  return { ok: res.status === 0, ran: passed + failed, launched, out, runner };
}
