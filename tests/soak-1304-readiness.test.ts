import { describe, expect, it } from 'bun:test';
import { auditWindow } from '../scripts/compat-window-audit.mjs';
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
  const expectedNextjsRef = 'v16.2.0';

  function night(
    overrides: Partial<{
      runId: string;
      eligible: boolean;
      runAttempt: string;
      knextRef: string;
      ref: string;
    }>,
  ) {
    return {
      runId: '100',
      eligible: true,
      runAttempt: '1',
      knextRef: expectedKnextRef,
      ref: expectedNextjsRef,
      ...overrides,
    };
  }

  /**
   * `current.runIds` defaults to every night's own runId — i.e. "all these
   * nights sit inside the currently-open, fingerprint-stable streak" — so
   * tests unrelated to streak continuity are unaffected. Tests that DO
   * exercise the continuity requirement override it explicitly.
   */
  function windowResultOf(
    nights: ReturnType<typeof night>[],
    currentRunIds: string[] = nights.map((n) => n.runId),
  ) {
    return { nights, current: { runIds: currentRunIds } };
  }

  it('maps eligible nights on the CURRENT rcTag/Next ref, inside the current streak, to green first-attempt runs, in runId order', () => {
    const windowResult = windowResultOf([
      night({ runId: '1' }),
      night({ runId: '2' }),
      night({ runId: '3' }),
    ]);
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef, expectedNextjsRef);
    expect(runs.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(runs.every((r) => r.conclusion === 'success' && r.attempt === 1)).toBe(true);
  });

  it('a night `auditWindow` already disqualified (red/rerun/bytecode-not-live/etc) maps to a RED run, breaking the streak', () => {
    const windowResult = windowResultOf([
      night({ runId: '1' }),
      night({ runId: '2', eligible: false }),
      night({ runId: '3' }),
    ]);
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef, expectedNextjsRef);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('a STALE rc.1 night is treated as red once the pin has moved to rc.2 — closes the rev-1396 "RC tag bumped" gap', () => {
    const staleRef = 'refs/tags/v1.0.0-rc.1';
    const currentRef = 'refs/tags/v1.0.0-rc.2';
    // auditWindow's own rule 6 only checks the SHAPE (isRcRef), so a stale
    // rc.1 night is still `eligible: true` there — the equality check below
    // is what this module adds on top.
    const windowResult = windowResultOf([
      night({ runId: '1', knextRef: staleRef }),
      night({ runId: '2', knextRef: staleRef }),
      night({ runId: '3', knextRef: staleRef }),
    ]);
    const runs = deriveCellRunsFromWindow(windowResult, currentRef, expectedNextjsRef);
    expect(runs.every((r) => r.conclusion !== 'success')).toBe(true);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('a night tested against a STALE Next.js ref is treated as red, even on the current rcTag (#1396 round 2 finding 2)', () => {
    const staleNextjsRef = 'v16.1.0';
    const windowResult = windowResultOf([
      night({ runId: '1', ref: staleNextjsRef }),
      night({ runId: '2', ref: staleNextjsRef }),
      night({ runId: '3', ref: staleNextjsRef }),
    ]);
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef, expectedNextjsRef);
    expect(runs.every((r) => r.conclusion !== 'success')).toBe(true);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('refuses (throws) without an expectedNextjsRef — never silently skips the check', () => {
    const windowResult = windowResultOf([night({ runId: '1' })]);
    expect(() =>
      deriveCellRunsFromWindow(windowResult, expectedKnextRef, undefined as unknown as string),
    ).toThrow(/expectedNextjsRef/);
    expect(() => deriveCellRunsFromWindow(windowResult, expectedKnextRef, '')).toThrow(
      /expectedNextjsRef/,
    );
  });

  it('a night outside the CURRENT open streak (e.g. before a fingerprint restart) is treated as red, even if individually eligible (#1396 round 2 finding 1)', () => {
    // Nights 1 and 2 are individually eligible (green shards, right rcTag,
    // right Next ref) but sit BEFORE a fingerprint restart — `current`
    // (what auditWindow computes as the streak still running at the last
    // graded night) only contains night 3. Nights 1/2 must not count toward
    // the trailing-3 requirement even though nothing about THEM looks red.
    const windowResult = windowResultOf(
      [night({ runId: '1' }), night({ runId: '2' }), night({ runId: '3' })],
      ['3'], // only night 3 is in the current streak
    );
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef, expectedNextjsRef);
    expect(runs.find((r) => r.id === 1)?.conclusion).not.toBe('success');
    expect(runs.find((r) => r.id === 2)?.conclusion).not.toBe('success');
    expect(runs.find((r) => r.id === 3)?.conclusion).toBe('success');
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('a rerun (runAttempt !== "1") maps to attempt > 1, not silently normalised to 1', () => {
    const windowResult = windowResultOf([night({ runId: '1', runAttempt: '2' })]);
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef, expectedNextjsRef);
    expect(runs[0].attempt).toBe(2);
  });

  it('an empty window maps to an empty run list, never vacuously ready', () => {
    const runs = deriveCellRunsFromWindow(
      { nights: [], current: { runIds: [] } },
      expectedKnextRef,
      expectedNextjsRef,
    );
    expect(runs).toEqual([]);
    expect(evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK).ready).toBe(false);
  });

  it('end to end: 3 genuinely fresh, correctly-tagged, correctly-versioned, in-streak, bytecode-live nights are READY', () => {
    const windowResult = windowResultOf([
      night({ runId: '10' }),
      night({ runId: '11' }),
      night({ runId: '12' }),
    ]);
    const runs = deriveCellRunsFromWindow(windowResult, expectedKnextRef, expectedNextjsRef);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(true);
    expect(result.evidence.map((r) => r.id)).toEqual([10, 11, 12]);
  });
});

/**
 * #1396 round 2 — the two `deriveCellRunsFromWindow`-only fixtures above
 * hand-construct `windowResult.current`/`nights` directly, which proves the
 * function's OWN logic but never proves it against what the REAL
 * `auditWindow` actually produces. This describe block composes the two:
 * real ledgers -> real `auditWindow` -> `deriveCellRunsFromWindow` -> real
 * `evaluateCellReadiness`, covering exactly the two cases named in review —
 * a fingerprint change and a Next.js ref change — the same way
 * `tests/compat-window-audit.test.ts` builds its own ledger fixtures.
 */
describe('deriveCellRunsFromWindow, composed through the REAL auditWindow (#1396 round 2 finding 3)', () => {
  const RC_TAG_REF = 'refs/tags/v1.0.0-rc.1';
  const CREDENTIALED_NEXTJS_REF = 'v16.2.0';

  function liveBytecode(runtime: string) {
    return { runtime, deploys: 3, live: 3, notLive: 0, reasons: [] };
  }

  /** A green 16-shard node night, matching the real ledger shape (mirrors
   * tests/compat-window-audit.test.ts's own `night()` fixture). */
  function ledger(over: Record<string, unknown> = {}) {
    const shards = Array.from({ length: 16 }, (_, i) => ({
      shard: `${i + 1}/16`,
      passed: 49,
      failed: 0,
      notRun: 0,
      runtime: 'node',
      bytecode: liveBytecode('node'),
    }));
    return {
      runId: '90000000000',
      runAttempt: '1',
      event: 'schedule',
      lane: 'node',
      ref: CREDENTIALED_NEXTJS_REF,
      compatMode: 'credential',
      credential: true,
      knextRef: RC_TAG_REF,
      knextSha: 'a'.repeat(40),
      complete: true,
      shardsExpected: 16,
      shardsSeen: 16,
      missingShards: [],
      windowFingerprint: 'sha256:aaaa',
      shards,
      ...over,
    };
  }

  it('a fingerprint change mid-window means the trailing 3 nights are NOT ready until 3 nights accrue on the NEW fingerprint', () => {
    // 2 green nights on fingerprint A, then the fingerprint moves, then only
    // 2 green nights on fingerprint B. Every night individually looks
    // eligible; without the streak-continuity fix, 3 of these 4 (spanning
    // the fingerprint boundary) could read as a clean trailing streak.
    const ledgers = [
      ledger({ runId: '90000000001', windowFingerprint: 'sha256:aaaa' }),
      ledger({ runId: '90000000002', windowFingerprint: 'sha256:aaaa' }),
      ledger({ runId: '90000000003', windowFingerprint: 'sha256:bbbb' }),
      ledger({ runId: '90000000004', windowFingerprint: 'sha256:bbbb' }),
    ];
    const windowResult = auditWindow(ledgers, { lane: 'node', scope: 'credential' });
    const runs = deriveCellRunsFromWindow(windowResult, RC_TAG_REF, CREDENTIALED_NEXTJS_REF);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('is READY once 3 consecutive nights all share the SAME fingerprint (the current open streak)', () => {
    const ledgers = [
      ledger({ runId: '90000000001', windowFingerprint: 'sha256:aaaa' }),
      ledger({ runId: '90000000002', windowFingerprint: 'sha256:aaaa' }),
      ledger({ runId: '90000000003', windowFingerprint: 'sha256:aaaa' }),
    ];
    const windowResult = auditWindow(ledgers, { lane: 'node', scope: 'credential' });
    const runs = deriveCellRunsFromWindow(windowResult, RC_TAG_REF, CREDENTIALED_NEXTJS_REF);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(true);
    expect(result.evidence.map((r) => r.id)).toEqual([90000000001, 90000000002, 90000000003]);
  });

  it('a Next.js ref change means the trailing 3 nights are NOT ready — nights tested against the old ref are red', () => {
    // 3 consecutive, same-fingerprint, right-rcTag nights — but the FIRST
    // one was dispatched before a NEXTJS_REF bump, so it tested the wrong
    // version. auditWindow itself has no rule for this (it is scoped to
    // knextRef/credential-mode/bytecode-liveness, never to WHICH Next.js
    // ref was under test) — this is deriveCellRunsFromWindow's own check.
    const ledgers = [
      ledger({ runId: '90000000001', ref: 'v16.1.0' }),
      ledger({ runId: '90000000002', ref: CREDENTIALED_NEXTJS_REF }),
      ledger({ runId: '90000000003', ref: CREDENTIALED_NEXTJS_REF }),
    ];
    const windowResult = auditWindow(ledgers, { lane: 'node', scope: 'credential' });
    const runs = deriveCellRunsFromWindow(windowResult, RC_TAG_REF, CREDENTIALED_NEXTJS_REF);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(false);
  });

  it('is READY once all 3 trailing nights share BOTH the current fingerprint AND the credentialed Next.js ref', () => {
    const ledgers = [
      ledger({ runId: '90000000001' }),
      ledger({ runId: '90000000002' }),
      ledger({ runId: '90000000003' }),
    ];
    const windowResult = auditWindow(ledgers, { lane: 'node', scope: 'credential' });
    const runs = deriveCellRunsFromWindow(windowResult, RC_TAG_REF, CREDENTIALED_NEXTJS_REF);
    const result = evaluateCellReadiness(runs, SOAK_REQUIRED_STREAK);
    expect(result.ready).toBe(true);
  });
});
