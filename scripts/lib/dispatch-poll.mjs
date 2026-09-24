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
 * snapshot, on the same branch.
 *
 * rev-1382 finding 2: with NO dispatchId, "newest workflow_dispatch not seen
 * before" is a HEURISTIC — every leg of a fast fan-out (4 legs dispatched
 * within seconds, as `compat-shipped-pin-early-warning.yml` does) can latch
 * onto the SAME newest run, giving a false green/red for every leg but one.
 * Reproduced directly: with 4 concurrent candidates the heuristic picks
 * whichever is newest regardless of which leg is asking.
 *
 * When `opts.dispatchId` is a non-empty string, matching is EXACT and has NO
 * heuristic at all: the caller is expected to have set the dispatched
 * workflow's own `run-name:` to that exact dispatchId (see
 * `test-e2e-deploy.yml`'s `run-name:` and
 * `compat-shipped-pin-dispatch-and-wait.mjs`'s `DISPATCH_ID`), so the run
 * list's `displayTitle` is the ONLY signal consulted — `createdAt`/recency
 * plays no role, and a run that does not carry that exact title is never a
 * candidate, however new. No match -> null (fail closed), never a
 * best-effort fallback to the newest run.
 *
 * An EMPTY/absent dispatchId preserves the old recency-heuristic behaviour,
 * for callers (and the pre-existing test suite) that never adopted a
 * dispatchId.
 *
 * @param {{databaseId:number}[]} runsBefore
 * @param {{databaseId:number,event:string,headBranch:string,createdAt:string,displayTitle?:string}[]} runsAfter
 * @param {{headBranch:string, dispatchId?:string}} opts
 * @returns {{databaseId:number}|null}
 */
export function pickDispatchedRun(runsBefore, runsAfter, opts) {
  const beforeIds = new Set(runsBefore.map((r) => r.databaseId));
  const base = runsAfter.filter(
    (r) =>
      !beforeIds.has(r.databaseId) &&
      r.event === 'workflow_dispatch' &&
      r.headBranch === opts.headBranch,
  );

  if (opts.dispatchId) {
    const exact = base
      .filter((r) => r.displayTitle === opts.dispatchId)
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return exact[0] ?? null;
  }

  const candidates = base.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
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

/**
 * A bounded retry with exponential backoff, for a `gh` call that can fail
 * TRANSIENTLY (rate limit, a network blip) during the 90-minute poll loop
 * (rev-1382 review). Before this, ANY thrown error from `listRecentRuns`/
 * `viewRun` propagated straight out of `main()` and exited 1 — a one-off
 * blip was indistinguishable from a real credential/early-warning red.
 *
 * Deliberately NOT applied to the initial `gh workflow run` dispatch call —
 * retrying a dispatch that may have actually SUCCEEDED risks a duplicate
 * dispatch, a different failure mode than "wait longer to read a result".
 *
 * Gives up and RE-THROWS the last error once `attempts` is exhausted —
 * never silently swallowed. `sleep` is injected so this is unit-testable
 * without a real 90-minute wait.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastError;
  let currentDelay = delayMs;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(currentDelay);
      currentDelay *= 2;
    }
  }
  throw lastError;
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
