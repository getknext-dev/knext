#!/usr/bin/env node
/**
 * e2e-round-aggregate.mjs — the CI aggregator's decision core (issue #1197 / T1).
 *
 * The `file-manager-e2e-round` ci.yml job runs with `if: always()` so it executes
 * even when an upstream `needs:` job FAILS — because bare `needs:` semantics would
 * SKIP the dependent, and a skipped required check can read as neutral/green. That
 * is the exact false-green hazard, so we assert EXPLICITLY on `needs.*.result`
 * here: the round passes only when every gated job is `success`.
 *
 * Path scoping is done at the aggregator (never `paths:` on ci.yml — #673): on a
 * diff that touches no app-affecting path, the round reports "N/A" GREEN with the
 * reason. See e2e-round-paths.mjs.
 *
 * This module is PURE at its core (`decide`) so the mutation-proofs can drive it
 * with fixtures: feed a failing result → non-zero; feed a runtime-path diff → not
 * N/A; feed a docs-only diff → N/A.
 */

import { execFileSync } from 'node:child_process';
import { AGGREGATOR_NEEDS } from './e2e-round-legs.mjs';
import { appAffectingFiles } from './e2e-round-paths.mjs';

/**
 * Decide the round's outcome.
 *
 * @param {object} input
 * @param {Record<string,string>} input.results  job id → GitHub result string
 *        ('success' | 'failure' | 'cancelled' | 'skipped' | '').
 * @param {ReadonlyArray<string>} input.changedFiles  merge-base diff file list.
 * @param {ReadonlyArray<string>} [input.needs]  the jobs to assert on; defaults to
 *        the registry-derived AGGREGATOR_NEEDS.
 * @returns {{ code: number, status: 'pass'|'fail'|'n/a', lines: string[] }}
 */
export function decide({ results, changedFiles, needs = AGGREGATOR_NEEDS }) {
  const lines = [];
  const affecting = appAffectingFiles(changedFiles);

  // Evaluate the leg results FIRST — BEFORE the N/A short-circuit. A scoped-out
  // diff must never green over a red leg: if an upstream leg failed, fail closed
  // regardless of the path scope. (The N/A branch used to return before this
  // loop, so a docs-only diff with all legs red returned exit 0.)
  const failures = [];
  for (const job of needs) {
    // Missing/empty is treated as NOT success — a job that never reported cannot
    // certify anything. Only the literal 'success' passes.
    const r = results[job] ?? '(no result)';
    if (r !== 'success') failures.push(`${job}=${r}`);
  }

  if (affecting.length === 0) {
    if (failures.length > 0) {
      lines.push(`file-manager e2e round FAILED: ${failures.join(', ')}`);
      lines.push('  Diff scoped N/A (no app-affecting paths) but an upstream leg was RED —');
      lines.push('  failing closed. A scoped-out diff must not green over a failed leg.');
      return { code: 1, status: 'fail', lines };
    }
    lines.push('file-manager e2e round: N/A — no app-affecting paths in this diff.');
    lines.push(
      '  (scoped at the aggregator via merge-base diff; never via paths: on ci.yml — #673)',
    );
    return { code: 0, status: 'n/a', lines };
  }

  lines.push(`file-manager e2e round: ${affecting.length} app-affecting path(s) — asserting.`);
  for (const p of affecting.slice(0, 8)) lines.push(`    ${p}`);
  if (affecting.length > 8) lines.push(`    …and ${affecting.length - 8} more`);
  for (const job of needs) {
    const r = results[job] ?? '(no result)';
    lines.push(`  ${r === 'success' ? 'OK ' : 'RED'}  ${job}: ${r}`);
  }

  if (failures.length > 0) {
    lines.push('');
    lines.push(`file-manager e2e round FAILED: ${failures.join(', ')}`);
    lines.push('  An upstream leg did not conclude success. This is fail-closed by design:');
    lines.push(
      '  bare `needs:` would have SKIPPED this job (reads as neutral) — asserted instead.',
    );
    return { code: 1, status: 'fail', lines };
  }

  lines.push('');
  lines.push('file-manager e2e round PASSED: every gated leg concluded success.');
  return { code: 0, status: 'pass', lines };
}

/** Read the merge-base diff file list from git (base...head). */
function gitDiffFiles(base, head) {
  const range = head ? `${base}...${head}` : base;
  const out = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // needs.*.result arrive via env (never interpolated into the shell). The
  // env-var name per job is E2E_RESULT_<UPPER_SNAKE(jobId)>.
  const envKey = (job) => `E2E_RESULT_${job.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
  const results = {};
  for (const job of AGGREGATOR_NEEDS) results[job] = process.env[envKey(job)] ?? '';

  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA || 'HEAD';
  let changedFiles = [];
  if (base) {
    try {
      changedFiles = gitDiffFiles(base, head);
    } catch (e) {
      // A diff we cannot compute is NOT a reason to pass — treat as app-affecting
      // by failing loud rather than silently reporting N/A.
      console.error(`e2e-round-aggregate: could not diff ${base}...${head}: ${e.message}`);
      console.error('  Refusing to scope out on an uncomputable diff. Exiting non-zero.');
      process.exit(1);
    }
  } else {
    console.error('e2e-round-aggregate: BASE_SHA unset — cannot path-scope. Exiting non-zero.');
    process.exit(1);
  }

  const { code, lines } = decide({ results, changedFiles });
  for (const l of lines) console.log(l);
  process.exit(code);
}
