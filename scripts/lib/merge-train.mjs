/**
 * Pure / injectable-`gh` decision logic for `scripts/merge-train.mjs` (#1439).
 *
 * WHY THIS EXISTS. The lead's ad-hoc merge scripts
 * (`scratchpad/merge-pr.sh` + `merge-seq.sh`) caused two real incidents in
 * one week:
 *   1. Deleting a merged base branch auto-closed its stacked child PR
 *      (#1406 -> #1428, re-opened as #1436) — third occurrence of this
 *      hazard.
 *   2. #1424 was dequeued twice because a new guard failed on the COMBINED
 *      tree (two PRs that merged after #1424 was cut added content its own
 *      guard forbids) — the PR's own CI had been green.
 *
 * This module holds the parts of the tool that must be unit-testable
 * without a live `gh` call or a real git remote: SHA-lock validation,
 * poll-state decisions, failing-log extraction, child-PR-retarget planning,
 * and test-runner detection for the pre-enqueue "merge main + run changed
 * tests" step. Every function that talks to GitHub takes an injectable `gh`
 * runner (`(args: string[]) => string`), mirroring
 * `scripts/credential-slot-watchdog.mjs` / `scripts/lib/dispatch-poll.mjs`.
 */

/** A full, lower- or upper-case 40-hex git SHA. Anything else (short SHA,
 * branch name, garbage) is rejected before it is ever used to lock a merge —
 * an agent once reported a nonexistent full SHA, so "looks like a SHA" is
 * necessary but not sufficient; callers must also resolve it on the remote
 * (see `resolveRemoteSha` below). */
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA_RE.test(value);
}

/**
 * Resolve a full SHA against the remote via `gh api repos/{repo}/commits/{sha}`.
 * Returns the resolved (canonical, lower-case) SHA on success, or `null` if
 * the remote does not know this commit — never throws, so callers can fail
 * closed with a clear message instead of an uncaught exception.
 *
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {string} sha
 */
export function resolveRemoteSha(gh, repo, sha) {
  if (!isFullSha(sha)) return null;
  try {
    const raw = gh(['api', `repos/${repo}/commits/${sha}`, '-q', '.sha']);
    const resolved = raw.trim();
    return isFullSha(resolved) ? resolved.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * SHA-lock check: is the PR's CURRENT head still the exact SHA that was
 * reviewed? Must be re-run on every poll tick, not just once at enqueue
 * time — a push after review must never ride an already-queued entry to
 * merge.
 *
 * @param {string} currentHead
 * @param {string} expectedHead
 */
export function headLockHolds(currentHead, expectedHead) {
  return typeof currentHead === 'string' && currentHead === expectedHead;
}

/**
 * The poll loop's pure decision function — given the PR's current observed
 * state, decide what the CLI should do next. Kept separate from the actual
 * polling/sleeping so it is testable without a clock or a network call.
 *
 * @param {{
 *   currentHead: string,
 *   expectedHead: string,
 *   prState: 'OPEN'|'MERGED'|'CLOSED',
 *   mergeCommitOid?: string|null,
 *   headInMain?: boolean,
 * }} observed
 * @returns {{action: 'MERGED'|'HEAD_MOVED'|'DEQUEUED'|'CONTINUE', detail?: string}}
 */
export function decidePollAction(observed) {
  if (!headLockHolds(observed.currentHead, observed.expectedHead)) {
    return { action: 'HEAD_MOVED', detail: `${observed.currentHead} != ${observed.expectedHead}` };
  }
  if (observed.prState === 'MERGED') {
    return {
      action: 'MERGED',
      detail: observed.headInMain ? 'head-in-main' : 'HEAD-NOT-IN-MAIN',
    };
  }
  if (observed.prState === 'CLOSED') {
    return { action: 'DEQUEUED', detail: 'PR closed without merging' };
  }
  return { action: 'CONTINUE' };
}

// ── Pre-enqueue: merge main into scratch copy + run changed tests ──────────

/**
 * Classify a changed PR file path as a test file this tool knows how to
 * run, and which runner it needs. Mirrors the repo convention documented in
 * `.claude/rules` / the PR rules file: files importing `bun:test` run under
 * `bun test`; everything else matching a test-file naming convention runs
 * under vitest. This function only decides membership by PATH; the actual
 * bun:test-vs-vitest split needs file CONTENT (see `detectRunnerForContent`).
 *
 * @param {string} path
 */
export function isTestFilePath(path) {
  return /(^|\/)(__tests__\/.*|.*\.(test|spec))\.(ts|tsx|mjs|js)$/.test(path);
}

/**
 * Decide bun:test vs vitest for a single test file from its own source,
 * since path alone does not say which runner it needs.
 *
 * @param {string} content
 * @returns {'bun'|'vitest'}
 */
export function detectRunnerForContent(content) {
  return /from\s+['"]bun:test['"]/.test(content) ? 'bun' : 'vitest';
}

/**
 * Group a PR's changed test files by the runner each needs.
 *
 * @param {{path: string, content: string}[]} files
 * @returns {{bun: string[], vitest: string[]}}
 */
export function groupChangedTestFilesByRunner(files) {
  /** @type {{bun: string[], vitest: string[]}} */
  const groups = { bun: [], vitest: [] };
  for (const f of files) {
    if (!isTestFilePath(f.path)) continue;
    groups[detectRunnerForContent(f.content)].push(f.path);
  }
  return groups;
}

/**
 * Extract the failing test/assertion lines from a bun:test or vitest run's
 * combined stdout+stderr. Best-effort, line-oriented, never throws — a
 * preflight refusal must always be able to show the human SOMETHING, even
 * if the exact format drifts. Recognises both runners' "(fail)"/"FAIL"
 * markers and a following assertion-error line where present.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function extractFailingTestLines(output) {
  const lines = String(output ?? '').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\(fail\)/.test(line) || /^\s*(FAIL|✗|×)\b/.test(line) || /^\s*\d+\)\s.*$/.test(line)) {
      hits.push(line.trim());
    }
  }
  return hits;
}

/**
 * Pure verdict for the pre-enqueue preflight step: given a test run's exit
 * code and its combined output, decide whether it is safe to enqueue.
 *
 * @param {{exitCode: number, output: string}} result
 * @returns {{ok: true} | {ok: false, reason: string, failing: string[]}}
 */
export function computePreflightVerdict(result) {
  if (result.exitCode === 0) {
    return { ok: true };
  }
  const failing = extractFailingTestLines(result.output);
  return {
    ok: false,
    reason: 'preflight tests failed against merged main',
    failing: failing.length > 0 ? failing : [result.output.trim().slice(-2000)],
  };
}

// ── Post-dequeue: find the merge-group run's failing job ───────────────────

/**
 * Given a list of check-runs for a merge-group / PR head commit, pick the
 * ones that actually failed (never "in progress" or "success"/"neutral").
 *
 * @param {{name: string, status: string, conclusion: string|null, detailsUrl?: string, databaseId?: number}[]} checkRuns
 */
export function failedCheckRuns(checkRuns) {
  return checkRuns.filter(
    (c) =>
      c.status === 'completed' &&
      c.conclusion &&
      c.conclusion !== 'success' &&
      c.conclusion !== 'neutral',
  );
}

// ── Pre-branch-deletion: find + retarget stacked children ──────────────────

/**
 * Format the list of open PRs whose base is the branch about to be deleted,
 * as a human-readable refusal message. Pure formatting, no I/O.
 *
 * @param {string} baseBranch
 * @param {{number: number, title: string, url: string}[]} children
 */
export function formatBlockedDeletionMessage(baseBranch, children) {
  const lines = children.map((c) => `  #${c.number} ${c.title} (${c.url})`);
  return [
    `REFUSING to delete "${baseBranch}": ${children.length} open PR(s) are still based on it:`,
    ...lines,
    'Retarget them to main first (--retarget), or delete manually once they are handled.',
  ].join('\n');
}

// ── Timeout parsing ─────────────────────────────────────────────────────────

/**
 * Parse a duration like "8h", "30m", "90s", or a bare integer (seconds).
 * Returns seconds. Throws on anything it cannot parse — a silently-wrong
 * timeout (e.g. "8h" parsed as 8 seconds) is worse than refusing to run.
 *
 * @param {string|number} value
 */
export function parseDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const s = String(value).trim();
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/i.exec(s);
  if (!m) throw new Error(`cannot parse duration: "${value}"`);
  const n = Number.parseFloat(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const mult = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return n * mult;
}

export const DEFAULT_TIMEOUT_SECONDS = 8 * 3600;
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
