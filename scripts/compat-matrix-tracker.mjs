#!/usr/bin/env node
/**
 * compat-matrix-tracker — the ONE pinned issue for the v1.0 credential matrix
 * (#1300, system-designer gate TD2).
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
 * Body-building is exported as a PURE function (`buildTrackerBody`) precisely
 * so it is unit-testable without `gh` or the network — `tests/compat-matrix-
 * tracker.test.ts` asserts its shape directly. The CLI at the bottom is the
 * thin, unavoidably-`gh`-shelling half.
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

  const existing = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title',
    '--jq',
    `[.[] | select(.title == "${TRACKER_TITLE}")][0].number // empty`,
  ]).trim();

  if (existing) {
    console.log(`updating existing tracker issue #${existing}`);
    gh(['issue', 'comment', existing, '--repo', repo, '--body', body]);
    // Re-assert the pin every run: a human could have accidentally unpinned
    // it, and a pin call on an already-pinned issue is a harmless no-op.
    try {
      gh(['issue', 'pin', existing, '--repo', repo]);
    } catch (err) {
      console.error(`::warning::could not (re)pin tracker issue #${existing}: ${err.message}`);
    }
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
    const newNum = newUrl.split('/').at(-1);
    gh(['issue', 'pin', newNum, '--repo', repo]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
