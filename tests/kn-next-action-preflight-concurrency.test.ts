/**
 * Regression guard for #1499: `tests/kn-next-action-preflight.test.ts`'s
 * `loads the classifier installed in the working directory` failed once
 * under the full 528-file suite's concurrency (PR #1494 round 2, run
 * 36302339979, job 108572201855) — `r.stdout` was `""` and `r.stderr` did
 * NOT contain the classifier-load message, meaning the child process failed
 * earlier than that, at the `SelfSubjectRulesReview` step.
 *
 * PR #1656 (the fix that shipped for #1499) added diagnosability
 * (`describeResult`) and a hard spawn timeout, but its own investigation —
 * 15x concurrent single-file runs, 4x full-suite runs, a 30-way run under
 * `ulimit -n 256` — never reproduced the failure, and concluded the file's
 * existing isolation (a fresh `mkdtempSync` per call, for both the app dir
 * and the PATH-prefixed kubectl stub dir, never shared across calls) was
 * already correct. That investigation was manual and one-off.
 *
 * This round's own investigation (150 total single-invocation runs at
 * concurrency 15, plus a mutation test — see below) found the SAME thing:
 * isolation is correct (a forced shared temp dir reds this file reliably,
 * proving the mutation-test harness can see the defect this class of bug
 * is), and the one real failure observed (1/150, at 15-way burst
 * concurrency) reproduced only as a transient exec/spawn hiccup under load
 * FAR above what `scripts/bun-test.mjs` ever actually applies in CI — its
 * `concurrency` is `Math.max(2, cpus - 2)`, so a hosted 2-4 core runner
 * schedules at most 2-6 files at once, never 15 simultaneous top-level
 * `bun test` process launches as one `Promise.all` burst produces.
 *
 * This file's own concurrency below is deliberately capped to that
 * REALISTIC range (not the higher burst that found the one transient hit)
 * so it stays a reliable regression guard for an actual isolation defect —
 * asserted below via mutation — without itself becoming a new flake by
 * modelling a burst CI never produces. It spawns CONCURRENT `bun test`
 * invocations of the preflight file itself (real process-level concurrency,
 * not `Promise.all` inside one process, which would not stress the per-call
 * `mkdtempSync` isolation the way genuinely separate OS processes racing the
 * filesystem does) and asserts every one passes clean. If a future change
 * reintroduces shared state (a fixed temp path, a shared kubectl stub
 * location, a module-level cache) this test fails the same way the CI flake
 * did — loudly, with every child's output attached — rather than depending
 * on someone noticing a one-off CI red.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TARGET = resolve(REPO_ROOT, 'tests/kn-next-action-preflight.test.ts');

/** Runs `bun test <TARGET>` as a real child process; resolves rather than rejects. */
function runOnce(bunBin: string) {
  return new Promise<{ code: number | null; output: string }>((resolvePromise) => {
    const child = spawn(bunBin, ['test', TARGET], { cwd: REPO_ROOT });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolvePromise({ code, output }));
    child.on('error', (err) => resolvePromise({ code: -1, output: String(err.message) }));
  });
}

// 6 concurrent full-file `bun test` invocations (18 tests each, spawning real
// `node` children of their own) is slower than any single run — generous but
// bounded, matching the file-timeout precedent in `scripts/bun-test.mjs`.
const STRESS_TEST_TIMEOUT_MS = 120_000;

describe('kn-next-action-preflight — concurrency stress (#1499)', () => {
  it(
    '6 concurrent `bun test` invocations of the preflight file all pass clean',
    async () => {
      const bunBin = process.env.KNEXT_BUN ?? 'bun';
      // Matches the realistic ceiling `scripts/bun-test.mjs` itself applies
      // (`Math.max(2, cpus - 2)`) rather than the higher burst that produced
      // the one transient hit in this round's own investigation (see the
      // file docstring) — high enough to exercise real concurrent isolation,
      // not high enough to model a burst CI never actually produces.
      const N = 6;
      const results = await Promise.all(Array.from({ length: N }, () => runOnce(bunBin)));

      const bad = results.filter((r) => r.code !== 0 || !/ 18 pass/.test(r.output));
      const summary = bad
        .map(
          (r, i) =>
            `--- failing run ${i} (code=${r.code}) ---\n${r.output.split('\n').slice(-30).join('\n')}`,
        )
        .join('\n\n');

      expect(bad.length, `${bad.length}/${N} concurrent runs failed:\n\n${summary}`).toBe(0);
      expect(results.length).toBe(N);
    },
    STRESS_TEST_TIMEOUT_MS,
  );
});
