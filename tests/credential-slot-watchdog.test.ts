import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  attachExactLanes,
  evaluateWatchdog,
  fetchScheduledRuns,
} from '../scripts/credential-slot-watchdog.mjs';
import {
  anyLaneNeedsAlert,
  attributeRunsToLanes,
  computeExpectedSlots,
  DEFAULT_CREDENTIAL_LANES,
  DEFAULT_GRACE_HOURS,
  decideCredentialSlotVerdicts,
  detectAmbiguousAttribution,
  extractScheduleCrons,
  mostRecentSlotAtOrBefore,
  parseAllDeclaredSlots,
  parseSimpleDailyCron,
  resolveCredentialLaneCrons,
  resolveCredentialLanes,
} from '../scripts/lib/credential-slot-watchdog.mjs';

/**
 * #1640 — the missing-night alert for compat credential slots. See
 * `scripts/lib/credential-slot-watchdog.mjs`'s module header for the full
 * design rationale: fail-closed cron parsing, and exact-marker-first /
 * conservative-heuristic-fallback lane attribution (#1650 round 2).
 */

const REAL_WORKFLOW = readFileSync(
  new URL('../.github/workflows/test-e2e-deploy.yml', import.meta.url),
  'utf8',
);

// ── parseSimpleDailyCron ─────────────────────────────────────────────────────

describe('parseSimpleDailyCron', () => {
  it('parses a once-daily "M H * * *" cron', () => {
    expect(parseSimpleDailyCron('17 1 * * *')).toEqual({ minute: 17, hour: 1 });
  });

  it('rejects a cron with a non-daily field (e.g. every 5 minutes)', () => {
    expect(() => parseSimpleDailyCron('*/5 * * * *')).toThrow(/not a supported/);
  });

  it('rejects an out-of-range hour/minute', () => {
    expect(() => parseSimpleDailyCron('99 1 * * *')).toThrow(/out-of-range/);
    expect(() => parseSimpleDailyCron('1 99 * * *')).toThrow(/out-of-range/);
  });
});

// ── extractScheduleCrons / resolveCredentialLaneCrons against the REAL file ──

describe('resolveCredentialLaneCrons against the real test-e2e-deploy.yml', () => {
  it('extracts all 6 declared schedule crons', () => {
    const crons = extractScheduleCrons(REAL_WORKFLOW);
    expect(crons).toEqual([
      '17 3 * * *',
      '47 4 * * *',
      '17 1 * * *',
      '47 5 * * *',
      '17 22 * * *',
      '47 23 * * *',
    ]);
  });

  it('resolves exactly the 4 credential lanes, matching DEFAULT_CREDENTIAL_LANES', () => {
    const lanes = resolveCredentialLaneCrons(REAL_WORKFLOW);
    const stripped = lanes.map(({ cron, lane, hour, minute }) => ({ cron, lane, hour, minute }));
    expect(stripped).toEqual(DEFAULT_CREDENTIAL_LANES.map((l) => ({ ...l })));
  });

  it('never includes an early-warning cron (17 3 / 47 4) as a credential lane', () => {
    const lanes = resolveCredentialLaneCrons(REAL_WORKFLOW);
    const crons = lanes.map((l) => l.cron);
    expect(crons).not.toContain('17 3 * * *');
    expect(crons).not.toContain('47 4 * * *');
  });
});

// ── resolveCredentialLanes — FAILS CLOSED (#1650 round 2, finding 1) ────────

describe('resolveCredentialLanes — fails closed on a parse failure', () => {
  it('uses live parsing against real input and does not throw', () => {
    expect(() => resolveCredentialLanes(REAL_WORKFLOW)).not.toThrow();
    const lanes = resolveCredentialLanes(REAL_WORKFLOW);
    const stripped = lanes.map(({ cron, lane, hour, minute }) => ({ cron, lane, hour, minute }));
    expect(stripped).toEqual(DEFAULT_CREDENTIAL_LANES.map((l) => ({ ...l })));
  });

  it('THROWS — never silently substitutes DEFAULT_CREDENTIAL_LANES — on unparseable input', () => {
    expect(() => resolveCredentialLanes('not: a\nworkflow: file\n')).toThrow(/cannot read slots/);
  });

  it('the thrown error wraps the underlying parse failure reason', () => {
    expect(() => resolveCredentialLanes('not: a\nworkflow: file\n')).toThrow(
      /no `schedule:` key found/,
    );
  });

  it('attaches graceHours to every resolved lane', () => {
    const lanes = resolveCredentialLanes(REAL_WORKFLOW, { defaultGraceHours: 12 });
    expect(lanes.every((l) => l.graceHours === 12)).toBe(true);
  });

  it('defaults graceHours to DEFAULT_GRACE_HOURS when unspecified', () => {
    const lanes = resolveCredentialLanes(REAL_WORKFLOW);
    expect(lanes.every((l) => l.graceHours === DEFAULT_GRACE_HOURS)).toBe(true);
    expect(DEFAULT_GRACE_HOURS).toBe(8);
  });
});

// ── mostRecentSlotAtOrBefore / computeExpectedSlots ─────────────────────────

describe('mostRecentSlotAtOrBefore', () => {
  it("returns today's slot when the slot time has already passed today", () => {
    const now = new Date('2026-09-29T10:00:00Z');
    expect(mostRecentSlotAtOrBefore(1, 17, now).toISOString()).toBe('2026-09-29T01:17:00.000Z');
  });

  it("returns yesterday's slot when today's slot has not happened yet", () => {
    const now = new Date('2026-09-29T00:30:00Z');
    expect(mostRecentSlotAtOrBefore(1, 17, now).toISOString()).toBe('2026-09-28T01:17:00.000Z');
  });

  it('is exact at the slot boundary itself (inclusive)', () => {
    const now = new Date('2026-09-29T01:17:00Z');
    expect(mostRecentSlotAtOrBefore(1, 17, now).toISOString()).toBe('2026-09-29T01:17:00.000Z');
  });
});

// ── attributeRunsToLanes — basic mechanics (heuristic path, non-ambiguous) ──

const ALL_SLOTS = parseAllDeclaredSlots(REAL_WORKFLOW);

describe('attributeRunsToLanes', () => {
  // Every lane's own current-cycle slot lands the SAME UTC day at this `now`
  // (chosen deliberately — see the "cross-lane masking" describe block below
  // for why that matters): node 01:17, bun 05:47, node-webpack 22:17,
  // bun-webpack 23:47, all 2026-09-29.
  const now = new Date('2026-09-29T23:50:00Z');
  const lanes = computeExpectedSlots(resolveCredentialLanes(REAL_WORKFLOW), now);

  /** Every lane's own clean, on-time run at `now`'s cycle — a realistic night where nothing is wrong. */
  function allLanesOnTime() {
    return [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T05:48:00Z',
        run_started_at: '2026-09-29T05:49:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T22:18:00Z',
        run_started_at: '2026-09-29T22:19:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T23:48:00Z',
        run_started_at: '2026-09-29T23:49:00Z',
      },
    ];
  }

  it('attributes an on-time run to its own lane when every lane has its own evidence', () => {
    const { attributed, ambiguousLanes } = attributeRunsToLanes(allLanesOnTime(), lanes, ALL_SLOTS);
    expect(attributed).toEqual([
      {
        lane: 'node',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
      {
        lane: 'bun',
        status: 'completed',
        created_at: '2026-09-29T05:48:00Z',
        run_started_at: '2026-09-29T05:49:00Z',
      },
      {
        lane: 'node-webpack',
        status: 'completed',
        created_at: '2026-09-29T22:18:00Z',
        run_started_at: '2026-09-29T22:19:00Z',
      },
      {
        lane: 'bun-webpack',
        status: 'completed',
        created_at: '2026-09-29T23:48:00Z',
        run_started_at: '2026-09-29T23:49:00Z',
      },
    ]);
    expect(ambiguousLanes.size).toBe(0);
  });

  it('attributes a LATE run (still nearest to its own slot) to the right lane', () => {
    // bun credential slot is 05:47; a run created at 12:00 (the #1640 example)
    // is nearest to 05:47 among all declared slots, and 12:00 is well outside
    // bun's predecessor's (node, 01:17) own 8h grace window (deadline 09:17) —
    // so this is unambiguous even in isolation.
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T12:00:00Z',
        run_started_at: '2026-09-29T12:05:00Z',
      },
    ];
    const { attributed, ambiguousLanes } = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(attributed.map((r) => r.lane)).toEqual(['bun']);
    expect(ambiguousLanes.size).toBe(0);
  });

  it('does NOT attribute an early-warning-only run (03:17/04:47) to any credential lane', () => {
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T03:18:00Z',
        run_started_at: '2026-09-29T03:19:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T04:48:00Z',
        run_started_at: '2026-09-29T04:49:00Z',
      },
    ];
    const { attributed, ambiguousLanes } = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(attributed).toEqual([]);
    expect(ambiguousLanes.size).toBe(0);
  });

  it('ignores non-schedule events', () => {
    // Timed at bun's slot + 13m (the same UNAMBIGUOUS-even-in-isolation
    // timing the "LATE run" test above uses — see its comment): if the
    // event-type filter were defeated, this run would otherwise attribute
    // cleanly to 'bun' with nothing else (no ambiguity check) masking the
    // difference, so the filter's own necessity is provable.
    const runs = [
      {
        event: 'workflow_dispatch',
        status: 'completed',
        created_at: '2026-09-29T12:00:00Z',
        run_started_at: '2026-09-29T12:05:00Z',
      },
    ];
    expect(attributeRunsToLanes(runs, lanes, ALL_SLOTS).attributed).toEqual([]);
  });

  it("does not attribute a STALE run from a previous day's slot to today's cycle", () => {
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-27T01:18:00Z',
        run_started_at: '2026-09-27T01:19:00Z',
      },
    ];
    expect(attributeRunsToLanes(runs, lanes, ALL_SLOTS).attributed).toEqual([]);
  });

  it("flags an on-time run as AMBIGUOUS (not silently attributed) in isolation, when it falls inside a neighbouring lane's grace window with no evidence of its own", () => {
    // node's run alone, with no other lane's evidence present at all — the
    // exact scenario the old heuristic would have quietly trusted.
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
    ];
    const { attributed, ambiguousLanes } = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(attributed).toEqual([]);
    expect(ambiguousLanes).toEqual(new Set(['node', 'bun-webpack']));
  });
});

// ── detectAmbiguousAttribution — cross-lane masking (#1650 round 2, finding 2) ──
//
// Real cron literals: node 01:17, bun 05:47, node-webpack 22:17, bun-webpack
// 23:47 UTC. `now` is chosen so every lane's current-cycle slot falls the
// SAME UTC day, giving clean adjacency: node -> bun (gap 4.5h) -> node-webpack
// (gap 16.5h) -> bun-webpack (gap 1.5h) -> node next day (gap 1.5h, wrap).
// 3 of these 4 gaps are under the 8h default grace — exactly the review's
// finding. Each AT-RISK pair gets both halves: ambiguous when the
// predecessor has no evidence, clean when it does. The one SAFE pair
// (node-webpack's predecessor bun, 16.5h gap) gets a control proving it is
// never ambiguous even with no predecessor evidence at all.

describe('detectAmbiguousAttribution — cross-lane masking, each adjacent pair', () => {
  const now = new Date('2026-09-29T23:50:00Z');
  const lanes = computeExpectedSlots(resolveCredentialLanes(REAL_WORKFLOW), now);

  // Pair: bun-webpack <- node-webpack (gap 1.5h, AT RISK)
  it('bun-webpack <- node-webpack: ambiguous when node-webpack has no evidence of its own', () => {
    const runs = [
      {
        lane: 'bun-webpack',
        status: 'completed',
        created_at: '2026-09-29T23:50:00Z',
        run_started_at: '2026-09-29T23:51:00Z',
      },
    ];
    const { kept, ambiguousLanes } = detectAmbiguousAttribution(runs, lanes);
    expect(kept).toEqual([]);
    expect(ambiguousLanes).toEqual(new Set(['bun-webpack', 'node-webpack']));
  });

  // Pair: bun <- node (gap 4.5h, AT RISK)
  it('bun <- node: ambiguous when node has no evidence of its own', () => {
    const runs = [
      {
        lane: 'bun',
        status: 'completed',
        created_at: '2026-09-29T05:50:00Z',
        run_started_at: '2026-09-29T05:51:00Z',
      },
    ];
    const { kept, ambiguousLanes } = detectAmbiguousAttribution(runs, lanes);
    expect(kept).toEqual([]);
    expect(ambiguousLanes).toEqual(new Set(['bun', 'node']));
  });

  // Pair: node <- bun-webpack (PREVIOUS day, gap 1.5h, AT RISK — the wraparound case)
  it('node <- bun-webpack (previous day): ambiguous when bun-webpack has no evidence of its own', () => {
    const runs = [
      {
        lane: 'node',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
    ];
    const { kept, ambiguousLanes } = detectAmbiguousAttribution(runs, lanes);
    expect(kept).toEqual([]);
    expect(ambiguousLanes).toEqual(new Set(['node', 'bun-webpack']));
  });

  it('node <- bun-webpack (previous day): clean when bun-webpack has its own independent evidence', () => {
    const runs = [
      {
        lane: 'node',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
      // The previous day's bun-webpack run — its OWN evidence, not today's.
      {
        lane: 'bun-webpack',
        status: 'completed',
        created_at: '2026-09-28T23:48:00Z',
        run_started_at: '2026-09-28T23:49:00Z',
      },
    ];
    const { kept, ambiguousLanes } = detectAmbiguousAttribution(runs, lanes);
    expect(kept).toEqual(runs);
    expect(ambiguousLanes.size).toBe(0);
  });

  // Pair: node-webpack <- bun (gap 16.5h, SAFE — control)
  it('node-webpack <- bun (16.5h gap): NEVER ambiguous, even with no predecessor evidence at all', () => {
    const runs = [
      {
        lane: 'node-webpack',
        status: 'completed',
        created_at: '2026-09-29T22:18:00Z',
        run_started_at: '2026-09-29T22:19:00Z',
      },
    ];
    const { kept, ambiguousLanes } = detectAmbiguousAttribution(runs, lanes);
    expect(kept).toEqual(runs);
    expect(ambiguousLanes.size).toBe(0);
  });

  // NOTE on "clean when the neighbour has its OWN evidence": the 3 at-risk
  // pairs above chain (bun needs node; node needs bun-webpack; bun-webpack
  // needs node-webpack), so isolating just one pair's "clean" half with a
  // 2-run fixture only works when the chosen lane's OWN predecessor is
  // ALSO independently covered. Rather than hand-picking fragile fixtures
  // per pair, the "every lane clean at once" case right below covers every
  // pair's clean half at once, exactly as a real healthy night would.
  it('every lane clean at once: a fully healthy night is never ambiguous on any pair', () => {
    const runs = [
      {
        lane: 'node',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
      {
        lane: 'bun',
        status: 'completed',
        created_at: '2026-09-29T05:48:00Z',
        run_started_at: '2026-09-29T05:49:00Z',
      },
      {
        lane: 'node-webpack',
        status: 'completed',
        created_at: '2026-09-29T22:18:00Z',
        run_started_at: '2026-09-29T22:19:00Z',
      },
      {
        lane: 'bun-webpack',
        status: 'completed',
        created_at: '2026-09-29T23:48:00Z',
        run_started_at: '2026-09-29T23:49:00Z',
      },
    ];
    const { kept, ambiguousLanes } = detectAmbiguousAttribution(runs, lanes);
    expect(kept).toEqual(runs);
    expect(ambiguousLanes.size).toBe(0);
  });
});

// ── attributeRunsToLanes — exact-marker signal (#1650 round 2, finding 2) ───

describe('attributeRunsToLanes — exact-marker signal takes priority over the heuristic', () => {
  const now = new Date('2026-09-29T23:50:00Z');
  const lanes = computeExpectedSlots(resolveCredentialLanes(REAL_WORKFLOW), now);

  it('attributes a same-cycle exact-marker run to its declared lane, overriding what the nearest-slot heuristic would have guessed', () => {
    // The nearest declared slot before this created_at is bun-webpack's
    // (23:47) — the heuristic would guess bun-webpack. The exact marker says
    // this is really node-webpack's very-late run; ground truth wins.
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T23:50:00Z',
        run_started_at: '2026-09-29T23:51:00Z',
        exactLane: 'node-webpack',
      },
    ];
    const { attributed, ambiguousLanes } = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(attributed).toEqual([
      {
        lane: 'node-webpack',
        status: 'completed',
        created_at: '2026-09-29T23:50:00Z',
        run_started_at: '2026-09-29T23:51:00Z',
      },
    ]);
    expect(ambiguousLanes.size).toBe(0);
  });

  it('never triggers ambiguity for a neighbouring lane: the exact path bypasses the heuristic (and its ambiguity check) entirely', () => {
    // Same timing as the "bun-webpack <- node-webpack: ambiguous" case above
    // — but WITH an exact marker, it must not be dropped or flag anything.
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T23:50:00Z',
        run_started_at: '2026-09-29T23:51:00Z',
        exactLane: 'bun-webpack',
      },
    ];
    const { attributed, ambiguousLanes } = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(attributed.map((r) => r.lane)).toEqual(['bun-webpack']);
    expect(ambiguousLanes.size).toBe(0);
  });

  it('rejects a STALE exact-marker run (previous cycle) even though the lane name matches', () => {
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-27T01:18:00Z',
        run_started_at: '2026-09-27T01:19:00Z',
        exactLane: 'node',
      },
    ];
    expect(attributeRunsToLanes(runs, lanes, ALL_SLOTS).attributed).toEqual([]);
  });

  it('ignores an exactLane naming an unknown lane and falls through to nothing (never crashes)', () => {
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
        exactLane: 'some-future-lane-not-yet-declared',
      },
    ];
    const { attributed } = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    // Falls through to the nearest-slot heuristic (unknown exactLane is
    // treated the same as no exactLane at all) — attributed to 'node' by
    // time, and NOT ambiguous since node's predecessor is absent entirely
    // from this single-run fixture... reproduced explicitly:
    expect(attributed).toEqual([]); // ambiguous in isolation, same as the plain-heuristic case
  });
});

// ── attachExactLanes (CLI layer) ─────────────────────────────────────────────

describe('attachExactLanes', () => {
  it('resolves exactLane from the marker artifacts when the mode marker reads credential', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return JSON.stringify({
        total_count: 2,
        artifacts: [{ name: 'compat-lane-bun' }, { name: 'compat-mode-credential' }],
      });
    };
    const runs = [
      { id: 42, event: 'schedule', status: 'completed', created_at: 'x', run_started_at: 'y' },
    ];
    const out = attachExactLanes(gh, runs);
    expect(out[0].exactLane).toBe('bun');
    expect(calls).toHaveLength(1);
    expect(calls[0].join(' ')).toContain('runs/42/artifacts');
  });

  it('does NOT trust the lane marker when the mode marker reads early-warning (same lane names as credential nights)', () => {
    const gh = () =>
      JSON.stringify({
        total_count: 2,
        artifacts: [{ name: 'compat-lane-bun' }, { name: 'compat-mode-early-warning' }],
      });
    const runs = [
      { id: 7, event: 'schedule', status: 'completed', created_at: 'x', run_started_at: null },
    ];
    const out = attachExactLanes(gh, runs);
    expect(out[0].exactLane).toBeNull();
  });

  it('does NOT trust the lane marker when the mode marker is missing/ambiguous', () => {
    const gh = () => JSON.stringify({ total_count: 1, artifacts: [{ name: 'compat-lane-bun' }] });
    const runs = [
      { id: 7, event: 'schedule', status: 'completed', created_at: 'x', run_started_at: null },
    ];
    const out = attachExactLanes(gh, runs);
    expect(out[0].exactLane).toBeNull();
  });

  it('degrades to no exact signal (run unchanged) when the artifacts call throws', () => {
    const gh = () => {
      throw new Error('network down');
    };
    const runs = [
      { id: 7, event: 'schedule', status: 'completed', created_at: 'x', run_started_at: null },
    ];
    const out = attachExactLanes(gh, runs);
    expect(out[0]).toEqual(runs[0]);
  });

  it('never calls gh for a non-schedule run', () => {
    const gh = mock(() => JSON.stringify({ total_count: 0, artifacts: [] }));
    const runs = [
      {
        id: 7,
        event: 'workflow_dispatch',
        status: 'completed',
        created_at: 'x',
        run_started_at: null,
      },
    ];
    const out = attachExactLanes(gh, runs);
    expect(gh).not.toHaveBeenCalled();
    expect(out[0]).toEqual(runs[0]);
  });

  it('never calls gh for a run with no id', () => {
    const gh = mock(() => JSON.stringify({ total_count: 0, artifacts: [] }));
    const runs = [
      { event: 'schedule', status: 'completed', created_at: 'x', run_started_at: null },
    ];
    attachExactLanes(gh, runs);
    expect(gh).not.toHaveBeenCalled();
  });
});

// ── decideCredentialSlotVerdicts (the pure decision function; mutation-proved) ──

describe('decideCredentialSlotVerdicts', () => {
  const laneDef = { lane: 'bun', expectedSlotTime: '2026-09-29T05:47:00.000Z', graceHours: 8 };

  it('alerts "missing" — no run since the slot, grace elapsed', () => {
    const now = new Date('2026-09-29T14:00:00Z'); // slot + 8h15m
    const [verdict] = decideCredentialSlotVerdicts({ lanes: [laneDef], runs: [], now });
    expect(verdict.verdict).toBe('missing');
    expect(verdict.lane).toBe('bun');
  });

  it('alerts "queued-too-long" — a run exists but has not started, grace elapsed', () => {
    const now = new Date('2026-09-29T14:00:00Z');
    const runs = [
      { lane: 'bun', status: 'queued', created_at: '2026-09-29T13:50:00Z', run_started_at: null },
    ];
    const [verdict] = decideCredentialSlotVerdicts({ lanes: [laneDef], runs, now });
    expect(verdict.verdict).toBe('queued-too-long');
  });

  it('stays "quiet" — the run started on time', () => {
    const now = new Date('2026-09-29T06:00:00Z');
    const runs = [
      {
        lane: 'bun',
        status: 'completed',
        created_at: '2026-09-29T05:48:00Z',
        run_started_at: '2026-09-29T05:49:00Z',
      },
    ];
    const [verdict] = decideCredentialSlotVerdicts({ lanes: [laneDef], runs, now });
    expect(verdict.verdict).toBe('quiet');
  });

  it('stays "quiet" — no run yet, but the grace window has not elapsed', () => {
    const now = new Date('2026-09-29T07:00:00Z'); // slot + 1h13m, well within 8h grace
    const [verdict] = decideCredentialSlotVerdicts({ lanes: [laneDef], runs: [], now });
    expect(verdict.verdict).toBe('quiet');
  });

  it('stays "quiet" — a run is queued, but the grace window has not elapsed', () => {
    const now = new Date('2026-09-29T07:00:00Z');
    const runs = [
      { lane: 'bun', status: 'queued', created_at: '2026-09-29T05:50:00Z', run_started_at: null },
    ];
    const [verdict] = decideCredentialSlotVerdicts({ lanes: [laneDef], runs, now });
    expect(verdict.verdict).toBe('quiet');
  });

  it('stays "quiet" — the run already completed (resolved), even long after the slot', () => {
    const now = new Date('2026-09-30T05:47:00Z'); // 24h later
    const runs = [
      {
        lane: 'bun',
        status: 'completed',
        created_at: '2026-09-29T12:00:00Z',
        run_started_at: '2026-09-29T12:05:00Z',
      },
    ];
    const [verdict] = decideCredentialSlotVerdicts({ lanes: [laneDef], runs, now });
    expect(verdict.verdict).toBe('quiet');
  });

  it('is exact at the grace boundary — one second before is quiet, at/after is an alert', () => {
    const slot = new Date('2026-09-29T05:47:00.000Z').getTime();
    const deadline = slot + 8 * 60 * 60 * 1000;
    const justBefore = new Date(deadline - 1000);
    const atDeadline = new Date(deadline);
    const beforeVerdict = decideCredentialSlotVerdicts({
      lanes: [laneDef],
      runs: [],
      now: justBefore,
    })[0];
    const atVerdict = decideCredentialSlotVerdicts({
      lanes: [laneDef],
      runs: [],
      now: atDeadline,
    })[0];
    expect(beforeVerdict.verdict).toBe('quiet');
    expect(atVerdict.verdict).toBe('missing');
  });

  it('decides multiple lanes independently in one call', () => {
    const now = new Date('2026-09-29T14:00:00Z');
    const lanes = [
      { lane: 'node', expectedSlotTime: '2026-09-29T01:17:00.000Z', graceHours: 8 },
      { lane: 'bun', expectedSlotTime: '2026-09-29T05:47:00.000Z', graceHours: 8 },
    ];
    const runs = [
      {
        lane: 'node',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
    ];
    const verdicts = decideCredentialSlotVerdicts({ lanes, runs, now });
    expect(verdicts.find((v) => v.lane === 'node')?.verdict).toBe('quiet');
    expect(verdicts.find((v) => v.lane === 'bun')?.verdict).toBe('missing');
  });
});

describe('decideCredentialSlotVerdicts — "ambiguous" verdict (#1650 round 2, finding 2)', () => {
  const laneDef = {
    lane: 'bun-webpack',
    expectedSlotTime: '2026-09-29T23:47:00.000Z',
    graceHours: 8,
  };

  it('alerts "ambiguous" when this lane is flagged, no run, and grace has elapsed', () => {
    const now = new Date('2026-09-30T08:00:00Z'); // slot + 8h13m
    const [verdict] = decideCredentialSlotVerdicts({
      lanes: [laneDef],
      runs: [],
      now,
      ambiguousLanes: new Set(['bun-webpack']),
    });
    expect(verdict.verdict).toBe('ambiguous');
    expect(verdict.reason).toMatch(/neighbouring lane/);
  });

  it('stays "quiet" (not ambiguous) before the grace window elapses, even if flagged', () => {
    const now = new Date('2026-09-30T00:00:00Z'); // well within grace
    const [verdict] = decideCredentialSlotVerdicts({
      lanes: [laneDef],
      runs: [],
      now,
      ambiguousLanes: new Set(['bun-webpack']),
    });
    expect(verdict.verdict).toBe('quiet');
  });

  it('does not leak an ambiguity flag onto an unrelated lane', () => {
    const now = new Date('2026-09-30T08:00:00Z');
    const [verdict] = decideCredentialSlotVerdicts({
      lanes: [laneDef],
      runs: [],
      now,
      ambiguousLanes: new Set(['node']),
    });
    expect(verdict.verdict).toBe('missing');
  });

  it('a real (even if unresolved) run for this lane still wins — "queued-too-long", not "ambiguous"', () => {
    const now = new Date('2026-09-30T08:00:00Z');
    const runs = [
      {
        lane: 'bun-webpack',
        status: 'queued',
        created_at: '2026-09-29T23:50:00Z',
        run_started_at: null,
      },
    ];
    const [verdict] = decideCredentialSlotVerdicts({
      lanes: [laneDef],
      runs,
      now,
      ambiguousLanes: new Set(['bun-webpack']),
    });
    expect(verdict.verdict).toBe('queued-too-long');
  });

  it('defaults ambiguousLanes to empty when omitted (backward compatible)', () => {
    const now = new Date('2026-09-30T08:00:00Z');
    const [verdict] = decideCredentialSlotVerdicts({ lanes: [laneDef], runs: [], now });
    expect(verdict.verdict).toBe('missing');
  });
});

describe('anyLaneNeedsAlert', () => {
  it('is true if any verdict is not quiet', () => {
    expect(anyLaneNeedsAlert([{ verdict: 'quiet' }, { verdict: 'missing' }])).toBe(true);
  });
  it('treats "ambiguous" as needing an alert too', () => {
    expect(anyLaneNeedsAlert([{ verdict: 'ambiguous' }])).toBe(true);
  });
  it('is false when every verdict is quiet', () => {
    expect(anyLaneNeedsAlert([{ verdict: 'quiet' }, { verdict: 'quiet' }])).toBe(false);
  });
  it('is false for an empty lane list', () => {
    expect(anyLaneNeedsAlert([])).toBe(false);
  });
});

// ── fetchScheduledRuns / evaluateWatchdog — offline, injected `gh` ──────────

function fakeGh(workflowRuns: unknown[]) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'api')
      return JSON.stringify({ total_count: workflowRuns.length, workflow_runs: workflowRuns });
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

describe('fetchScheduledRuns', () => {
  it('calls the workflow-runs API with event=schedule and maps the fields the decision layer needs', () => {
    const { gh, calls } = fakeGh([
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
        html_url: 'https://x',
      },
    ]);
    const runs = fetchScheduledRuns(gh);
    expect(runs).toEqual([
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
        html_url: 'https://x',
      },
    ]);
    const apiCall = calls[0].join(' ');
    expect(apiCall).toContain('actions/workflows/test-e2e-deploy.yml/runs');
    expect(apiCall).toContain('event=schedule');
  });

  it("propagates each run's numeric id, for the artifact-marker lookup", () => {
    const { gh } = fakeGh([
      {
        id: 123456,
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
        html_url: 'https://x',
      },
    ]);
    const [run] = fetchScheduledRuns(gh);
    expect(run.id).toBe(123456);
  });

  it('is read-only: it never calls gh with a mutating subcommand', () => {
    const { gh, calls } = fakeGh([]);
    fetchScheduledRuns(gh);
    for (const call of calls) {
      expect(call[0]).toBe('api');
    }
  });

  it('tolerates a missing run_started_at (still queued)', () => {
    const { gh } = fakeGh([
      {
        event: 'schedule',
        status: 'queued',
        created_at: '2026-09-29T05:50:00Z',
        run_started_at: null,
        html_url: 'https://x',
      },
    ]);
    const [run] = fetchScheduledRuns(gh);
    expect(run.run_started_at).toBeNull();
  });
});

describe('evaluateWatchdog — end to end, offline', () => {
  it('reports "missing" when the runs list is empty and grace has elapsed', () => {
    const { gh } = fakeGh([]);
    const now = new Date('2026-09-29T20:00:00Z'); // every credential slot's +8h has passed
    const verdicts = evaluateWatchdog({ workflowYamlText: REAL_WORKFLOW, gh, now, graceHours: 8 });
    expect(verdicts).toHaveLength(4);
    expect(anyLaneNeedsAlert(verdicts)).toBe(true);
    expect(verdicts.find((v) => v.lane === 'node')?.verdict).toBe('missing');
  });

  it('is fully quiet when every lane ran on time', () => {
    const { gh } = fakeGh([
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T05:48:00Z',
        run_started_at: '2026-09-29T05:49:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T22:18:00Z',
        run_started_at: '2026-09-29T22:19:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T23:48:00Z',
        run_started_at: '2026-09-29T23:49:00Z',
      },
    ]);
    // Same UTC day as every run above, so none of the 4 lanes' expected slots
    // have rolled over to the next occurrence yet (which would make these
    // runs read as a STALE prior-day occurrence rather than this cycle's).
    const now = new Date('2026-09-29T23:59:00Z');
    const verdicts = evaluateWatchdog({ workflowYamlText: REAL_WORKFLOW, gh, now, graceHours: 8 });
    expect(anyLaneNeedsAlert(verdicts)).toBe(false);
  });

  it('reports "queued-too-long" for a lane whose run never left the queue', () => {
    const { gh } = fakeGh([
      // node: queued, never started — the lane under test.
      {
        event: 'schedule',
        status: 'queued',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: null,
      },
      // The other 3 lanes each have their OWN clean evidence, so node's
      // predecessor (bun-webpack, previous day) is independently covered —
      // node's queued run is unambiguously node's, not "ambiguous".
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T05:48:00Z',
        run_started_at: '2026-09-29T05:49:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-28T22:18:00Z',
        run_started_at: '2026-09-28T22:19:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-28T23:48:00Z',
        run_started_at: '2026-09-28T23:49:00Z',
      },
    ]);
    const now = new Date('2026-09-29T09:30:00Z'); // slot + 8h13m
    const verdicts = evaluateWatchdog({ workflowYamlText: REAL_WORKFLOW, gh, now, graceHours: 8 });
    expect(verdicts.find((v) => v.lane === 'node')?.verdict).toBe('queued-too-long');
  });

  it('honors an explicit graceHours override over the default', () => {
    const { gh } = fakeGh([]);
    const now = new Date('2026-09-29T03:00:00Z'); // 1h43m after the node slot (01:17)
    const withDefaultGrace = evaluateWatchdog({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now,
      graceHours: 8,
    });
    const withTightGrace = evaluateWatchdog({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now,
      graceHours: 1,
    });
    expect(withDefaultGrace.find((v) => v.lane === 'node')?.verdict).toBe('quiet');
    expect(withTightGrace.find((v) => v.lane === 'node')?.verdict).toBe('missing');
  });

  it('FAILS CLOSED: throws (never silently defaults) when the workflow cron shape cannot be parsed', () => {
    const { gh } = fakeGh([]);
    expect(() =>
      evaluateWatchdog({ workflowYamlText: 'not: a\nworkflow: file\n', gh, now: new Date() }),
    ).toThrow(/cannot read slots/);
  });

  it('does NOT throw against the real, currently-checked-in workflow (the success half)', () => {
    const { gh } = fakeGh([]);
    expect(() =>
      evaluateWatchdog({
        workflowYamlText: REAL_WORKFLOW,
        gh,
        now: new Date('2026-09-29T20:00:00Z'),
      }),
    ).not.toThrow();
  });
});
