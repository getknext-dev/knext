/**
 * Pure logic for #1304 ([v1.0 T13] soak): before rc.1 is cut, every WIRED
 * credential cell needs 3 consecutive green FIRST-ATTEMPT dispatches on the
 * frozen RC ref with bytecode caching live — otherwise the 14-night window
 * resets immediately on cut (jev 0.79 at filing). Exit criterion: an
 * evidence table (run ids per cell) posted on the issue.
 *
 * "First attempt" excludes any run manually re-run (`gh run rerun`,
 * `attempt > 1`) — a rerun is a materially weaker signal than a clean first
 * pass, and #1304's bar is explicit about first-attempt green.
 *
 * This module never calls `gh` or the network — see
 * `scripts/soak-1304-readiness.mjs` for the thin CLI wrapper that supplies
 * real run data once an RC tag exists.
 */

/** #1304's own exit bar: 3 consecutive green first-attempt nights per cell. */
export const SOAK_REQUIRED_STREAK = 3;

/**
 * @typedef {{ id: number, conclusion: string, attempt: number, createdAt: string }} CredentialRun
 */

/**
 * Evaluates ONE cell: are the most recent `requiredStreak` nights (sorted by
 * `createdAt`) ALL first-attempt (`attempt === 1`) and green
 * (`conclusion === 'success'`)? Any red or reran night inside that trailing
 * window fails the cell, however many total nights exist.
 *
 * @param {CredentialRun[]} runs
 * @param {number} [requiredStreak]
 * @returns {{ ready: boolean, reason?: string, evidence: CredentialRun[] }}
 */
export function evaluateCellReadiness(runs, requiredStreak = SOAK_REQUIRED_STREAK) {
  const sorted = [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  if (sorted.length < requiredStreak) {
    return {
      ready: false,
      reason: `only ${sorted.length} night(s) recorded, need ${requiredStreak}`,
      evidence: sorted,
    };
  }

  const window = sorted.slice(-requiredStreak);
  const mostRecent = window[window.length - 1];
  if (mostRecent.conclusion !== 'success') {
    return {
      ready: false,
      reason: `the most recent night (run ${mostRecent.id}) went red (${mostRecent.conclusion})`,
      evidence: window,
    };
  }

  const rerun = window.find((r) => r.attempt !== 1);
  if (rerun) {
    return {
      ready: false,
      reason: `run ${rerun.id} in the trailing window was a RERUN (attempt ${rerun.attempt}), not a clean first attempt`,
      evidence: window,
    };
  }

  const red = window.find((r) => r.conclusion !== 'success');
  if (red) {
    return {
      ready: false,
      reason: `run ${red.id} in the trailing window went red (${red.conclusion})`,
      evidence: window,
    };
  }

  return { ready: true, evidence: window };
}

/**
 * Evaluates every cell and builds the evidence-table markdown #1304 asks be
 * posted on the issue. An EMPTY cell map is never vacuously ready — a scan
 * that finds no cells has proven nothing.
 *
 * @param {Record<string, CredentialRun[]>} runsByCell
 * @param {number} [requiredStreak]
 */
export function evaluateSoakReadiness(runsByCell, requiredStreak = SOAK_REQUIRED_STREAK) {
  const cellNames = Object.keys(runsByCell);
  /** @type {Record<string, ReturnType<typeof evaluateCellReadiness>>} */
  const perCell = {};
  for (const cell of cellNames) {
    perCell[cell] = evaluateCellReadiness(runsByCell[cell], requiredStreak);
  }

  const overallReady = cellNames.length > 0 && cellNames.every((c) => perCell[c].ready);

  const rows = cellNames
    .sort()
    .map((cell) => {
      const r = perCell[cell];
      const runIds = r.evidence.map((e) => e.id).join(', ') || '(none)';
      return `| ${cell} | ${r.ready ? 'READY' : 'not ready'} | ${runIds} | ${r.reason ?? ''} |`;
    })
    .join('\n');
  const evidenceTableMarkdown = `| cell | status | run ids (trailing ${requiredStreak}) | reason |\n| --- | --- | --- | --- |\n${rows}`;

  return { overallReady, perCell, evidenceTableMarkdown };
}
