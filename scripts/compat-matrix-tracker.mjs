#!/usr/bin/env node
/**
 * compat-matrix-tracker — the ONE pinned issue for the v1.0 credential matrix
 * (#1300, system-designer gate TD2; review round 2 fixed three defects the
 * first pass missed — see the inline notes below, each keyed to the review
 * finding it closes).
 *
 * WHY THIS EXISTS
 * ----------------
 * `test-e2e-deploy.yml`'s red-alert step opens or updates a PER-CELL issue
 * (`Compat CREDENTIAL RED (<lane>, RC tag)`, labelled `credential-reset`) on
 * every credential-night red. With 5+ credentialing lanes (node, bun,
 * node-webpack, bun-webpack, bun-vinext) plus the two early-warning titles,
 * that is up to 7 distinct issue titles racing for GitHub's hard cap of
 * **3 pinned issues per repo** — and a failed `gh issue pin` call is only a
 * warning, not a failure, so a red beyond the third pinned lane went
 * genuinely unseen: nothing else in this repo surfaces it.
 *
 * The fix: per-cell issues are NEVER pinned (see the workflow's own note at
 * the alert step). Instead exactly ONE issue — this tracker — is pinned, and
 * it is kept current by a daily comment carrying the full matrix (every cell,
 * wired or not, its current-streak night count, and its restart cause if the
 * streak most recently restarted). A reader who wants the aggregate state
 * opens one pinned issue; a reader who wants one cell's detail follows the
 * `credential-reset` label to that cell's own thread.
 *
 * REVIEW FINDING 1 (jev 0.75, blocker) — GitHub's 3-pin cap can ALREADY be
 * fully held by unrelated closed issues (observed: #210/#220/#255 in this
 * repo), in which case `gh issue pin` on the tracker throws outright. This
 * module now (a) unpins any CLOSED pinned issue before pinning the tracker —
 * never an OPEN one, which could be someone else's legitimate pin — and (b)
 * FAILS LOUDLY (throws, non-zero exit) if the tracker still isn't pinned
 * after that, rather than the old warn-and-continue.
 *
 * REVIEW FINDING 2 (0.87) — the old dedup lookup searched the newest 100 OPEN
 * issues by title. This repo alone has 136+ open issues, so a long-lived
 * tracker can fall off that page and get re-created. The lookup now filters
 * by the `credential-matrix-tracker` LABEL first (a handful of issues, ever)
 * and re-checks the title as a defensive tie-breaker.
 *
 * REVIEW FINDING 3 (0.78) — a permissions regression (job-level `permissions:`
 * silently DROPS `actions: read`) can make every `gh run list`/`gh run
 * download` in compat-window-audit.mjs's `--fetch` fail closed, producing a
 * matrix where every wired cell shows 0 nights / all-unresolved — which reads
 * exactly like "the credential program collapsed" when it actually means
 * "this job couldn't read Actions". `looksLikeFetchFailure` distinguishes the
 * two and the CLI refuses to publish on the former.
 *
 * Every `gh`-calling function below takes its `gh` callable as a PARAMETER
 * (never imports `execFileSync` itself), so `tests/compat-matrix-tracker.
 * test.ts` exercises the real branch logic against a scripted fake — no
 * network, no `gh` binary required to prove the pin/dedup/fail-closed
 * behaviour.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { CREDENTIAL_CELLS } from './compat-window-audit.mjs';

/** The tracker's title IS its idempotency key — never change it casually. */
export const TRACKER_TITLE = 'Compat v1.0 credential matrix tracker (pinned)';

/** The label GitHub search/filters can use to find this issue directly. */
export const TRACKER_LABEL = 'credential-matrix-tracker';

/** The label every per-cell credential-reset issue carries (#1300). */
export const CREDENTIAL_RESET_LABEL = 'credential-reset';

/**
 * Render one cell's row. `entry` is `matrix.cells[lane]`, the `auditWindow`
 * result for that lane at `scope: 'credential'` — see compat-window-audit.mjs.
 *
 * @param {{runtime: string, builder: string, lane: string, wired: boolean}} cell
 * @param {ReturnType<typeof import('./compat-window-audit.mjs').auditWindow>} entry
 */
export function formatCellRow(cell, entry) {
  const status = cell.wired ? (entry.met ? 'MET' : 'not met') : 'UNWIRED';
  const cause = entry.current?.restartCause ? ` (last restart: ${entry.current.restartCause})` : '';
  return (
    `| ${cell.runtime}×${cell.builder} | \`${cell.lane}\` | ${cell.wired ? 'wired' : 'unwired'} ` +
    `| ${entry.current.nights}/${entry.requiredNights} | ${status}${cause} |`
  );
}

/**
 * Build the tracker issue body from a `compat-window-audit.mjs --fetch
 * --matrix --json` result. Pure — no `gh`, no network, no Date.now() unless
 * `opts.generatedAt` is omitted (defaulted for testability).
 *
 * @param {{cells: Record<string, any>, allMet: boolean}} matrix
 * @param {{runUrl?: string, generatedAt?: string}} [opts]
 */
export function buildTrackerBody(matrix, opts = {}) {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const rows = CREDENTIAL_CELLS.map((cell) => {
    const entry = matrix.cells[cell.lane];
    if (!entry) {
      throw new Error(`compat-matrix-tracker: matrix has no entry for lane "${cell.lane}"`);
    }
    return formatCellRow(cell, entry);
  });
  const verdict = matrix.allMet
    ? 'v1.0 CREDENTIAL MET — every supported cell banked its window on an RC tag.'
    : 'v1.0 credential NOT YET met — every supported cell needs its own 14 RC-tag nights.';
  return `Daily matrix audit — generated ${generatedAt}${opts.runUrl ? ` by ${opts.runUrl}` : ''}.

This is the **one pinned aggregate view** of every credentialing cell (ADR-0056
D2: one independent 14-night window per runtime×builder cell). A per-cell red
opens or updates its own \`${CREDENTIAL_RESET_LABEL}\`-labelled issue with the
full failure detail and restart cause; that issue is deliberately NOT pinned
(GitHub's 3-pin cap, #1300) — this tracker is the single always-visible
surface, refreshed once a day regardless of whether last night was red.

| Cell | Lane | Wired | Nights (current/required) | Status |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

**${verdict}**

Open credential-reset issues: search \`is:issue is:open label:${CREDENTIAL_RESET_LABEL}\`.`;
}

/**
 * REVIEW FINDING 3 — does this matrix look like a FETCH failure (permissions,
 * `gh run list`/`gh run download` degraded) rather than a genuine "every wired
 * cell has zero credentialed history" state?
 *
 * Scoped to WIRED cells only: an unwired cell (node-vinext today) has no
 * workflow at all, so it legitimately shows zero nights forever — that is not
 * evidence of anything breaking. Among wired cells, the credential program
 * runs on dedicated nightly crons (docs/compat-matrix.md), so it is not
 * plausible for EVERY wired cell to have graded zero nights or have every
 * graded night come back `unresolved` unless the fetch itself is degraded
 * (most commonly: `actions: read` missing from the job's permissions, so `gh
 * run list`/`gh run download` fail and every night reads as
 * `artifact-api-unreachable`/`artifact-download-failed`).
 *
 * @param {{cells: Record<string, any>}} matrix
 * @param {typeof CREDENTIAL_CELLS} [cells]
 */
export function looksLikeFetchFailure(matrix, cells = CREDENTIAL_CELLS) {
  const wired = cells.filter((c) => c.wired);
  if (wired.length === 0) return false;
  return wired.every((c) => {
    const entry = matrix?.cells?.[c.lane];
    if (!entry) return true; // a wired cell missing from the matrix entirely is its own red flag
    const nights = Array.isArray(entry.nights) ? entry.nights : [];
    return nights.length === 0 || nights.every((n) => Boolean(n?.unresolved));
  });
}

/**
 * REVIEW FINDING 2 — find the tracker issue by LABEL first (a handful of
 * issues, ever — immune to the "falls off page 1 of 100" failure the old
 * title-only, `--state open --limit 100` lookup had), then defensively
 * confirm the title too, so a label collision can never silently adopt the
 * wrong issue as the tracker.
 *
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @returns {number|null}
 */
export function findTrackerIssue(gh, repo) {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--label',
    TRACKER_LABEL,
    '--limit',
    '20',
    '--json',
    'number,title',
  ]);
  /** @type {Array<{number: number, title: string}>} */
  const issues = JSON.parse(raw);
  const match = issues.find((i) => i.title === TRACKER_TITLE);
  return match ? match.number : null;
}

/**
 * REVIEW FINDING 1 — pin `issueNumber`, unpinning any CLOSED pinned issue
 * first (never an OPEN one — that could be someone else's legitimate pin),
 * and FAIL LOUDLY (throw) if the tracker still isn't pinned afterward. The
 * old code only warned on a failed pin, which is exactly how "3 pin slots
 * held by closed issues" went unnoticed — the job stayed green while the one
 * thing this feature promises (a pinned, always-visible tracker) silently
 * didn't happen.
 *
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {number} issueNumber
 */
export function ensurePinned(gh, repo, issueNumber) {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--search',
    'is:pinned',
    '--limit',
    '10',
    '--json',
    'number,state',
  ]);
  /** @type {Array<{number: number, state: string}>} */
  const pinned = JSON.parse(raw);
  for (const p of pinned) {
    if (p.number === issueNumber) {
      return; // already pinned — nothing to do
    }
    if (String(p.state).toUpperCase() === 'CLOSED') {
      gh(['issue', 'unpin', String(p.number), '--repo', repo]);
    }
    // An OPEN pinned issue is left alone even if it fills the last slot — the
    // caller's `gh issue pin` below will throw, and that throw is the loud
    // failure this function exists to guarantee. Unpinning someone else's
    // live pinned issue to make room is not this feature's call to make.
  }
  gh(['issue', 'pin', String(issueNumber), '--repo', repo]);
  // Verify against the REAL field (`isPinned`, confirmed present on
  // `gh issue view --json`) — the pin call throwing on failure is the first
  // line of defense, but a verify-after-write closes the gap where `gh`
  // exits 0 without the pin actually having taken (e.g. a stale cache read).
  const verify = JSON.parse(
    gh(['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'isPinned']),
  );
  if (verify.isPinned !== true) {
    throw new Error(
      `compat-matrix-tracker: issue #${issueNumber} is NOT pinned after the pin call ` +
        `(repo: ${repo}) — GitHub's 3-pin cap may still be held by other OPEN pinned issues; ` +
        'this tracker never unpins an open issue automatically. Unpin one manually.',
    );
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('compat-matrix-tracker: GITHUB_REPOSITORY is required');
    process.exit(2);
  }
  const matrixFile = arg('--matrix-file', null);
  if (!matrixFile || !existsSync(matrixFile)) {
    console.error('compat-matrix-tracker: pass --matrix-file <path-to-json>');
    process.exit(2);
  }
  const matrix = JSON.parse(readFileSync(matrixFile, 'utf8'));

  // REVIEW FINDING 3 — refuse to publish a fetch-failure matrix. Publishing it
  // would read as "the credential program collapsed to zero" when the real
  // fault is more likely a permissions regression on THIS job.
  if (looksLikeFetchFailure(matrix)) {
    console.error(
      '::error::compat-matrix-tracker: every WIRED cell has zero graded nights or all-unresolved ' +
        'nights — this looks like a FETCH failure (e.g. missing `actions: read` on the job), not a ' +
        'real credential-program state. Refusing to publish a misleading tracker comment.',
    );
    process.exit(1);
  }

  const runUrl = arg('--run-url', undefined);
  const body = buildTrackerBody(matrix, { runUrl });

  // Ensure-first, same pattern as the credential-reset label: --force never
  // fails on an already-existing label, so this is safe to run every night.
  gh([
    'label',
    'create',
    TRACKER_LABEL,
    '--repo',
    repo,
    '--color',
    '0e8a16',
    '--description',
    'The one pinned v1.0 credential matrix tracker issue',
    '--force',
  ]);

  const existing = findTrackerIssue(gh, repo);

  let issueNumber = existing;
  if (existing) {
    console.log(`updating existing tracker issue #${existing}`);
    gh(['issue', 'comment', String(existing), '--repo', repo, '--body', body]);
  } else {
    console.log('creating the tracker issue');
    const newUrl = gh([
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      TRACKER_TITLE,
      '--body',
      body,
      '--label',
      TRACKER_LABEL,
    ]).trim();
    issueNumber = Number(newUrl.split('/').at(-1));
  }

  // Re-assert the pin every run, on BOTH branches: a human could have
  // accidentally unpinned it, and (finding 1) the pin slots could be held by
  // stale closed issues — this now fails the job rather than warning.
  ensurePinned(gh, repo, issueNumber);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
