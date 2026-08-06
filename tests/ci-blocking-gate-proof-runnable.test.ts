import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  declaredTestTitles,
  GATE_TEST_NAME,
  GATES,
  resolveTestRunner,
} from '../scripts/lib/ci-blocking-gate-proof.mjs';

/**
 * The standing proof must be RUNNABLE (#672 round 5).
 *
 * `scripts/mutation-prove-ci-blocking-gates.mjs` is cited by two files as the
 * evidence that the converted ci.yml blocking-gate guards are not decoration.
 * Nothing ran it, and nothing checked it could run — so it went offline and
 * stayed offline: `pnpm exec vitest` resolves nothing in a tree without its own
 * `node_modules` (a git worktree, a fresh clone before install), and the prover
 * reported that as `FATAL: <spec> has no test named "…"`. Wrong cause, so the
 * actionable next step was wrong too: the assertion names were never renamed.
 *
 * "A spec that cannot run is not a guard" is the finding #659 closed and the
 * reason #640 existed, and a prover that FATALs is WORSE than no prover because
 * its result is quoted as evidence. So the three ways it can go offline are now
 * checked here, cheaply, on every test run:
 *
 *   1. THE RUNNER CANNOT START — the launcher the prover uses is exercised.
 *   2. AN ASSERTION WAS RENAMED — the prover selects by `vitest -t <name>`, and
 *      `vitest -t` with a name that matches nothing EXITS 0, so a rename turns
 *      the whole proof into a no-op that reports success. The declaration is
 *      read from a CODE-ONLY view of the spec (#680), so a title left behind in
 *      a comment or a string does not satisfy this.
 *   3. A GATES SPEC MOVED — the `existsSync` below. That is the third cause of
 *      "nothing ran", and until #680 the prover misreported it as a dead runner.
 *
 * What it does NOT check is the prover's own attribution logic; that lives in
 * `tests/ci-blocking-gate-proof-diagnosis.test.ts`.
 *
 * This does not re-run the 25 mutations (that is minutes of vitest); it asserts
 * the proof is not offline, which is the failure that actually happened.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('the ci.yml blocking-gate mutation proof is runnable', () => {
  it('is non-vacuous: it covers every converted gate', () => {
    // Without this, emptying GATES would make the `it.each` blocks below pass
    // by iterating nothing — the same vacuity the prover itself guards against.
    expect(GATES.length).toBeGreaterThanOrEqual(5);
    expect(GATE_TEST_NAME.length).toBeGreaterThan(20);
  });

  it('the test runner it launches actually starts, on a PATH it did not inherit', () => {
    // The failure that took the proof offline, and the assertion had to be
    // written twice: the first version spawned the runner with the INHERITED
    // environment and was decoration. Under vitest, `node_modules/.bin` is
    // already on PATH, so even the broken `pnpm exec vitest` fallback starts —
    // mutation-proved: breaking the resolver left that version GREEN.
    //
    // So two things are asserted, neither of which the ambient PATH can supply:
    // the resolver found a REAL binary on disk (not the last-resort fallback),
    // and that binary runs with PATH sanitised to the system default.
    const runner = resolveTestRunner(REPO_ROOT);
    expect(
      runner.args,
      `resolver fell back to \`${runner.command} ${runner.args.join(' ')}\` — no runner binary was found by walking up from ${REPO_ROOT}, so the proof cannot run`,
    ).toEqual([]);
    expect(existsSync(runner.command), `${runner.command} does not exist`).toBe(true);

    const res = spawnSync(runner.command, ['--version'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // `node` itself must stay reachable — the bin shim is a script that
      // execs it — but nothing else from the ambient PATH does, so a resolver
      // that resolved nothing cannot be rescued by the environment.
      env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    expect(
      res.status,
      `runner did not start: ${(res.stderr ?? '') || (res.error?.message ?? '')}`,
    ).toBe(0);
    expect(`${res.stdout ?? ''}`).toMatch(/vitest\//);
  });

  it.each(GATES)('$spec declares the assertion the proof selects by name', ({ spec }) => {
    // `vitest -t <no match>` exits 0, so a rename would silently make the proof
    // a no-op. Asserted against the spec's DECLARED titles — code only, so a
    // rename reds here even when the old title survives in a comment or a string
    // (measured: that combination used to leave this guard 7/7 green, #680) —
    // instead of being discovered the next time someone runs the prover.
    const path = resolve(REPO_ROOT, spec);
    expect(existsSync(path), `${spec} is missing`).toBe(true);
    const titles = declaredTestTitles(readFileSync(path, 'utf8'));
    expect(
      titles.some((title) => title.includes(GATE_TEST_NAME)),
      `${spec} declares no test whose name contains ${JSON.stringify(GATE_TEST_NAME)} — found: ${JSON.stringify(titles)}`,
    ).toBe(true);
  });
});
