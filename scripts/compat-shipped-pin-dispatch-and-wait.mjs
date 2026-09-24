#!/usr/bin/env node
/**
 * Dispatches `test-e2e-deploy.yml` for ONE shipped-pin early-warning cell,
 * waits for it to finish, and exits non-zero on red (#1376 option b,
 * founder-approved 2026-09-25).
 *
 * Deliberately dispatches the EXISTING credential workflow rather than
 * duplicating its ~2000 lines of checkout/build/pack/deploy machinery — see
 * `scripts/lib/dispatch-poll.mjs`'s header for why that also means this
 * lane can never advance a v1.0 credential count: `KNEXT_COMPAT_MODE` in
 * `test-e2e-deploy.yml` is `'credential'` for exactly 4 named `schedule`
 * cron literals and `'early-warning'` for everything else, including every
 * `workflow_dispatch` — which is the ONLY trigger this script ever uses.
 *
 * Required env: GH_TOKEN (or gh's own auth), GITHUB_REPOSITORY,
 * KNEXT_RUNTIME (node|bun), KNEXT_BUILDER (turbopack|webpack), DISPATCH_ID
 * (rev-1382 — a per-leg identifier this script sends as `test-e2e-deploy.yml`'s
 * own `dispatchId` input, which that workflow's `run-name:` echoes verbatim;
 * `pickDispatchedRun` then matches the polled run list's `displayTitle`
 * EXACTLY against it, never a "newest run" guess — see
 * `scripts/lib/dispatch-poll.mjs`'s header for why that heuristic broke
 * under this lane's own 4-leg fan-out).
 * Optional: DISPATCH_REF (default 'main'), POLL_INTERVAL_MS (default
 * 30000), MAX_WAIT_MS (default 90 * 60_000 — 90 minutes; the CALLING job's
 * `timeout-minutes` must be set strictly higher than this so GitHub's hard
 * job-kill never races this script's own deadline — a job killed by its own
 * timeout reports step status `cancelled`, not `failure`, which
 * `if: failure()` never observes).
 *
 * Usage: node scripts/compat-shipped-pin-dispatch-and-wait.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isRedConclusion,
  isTerminalStatus,
  pickDispatchedRun,
  shippedPinRef,
  withRetry,
} from './lib/dispatch-poll.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_WORKFLOW = 'test-e2e-deploy.yml';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function loadManifest() {
  const path = resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Both wrapped in `withRetry` (rev-1382 review, optional item): these run
 * repeatedly across the 90-minute poll loop, so a transient `gh` error
 * (rate limit, a network blip) used to crash the whole script immediately —
 * indistinguishable in the alert from an ACTUAL credential/early-warning
 * red. The dispatch call itself (`gh workflow run`, below) is deliberately
 * NOT retried: retrying a dispatch that may have actually succeeded risks a
 * duplicate dispatch, a different failure mode than "wait longer to read a
 * result".
 */
function listRecentRuns(repo) {
  return withRetry(async () => {
    const out = gh([
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      TARGET_WORKFLOW,
      '--json',
      'databaseId,event,headBranch,createdAt,status,conclusion,displayTitle',
      '--limit',
      '30',
    ]);
    return JSON.parse(out);
  });
}

function viewRun(repo, id) {
  return withRetry(async () => {
    const out = gh(['run', 'view', String(id), '--repo', repo, '--json', 'status,conclusion,url']);
    return JSON.parse(out);
  });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runtime = process.env.KNEXT_RUNTIME;
  const builder = process.env.KNEXT_BUILDER;
  const dispatchId = process.env.DISPATCH_ID;
  const ref = process.env.DISPATCH_REF ?? 'main';
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
  const maxWaitMs = Number(process.env.MAX_WAIT_MS ?? 90 * 60_000);

  if (!repo || !runtime || !builder || !dispatchId) {
    console.error(
      'FATAL: GITHUB_REPOSITORY, KNEXT_RUNTIME, KNEXT_BUILDER, DISPATCH_ID are required',
    );
    process.exit(1);
  }

  const nextjsRef = shippedPinRef(loadManifest());
  console.log(
    `Dispatching ${TARGET_WORKFLOW} — runtime=${runtime} builder=${builder} nextjsRef=${nextjsRef} (smoke=true, ref=${ref})`,
  );

  const runsBefore = await listRecentRuns(repo);
  gh([
    'workflow',
    'run',
    TARGET_WORKFLOW,
    '--repo',
    repo,
    '--ref',
    ref,
    '-f',
    `nextjsRef=${nextjsRef}`,
    '-f',
    `runtime=${runtime}`,
    '-f',
    `builder=${builder}`,
    '-f',
    'smoke=true',
    '-f',
    `dispatchId=${dispatchId}`,
  ]);

  const deadline = Date.now() + maxWaitMs;
  let run = null;
  while (Date.now() < deadline && !run) {
    await sleep(pollIntervalMs);
    run = pickDispatchedRun(runsBefore, await listRecentRuns(repo), {
      headBranch: ref,
      dispatchId,
    });
  }
  if (!run) {
    console.error(
      `FATAL: no run with displayTitle "${dispatchId}" appeared within the wait window — no fallback to a "newest run" guess (rev-1382 finding 2)`,
    );
    process.exit(1);
  }
  console.log(`Found dispatched run ${run.databaseId}, polling for completion...`);

  let status = run.status;
  let conclusion = run.conclusion;
  let url = '';
  while (Date.now() < deadline && !isTerminalStatus(status)) {
    await sleep(pollIntervalMs);
    const info = await viewRun(repo, run.databaseId);
    status = info.status;
    conclusion = info.conclusion;
    url = info.url;
  }

  if (!isTerminalStatus(status)) {
    console.error(`FATAL: run ${run.databaseId} did not complete within the wait window (${url})`);
    process.exit(1);
  }

  console.log(`Run ${run.databaseId} concluded: ${conclusion} (${url})`);
  if (isRedConclusion(conclusion)) {
    console.error(`RED: ${runtime}/${builder} @ ${nextjsRef} — ${conclusion} (${url})`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
