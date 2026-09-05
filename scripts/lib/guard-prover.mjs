/**
 * The shared driver for a table-driven guard prover (sprint 2, lane G).
 *
 * WHY THIS EXISTS. Sprint 1 shipped nine new guards and zero mutation provers.
 * The reason given at sprint close was not disagreement with the discipline —
 * `scripts/mutate-prove.sh` was available and correct — it was cost: every
 * prover re-implements the same baseline, canary, clean-tree and exit-code
 * bookkeeping around a table that is usually a dozen lines. When the ceremony
 * costs more than the content, the ceremony is what gets skipped.
 *
 * So the ceremony moves here, once, and a prover becomes its mutation table plus
 * the argument for why each mutation matters. That argument is the part no
 * helper can write.
 *
 * WHAT IT DOES NOT TAKE OVER, deliberately: `declareMutations` and
 * `recordMutation` stay in the CALLER. `prover-lane.mjs` audits each prover's own
 * source for those calls, and a driver that made them on the prover's behalf
 * would satisfy the audit for a file that declares nothing — the
 * delegation-defeats-the-guard shape #693 already had to fix once.
 *
 * DISCIPLINE ENFORCED HERE (`.claude/rules/workflow.md`), so no caller can skip it:
 *   - every verdict branches on the runner's EXIT CODE; output is never parsed;
 *   - the baseline must be GREEN before anything is planted, else ABORT;
 *   - a CANARY mutation must go RED before any green below is trusted;
 *   - the tree is checked clean between mutations, never assumed;
 *   - a partial run is a FAILURE, not a pass.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSpecRunner } from './ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './mutation-harness.mjs';

/**
 * Run one spec and return ONLY its exit code.
 *
 * Output is deliberately discarded. This repo has already had 14 decorative
 * mutations certified all-green by a pass/fail grep that vitest's ANSI defeated,
 * so there is nothing here to grep.
 *
 * @param {string} repoRoot
 * @param {string} spec
 * @returns {number}
 */
export function runSpecExit(repoRoot, spec) {
  const runner = resolveSpecRunner(repoRoot, spec);
  const res = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (res.status === null) {
    throw new Error(`runner did not exit cleanly for ${spec}: ${res.signal ?? res.error}`);
  }
  return res.status;
}

/**
 * Assert the working tree is clean, reading `git status` rather than trusting it.
 *
 * A mutation that survives a stall is the incident the harness was built for, and
 * `.claude/` is excluded because agent scratch lives there and is not the tree
 * under proof.
 *
 * @param {string} repoRoot
 * @param {string} label
 */
export function assertTreeClean(repoRoot, label) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() && !line.includes('.claude/'));
  if (dirty.length > 0) {
    throw new Error(`[${label}] working tree not clean:\n${dirty.join('\n')}`);
  }
}

/**
 * A `GuardProver` bound to one repo and one spec.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.spec the guard being proved
 * @param {Record<string, string>} opts.subjects name -> repo-relative path of every
 *   file this prover mutates. Snapshotted up front so restores are
 *   content-addressed rather than `git checkout`-shaped.
 */
export function createGuardProver({ repoRoot, spec, subjects }) {
  const snaps = Object.fromEntries(
    Object.entries(subjects).map(([name, rel]) => [name, snapshot(resolve(repoRoot, rel))]),
  );
  const failures = [];
  let ran = 0;

  /**
   * PREFLIGHT: every anchor must occur exactly once BEFORE anything expensive
   * runs. An anchor invalidated by an unrelated edit otherwise surfaces as an
   * abort several mutations in — which is exactly how #912's two dead provers
   * behaved, for months, while reading as proved.
   *
   * @param {Array<{id: string, subject: string, anchor: string}>} mutations
   */
  function preflight(mutations) {
    for (const m of mutations) {
      const snap = snaps[m.subject];
      if (!snap) throw new Error(`${m.id}: unknown subject ${JSON.stringify(m.subject)}`);
      const src = readFileSync(snap.path, 'utf8');
      const n = src.split(m.anchor).length - 1;
      if (n !== 1) {
        throw new Error(
          `ABORT (preflight): ${m.id}'s anchor occurs ${n}x in ${m.subject} (expected 1): ` +
            `${JSON.stringify(m.anchor.slice(0, 90))}\nA mutation whose anchor no longer matches ` +
            'proves nothing, and carrying on would report a sweep that never ran.',
        );
      }
    }
    console.log(`preflight ok: ${mutations.length} anchor(s) still match their subjects`);
  }

  /** The unmutated guard must be GREEN, or nothing below means anything. */
  function baseline() {
    assertTreeClean(repoRoot, 'baseline');
    const status = runSpecExit(repoRoot, spec);
    if (status !== 0) {
      console.error(
        `ABORT: ${spec} exits ${status} before any mutation. Every verdict below would be noise.`,
      );
      process.exit(1);
    }
    console.log(`baseline ok: ${spec} is green`);
  }

  /**
   * STEP 0 — prove the harness can SEE RED.
   *
   * A runner that always exits 0 would certify every mutation below while
   * nothing ran at all, and that has happened in this repo. The canary is a real
   * mutation of a real subject rather than a synthetic failing spec, so it also
   * proves the RUNNER is pointed at the right file.
   *
   * @param {{subject: string, anchor: string, replacement: string, options?: object}} canary
   */
  function proveCanSeeRed(canary) {
    const snap = snaps[canary.subject];
    mutate(snap, canary.anchor, canary.replacement, canary.options ?? {});
    // Same unconditional restore as `run()` — the canary plants a real mutation
    // in a real tracked file, so a runner that dies here would leave it there.
    let status;
    try {
      status = runSpecExit(repoRoot, spec);
    } finally {
      restore(snap);
    }
    if (status === 0) {
      console.error(
        'ABORT: the canary mutation left the guard GREEN. The harness cannot observe red, so ' +
          'every green below would be meaningless.',
      );
      process.exit(1);
    }
    console.log(`step 0 ok: the harness sees red (canary exit=${status})`);
    assertTreeClean(repoRoot, 'after canary');
  }

  /**
   * Plant one mutation, grade it on the EXIT CODE, restore, and verify the tree.
   *
   * @param {{id: string, expect: 'red'|'green', claim: string, subject: string,
   *          anchor: string, replacement: string, options?: object,
   *          validate?: (mutated: string) => string | undefined}} m
   *   `validate` returns a PROBLEM string when the mutated subject is not the
   *   thing it claims to be (unparseable YAML, broken JSON). Returning a problem
   *   ABORTS rather than grading — see the note inside.
   * @returns {number} the exit code, so the caller can log it
   */
  function run(m) {
    assertTreeClean(repoRoot, `before ${m.id}`);
    const snap = snaps[m.subject];
    mutate(snap, m.anchor, m.replacement, m.options ?? {});
    // VALIDITY BEFORE VERDICT. A mutation that leaves its subject unparseable
    // reds the guard for the wrong reason, and a red for the wrong reason is
    // indistinguishable in the log from a guard doing its job — the invalid
    // mutation this repo has already had to tell apart from a decorative guard.
    //
    // MEASURED, not anticipated: this check was added after a NEGATIVE control
    // reddened, and the cause was the harness's residue marker landing at column
    // zero inside a YAML block scalar, ending the scalar. Without the negative
    // control the four reds beside it would have read as proof.
    // RESTORE IS UNCONDITIONAL (#927 review). Everything between the mutation
    // and the restore now sits in a `try`, because the two things that can throw
    // here — `m.validate` and `runSpecExit` (which throws when the runner dies
    // on a signal rather than exiting) — would otherwise leave the subject
    // MUTATED on disk and the process on its way out.
    //
    // This is not hypothetical: commit e64c4892 on this branch repaired exactly
    // that outcome arriving by a different route, and the residue scanner could
    // not see it because the planted mutation was a DELETION and a deletion
    // leaves no marker. A prover that dies dirty hands the next `git add -A` a
    // silent revert of the thing it exists to protect.
    let status;
    try {
      if (m.validate) {
        const problem = m.validate(readFileSync(snap.path, 'utf8'));
        if (problem) {
          // `throw`, not `process.exit`: exiting here would skip the `finally`
          // and leave the tree dirty — the bug this block was added to fix.
          throw new Error(
            `${m.id} left its subject INVALID (${problem}). Its verdict would be a red for the ` +
              'wrong reason. Fix the mutation, do not accept the red.',
          );
        }
      }
      status = runSpecExit(repoRoot, spec);
    } finally {
      restore(snap);
    }
    assertTreeClean(repoRoot, `after ${m.id}`);
    ran += 1;
    const ok = m.expect === 'red' ? status !== 0 : status === 0;
    if (!ok) {
      failures.push(`${m.id}: expected ${m.expect}, got exit ${status} — ${m.claim}`);
    }
    const verdict = ok ? (m.expect === 'red' ? 'KILLED' : 'TOLERATED') : '*** SURVIVED ***';
    console.log(`   ${m.id} expect=${m.expect} exit=${status} ${verdict} — ${m.claim}`);
    return status;
  }

  /**
   * Final verdict. A partial run is a FAILURE: a prover that stops at item 5 of
   * 13 and exits 0 was cited as evidence for all thirteen for several PRs.
   *
   * @param {number} declared
   */
  function finish(declared) {
    assertTreeClean(repoRoot, 'final');
    if (ran !== declared) {
      console.error(`ABORT: declared ${declared} mutation(s) but ran ${ran}. Partial != pass.`);
      process.exit(1);
    }
    if (failures.length > 0) {
      console.error(`\n${failures.length} mutation(s) did NOT behave as required:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\n${declared} mutation(s) behaved as required, 0 survived; tree restored clean.`);
  }

  return { preflight, baseline, proveCanSeeRed, run, finish };
}
