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
 * SHARDED AND BOUNDED (#2208 / #2499). One serial job over every prover under a
 * single ceiling was cancelled five runs running: one prover with no bound of its
 * own ate 47 minutes and ninety never started. So the lane now splits the set
 * across matrix legs (`--shard <i>/<n>`, a pure function of the sorted set, see
 * `lib/prover-shard.mjs`), every prover has its OWN wall-clock bound
 * (`KNEXT_PROVER_TIMEOUT_MS`, default 100 minutes; a timeout is a finding and the
 * next prover still runs), output is streamed as it arrives so a cancelled run
 * still shows what was running, and `--report <file>` writes the leg's
 * machine-readable result for the aggregate job, which proves that the legs'
 * union is the whole set and that declared == run for every prover.
 *
 * Usage:  node scripts/run-mutation-provers.mjs [--shard <i>/<n>] [--list] [--report <file>]
 *   --shard   run only this shard (1-based); omitted = every prover
 *   --list    print the selected provers and exit 0 without running anything
 *   --report  write the JSON report the aggregate job consumes
 * Env: KNEXT_PROVER_TIMEOUT_MS, PROVER_LANE_REF, PROVER_LANE_SHA (report metadata)
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProvers, evaluateProverRun } from './lib/prover-lane.mjs';
import { makeReport, parseShardSpec, proverTimeoutMs, shardProvers } from './lib/prover-shard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fatal(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { shard: null, list: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--shard' || a === '--report') {
      const v = argv[++i];
      if (v === undefined) fatal(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else {
      fatal(
        `unknown argument ${JSON.stringify(a)} — an unrecognised flag must not mean "run everything"`,
      );
    }
  }
  return out;
}

/**
 * Run ONE prover under a wall-clock bound, streaming its output (#2208).
 *
 * The lane used to `spawnSync` each prover with `maxBuffer` and NO `timeout`,
 * and printed the output only after the child exited. Both halves hurt on the
 * night that mattered: a prover that never exited ate the whole job ceiling
 * (47 minutes of a 100-minute budget, run 38140088966), and because its output
 * was buffered, the cancelled run's log held nothing about it.
 *
 * Here the child's output is echoed AS IT ARRIVES (and also captured, because
 * the verdict is parsed from it), and on timeout the child's whole PROCESS
 * GROUP is killed. Group, not child: a prover's work is done by grandchildren
 * (vitest, go test, cargo), and an orphan that outlives its prover keeps running
 * against a tree the next prover is about to mutate.
 */
/** Cap on captured output, matching the old `maxBuffer`. Echo is not capped. */
const MAX_CAPTURE = 64 * 1024 * 1024;

/**
 * @param {string} absPath the prover script
 * @param {{ cwd: string, timeoutMs: number, echo?: (chunk: string) => void }} opts
 * @returns {Promise<{ status: number | null, signal: string | null, output: string,
 *                     timedOut: boolean, error?: Error }>}
 */
function runProver(absPath, { cwd, timeoutMs, echo = (c) => process.stdout.write(c) }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [absPath], {
      cwd,
      // Its own process group, so the kill below can take the whole tree.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let spawnError;
    const take = (chunk) => {
      const text = chunk.toString('utf8');
      echo(text);
      if (output.length < MAX_CAPTURE) output += text;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.on('error', (error) => {
      spawnError = error;
    });
    // Sweep the group the moment the prover itself exits: a grandchild that
    // lingers would otherwise keep running into the next prover (and, holding the
    // stdio pipes open, would delay `close` until the timeout).
    child.on('exit', () => killGroup());
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, output, timedOut, error: spawnError });
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const discovered = discoverProvers(REPO_ROOT);
if (discovered.length === 0) {
  console.error('FATAL: no scripts/mutation-prove-*.mjs found — the lane would pass vacuously');
  process.exit(1);
}

let shard = null;
if (args.shard !== null) {
  try {
    shard = parseShardSpec(args.shard);
  } catch (error) {
    fatal(error.message);
  }
}
const provers = shard ? shardProvers(discovered, shard.index, shard.count) : discovered;
if (provers.length === 0) {
  fatal(
    `no prover in shard ${args.shard} (empty shard of ${discovered.length}) — more shards than provers`,
  );
}

if (args.list) {
  for (const p of provers) console.log(p.relPath);
  process.exit(0);
}

/** Run a repo command, or null when it cannot (not a repository, no such command). */
function repoOut(argv) {
  try {
    return execFileSync(argv[0], argv.slice(1), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// The leg's ACTUAL checked-out HEAD. The report used to echo PROVER_LANE_SHA back,
// which is the plan's own claim, so the aggregate compared the plan with itself.
// Reading HEAD is the only way the aggregate's sha check can ever fail.
const actualSha = repoOut(['git', 'rev-parse', 'HEAD'])?.trim() ?? null;
const plannedSha = process.env.PROVER_LANE_SHA;
if (plannedSha && actualSha !== plannedSha) {
  fatal(
    `the checked-out HEAD (${actualSha ?? 'unreadable'}) is not the sha the plan pinned (${plannedSha}) — this leg would prove the wrong tree`,
  );
}

/** Untracked, non-ignored files, as a Set (null when the tree is not a repository). */
function untrackedFiles() {
  const out = repoOut(['git', 'ls-files', '--others', '--exclude-standard', '-z']);
  return out === null ? null : new Set(out.split('\0').filter(Boolean));
}

const timeoutMs = proverTimeoutMs();
console.log(
  `Running ${provers.length} of ${discovered.length} mutation prover(s)` +
    `${shard ? ` (shard ${shard.index}/${shard.count})` : ''}, discovered by glob, ` +
    `each bounded to ${Math.round(timeoutMs / 1000)}s:\n`,
);
for (const p of provers) console.log(`  - ${p.relPath}`);
console.log('');

/**
 * After a kill the prover's byte-snapshot restore never ran; do not let the next
 * prover inherit a half-mutated tree.
 *
 * Two halves, because a prover can leave two kinds of residue: a MODIFIED tracked
 * file (restored by checkout) and a NEW untracked file (checkout cannot see it).
 * The untracked half removes only what appeared since `before` was taken, never
 * the whole untracked set, so lane-owned files that existed before the prover
 * started (and everything git ignores: node_modules, dist, bin) are preserved.
 */
function restoreTreeAfterKill(before) {
  if (process.env.GITHUB_ACTIONS !== 'true' && process.env.KNEXT_LANE_RESTORE_AFTER_KILL !== '1') {
    return 'the prover was killed mid-mutation; this is not CI so the tree was NOT restored — check the working tree';
  }
  const notes = [];
  try {
    execFileSync('git', ['checkout', '--', '.'], { cwd: REPO_ROOT, stdio: 'ignore' });
    notes.push('tracked files restored');
  } catch (error) {
    return `RESTORE FAILED (${error.message}) — later provers ran on a possibly-dirty tree`;
  }
  const after = untrackedFiles();
  if (before && after) {
    const created = [...after].filter((f) => !before.has(f));
    for (const f of created) rmSync(resolve(REPO_ROOT, f), { force: true });
    notes.push(`${created.length} untracked file(s) it created removed`);
  } else {
    notes.push('untracked files could not be compared');
  }
  return `${notes.join(', ')} before the next prover`;
}

const results = [];
for (const prover of provers) {
  console.log(`\n${'═'.repeat(78)}\n▶ ${prover.relPath}\n${'═'.repeat(78)}`);
  const started = Date.now();
  const untrackedBefore = untrackedFiles();
  const run = await runProver(prover.absPath, { cwd: REPO_ROOT, timeoutMs });
  if (run.error) console.error(`   spawn error: ${run.error.message}`);
  const { summary, findings } = evaluateProverRun({ status: run.status, output: run.output });
  if (run.timedOut) {
    const note = restoreTreeAfterKill(untrackedBefore);
    findings.unshift(
      `TIMED OUT after ${Math.round((Date.now() - started) / 1000)}s (bound ${Math.round(timeoutMs / 1000)}s) — killed with its process group; ${note}`,
    );
    console.error(`\n   ${findings[0]}`);
  }
  results.push({ relPath: prover.relPath, summary, findings });
}

console.log(`\n${'═'.repeat(78)}\nLANE SUMMARY\n${'═'.repeat(78)}`);
for (const r of results) {
  const counts = r.summary ? `${r.summary.run}/${r.summary.declared}` : '—/—';
  console.log(`${r.findings.length === 0 ? 'ok  ' : 'FAIL'} ${counts.padEnd(8)} ${r.relPath}`);
  for (const f of r.findings) console.log(`       ${f}`);
}

if (args.report) {
  const report = makeReport({
    ref: process.env.PROVER_LANE_REF ?? 'unknown',
    sha: actualSha ?? 'unknown',
    shard: shard?.index ?? 1,
    shards: shard?.count ?? 1,
    discovered: discovered.map((p) => p.relPath),
    results,
  });
  mkdirSync(dirname(resolve(args.report)), { recursive: true });
  writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written: ${args.report}`);
}

const failed = results.filter((r) => r.findings.length > 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} prover(s) FAILED the lane`);
  process.exit(1);
}
console.log(`\nall ${results.length} prover(s) ran every mutation they declare`);
