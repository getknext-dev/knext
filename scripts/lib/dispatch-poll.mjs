/**
 * Pure logic for `scripts/compat-shipped-pin-dispatch-and-wait.mjs` (#1376
 * option b, founder-approved 2026-09-25) — the shipped-pin early-warning
 * lane, which reuses `test-e2e-deploy.yml`'s real deploy-test harness
 * instead of duplicating it: it DISPATCHES that workflow (never a
 * `schedule` event, so `KNEXT_COMPAT_MODE` there is unconditionally
 * `early-warning` — never `credential`, by construction of code this lane
 * does not touch) and polls for the triggered run's outcome.
 *
 * Split from the CLI wrapper so the matching/timeout/red-detection logic is
 * unit-testable without a live `gh` call or a real GitHub Actions run —
 * mirrors why `scripts/lib/ci-blocking-gate-proof.mjs` exists separately
 * from its own CLI script.
 */

/**
 * `gh workflow run` does not return the dispatched run's id — GitHub's own
 * documented limitation. The standard workaround: snapshot the workflow's
 * recent runs BEFORE dispatching, dispatch, then poll the recent-runs list
 * AFTER until a `workflow_dispatch` run appears that was not in the
 * snapshot, on the same branch. Ties are broken by newest `createdAt` —
 * GitHub Actions run ids are not guaranteed monotonic across concurrent
 * dispatches, but createdAt is what humans reading a run list would use.
 *
 * @param {{databaseId:number}[]} runsBefore
 * @param {{databaseId:number,event:string,headBranch:string,createdAt:string}[]} runsAfter
 * @param {{headBranch:string}} opts
 * @returns {{databaseId:number}|null}
 */
export function pickDispatchedRun(runsBefore, runsAfter, opts) {
  const beforeIds = new Set(runsBefore.map((r) => r.databaseId));
  const candidates = runsAfter
    .filter(
      (r) =>
        !beforeIds.has(r.databaseId) &&
        r.event === 'workflow_dispatch' &&
        r.headBranch === opts.headBranch,
    )
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return candidates[0] ?? null;
}

/** A GitHub Actions run's `status` field reaches exactly one terminal value. */
export function isTerminalStatus(status) {
  return status === 'completed';
}

/**
 * A red conclusion — anything that is not an unambiguous pass. `success` and
 * `neutral` are the only ones treated as NOT red; everything else (including
 * an unrecognised future conclusion string) is red. Silence, or a shape this
 * function has never seen, must never read as green — the same principle
 * `scripts/compat-window-audit.mjs`'s disqualifier list already applies.
 */
export function isRedConclusion(conclusion) {
  return conclusion !== 'success' && conclusion !== 'neutral';
}

/**
 * The `nextjsRef` this lane dispatches with, derived from the manifest —
 * never a literal `scripts/*.mjs` hardcodes, so a future bump to
 * `shippedNextPin` (e.g. area-build's planned ≥16.3.5 move) is picked up
 * automatically, with no second place to remember to edit.
 *
 * @param {{shippedNextPin:string}} manifest
 */
export function shippedPinRef(manifest) {
  return `v${manifest.shippedNextPin}`;
}

/** The 4 real (non-turbopack-excluded) matrix cells this lane runs. Turbopack
 * is included as a REAL cell (not allowed-to-fail): #1372's Turbopack +
 * adapterPath + output:'standalone' regression is fixed upstream in
 * next@16.3.5, and area-build is moving the shipped pin to ≥16.3.5 before
 * 0.5.0, so both turbopack cells are expected to pass once that lands. */
export const SHIPPED_PIN_CELLS = Object.freeze([
  Object.freeze({ runtime: 'node', builder: 'turbopack' }),
  Object.freeze({ runtime: 'node', builder: 'webpack' }),
  Object.freeze({ runtime: 'bun', builder: 'turbopack' }),
  Object.freeze({ runtime: 'bun', builder: 'webpack' }),
]);
