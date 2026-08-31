import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveTestRunner } from '../scripts/lib/ci-blocking-gate-proof.mjs';
import { MUTATIONS } from '../scripts/lib/publish-markers-proof.mjs';
import { nodeDir } from './helpers/runtime-binaries';

/**
 * The publish-marker mutation proof must be RUNNABLE (#681 item 4).
 *
 * `scripts/mutation-prove-publish-markers.mjs` is the cited evidence that the
 * `#674`/`#679` marker guards are not decoration. It went OFFLINE and stayed
 * offline without anyone noticing: its item-5 anchor named
 * `const REF_SCOPED = /.../`, a construct #675 deleted, and the harness aborts
 * on an anchor it cannot find exactly once — so the run died at item 5 and
 * items 6-10 NEVER EXECUTED. The proof was quoted as passing while a third of
 * it had never run.
 *
 * That is the fourth prover in this repo found non-functional, and #680 already
 * built the answer for the other one (`ci-blocking-gate-proof-runnable.test.ts`):
 * the prover's configuration lives in a lib, and a test asserts every part of
 * it still resolves. This is the same shape rather than a fifth invention.
 *
 * Every anchor here is still a DELETABLE STRING — nothing can make a text
 * anchor immune to the edit that removes its subject. What this changes is that
 * the breakage is LOUD: it reds in `vitest`, which CI runs on every PR, instead
 * of waiting for the next person to run the prover by hand. `grep -rn
 * mutation-prove .github/workflows/` still returns nothing — no CI job runs any
 * prover — so this test is the only thing standing between an anchor going
 * stale and the proof silently covering less than it claims.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('the publish-marker mutation proof is runnable', () => {
  it('is non-vacuous: it still carries every mutation item', () => {
    // Without this, emptying MUTATIONS would make the `it.each` blocks below
    // pass by iterating nothing — the vacuity the prover itself guards against.
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(13);
    // Duplicated labels would let two items collapse into one unnoticed.
    expect(new Set(MUTATIONS.map((m) => m.label)).size).toBe(MUTATIONS.length);
  });

  it.each(MUTATIONS)('$label — its target file and spec exist', ({ file, spec }) => {
    expect(existsSync(resolve(REPO_ROOT, file)), `${file} is missing`).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, spec)), `${spec} is missing`).toBe(true);
  });

  it.each(MUTATIONS)('$label — its anchor still occurs EXACTLY once', ({ file, anchor }) => {
    // The precise precondition `mutate()` asserts before writing anything —
    // deliberately the SAME substring count (`countOccurrences`), not a
    // stricter reading of it. It aborts on 0 (the subject moved or was
    // rewritten) and on >1 (the mutation would be ambiguous), and either way
    // every LATER item in the script is skipped. Checking it here turns "the
    // proof quietly stopped covering every item after this one" into a red test
    // on the PR that caused it.
    //
    // What this therefore does NOT catch, stated rather than implied: an edit
    // that leaves the anchor intact as a SUBSTRING (appending to its line).
    // That is not a miss — the prover still mutates successfully in that case,
    // so the guard tracks the prover instead of over-reporting. Mutation-proved
    // both ways: an appended comment stays GREEN here AND leaves the prover
    // working; a genuine rewrite (`stringify(doc, { lineWidth: 0 })` →
    // `serialiseWorkflow(doc)`) reds.
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    expect(
      source.split(anchor).length - 1,
      `anchor for \`${file}\` no longer occurs exactly once:\n${anchor}`,
    ).toBe(1);
  });

  it('the test runner the prover launches actually starts', () => {
    // The prover used `pnpm exec vitest`, which resolves NOTHING in a tree with
    // no `node_modules` of its own — a git worktree, or a fresh clone before
    // install. Measured in this repo's agent worktrees: `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
    // Command "vitest" not found`, on which the prover would score every spec
    // as "went RED as required" and then report the restore as broken. A wrong
    // green half and a wrong diagnosis, which is how the OTHER prover was
    // misread for a whole PR (#672 round 5).
    const runner = resolveTestRunner(REPO_ROOT);
    expect(
      runner.args,
      `resolver fell back to \`${runner.command} ${runner.args.join(' ')}\` — no runner binary was found by walking up from ${REPO_ROOT}, so the proof cannot run`,
    ).toEqual([]);
    const res = spawnSync(runner.command, ['--version'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // Nothing from the ambient PATH may rescue a resolver that resolved
      // nothing; `node` stays reachable only because the bin shim execs it.
      // `nodeDir()`, not `dirname(process.execPath)`. The restriction below is
      // the point of this guard — a resolver that resolved nothing must not be
      // rescued by the ambient PATH — but under `bun test` `process.execPath`
      // is bun, so `node` fell off the list entirely and the child died with
      // `env: node: No such file or directory`. That is a failure about the
      // harness that says nothing about the resolver.
      env: { ...process.env, PATH: `${nodeDir()}:/usr/bin:/bin` },
    });
    expect(
      res.status,
      `runner did not start: ${(res.stderr ?? '') || (res.error?.message ?? '')}`,
    ).toBe(0);
    expect(`${res.stdout ?? ''}`).toMatch(/vitest\//);
  });
});
