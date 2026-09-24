import { describe, expect, it } from 'bun:test';
import {
  deriveCellRunsFromWindow,
  evaluateCellReadiness,
  evaluateSoakReadiness,
  SOAK_REQUIRED_STREAK,
} from '../scripts/lib/soak-readiness.mjs';

/**
 * #1304 ([v1.0 T13] soak): before rc.1 is cut, each of the WIRED credential
 * cells needs **3 consecutive green FIRST-ATTEMPT** dispatches on the frozen
 * RC ref with bytecode caching live — otherwise the 14-night window resets
 * immediately on cut. Exit: an evidence table (run ids per cell) posted on
 * the issue.
 *
 * This module is the PURE logic for turning a `gh run list`-shaped array of
 * credential-night runs per cell into a readiness verdict + evidence table —
 * unit-testable against fixtures, no live `gh` call. The CLI wrapper
 * (`scripts/soak-1304-readiness.mjs`) supplies the real runs once an RC tag
 * exists; per the standing task, THAT dispatch is deliberately not run yet
 * (the credentialed Next version may still move per #1376/#1307, and no RC
 * has been cut — `.github/compat-credential-ref.json`'s `rcTag` is `null`).
 *
 * "First attempt" excludes any run that was manually RE-RUN
 * (`gh run rerun`) — `attempt > 1` — because a rerun is not the same signal
 * as a clean first pass; #1304's bar is explicitly about first-attempt
 * green, not eventually-green.
 */

function run(
  overrides: Partial<{ id: number; conclusion: string; attempt: number; createdAt: string }>,
) {
  return {
    id: 1,
    conclusion: 'success',
    attempt: 1,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('evaluateCellReadiness — one cell, requires the LAST N consecutive nights all green first-attempt', () => {
  it('ready when the most recent 3 nights are all attempt=1, conclusion=success', () => {
    const runs = [
      run({ id: 1, createdAt: '2026-01-01T00:00:00Z' }),
      run({ id: 2, createdAt: '2026-01-02T00:00:00Z' }),
      run({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
    ];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(true);
    expect(result.evidence.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('not ready with fewer than 3 nights recorded at all', () => {
    const runs = [run({ id: 1 }), run({ id: 2 })];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/only 2/i);
  });

  it('not ready when the MOST RECENT night is red, even if an earlier 3-streak was green', () => {
    const runs = [
      run({ id: 1, createdAt: '2026-01-01T00:00:00Z' }),
      run({ id: 2, createdAt: '2026-01-02T00:00:00Z' }),
      run({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
      run({ id: 4, createdAt: '2026-01-04T00:00:00Z', conclusion: 'failure' }),
    ];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/most recent night.*red|red.*most recent/i);
  });

  it('not ready when a red night sits in the MIDDLE of the trailing window, even though the most recent night is green', () => {
    // success, failure, success — the mostRecent-only check alone would pass
    // this; the streak must be genuinely unbroken across the whole window.
    const runs = [
      run({ id: 1, createdAt: '2026-01-01T00:00:00Z' }),
      run({ id: 2, createdAt: '2026-01-02T00:00:00Z', conclusion: 'failure' }),
      run({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
    ];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/run 2.*red|red.*run 2/i);
  });

  it('not ready when a night in the trailing window was a RERUN (attempt > 1), even if it eventually went green', () => {
    const runs = [
      run({ id: 1, createdAt: '2026-01-01T00:00:00Z' }),
      run({ id: 2, createdAt: '2026-01-02T00:00:00Z', attempt: 2 }),
      run({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
    ];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/rerun|attempt/i);
  });

  it('a RERUN restarts the streak count going forward, even after it — never silently ignored', () => {
    // A reran night at position 2 means only night 3 is a clean trailing
    // record; with SOAK_REQUIRED_STREAK=3 there still are not 3 CONSECUTIVE
    // clean nights, so this must stay unready.
    const runs = [
      run({ id: 1, createdAt: '2026-01-01T00:00:00Z' }),
      run({ id: 2, createdAt: '2026-01-02T00:00:00Z', attempt: 2 }),
      run({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
      run({ id: 4, createdAt: '2026-01-04T00:00:00Z' }),
    ];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('IS ready once 3 clean consecutive nights accumulate strictly after a rerun', () => {
    const runs = [
      run({ id: 1, createdAt: '2026-01-01T00:00:00Z', attempt: 2 }),
      run({ id: 2, createdAt: '2026-01-02T00:00:00Z' }),
      run({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
      run({ id: 4, createdAt: '2026-01-04T00:00:00Z' }),
    ];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(true);
    expect(result.evidence.map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it('sorts by createdAt rather than trusting input order (defensive, since gh run list order is not contractual)', () => {
    const runs = [
      run({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
      run({ id: 1, createdAt: '2026-01-01T00:00:00Z' }),
      run({ id: 2, createdAt: '2026-01-02T00:00:00Z' }),
    ];
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(true);
    expect(result.evidence.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe('evaluateSoakReadiness — every WIRED cell, aggregate verdict + evidence table', () => {
  it('overall ready only when EVERY cell is individually ready', () => {
    const byCell = {
      node: [run({ id: 1 }), run({ id: 2 }), run({ id: 3 })],
      bun: [run({ id: 4 }), run({ id: 5 })], // only 2 — not ready
    };
    const result = evaluateSoakReadiness(byCell, SOAK_REQUIRED_STREAK);
    expect(result.overallReady).toBe(false);
    expect(result.perCell.node.ready).toBe(true);
    expect(result.perCell.bun.ready).toBe(false);
  });

  it('overall ready when every cell has its 3 clean consecutive nights', () => {
    const byCell = {
      node: [run({ id: 1 }), run({ id: 2 }), run({ id: 3 })],
      bun: [run({ id: 4 }), run({ id: 5 }), run({ id: 6 })],
    };
    const result = evaluateSoakReadiness(byCell, SOAK_REQUIRED_STREAK);
    expect(result.overallReady).toBe(true);
  });

  it('an empty cell set is NOT vacuously ready (non-vacuity, fail closed)', () => {
    const result = evaluateSoakReadiness({}, SOAK_REQUIRED_STREAK);
    expect(result.overallReady).toBe(false);
  });

  it('formats a markdown evidence table suitable for posting on the issue', () => {
    const byCell = {
      node: [run({ id: 101 }), run({ id: 102 }), run({ id: 103 })],
    };
    const result = evaluateSoakReadiness(byCell, SOAK_REQUIRED_STREAK);
    expect(result.evidenceTableMarkdown).toContain('| node |');
    expect(result.evidenceTableMarkdown).toContain('101');
    expect(result.evidenceTableMarkdown).toContain('102');
    expect(result.evidenceTableMarkdown).toContain('103');
  });
});

describe('SOAK_REQUIRED_STREAK', () => {
  it('is 3, per #1304 exit criteria', () => {
    expect(SOAK_REQUIRED_STREAK).toBe(3);
  });
});

/**
 * rev-1396 review: the CLI's original per-cell data source (`gh run list`
 * filtered only by workflow file) ignored the cell entirely — no filter on
 * runtime, builder, credential-vs-early-warning mode, or ref-vs-rcTag — and
 * `SOAK_SINCE_ISO` defaulted to the epoch, so pre-RC-cut runs could count.
 * "Bytecode LIVE" was never checked at all, yet the script printed READY.
 *
 * Fix: source cell/mode/ref/bytecode-liveness attribution from
 * `scripts/compat-window-audit.mjs`'s EXISTING, already-tested
 * `auditWindow` (built for exactly this — ADR-0056 rule 6 enforces
 * credential-mode + a real RC-tag-shaped `knextRef`; rule 7 enforces
 * bytecode-liveness per shard for the cell's runtime; `lane` scoping
 * enforces runtime+builder) rather than re-deriving any of that from raw
 * `gh run list` output. `deriveCellRunsFromWindow` is the small glue that
 * turns an `auditWindow()` result into the `CredentialRun[]` shape
 * `evaluateCellReadiness` already consumes — including the ONE thing
 * `auditWindow` does not itself enforce: that every night's `knextRef`
 * matches the CURRENT `rcTag` from the pin file, not just ANY RC-tag-shaped
 * ref (closing the "RC tag got bumped, stale rc.1 evidence still counts"
 * gap `SOAK_SINCE_ISO` was trying and failing to close).
 */
describe('deriveCellRunsFromWindow — sources cell readiness from the already-graded audit window', () => {
  const expectedKnextRef = 'refs/tags/v1.0.0-rc.1';

  function night(
    overrides: Partial<{ runId: string; eligible: boolean; runAttempt: string; knextRef: string }>,
  ) {
    return {
      runId: '100',
      eligible: true,
      runAttempt: '1',
      knextRef: expectedKnextRef,
      ...overrides,
    };
  }

  it('maps eligible nights on the CURRENT rcTag to green first-attempt runs, in runId order', () => {
    const windowResult = {
      nights: [night({ runId: '1' }), night({ runId: '2' }), night({ runId: '3' })],
    };
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef);
    expect(runs.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(runs.every((r) => r.conclusion === 'success' && r.attempt === 1)).toBe(true);
  });

  it('a night `auditWindow` already disqualified (red/rerun/bytecode-not-live/etc) maps to a RED run, breaking the streak', () => {
    const windowResult = {
      nights: [
        night({ runId: '1' }),
        night({ runId: '2', eligible: false }),
        night({ runId: '3' }),
      ],
    };
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('a STALE rc.1 night is treated as red once the pin has moved to rc.2 — closes the rev-1396 "RC tag bumped" gap', () => {
    const staleRef = 'refs/tags/v1.0.0-rc.1';
    const currentRef = 'refs/tags/v1.0.0-rc.2';
    // auditWindow's own rule 6 only checks the SHAPE (isRcRef), so a stale
    // rc.1 night is still `eligible: true` there — the equality check below
    // is what this module adds on top.
    const windowResult = {
      nights: [
        night({ runId: '1', knextRef: staleRef }),
        night({ runId: '2', knextRef: staleRef }),
        night({ runId: '3', knextRef: staleRef }),
      ],
    };
    const runs = deriveCellRunsFromWindow(windowResult, currentRef);
    expect(runs.every((r) => r.conclusion !== 'success')).toBe(true);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('a rerun (runAttempt !== "1") maps to attempt > 1, not silently normalised to 1', () => {
    const windowResult = { nights: [night({ runId: '1', runAttempt: '2' })] };
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef);
    expect(runs[0].attempt).toBe(2);
  });

  it('an empty window maps to an empty run list, never vacuously ready', () => {
    const runs = deriveCellRunsFromWindow({ nights: [] }, expectedKnextRef);
    expect(runs).toEqual([]);
    expect(evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK).ready).toBe(false);
  });

  it('end to end: 3 genuinely fresh, correctly-tagged, bytecode-live nights are READY', () => {
    const windowResult = {
      nights: [night({ runId: '10' }), night({ runId: '11' }), night({ runId: '12' })],
    };
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(true);
    expect(result.evidence.map((r) => r.id)).toEqual([10, 11, 12]);
  });
});
