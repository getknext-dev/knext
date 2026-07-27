#!/usr/bin/env node
/**
 * scripts/e2e-shard-history.mjs — the cross-run, LANE-LABELLED per-shard ledger
 * for the official-harness compat gate (#545 AC1/AC3, sprint-1 T1).
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this, a shard's outcome lived in two places, neither queryable:
 *   * the job conclusion (says "shard 6/16 failed", never which test), and
 *   * a `compat-suite-summary-*.json` artifact carrying COUNTS only.
 * So "is the flake stable or rotating?" could only be answered by downloading
 * job logs one at a time — which is precisely why re-running until green erased
 * the signal (#545: "the flake rate is folklore, not a number someone can
 * watch"). This tool turns it into a number.
 *
 * LANE HONESTY (the one rule this file exists to keep)
 * ----------------------------------------------------
 * The lane is NEVER inferred from cron timing. #545 says so explicitly, and the
 * reason is concrete: the two schedules are 90 minutes apart on the same ref, so
 * a timing heuristic would launder a BUN red into the NODE credential lane's
 * flake rate — the exact laundering the v1.0 gate cannot survive. The lane comes
 * from the run's own evidence: the `runtime` field the shard summary artifact
 * carries (scripts/e2e-summary.mjs writes it from KNEXT_RUNTIME). A run whose
 * artifacts have expired or are unreadable is reported as `unknown` and counted
 * separately — never silently defaulted to `node`.
 *
 * Usage:
 *   node scripts/e2e-shard-history.mjs [--limit 40] [--lane node|bun] [--json]
 * Requires `gh` on PATH and repo read scope.
 *
 * The pure `classifyRuns()` / `renderLedgerTable()` exports are unit-tested in
 * tests/compat-shard-flake-attribution.test.ts.
 */

import { execFileSync } from 'node:child_process';

const WORKFLOW = 'test-e2e-deploy.yml';
/** Job names look like `Deploy tests (shard 6/16)`. */
const SHARD_JOB_RE = /^Deploy tests \(shard (\d+\/\d+)\)$/;

/**
 * Reduce raw run+job records into one lane-labelled row per run.
 *
 * @param {Array<{databaseId:number, createdAt:string, event:string, conclusion:string,
 *                jobs:Array<{name:string, conclusion:string}>, lane?:string}>} runs
 * @returns {Array<{runId:number, createdAt:string, event:string, lane:string,
 *                  conclusion:string, failedShards:string[], shardCount:number,
 *                  nonShardFailures:string[]}>}
 */
export function classifyRuns(runs) {
  return (runs ?? []).map((run) => {
    const jobs = run.jobs ?? [];
    const failedShards = [];
    const nonShardFailures = [];
    let shardCount = 0;
    for (const job of jobs) {
      const m = String(job.name ?? '').match(SHARD_JOB_RE);
      if (m) {
        shardCount += 1;
        if (job.conclusion === 'failure') failedShards.push(m[1]);
        continue;
      }
      if (job.conclusion === 'failure') nonShardFailures.push(String(job.name ?? ''));
    }
    // Numeric shard order, so `10/16` sorts after `9/16`.
    failedShards.sort((a, b) => Number(a.split('/')[0]) - Number(b.split('/')[0]));
    return {
      runId: run.databaseId,
      createdAt: run.createdAt,
      event: run.event,
      // NEVER guessed — see the lane-honesty note above.
      lane: run.lane === 'node' || run.lane === 'bun' ? run.lane : 'unknown',
      conclusion: run.conclusion,
      failedShards,
      shardCount,
      nonShardFailures,
    };
  });
}

/** Render the ledger as a Markdown table (job-summary / terminal friendly). */
export function renderLedgerTable(rows) {
  const header =
    '| run | created (UTC) | lane | result | failing shards | other failing jobs |\n' +
    '|---|---|---|---|---|---|';
  const body = (rows ?? [])
    .map(
      (r) =>
        `| ${r.runId} | ${r.createdAt} | ${r.lane} | ${r.conclusion} | ` +
        `${r.failedShards.length ? r.failedShards.join(', ') : '—'} | ` +
        `${r.nonShardFailures.length ? r.nonShardFailures.join(', ') : '—'} |`,
    )
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Per-lane flake summary. `unknown` is its OWN bucket and is reported — an
 * unattributable run must never be folded into a lane's denominator.
 */
export function summarizeLanes(rows) {
  const byLane = {};
  for (const r of rows ?? []) {
    byLane[r.lane] ??= { runs: 0, red: 0, shardHits: {} };
    const b = byLane[r.lane];
    b.runs += 1;
    if (r.failedShards.length > 0 || r.nonShardFailures.length > 0) b.red += 1;
    for (const s of r.failedShards) b.shardHits[s] = (b.shardHits[s] ?? 0) + 1;
  }
  return byLane;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const limit = Number(arg('limit', '40'));
  const laneFilter = arg('lane');
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();

  const runs = JSON.parse(
    gh([
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--limit',
      String(limit),
      '--json',
      'databaseId,createdAt,event,conclusion',
    ]),
  ).filter((r) => r.event === 'schedule');

  const enriched = runs.map((r) => {
    const jobs = JSON.parse(
      gh([
        'run',
        'view',
        String(r.databaseId),
        '--json',
        'jobs',
        '--jq',
        '[.jobs[] | {name, conclusion}]',
      ]),
    );
    // The lane comes from the run's KNEXT_RUNTIME echo in a shard job's env
    // group; when unavailable the row is `unknown` by design.
    const lane = laneFromRunLog(repo, r.databaseId);
    return { ...r, jobs, lane };
  });

  const rows = classifyRuns(enriched).filter((r) => !laneFilter || r.lane === laneFilter);
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ rows, lanes: summarizeLanes(rows) }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderLedgerTable(rows)}\n\n`);
  const lanes = summarizeLanes(rows);
  for (const [lane, b] of Object.entries(lanes)) {
    const hits = Object.entries(b.shardHits)
      .sort((a, c) => c[1] - a[1])
      .map(([s, n]) => `${s}×${n}`)
      .join(' ');
    process.stdout.write(
      `${lane}: ${b.red}/${b.runs} scheduled runs red${hits ? ` — shard hits: ${hits}` : ''}\n`,
    );
  }
}

/**
 * The run's own lane echo. Every shard job logs `KNEXT_RUNTIME: <lane>` in its
 * step env group, so the lane is READ from the run rather than inferred. Logs
 * outlive artifacts, which is why this is the primary source.
 */
function laneFromRunLog(repo, runId) {
  try {
    const jobs = JSON.parse(
      gh([
        'api',
        `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
        '--jq',
        '[.jobs[] | select(.name | startswith("Deploy tests")) | .id]',
      ]),
    );
    if (!jobs.length) return undefined;
    const log = gh(['api', `repos/${repo}/actions/jobs/${jobs[0]}/logs`]);
    const m = log.match(/KNEXT_RUNTIME:\s*(node|bun)\b/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
