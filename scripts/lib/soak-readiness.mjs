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
 * Turns an `auditWindow()` result (`scripts/compat-window-audit.mjs`) into
 * the `CredentialRun[]` shape `evaluateCellReadiness` consumes (rev-1396
 * review). `auditWindow`'s own per-night grading is what actually supplies
 * the filtering the original CLI lacked — ADR-0056 rule 6 (credential mode +
 * a real RC-tag-shaped `knextRef`) and rule 7 (bytecode caching proven LIVE
 * per shard, for the cell's runtime) are already enforced there, and `lane`
 * scoping already restricts to the one runtime×builder cell. This function
 * adds exactly ONE thing `auditWindow` does not itself check: that a
 * night's `knextRef` matches the CURRENT `rcTag` (`expectedKnextRef`,
 * `refs/tags/<rcTag>`) — `isRcRef` only validates the SHAPE, so a stale
 * night from a PRIOR rc.N (before a bump) would otherwise still read as
 * valid evidence for the current one.
 *
 * `auditWindow`'s `nights` array is already ordered ascending by `runId`
 * (`selectLaneNights` sorts it), so `id` alone is enough for
 * `evaluateCellReadiness`'s ordering — `createdAt` is synthesised from the
 * numeric run id (a monotonic sort key, NOT a real timestamp; `gradeNight`
 * does not return one) purely so the shared sort-by-`createdAt` logic keeps
 * working unchanged.
 *
 * A night `auditWindow` already disqualified (red shards, a rerun, missing
 * bytecode-liveness, a non-credential ref, anything else rule 6/7 catch) OR
 * whose `knextRef` does not match `expectedKnextRef` maps to a RED run —
 * never silently dropped, so it correctly BREAKS a trailing streak rather
 * than being invisible to it.
 *
 * @param {{ nights: Array<{ runId: string, eligible: boolean, runAttempt: string, knextRef: string|null }> }} auditWindowResult
 * @param {string} expectedKnextRef
 * @returns {import('./soak-readiness.mjs').CredentialRun[]}
 */
export function deriveCellRunsFromWindow(auditWindowResult, expectedKnextRef) {
  const nights = auditWindowResult?.nights ?? [];
  return nights.map((n) => {
    const onCurrentRcTag = n.knextRef === expectedKnextRef;
    return {
      id: Number(n.runId),
      conclusion: n.eligible && onCurrentRcTag ? 'success' : 'failure',
      attempt: Number(n.runAttempt ?? 1),
      createdAt: new Date(Number(n.runId)).toISOString(),
    };
  });
}

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
