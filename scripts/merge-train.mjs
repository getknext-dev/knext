#!/usr/bin/env node

/**
 * merge-train — promoted, tested replacement for the lead's scratch scripts
 * (`merge-pr.sh` + `merge-seq.sh`), per #1439.
 *
 * Two real incidents drove this:
 *   1. Deleting a merged base branch auto-closed its stacked child PR — third
 *      occurrence of this hazard.
 *   2. A PR was dequeued twice on a COMBINED-tree guard failure that its own
 *      (isolated) CI never saw.
 *
 * Every decision this file's CLI layer makes is delegated to
 * `scripts/lib/merge-train.mjs`'s pure functions, which is what
 * `tests/merge-train.test.ts` exercises. This file is the thin
 * gh/git/spawn orchestration around them.
 *
 * Usage:
 *   node scripts/merge-train.mjs enqueue <PR> <EXPECTED_HEAD_SHA> [--skip-preflight] [--timeout 8h]
 *   node scripts/merge-train.mjs investigate <PR>
 *   node scripts/merge-train.mjs delete-base <branch> [--retarget]
 *
 * Env:
 *   MERGE_TRAIN_REPO   default "getknext-dev/knext"
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePreflightVerdict,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  decidePollAction,
  failedCheckRuns,
  formatBlockedDeletionMessage,
  groupChangedTestFilesByRunner,
  isFullSha,
  parseDurationSeconds,
  resolveRemoteSha,
} from './lib/merge-train.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = process.env.MERGE_TRAIN_REPO ?? 'getknext-dev/knext';

export function runGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${String(r.stderr ?? r.stdout).slice(0, 2000)}`);
  }
  return r.stdout;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ── PR head / state lookups ─────────────────────────────────────────────────

export function fetchPrHead(gh, repo, pr) {
  return gh([
    'pr',
    'view',
    String(pr),
    '-R',
    repo,
    '--json',
    'headRefOid',
    '-q',
    '.headRefOid',
  ]).trim();
}

export function fetchPrView(gh, repo, pr) {
  const raw = gh([
    'pr',
    'view',
    String(pr),
    '-R',
    repo,
    '--json',
    'state,headRefOid,mergeCommit,baseRefName,headRefName',
  ]);
  return JSON.parse(raw);
}

export function isHeadAncestorOfMain(repoRoot, headSha) {
  const fetch = spawnSync('git', ['-C', repoRoot, 'fetch', '-q', 'origin', 'main'], {
    encoding: 'utf8',
  });
  if (fetch.status !== 0) throw new Error(`git fetch origin main failed: ${fetch.stderr}`);
  const check = spawnSync(
    'git',
    ['-C', repoRoot, 'merge-base', '--is-ancestor', headSha, 'origin/main'],
    {
      encoding: 'utf8',
    },
  );
  return check.status === 0;
}

// ── Pre-enqueue preflight ───────────────────────────────────────────────────

/**
 * Default `exec` dependency: runs a real child process. Injectable so
 * `runPreflight` is unit-testable without a real git clone/merge or a real
 * test-runner invocation — see `tests/merge-train-cli.test.ts`.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 */
export function defaultExec(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function run(exec, cmd, args, opts) {
  const r = exec(cmd, args, opts);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr ?? r.stdout}`);
  }
  return r.stdout;
}

/**
 * Merge the PR's ACTUAL base branch (not a hardcoded "main" — a stacked PR's
 * base is another feature branch, #1731 review round 2) into a scratch
 * worktree copy of the PR head, and run the PR's changed test files. Refuses
 * (throws) on a red result unless `opts.skip` is set.
 *
 * `opts.exec` is the injectable process runner (defaults to `defaultExec`),
 * so this whole flow is unit-testable with a fake that never touches a real
 * git remote or spawns a real test runner.
 */
export function runPreflight(gh, repo, pr, headSha, opts = {}) {
  if (opts.skip) {
    console.log('PREFLIGHT SKIPPED (--skip-preflight)');
    return;
  }
  const exec = opts.exec ?? defaultExec;

  // The PR's OWN base — never a hardcoded "main". A stacked PR's base is
  // another feature branch; merging main into it there would preflight
  // against a tree the PR is not actually being merged into.
  const baseRefName =
    gh([
      'pr',
      'view',
      String(pr),
      '-R',
      repo,
      '--json',
      'baseRefName',
      '-q',
      '.baseRefName',
    ]).trim() || 'main';

  const filesRaw = gh(['pr', 'diff', String(pr), '-R', repo, '--name-only']);
  const paths = filesRaw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const scratch = opts.scratchDir ?? mkdtempSync(join(tmpdir(), 'merge-train-'));
  try {
    run(exec, 'git', ['clone', '-q', REPO_ROOT, scratch]);
    run(exec, 'git', ['-C', scratch, 'fetch', '-q', 'origin', headSha, baseRefName]);
    run(exec, 'git', ['-C', scratch, 'checkout', '-q', headSha]);
    const merge = exec('git', ['-C', scratch, 'merge', '-q', '--no-edit', `origin/${baseRefName}`]);
    if (merge.status !== 0) {
      throw new Error(
        `REFUSING to enqueue: origin/${baseRefName} does not merge cleanly into PR head.\n${merge.stderr}`,
      );
    }

    const changedTestFiles = paths.map((p) => {
      let content = '';
      try {
        content = readFileSync(join(scratch, p), 'utf8');
      } catch {
        content = '';
      }
      return { path: p, content };
    });
    const groups = groupChangedTestFilesByRunner(changedTestFiles);

    for (const [runner, files] of Object.entries(groups)) {
      if (files.length === 0) continue;
      const cmd = runner === 'bun' ? 'bun' : 'npx';
      const args = runner === 'bun' ? ['test', ...files] : ['vitest', 'run', ...files];
      const res = exec(cmd, args, { cwd: scratch });
      const verdict = computePreflightVerdict({
        exitCode: res.status ?? 1,
        output: `${res.stdout}\n${res.stderr}`,
      });
      if (!verdict.ok) {
        console.error(`REFUSING TO ENQUEUE — ${verdict.reason} (${runner}):`);
        for (const line of verdict.failing) console.error(`  ${line}`);
        throw new Error('preflight failed');
      }
    }
    console.log(
      `PREFLIGHT OK (${paths.length} changed file(s), origin/${baseRefName} merges cleanly)`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── enqueue + poll ───────────────────────────────────────────────────────────

export async function enqueueAndWait(gh, repo, pr, expectedHead, opts = {}) {
  if (!isFullSha(expectedHead)) {
    console.log(`REFUSED: "${expectedHead}" is not a full 40-hex SHA`);
    return 3;
  }
  const resolved = resolveRemoteSha(gh, repo, expectedHead);
  if (!resolved) {
    console.log(`REFUSED: SHA ${expectedHead} does not resolve on the remote`);
    return 3;
  }

  const cur = fetchPrHead(gh, repo, pr);
  if (cur !== expectedHead) {
    console.log(`HEAD MOVED: ${cur} != ${expectedHead}`);
    return 3;
  }

  if (!opts.skipPreflight) {
    runPreflight(gh, repo, pr, expectedHead, { skip: false });
  }

  // `--match-head-commit` makes GitHub itself refuse the merge atomically if
  // the PR's head has moved since we last read it — check-then-act between
  // the `fetchPrHead` above and this call is otherwise a race a push can
  // win. The per-poll HEAD MOVED check (below) still runs on every tick for
  // defence in depth, but this is the SHA-lock's primary enforcement point.
  gh(['pr', 'merge', String(pr), '-R', repo, '--merge', '--match-head-commit', expectedHead]);

  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const intervalSeconds = opts.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const view = fetchPrView(gh, repo, pr);
    const headInMain =
      view.state === 'MERGED' && view.mergeCommit?.oid
        ? isHeadAncestorOfMain(REPO_ROOT, expectedHead)
        : undefined;
    const decision = decidePollAction({
      currentHead: view.headRefOid,
      expectedHead,
      prState: view.state,
      mergeCommitOid: view.mergeCommit?.oid ?? null,
      headInMain,
    });

    if (decision.action === 'MERGED') {
      console.log(`MERGED ${expectedHead} ${decision.detail}`);
      return 0;
    }
    if (decision.action === 'HEAD_MOVED') {
      console.log(`HEAD MOVED: ${decision.detail}`);
      return 3;
    }
    if (decision.action === 'DEQUEUED') {
      console.log(`DEQUEUED: ${decision.detail}`);
      await investigateFailure(gh, repo, pr);
      return 1;
    }
    await sleep(intervalSeconds * 1000);
  }
  console.log('TIMEOUT');
  return 2;
}

// ── post-dequeue investigation ───────────────────────────────────────────────

export async function investigateFailure(gh, repo, pr) {
  let runsRaw;
  try {
    runsRaw = gh([
      'api',
      `repos/${repo}/commits/${await currentPrHeadSafe(gh, repo, pr)}/check-runs`,
      '-q',
      '.check_runs',
    ]);
  } catch (e) {
    console.error(`could not fetch check-runs: ${e.message}`);
    return;
  }
  const runs = JSON.parse(runsRaw);
  const failed = failedCheckRuns(runs);
  if (failed.length === 0) {
    console.log('no failed check-runs found (may still be a merge-queue-only failure)');
    return;
  }
  for (const f of failed) {
    console.log(`FAILED: ${f.name} (${f.conclusion}) ${f.detailsUrl ?? ''}`);
  }
}

async function currentPrHeadSafe(gh, repo, pr) {
  try {
    return fetchPrHead(gh, repo, pr);
  } catch {
    return '';
  }
}

// ── pre-branch-deletion retarget guard ──────────────────────────────────────

export function listOpenChildPRs(gh, repo, baseBranch) {
  const raw = gh([
    'pr',
    'list',
    '-R',
    repo,
    '--base',
    baseBranch,
    '--state',
    'open',
    '--json',
    'number,title,url',
  ]);
  return JSON.parse(raw);
}

export function deleteBaseBranch(gh, repo, baseBranch, opts = {}) {
  const children = listOpenChildPRs(gh, repo, baseBranch);
  if (children.length > 0) {
    if (!opts.retarget) {
      console.log(formatBlockedDeletionMessage(baseBranch, children));
      return 1;
    }
    for (const c of children) {
      gh(['pr', 'edit', String(c.number), '-R', repo, '--base', 'main']);
      console.log(`retargeted #${c.number} -> main`);
    }
  }
  gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${baseBranch}`]);
  console.log(`deleted ${baseBranch}`);
  return 0;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = { skipPreflight: false, retarget: false, timeout: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-preflight') flags.skipPreflight = true;
    else if (a === '--retarget') flags.retarget = true;
    else if (a === '--timeout') flags.timeout = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);

  if (cmd === 'enqueue') {
    const [pr, sha] = rest;
    if (!pr || !sha) {
      console.error(
        'usage: merge-train.mjs enqueue <PR> <EXPECTED_HEAD_SHA> [--skip-preflight] [--timeout 8h]',
      );
      process.exit(2);
    }
    const timeoutSeconds = flags.timeout
      ? parseDurationSeconds(flags.timeout)
      : DEFAULT_TIMEOUT_SECONDS;
    const code = await enqueueAndWait(runGh, REPO, pr, sha, {
      skipPreflight: flags.skipPreflight,
      timeoutSeconds,
    });
    process.exit(code);
  } else if (cmd === 'investigate') {
    const [pr] = rest;
    if (!pr) {
      console.error('usage: merge-train.mjs investigate <PR>');
      process.exit(2);
    }
    await investigateFailure(runGh, REPO, pr);
  } else if (cmd === 'delete-base') {
    const [branch] = rest;
    if (!branch) {
      console.error('usage: merge-train.mjs delete-base <branch> [--retarget]');
      process.exit(2);
    }
    process.exit(deleteBaseBranch(runGh, REPO, branch, { retarget: flags.retarget }));
  } else {
    console.error('usage: merge-train.mjs <enqueue|investigate|delete-base> ...');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
