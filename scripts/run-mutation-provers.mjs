#!/usr/bin/env node
/**
 * The mutation-prover LANE (#685): run every prover, and grade each honestly.
 *
 * `grep -rn mutation-prove .github/workflows/` returned nothing until this
 * script existed. Every prover was manual-only, and that is the structural
 * reason SEVEN of them were found non-functional in a single session — five
 * distinct root causes, three of which printed a confidently WRONG diagnosis
 * instead of failing visibly.
 *
 * TWO FAILURE MODES, BOTH FATAL HERE:
 *
 *   1. A non-zero exit. The obvious one.
 *   2. A prover that runs FEWER (or more) mutations than it declares.
 *      `mutation-prove-publish-markers.mjs` ran 4 of 13 and exited 0 for
 *      several PRs while being cited as evidence for all thirteen. An
 *      exit-code-only lane calls that GREEN, so it is the criterion that
 *      matters most: the verdict is `declared === run`, checked in both
 *      directions (see `lib/prover-lane.mjs`).
 *
 * The prover set is DISCOVERED by glob, never enumerated — an eighth prover
 * written next month is run tonight without anyone remembering to add it, and
 * the guard in `tests/mutation-prover-lane.test.ts` audits the same discovered
 * set for the runner-resolution and declaration contracts.
 *
 * EVERY prover runs even after one fails: a lane that stops at the first red
 * tells you about one prover per night, and the whole point of running them
 * together is to see the entire board.
 *
 * Usage:  node scripts/run-mutation-provers.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProvers, evaluateProverRun } from './lib/prover-lane.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const provers = discoverProvers(REPO_ROOT);
if (provers.length === 0) {
  console.error('FATAL: no scripts/mutation-prove-*.mjs found — the lane would pass vacuously');
  process.exit(1);
}

console.log(`Running ${provers.length} mutation prover(s), discovered by glob:\n`);
for (const p of provers) console.log(`  - ${p.relPath}`);
console.log('');

const results = [];
for (const prover of provers) {
  console.log(`\n${'═'.repeat(78)}\n▶ ${prover.relPath}\n${'═'.repeat(78)}`);
  const run = spawnSync(process.execPath, [prover.absPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // The child's own output is the triage material for a red night, so it is
    // captured AND echoed rather than swallowed into a summary line.
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  process.stdout.write(output);
  if (run.error) console.error(`   spawn error: ${run.error.message}`);
  const { summary, findings } = evaluateProverRun({ status: run.status, output });
  results.push({ relPath: prover.relPath, summary, findings });
}

console.log(`\n${'═'.repeat(78)}\nLANE SUMMARY\n${'═'.repeat(78)}`);
for (const r of results) {
  const counts = r.summary ? `${r.summary.run}/${r.summary.declared}` : '—/—';
  console.log(`${r.findings.length === 0 ? 'ok  ' : 'FAIL'} ${counts.padEnd(8)} ${r.relPath}`);
  for (const f of r.findings) console.log(`       ${f}`);
}

const failed = results.filter((r) => r.findings.length > 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} prover(s) FAILED the lane`);
  process.exit(1);
}
console.log(`\nall ${results.length} prover(s) ran every mutation they declare`);
