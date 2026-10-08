import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  attachExactLanes,
  evaluateWatchdog,
  fetchScheduledRuns,
  fetchWindowRuns,
  resolveCheckAnchors,
  runCli,
  runWatchdogFromEnv,
} from '../scripts/credential-slot-watchdog.mjs';
import {
  anyLaneNeedsAlert,
  attributeRunsToLanes,
  computeExpectedSlots,
  DEFAULT_CREDENTIAL_LANES,
  DEFAULT_GRACE_HOURS,
  decideCredentialSlotVerdicts,
  detectAmbiguousAttribution,
  dueFiresInWindow,
  extractScheduleCrons,
  mostRecentFireAtOrBefore,
  mostRecentSlotAtOrBefore,
  parseAllDeclaredSlots,
  parseSimpleDailyCron,
  resolveCredentialLaneCrons,
  resolveCredentialLanes,
  WATCHDOG_LOOKBACK_HOURS,
  WATCHDOG_MAX_WINDOW_HOURS,
  watchdogWindow,
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

/**
 * ADR-0056 Amendment 5 moved every credential cell from one fire a day to
 * three (one cron literal with a comma-listed hour field). The attribution,
 * ambiguity and pagination tests below replay REAL runs recorded under the
 * previous one-fire-a-day schedule, so they run against that schedule: the real
 * workflow with each multi-fire literal put back to its single historical fire.
 * The live multi-fire schedule has its own block ("three fires a day").
 */
const LEGACY_CRONS: Record<string, string> = {
  '17 1,9,17 * * *': '17 1 * * *',
  '47 5,13,21 * * *': '47 5 * * *',
  '17 6,14,22 * * *': '17 22 * * *',
  '47 7,15,23 * * *': '47 23 * * *',
};
const LEGACY_WORKFLOW = Object.entries(LEGACY_CRONS).reduce((text, [now, then]) => {
  if (!text.includes(`'${now}'`)) throw new Error(`fixture drift: '${now}' not in the workflow`);
  return text.replaceAll(`'${now}'`, `'${then}'`);
}, REAL_WORKFLOW);

// ── parseSimpleDailyCron ─────────────────────────────────────────────────────

describe('parseSimpleDailyCron', () => {
  it('parses a once-daily "M H * * *" cron', () => {
    expect(parseSimpleDailyCron('17 1 * * *')).toEqual({ minute: 17, hour: 1, hours: [1] });
  });

  it('parses a multi-fire "M H1,H2,H3 * * *" cron into every fire hour (ADR-0056 Amendment 5)', () => {
    expect(parseSimpleDailyCron('17 1,9,17 * * *')).toEqual({
      minute: 17,
      hour: 1,
      hours: [1, 9, 17],
    });
  });

  it('rejects an hour range, a step or a duplicate hour (it could not enumerate the fires)', () => {
    expect(() => parseSimpleDailyCron('17 1-9 * * *')).toThrow(/not a supported/);
    expect(() => parseSimpleDailyCron('17 */8 * * *')).toThrow(/not a supported/);
    expect(() => parseSimpleDailyCron('17 1,1 * * *')).toThrow(/duplicate/);
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
      '17 1,9,17 * * *',
      '47 5,13,21 * * *',
      '17 6,14,22 * * *',
      '47 7,15,23 * * *',
    ]);
  });

  it('resolves exactly the 4 credential lanes, matching DEFAULT_CREDENTIAL_LANES', () => {
    const lanes = resolveCredentialLaneCrons(REAL_WORKFLOW);
    const stripped = lanes.map(({ cron, lane, hour, hours, minute }) => ({
      cron,
      lane,
      hour,
      hours,
      minute,
    }));
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
    const stripped = lanes.map(({ cron, lane, hour, hours, minute }) => ({
      cron,
      lane,
      hour,
      hours,
      minute,
    }));
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

const ALL_SLOTS = parseAllDeclaredSlots(LEGACY_WORKFLOW);

describe('attributeRunsToLanes', () => {
  // Every lane's own current-cycle slot lands the SAME UTC day at this `now`
  // (chosen deliberately — see the "cross-lane masking" describe block below
  // for why that matters): node 01:17, bun 05:47, node-webpack 22:17,
  // bun-webpack 23:47, all 2026-09-29.
  const now = new Date('2026-09-29T23:50:00Z');
  const lanes = computeExpectedSlots(resolveCredentialLanes(LEGACY_WORKFLOW), now);

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
  const lanes = computeExpectedSlots(resolveCredentialLanes(LEGACY_WORKFLOW), now);

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
  const lanes = computeExpectedSlots(resolveCredentialLanes(LEGACY_WORKFLOW), now);

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
    const verdicts = evaluateWatchdog({
      workflowYamlText: LEGACY_WORKFLOW,
      gh,
      now,
      graceHours: 8,
    });
    expect(verdicts).toHaveLength(4);
    expect(anyLaneNeedsAlert(verdicts)).toBe(true);
    expect(verdicts.find((v) => v.lane === 'node')?.verdict).toBe('missing');
  });

  it('is fully quiet when every lane ran on time', () => {
    const { gh } = fakeGh([
      // The night before's bun-webpack run. These runs carry no lane markers,
      // so node's 01:18 run is placed by timing — and it is only unambiguously
      // node's when the fire just before it (bun-webpack 09-28 23:47) has its
      // own run. Each fire is judged in its own context (round 2), so it is
      // that fire's run that counts, not bun-webpack's later 09-29 run.
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-28T23:48:00Z',
        run_started_at: '2026-09-28T23:49:00Z',
      },
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
    // No previous watchdog run is given, so the window is the lookback:
    // (now - grace - WATCHDOG_LOOKBACK_HOURS, now - grace] = (09-28 23:48,
    // 09-29 23:48]. That holds exactly the four once-a-day fires of 09-29 —
    // bun-webpack 23:47 is the last, one minute inside the due point — and
    // every one has its run above.
    const now = new Date('2026-09-30T07:48:00Z');
    const verdicts = evaluateWatchdog({
      workflowYamlText: LEGACY_WORKFLOW,
      gh,
      now,
      graceHours: 8,
    });
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
    const verdicts = evaluateWatchdog({
      workflowYamlText: LEGACY_WORKFLOW,
      gh,
      now,
      graceHours: 8,
    });
    expect(verdicts.find((v) => v.lane === 'node')?.verdict).toBe('queued-too-long');
  });

  it('honors an explicit graceHours override over the default', () => {
    // Only YESTERDAY's node run exists. At 03:00, 1h43m after today's 01:17
    // node slot: with the 8 h default the latest DUE node fire is yesterday's
    // (quiet — its run exists); with a 1 h grace it is today's (missing).
    // node's predecessor (bun-webpack, 23:47 the day before) has its own run,
    // so the marker-less node run is unambiguously node's.
    const { gh } = fakeGh([
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-27T23:48:00Z',
        run_started_at: '2026-09-27T23:49:00Z',
      },
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-28T01:18:00Z',
        run_started_at: '2026-09-28T01:19:00Z',
      },
    ]);
    const now = new Date('2026-09-29T03:00:00Z');
    const withDefaultGrace = evaluateWatchdog({
      workflowYamlText: LEGACY_WORKFLOW,
      gh,
      now,
      graceHours: 8,
    });
    const withTightGrace = evaluateWatchdog({
      workflowYamlText: LEGACY_WORKFLOW,
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
// ── #1895 — the 2026-10-05 false positive, replayed from the real run set ───
//
// Watchdog run 37356511131 (2026-10-05 18:30Z) reported all four night-4
// credential lanes "missing" although their scheduled runs existed inside
// their 8 h grace windows. The listing it got did not contain them (one
// `event=schedule` response was observed returning a stale window — newest
// run 2026-09-27 — while 179 runs existed). The fixture below is that run
// set, with the four crowding `workflow_dispatch` runs at 17:08Z from the real
// listing.

type FixtureRun = {
  id: number;
  event: 'schedule' | 'workflow_dispatch';
  created_at: string;
  head_branch: string;
  status: string;
  html_url: string;
  run_started_at: string | null;
  // fixture-only: artifact markers (absent on dispatch runs in the real data)
  markers: string[];
};

const fixtureRun = (
  id: number,
  event: FixtureRun['event'],
  created_at: string,
  markers: string[] = [],
  head_branch = 'main',
): FixtureRun => ({
  id,
  event,
  created_at,
  head_branch,
  status: 'completed',
  html_url: `https://github.com/getknext-dev/knext/actions/runs/${id}`,
  run_started_at: created_at,
  markers,
});

const CRED = (lane: string) => [`compat-lane-${lane}`, 'compat-mode-credential'];
const EW = (lane: string) => [`compat-lane-${lane}`, 'compat-mode-early-warning'];

const NIGHT4_NODE_WEBPACK = 37249321353;
const NIGHT4_BUN_WEBPACK = 37255368185;
const NIGHT4_NODE = 37276219808;
const NIGHT4_BUN = 37311289929;
// Early-warning runs (any lane) are not credential runs, but they carry no exact lane and are
// attributed by timing, so one landing inside a credential slot's grace window satisfies it. A
// credential run is only truly 'absent' once those are removed too.
const isEarlyWarning = (r: FixtureRun) => r.markers.includes('compat-mode-early-warning');

const NIGHT4_RUNS: FixtureRun[] = [
  fixtureRun(37198322226, 'schedule', '2026-10-04T11:19:05Z', EW('bun')),
  fixtureRun(NIGHT4_NODE_WEBPACK, 'schedule', '2026-10-05T00:54:39Z', CRED('node-webpack')),
  fixtureRun(NIGHT4_BUN_WEBPACK, 'schedule', '2026-10-05T02:25:48Z', CRED('bun-webpack')),
  fixtureRun(NIGHT4_NODE, 'schedule', '2026-10-05T07:10:09Z', CRED('node')),
  fixtureRun(37292974381, 'workflow_dispatch', '2026-10-05T09:53:16Z', [], 'v1.0.0-rc.5'),
  fixtureRun(37297035896, 'schedule', '2026-10-05T10:30:40Z', EW('node')),
  fixtureRun(37305584727, 'schedule', '2026-10-05T11:51:03Z', EW('bun')),
  fixtureRun(NIGHT4_BUN, 'schedule', '2026-10-05T12:41:30Z', CRED('bun')),
  fixtureRun(37346137030, 'workflow_dispatch', '2026-10-05T17:08:04Z'),
  fixtureRun(37346137726, 'workflow_dispatch', '2026-10-05T17:08:04Z'),
  fixtureRun(37346138468, 'workflow_dispatch', '2026-10-05T17:08:05Z'),
  fixtureRun(37346139474, 'workflow_dispatch', '2026-10-05T17:08:05Z'),
];

const WATCHDOG_NOW = new Date('2026-10-05T18:30:51Z');

/** More dispatch runs than one API page holds, all newer than every credential run. */
const crowd = (n: number): FixtureRun[] =>
  Array.from({ length: n }, (_, i) =>
    fixtureRun(
      38_000_000 + i,
      'workflow_dispatch',
      new Date(Date.UTC(2026, 9, 5, 17, 9, 0) + i * 1000).toISOString(),
    ),
  );

type ListingShape = 'schedule' | 'unfiltered';

/**
 * A `gh api` simulator over `runs` that honours what the real endpoints do:
 * `event`, `created=>=`, `per_page` (capped at 100), `page`, newest-first order,
 * plus the per-run artifacts listing. `hide` makes one listing shape omit runs,
 * the way the incident's stale response did.
 */
function simGh(
  runs: FixtureRun[],
  {
    hide = () => false,
    fail = () => false,
  }: {
    hide?: (shape: ListingShape, r: FixtureRun) => boolean;
    fail?: (shape: ListingShape) => boolean;
  } = {},
) {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    const url = args[1] ?? '';
    calls.push(url);
    const artifacts = /actions\/runs\/(\d+)\/artifacts/.exec(url);
    if (artifacts) {
      const found = runs.find((r) => r.id === Number(artifacts[1]));
      return JSON.stringify({ artifacts: (found?.markers ?? []).map((name) => ({ name })) });
    }
    const q = new URLSearchParams(url.split('?')[1] ?? '');
    const shape: ListingShape = q.get('event') === 'schedule' ? 'schedule' : 'unfiltered';
    if (fail(shape)) throw new Error(`simulated ${shape} listing failure`);
    const since = q.get('created')?.replace(/^>=/, '');
    const perPage = Math.min(Number(q.get('per_page') ?? 30), 100);
    const page = Number(q.get('page') ?? 1);
    const matching = runs
      .filter((r) => (shape === 'schedule' ? r.event === 'schedule' : true))
      .filter((r) => !since || new Date(r.created_at) >= new Date(since))
      .filter((r) => !hide(shape, r))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
    const slice = matching.slice((page - 1) * perPage, page * perPage);
    return JSON.stringify({ total_count: matching.length, workflow_runs: slice });
  };
  return { gh, calls };
}

const verdictsOf = (gh: (a: string[]) => string, now = WATCHDOG_NOW): Record<string, string> =>
  Object.fromEntries(
    evaluateWatchdog({ workflowYamlText: LEGACY_WORKFLOW, gh, now, graceHours: 8 }).map((v) => [
      v.lane,
      v.verdict,
    ]),
  );

const ALL_QUIET = {
  node: 'quiet',
  bun: 'quiet',
  'node-webpack': 'quiet',
  'bun-webpack': 'quiet',
};

describe('#1895 — night-4 replay: present late-but-in-grace runs are NOT flagged', () => {
  it('is quiet on all four lanes for the exact run set (late runs 2.6-6.9 h after slot)', () => {
    const { gh } = simGh(NIGHT4_RUNS);
    expect(verdictsOf(gh)).toEqual(ALL_QUIET);
  });

  it('stays quiet when the event=schedule listing is STALE (the incident) — the unfiltered listing still carries the runs', () => {
    const { gh } = simGh(NIGHT4_RUNS, { hide: (shape) => shape === 'schedule' });
    expect(verdictsOf(gh)).toEqual(ALL_QUIET);
  });

  it('stays quiet when the UNFILTERED listing is the stale one — the schedule listing still carries the runs', () => {
    const { gh } = simGh(NIGHT4_RUNS, { hide: (shape) => shape === 'unfiltered' });
    expect(verdictsOf(gh)).toEqual(ALL_QUIET);
  });

  it('stays quiet when workflow_dispatch runs crowd more than one page AND the schedule listing is stale (pagination)', () => {
    const { gh, calls } = simGh([...NIGHT4_RUNS, ...crowd(250)], {
      hide: (shape) => shape === 'schedule',
    });
    expect(verdictsOf(gh)).toEqual(ALL_QUIET);
    // The scheduled runs sit behind >2 pages of dispatch runs: only walking
    // pages finds them.
    const pages = calls
      .filter((u) => u.includes('/runs?') && !u.includes('event=schedule'))
      .map((u) => Number(new URLSearchParams(u.split('?')[1]).get('page')));
    expect(Math.max(...pages)).toBeGreaterThanOrEqual(3);
  });

  it('never fetches artifact markers for crowding dispatch runs', () => {
    const { gh, calls } = simGh([...NIGHT4_RUNS, ...crowd(120)]);
    verdictsOf(gh);
    const dispatchIds = [37346137030, 37346137726, 37346138468, 37346139474, 37292974381];
    for (const id of dispatchIds) {
      expect(calls.some((u) => u.includes(`/runs/${id}/artifacts`))).toBe(false);
    }
  });

  it('tolerates one listing failing outright (the other is enough)', () => {
    const { gh } = simGh(NIGHT4_RUNS, { fail: (shape) => shape === 'schedule' });
    expect(verdictsOf(gh)).toEqual(ALL_QUIET);
  });

  it('FAILS CLOSED when BOTH listings fail (never a silent quiet or empty list)', () => {
    const { gh } = simGh(NIGHT4_RUNS, { fail: () => true });
    expect(() => verdictsOf(gh)).toThrow(/simulated/);
  });
});

describe('#1895 — night-4 replay: a truly absent run IS flagged', () => {
  it.each([
    ['node-webpack', NIGHT4_NODE_WEBPACK],
    ['bun-webpack', NIGHT4_BUN_WEBPACK],
    ['node', NIGHT4_NODE],
    ['bun', NIGHT4_BUN],
  ])('flags only %s when its run is absent from every listing', (lane, id) => {
    const { gh } = simGh(NIGHT4_RUNS.filter((r) => r.id !== id && !isEarlyWarning(r)));
    const verdicts = verdictsOf(gh);
    expect(verdicts[lane]).not.toBe('quiet');
    for (const [other, v] of Object.entries(verdicts)) {
      if (other !== lane) expect(v).toBe('quiet');
    }
  });

  it('flags all four (as "missing") when no credential run exists at all, crowded by dispatches', () => {
    const credentialIds = [NIGHT4_NODE_WEBPACK, NIGHT4_BUN_WEBPACK, NIGHT4_NODE, NIGHT4_BUN];
    const { gh } = simGh([
      ...NIGHT4_RUNS.filter((r) => !credentialIds.includes(r.id) && !isEarlyWarning(r)),
      ...crowd(250),
    ]);
    expect(verdictsOf(gh)).toEqual({
      node: 'missing',
      bun: 'missing',
      'node-webpack': 'missing',
      'bun-webpack': 'missing',
    });
  });
});

describe('#1895 — night-4 replay: a run outside its grace window IS flagged', () => {
  it('flags node as queued-too-long when its run was created but never started within 8 h', () => {
    const runs = NIGHT4_RUNS.map((r) =>
      r.id === NIGHT4_NODE ? { ...r, status: 'queued', run_started_at: null } : r,
    );
    const { gh } = simGh(runs);
    const verdicts = verdictsOf(gh);
    expect(verdicts.node).toBe('queued-too-long');
    expect(verdicts.bun).toBe('quiet');
  });

  it('flags a lane whose only evidence predates its slot (stale prior-cycle run)', () => {
    const stale = NIGHT4_RUNS.map((r) =>
      r.id === NIGHT4_NODE ? { ...r, created_at: '2026-10-04T07:10:09Z' } : r,
    );
    const { gh } = simGh(stale);
    expect(verdictsOf(gh).node).not.toBe('quiet');
  });

  it('checks a slot only once its grace has elapsed (boundary)', () => {
    // ADR-0056 Amendment 5: the watchdog checks the latest DUE fire. One
    // second before 10-05 01:17 + 8 h, node's due fire is still 10-04's
    // (outside this fixture, so it reads missing for 10-04 — never for
    // 10-05); from 09:17:00 it is 10-05's.
    const noNode = NIGHT4_RUNS.filter((r) => r.id !== NIGHT4_NODE);
    const { gh } = simGh(noNode);
    const before = evaluateWatchdog({
      workflowYamlText: LEGACY_WORKFLOW,
      gh,
      now: new Date('2026-10-05T09:16:59Z'),
      graceHours: 8,
    }).find((v) => v.lane === 'node');
    const at = evaluateWatchdog({
      workflowYamlText: LEGACY_WORKFLOW,
      gh,
      now: new Date('2026-10-05T09:17:00Z'),
      graceHours: 8,
    }).find((v) => v.lane === 'node');
    expect(before?.reason).toContain('2026-10-04T01:17:00.000Z');
    expect(at?.reason).toContain('2026-10-05T01:17:00.000Z');
    expect(at?.verdict).toBe('missing');
  });
});

describe('fetchScheduledRuns / fetchWindowRuns — pagination and union (#1895)', () => {
  it('walks pages until a short page, returning every run across them', () => {
    const { gh } = simGh(crowd(250));
    const out = fetchScheduledRuns(gh, { event: null });
    expect(out).toHaveLength(250);
  });

  it('stops paging once a page reaches below `since`, never walking the whole history', () => {
    const { gh, calls } = simGh([...crowd(250), fixtureRun(1, 'schedule', '2026-01-01T00:00:00Z')]);
    fetchScheduledRuns(gh, { event: null, since: '2026-10-05T17:09:00Z' });
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('fetchWindowRuns unions by id and drops runs older than `since` and non-schedule events', () => {
    const { gh } = simGh(NIGHT4_RUNS);
    const out = fetchWindowRuns(gh, { since: '2026-10-05T00:00:00Z' });
    const ids = out.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        NIGHT4_NODE_WEBPACK,
        NIGHT4_BUN_WEBPACK,
        NIGHT4_NODE,
        NIGHT4_BUN,
        37297035896,
        37305584727,
      ].sort(),
    );
  });
});
// ── ADR-0056 Amendment 5 — three fires a day per lane ──────────────────────

describe('three fires a day — the live schedule (ADR-0056 Amendment 5)', () => {
  const WATCHDOG_WORKFLOW = readFileSync(
    new URL('../.github/workflows/credential-slot-watchdog.yml', import.meta.url),
    'utf8',
  );
  const H = 3_600_000;
  const at = (day: string, hour: number, minute: number) =>
    new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);

  it('every credential lane resolves to three fires, 8 h apart', () => {
    const lanes = resolveCredentialLanes(REAL_WORKFLOW);
    expect(lanes).toHaveLength(4);
    for (const l of lanes) {
      expect(l.hours).toHaveLength(3);
      expect(l.hours[1] - l.hours[0]).toBe(8);
      expect(l.hours[2] - l.hours[1]).toBe(8);
    }
  });

  it('mostRecentFireAtOrBefore picks the latest of the listed hours', () => {
    const fire = (iso: string) =>
      mostRecentFireAtOrBefore([1, 9, 17], 17, new Date(iso)).toISOString();
    expect(fire('2026-10-10T09:16:59Z')).toBe('2026-10-10T01:17:00.000Z');
    expect(fire('2026-10-10T09:17:00Z')).toBe('2026-10-10T09:17:00.000Z');
    expect(fire('2026-10-10T00:30:00Z')).toBe('2026-10-09T17:17:00.000Z');
  });

  it('checks the latest DUE fire: a run of a LATER, not-yet-due fire never satisfies it', () => {
    // 02:05 - 8 h = 18:05 the day before, so node's due fire is 10-09 17:17.
    // The only node run belongs to 10-10 01:17 — a different fire.
    const { gh } = simGh([fixtureRun(1, 'schedule', '2026-10-10T01:20:00Z', CRED('node'))]);
    const node = evaluateWatchdog({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now: new Date('2026-10-10T02:05:00Z'),
      previousCheckAt: new Date('2026-10-09T18:05:00Z'),
      graceHours: 8,
    }).find((v) => v.lane === 'node');
    expect(node?.verdict).toBe('missing');
    expect(node?.reason).toContain('2026-10-09T17:17:00.000Z');
  });

  it('is quiet when the due fire has its own run, even one created 7 h late', () => {
    const { gh } = simGh([fixtureRun(1, 'schedule', '2026-10-10T00:17:00Z', CRED('node'))]);
    const node = evaluateWatchdog({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now: new Date('2026-10-10T02:05:00Z'),
      previousCheckAt: new Date('2026-10-09T18:05:00Z'),
      graceHours: 8,
    }).find((v) => v.lane === 'node');
    expect(node?.verdict).toBe('quiet');
  });

  it('the heuristic fallback (no markers) places a run on the right fire of a multi-fire cron', () => {
    const lanes = computeExpectedSlots(
      resolveCredentialLanes(REAL_WORKFLOW),
      new Date('2026-10-10T10:00:00Z'),
    );
    // node's 09:17 fire; its predecessor (bun-webpack 07:47) has its own run,
    // so the conservative ambiguity check does not drop node's.
    const { attributed } = attributeRunsToLanes(
      [
        {
          event: 'schedule',
          status: 'completed',
          created_at: '2026-10-10T07:50:00Z',
          run_started_at: '2026-10-10T07:50:00Z',
        },
        {
          event: 'schedule',
          status: 'completed',
          created_at: '2026-10-10T09:20:00Z',
          run_started_at: '2026-10-10T09:20:00Z',
        },
      ],
      lanes,
      parseAllDeclaredSlots(REAL_WORKFLOW),
    );
    expect(attributed.find((r) => r.created_at === '2026-10-10T09:20:00Z')?.lane).toBe('node');
  });

  it("the watchdog's own schedule, on time, checks every fire of every lane exactly once", () => {
    const watchdogCrons = extractScheduleCrons(WATCHDOG_WORKFLOW).map(parseSimpleDailyCron);
    const lanes = resolveCredentialLanes(REAL_WORKFLOW);
    const checks: Date[] = [];
    for (const day of ['2026-10-10', '2026-10-11']) {
      for (const c of watchdogCrons) for (const h of c.hours) checks.push(at(day, h, c.minute));
    }
    checks.sort((a, b) => a.getTime() - b.getTime());
    const checked: string[] = [];
    checks.forEach((t, i) => {
      const w = watchdogWindow({
        checkAt: t,
        previousCheckAt: i === 0 ? null : checks[i - 1],
        graceHours: DEFAULT_GRACE_HOURS,
      });
      for (const f of dueFiresInWindow(lanes, w)) checked.push(`${f.lane}@${f.fire.toISOString()}`);
    });
    // No fire is checked twice …
    expect(new Set(checked).size).toBe(checked.length);
    // … and every fire from the first check's lookback to the last check's due point is checked.
    const first =
      (checks[0] as Date).getTime() - (DEFAULT_GRACE_HOURS + WATCHDOG_LOOKBACK_HOURS) * H;
    const last = (checks.at(-1) as Date).getTime() - DEFAULT_GRACE_HOURS * H;
    let covered = 0;
    for (const l of lanes) {
      for (const day of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']) {
        for (const h of l.hours) {
          const fire = at(day, h, l.minute);
          if (fire.getTime() > first && fire.getTime() <= last) {
            expect(checked).toContain(`${l.lane}@${fire.toISOString()}`);
            covered += 1;
          }
        }
      }
    }
    expect(covered).toBe(checked.length);
  });
});
// ── Jittered watchdog starts — every fire checked once (PR #2013 round 2) ───
//
// GitHub starts this watchdog's scheduled runs late, and by a DIFFERENT amount
// each time (measured 4.9-6.6 h; the e2e credential runs it watches start
// 2.3-7.4 h late). A watchdog that checks only "the latest fire at or before
// now - grace" skips a fire whenever two consecutive runs' delays differ enough
// (and checks another twice). The fix checks EVERY fire in the window since the
// previous watchdog run: (previous start - grace, this start - grace]. These
// tests replay jittered start times, seeded so a failure reproduces.

describe('jittered watchdog starts — every fire is checked exactly once', () => {
  const H = 3_600_000;
  const WATCHDOG_WORKFLOW = readFileSync(
    new URL('../.github/workflows/credential-slot-watchdog.yml', import.meta.url),
    'utf8',
  );
  const lanes = resolveCredentialLanes(REAL_WORKFLOW);
  const watchdogCrons = extractScheduleCrons(WATCHDOG_WORKFLOW).map(parseSimpleDailyCron);
  const WATCHDOG_PERIOD_HOURS = 24 / watchdogCrons.reduce((n, c) => n + c.hours.length, 0);
  // Measured 2026-10-01..08: the watchdog's own scheduled runs, and the
  // credential e2e runs it watches.
  const WATCHDOG_DELAY_HOURS: [number, number] = [4.9, 6.6];
  const E2E_DELAY_HOURS: [number, number] = [2.3, 7.4];
  const DAYS = Array.from({ length: 10 }, (_, i) =>
    new Date(Date.UTC(2026, 9, 10 + i)).toISOString().slice(0, 10),
  );

  /** mulberry32 — a tiny seeded PRNG, so a red seed reproduces exactly. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uniform = (rand: () => number, [lo, hi]: [number, number]) => lo + (hi - lo) * rand();
  const nominal = (day: string, hour: number, minute: number) =>
    new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);

  /** The watchdog's scheduled starts over DAYS, each delayed by a random amount in `delay`. */
  function jitteredStarts(rand: () => number, delay: [number, number]): Date[] {
    const starts: Date[] = [];
    for (const day of DAYS) {
      for (const c of watchdogCrons) {
        for (const h of c.hours) {
          starts.push(
            new Date(nominal(day, h, c.minute).getTime() + Math.round(uniform(rand, delay) * H)),
          );
        }
      }
    }
    return starts.sort((a, b) => a.getTime() - b.getTime());
  }

  /** Every credential fire in (from, to]. */
  function firesBetween(from: number, to: number): string[] {
    const out: string[] = [];
    for (const day of ['2026-10-08', '2026-10-09', ...DAYS]) {
      for (const l of lanes) {
        for (const h of l.hours) {
          const t = nominal(day, h, l.minute).getTime();
          if (t > from && t <= to) out.push(`${l.lane}@${new Date(t).toISOString()}`);
        }
      }
    }
    return out.sort();
  }

  /** How many times each fire is checked, when run i anchors on run i-1's start. */
  function coverage(starts: Date[]): Map<string, number> {
    const checked = new Map<string, number>();
    starts.forEach((checkAt, i) => {
      const w = watchdogWindow({
        checkAt,
        previousCheckAt: i === 0 ? null : starts[i - 1],
        graceHours: DEFAULT_GRACE_HOURS,
      });
      for (const f of dueFiresInWindow(lanes, w)) {
        const key = `${f.lane}@${f.fire.toISOString()}`;
        checked.set(key, (checked.get(key) ?? 0) + 1);
      }
    });
    return checked;
  }

  function expectExactlyOnce(starts: Date[]) {
    const checked = coverage(starts);
    const expected = firesBetween(
      (starts[0] as Date).getTime() - (DEFAULT_GRACE_HOURS + WATCHDOG_LOOKBACK_HOURS) * H,
      (starts.at(-1) as Date).getTime() - DEFAULT_GRACE_HOURS * H,
    );
    expect(expected.length).toBeGreaterThanOrEqual(7 * 12); // ≥ 7 days of 12 fires
    expect([...checked.keys()].sort()).toEqual(expected);
    expect([...checked.values()].every((n) => n === 1)).toBe(true);
  }

  it('the no-previous-run lookback covers the watchdog period plus the worst measured delay', () => {
    // A run must reach back past the previous run's window end; consecutive starts
    // can be as far apart as one period plus the delay spread. 24 h also covers
    // ONE dropped watchdog run (2 periods + the worst e2e delay = 23.4 h).
    expect(WATCHDOG_PERIOD_HOURS).toBe(8);
    expect(WATCHDOG_LOOKBACK_HOURS).toBeGreaterThanOrEqual(
      WATCHDOG_PERIOD_HOURS + Math.max(WATCHDOG_DELAY_HOURS[1], E2E_DELAY_HOURS[1]),
    );
    expect(WATCHDOG_LOOKBACK_HOURS).toBeGreaterThanOrEqual(
      2 * WATCHDOG_PERIOD_HOURS + E2E_DELAY_HOURS[1],
    );
    expect(WATCHDOG_MAX_WINDOW_HOURS).toBeGreaterThan(WATCHDOG_LOOKBACK_HOURS);
  });

  it('watchdogWindow: (previous start - grace, this start - grace]; the lookback only without a previous run', () => {
    const checkAt = new Date('2026-10-10T15:00:00Z');
    expect(
      watchdogWindow({
        checkAt,
        previousCheckAt: new Date('2026-10-10T06:30:00Z'),
        graceHours: 8,
      }),
    ).toEqual({
      start: new Date('2026-10-09T22:30:00Z'),
      end: new Date('2026-10-10T07:00:00Z'),
      anchored: true,
      gap: false,
    });
    expect(watchdogWindow({ checkAt, previousCheckAt: null, graceHours: 8 })).toEqual({
      start: new Date(new Date('2026-10-10T07:00:00Z').getTime() - WATCHDOG_LOOKBACK_HOURS * H),
      end: new Date('2026-10-10T07:00:00Z'),
      anchored: false,
      gap: false,
    });
    // A previous run that is not before this one is no anchor (clock skew, a re-run).
    expect(watchdogWindow({ checkAt, previousCheckAt: checkAt, graceHours: 8 }).anchored).toBe(
      false,
    );
  });

  it('watchdogWindow: a previous run older than the maximum window is clamped and flagged as a gap', () => {
    const checkAt = new Date('2026-10-20T15:00:00Z');
    const w = watchdogWindow({
      checkAt,
      previousCheckAt: new Date('2026-10-10T06:30:00Z'),
      graceHours: 8,
    });
    expect(w.gap).toBe(true);
    expect(w.end.getTime() - w.start.getTime()).toBe(WATCHDOG_MAX_WINDOW_HOURS * H);
  });

  it('dueFiresInWindow: start exclusive, end inclusive, every listed hour', () => {
    const fires = dueFiresInWindow(lanes, {
      start: new Date('2026-10-10T01:17:00Z'),
      end: new Date('2026-10-10T09:17:00Z'),
    }).map((f) => `${f.lane}@${f.fire.toISOString().slice(11, 16)}`);
    expect(fires).toEqual(['bun@05:47', 'node-webpack@06:17', 'bun-webpack@07:47', 'node@09:17']);
  });

  it("the reviewer's reproduction: delays 6.6 h, 4.9 h, 6.6 h skip nothing and repeat nothing", () => {
    // 09:25 + 6.6 h, 17:25 + 4.9 h, 01:25 + 6.6 h. Checking only the latest due
    // fire, bun-webpack 07:47 is checked by the first two runs and 15:47 by
    // none. Anchoring on the previous run's start checks each exactly once.
    const starts = [
      new Date('2026-10-10T16:01:00Z'),
      new Date('2026-10-10T22:19:00Z'),
      new Date('2026-10-11T08:01:00Z'),
    ];
    const checked = coverage(starts);
    expect(checked.get('bun-webpack@2026-10-10T07:47:00.000Z')).toBe(1);
    expect(checked.get('bun-webpack@2026-10-10T15:47:00.000Z')).toBe(1);
    expect(checked.get('bun-webpack@2026-10-10T23:47:00.000Z')).toBe(1);
  });

  it("the reviewer's reproduction, end to end: a missing bun-webpack 15:47 run alerts exactly once", () => {
    // Every fire 10-09..10-11 has its credential run (2 h late) except
    // bun-webpack 10-10 15:47. Watchdog runs start 16:01, 22:19 and 08:01 the
    // next day (09:25 + 6.6 h, 17:25 + 4.9 h, 01:25 + 6.6 h), each anchored on
    // the one before. Checking only the latest due fire never looks at 15:47.
    const runs: FixtureRun[] = [];
    let id = 1;
    for (const day of ['2026-10-09', '2026-10-10', '2026-10-11']) {
      for (const l of lanes) {
        for (const h of l.hours) {
          const fire = nominal(day, h, l.minute);
          if (l.lane === 'bun-webpack' && fire.toISOString() === '2026-10-10T15:47:00.000Z') {
            continue;
          }
          const created = new Date(fire.getTime() + 2 * H).toISOString();
          runs.push(fixtureRun(id++, 'schedule', created, CRED(l.lane)));
        }
      }
    }
    const starts = [
      new Date('2026-10-10T09:00:00Z'),
      new Date('2026-10-10T16:01:00Z'),
      new Date('2026-10-10T22:19:00Z'),
      new Date('2026-10-11T08:01:00Z'),
    ];
    const alerts: string[] = [];
    starts.forEach((checkAt, i) => {
      if (i === 0) return; // the first start is only the anchor
      const { gh } = simGh(runs.filter((r) => new Date(r.created_at) <= checkAt));
      const verdicts = evaluateWatchdog({
        workflowYamlText: REAL_WORKFLOW,
        gh,
        now: checkAt,
        checkAt,
        previousCheckAt: starts[i - 1],
        graceHours: DEFAULT_GRACE_HOURS,
      });
      for (const v of verdicts) {
        if (v.verdict !== 'quiet') alerts.push(`${v.lane}@${v.slot}:${v.verdict}`);
      }
    });
    expect(alerts).toEqual(['bun-webpack@2026-10-10T15:47:00.000Z:missing']);
  });

  it.each(
    Array.from({ length: 25 }, (_, i) => i + 1),
  )('seed %i: measured watchdog delays (4.9-6.6 h) over 10 days — every fire checked exactly once', (seed) => {
    expectExactlyOnce(jitteredStarts(prng(seed), WATCHDOG_DELAY_HOURS));
  });

  it.each(
    Array.from({ length: 25 }, (_, i) => i + 101),
  )('seed %i: stress — e2e-wide delays (2.3-7.4 h) and one dropped watchdog run — every fire checked exactly once', (seed) => {
    const rand = prng(seed);
    const starts = jitteredStarts(rand, E2E_DELAY_HOURS);
    starts.splice(1 + Math.floor(rand() * (starts.length - 2)), 1);
    expectExactlyOnce(starts);
  });

  // Round 3: some watchdog runs CRASH (conclude `failure` before evaluating),
  // TIME OUT (`cancelled`), or are still IN PROGRESS when the next run lists
  // them. Every run resolves its anchor through the real `resolveCheckAnchors`
  // over a fake Actions listing of the runs before it, as each one would have
  // seen it. Only a run that evaluated checks anything, and every fire in range
  // must still be checked at least once.
  it.each(
    Array.from({ length: 25 }, (_, i) => i + 301),
  )('seed %i: crashed, timed-out and in-progress watchdog runs — every fire is still checked', (seed) => {
    const rand = prng(seed);
    const starts = jitteredStarts(rand, WATCHDOG_DELAY_HOURS);
    // `slow` / `slow-crash`: still in progress when the next run lists it,
    // then concludes success / failure.
    type Outcome = 'success' | 'failure' | 'cancelled' | 'slow' | 'slow-crash';
    const evaluates = (o: Outcome) => o === 'success' || o === 'slow';
    const outcomes: Outcome[] = [];
    let streak = 0;
    starts.forEach((_, i) => {
      const r = rand();
      let o: Outcome =
        r < 0.1
          ? 'failure'
          : r < 0.2
            ? 'cancelled'
            : r < 0.3
              ? 'slow'
              : r < 0.4
                ? 'slow-crash'
                : 'success';
      // Keep a run of non-evaluating runs well inside the 72 h maximum window,
      // and end on a run that evaluated (the range below ends at its due point).
      if (!evaluates(o) && (streak >= 3 || i === starts.length - 1)) o = 'success';
      // Every seed starts with each kind once: the very first run crashes (so
      // the next has no successful run in view), the second is still in
      // progress when the third lists it, the third times out, and the fourth
      // is in progress when the fifth lists it and then crashes.
      if (i < 4) o = (['failure', 'slow', 'cancelled', 'slow-crash'] as const)[i];
      streak = evaluates(o) ? 0 : streak + 1;
      outcomes.push(o);
    });
    for (const kind of ['failure', 'cancelled', 'slow', 'slow-crash'] as const) {
      expect(outcomes.filter((o) => o === kind).length).toBeGreaterThan(0);
    }

    /** Run j as run i's listing shows it: a slow run is still in progress for the next run. */
    const asSeenBy = (i: number, j: number) => {
      const iso = (starts[j] as Date).toISOString();
      const o = outcomes[j] as Outcome;
      const live = j === i || ((o === 'slow' || o === 'slow-crash') && j === i - 1);
      return {
        id: 1000 + j,
        event: 'schedule',
        status: live ? 'in_progress' : 'completed',
        conclusion: live ? null : o === 'slow' ? 'success' : o === 'slow-crash' ? 'failure' : o,
        created_at: iso,
        run_started_at: iso,
        html_url: `https://x/${1000 + j}`,
      };
    };

    const checked = new Map<string, number>();
    starts.forEach((checkAt, i) => {
      const listingNewestFirst = Array.from({ length: i + 1 }, (_, k) => asSeenBy(i, i - k)).slice(
        0,
        30,
      );
      const gh = () =>
        JSON.stringify({
          total_count: listingNewestFirst.length,
          workflow_runs: listingNewestFirst,
        });
      const anchors = resolveCheckAnchors(gh, {
        runId: String(1000 + i),
        eventName: 'schedule',
        now: new Date(checkAt.getTime() + 60_000),
      });
      expect(anchors.checkAt.getTime()).toBe(checkAt.getTime());
      if (!evaluates(outcomes[i] as Outcome)) return; // crashed: evaluated nothing
      const w = watchdogWindow({ ...anchors, graceHours: DEFAULT_GRACE_HOURS });
      expect(w.gap).toBe(false);
      for (const f of dueFiresInWindow(lanes, w)) {
        const key = `${f.lane}@${f.fire.toISOString()}`;
        checked.set(key, (checked.get(key) ?? 0) + 1);
      }
    });
    const expected = firesBetween(
      (starts[0] as Date).getTime() - (DEFAULT_GRACE_HOURS + WATCHDOG_LOOKBACK_HOURS) * H,
      (starts.at(-1) as Date).getTime() - DEFAULT_GRACE_HOURS * H,
    );
    expect(expected.length).toBeGreaterThanOrEqual(7 * 12);
    const unchecked = expected.filter((k) => !checked.has(k));
    expect(unchecked).toEqual([]);
    // Nothing outside the range is checked either (the window never overshoots).
    expect([...checked.keys()].filter((k) => !expected.includes(k))).toEqual([]);
  });

  it.each(
    Array.from({ length: 8 }, (_, i) => i + 201),
  )('seed %i: end to end — alerts exactly the dropped credential runs, each exactly once', (seed) => {
    const rand = prng(seed);
    const starts = jitteredStarts(rand, WATCHDOG_DELAY_HOURS);
    const runs: FixtureRun[] = [];
    const dropped = new Set<string>();
    let id = 1;
    for (const day of ['2026-10-08', '2026-10-09', ...DAYS]) {
      for (const l of lanes) {
        for (const h of l.hours) {
          const fire = nominal(day, h, l.minute);
          if (rand() < 0.15) {
            dropped.add(`${l.lane}@${fire.toISOString()}`);
            continue;
          }
          const created = new Date(fire.getTime() + uniform(rand, E2E_DELAY_HOURS) * H);
          runs.push(fixtureRun(id++, 'schedule', created.toISOString(), CRED(l.lane)));
        }
      }
      // The two early-warning runs share the run list and are just as late.
      for (const [hh, mm, lane] of [
        [3, 17, 'node'],
        [4, 47, 'bun'],
      ] as const) {
        const created = new Date(
          nominal(day, hh, mm).getTime() + uniform(rand, E2E_DELAY_HOURS) * H,
        );
        runs.push(fixtureRun(id++, 'schedule', created.toISOString(), EW(lane)));
      }
    }
    const alerted = new Map<string, number>();
    starts.forEach((checkAt, i) => {
      const { gh } = simGh(runs.filter((r) => new Date(r.created_at) <= checkAt));
      const verdicts = evaluateWatchdog({
        workflowYamlText: REAL_WORKFLOW,
        gh,
        now: new Date(checkAt.getTime() + 60_000),
        checkAt,
        previousCheckAt: i === 0 ? null : starts[i - 1],
        graceHours: DEFAULT_GRACE_HOURS,
      });
      for (const v of verdicts.filter((x) => x.verdict !== 'quiet')) {
        const key = `${v.lane}@${v.slot}`;
        alerted.set(key, (alerted.get(key) ?? 0) + 1);
      }
    });
    const inRange = new Set(
      firesBetween(
        (starts[0] as Date).getTime() - (DEFAULT_GRACE_HOURS + WATCHDOG_LOOKBACK_HOURS) * H,
        (starts.at(-1) as Date).getTime() - DEFAULT_GRACE_HOURS * H,
      ),
    );
    const expected = [...dropped].filter((k) => inRange.has(k)).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect([...alerted.keys()].sort()).toEqual(expected);
    expect([...alerted.values()].every((n) => n === 1)).toBe(true);
  });

  it('evaluateWatchdog alerts a coverage gap when its previous run is older than the maximum window', () => {
    const { gh } = simGh([]);
    const verdicts = evaluateWatchdog({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now: new Date('2026-10-20T15:00:00Z'),
      previousCheckAt: new Date('2026-10-10T06:30:00Z'),
      graceHours: 8,
    });
    expect(verdicts.some((v) => v.verdict === 'coverage-gap')).toBe(true);
  });

  it('every verdict names the fire it checked', () => {
    const { gh } = simGh([]);
    const verdicts = evaluateWatchdog({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now: new Date('2026-10-10T15:00:00Z'),
      previousCheckAt: new Date('2026-10-10T07:00:00Z'),
      graceHours: 8,
    });
    // (10-09 23:00, 10-10 07:00]: bun-webpack 23:47, node 01:17, bun 05:47, node-webpack 06:17.
    expect(verdicts.map((v) => `${v.lane}@${v.slot}`).sort()).toEqual(
      [
        'bun-webpack@2026-10-09T23:47:00.000Z',
        'node@2026-10-10T01:17:00.000Z',
        'bun@2026-10-10T05:47:00.000Z',
        'node-webpack@2026-10-10T06:17:00.000Z',
      ].sort(),
    );
    expect(verdicts.every((v) => v.verdict === 'missing')).toBe(true);
  });
});

describe('resolveCheckAnchors — this run and the previous one, from the Actions API', () => {
  const watchdogRun = (
    id: number,
    started: string,
    status = 'completed',
    conclusion: string | null = 'success',
    event = 'schedule',
  ) => ({
    id,
    event,
    status,
    conclusion,
    created_at: started,
    run_started_at: started,
    html_url: `https://x/${id}`,
  });
  const listing = (runs: unknown[]) => {
    const calls: string[] = [];
    const gh = (args: string[]) => {
      calls.push(args.join(' '));
      return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    };
    return { gh, calls };
  };
  const now = new Date('2026-10-10T15:00:30Z');

  it("anchors on this run's own start and the newest SUCCESSFUL scheduled run before it", () => {
    const { gh, calls } = listing([
      watchdogRun(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      watchdogRun(29, '2026-10-10T06:30:00Z', 'completed', 'success'),
      watchdogRun(28, '2026-10-09T23:10:00Z'),
    ]);
    const a = resolveCheckAnchors(gh, { runId: '30', eventName: 'schedule', now });
    expect(a.checkAt.toISOString()).toBe('2026-10-10T15:00:00.000Z');
    // `success` means the run evaluated its window (an alerting run exits 0 too).
    expect(a.previousCheckAt?.toISOString()).toBe('2026-10-10T06:30:00.000Z');
    expect(calls[0]).toContain('actions/workflows/credential-slot-watchdog.yml/runs');
    expect(calls[0]).toContain('event=schedule');
  });

  it('skips a cancelled previous run (it may not have evaluated), reaching back to the one before', () => {
    const { gh } = listing([
      watchdogRun(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      watchdogRun(29, '2026-10-10T06:30:00Z', 'completed', 'cancelled'),
      watchdogRun(28, '2026-10-09T23:10:00Z'),
    ]);
    const a = resolveCheckAnchors(gh, { runId: '30', eventName: 'schedule', now });
    expect(a.previousCheckAt?.toISOString()).toBe('2026-10-09T23:10:00.000Z');
  });

  it('a dispatch is never anchored (full lookback; it never alerts anyway)', () => {
    const { gh, calls } = listing([watchdogRun(28, '2026-10-09T23:10:00Z')]);
    const a = resolveCheckAnchors(gh, { runId: '31', eventName: 'workflow_dispatch', now });
    expect(a).toEqual({ checkAt: now, previousCheckAt: null });
    expect(calls).toEqual([]);
  });

  it('an unreadable listing degrades to the full lookback (may repeat a check, never skips one)', () => {
    const gh = () => {
      throw new Error('api down');
    };
    expect(resolveCheckAnchors(gh, { runId: '30', eventName: 'schedule', now })).toEqual({
      checkAt: now,
      previousCheckAt: null,
    });
  });

  it('runWatchdogFromEnv wires GITHUB_RUN_ID / GITHUB_EVENT_NAME into the window', () => {
    const watchdogRuns = [
      watchdogRun(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      watchdogRun(29, '2026-10-10T07:00:00Z', 'completed', 'success'),
    ];
    const gh = (args: string[]) => {
      const url = args[1] ?? '';
      if (url.includes('credential-slot-watchdog.yml/runs'))
        return JSON.stringify({ total_count: 2, workflow_runs: watchdogRuns });
      if (url.includes('/artifacts')) return JSON.stringify({ artifacts: [] });
      return JSON.stringify({ total_count: 0, workflow_runs: [] });
    };
    const verdicts = runWatchdogFromEnv({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now,
      env: { GITHUB_RUN_ID: '30', GITHUB_EVENT_NAME: 'schedule', WATCHDOG_GRACE_HOURS: '8' },
    });
    // Exactly the four fires in (10-09 23:00, 10-10 07:00] — not the 24 h lookback's twelve.
    expect(verdicts).toHaveLength(4);
  });
});
// ── An early-warning run never stands in for a credential run (round 2) ────
//
// Found by the jittered end-to-end replay above (seed 203): two late
// early-warning runs vouched for each other. The 03:17 one, delayed past bun's
// 05:47 fire, was heuristically placed on bun and counted as bun's "own
// evidence"; that let the 04:47 one, delayed past node-webpack's 06:17 fire, be
// credited to node-webpack — whose real credential run was missing. A run whose
// own mode marker reads `early-warning` is certainly not a credential run, so it
// is dropped before attribution. Only a run with NO readable mode marker falls
// back to the timing heuristic.

describe('a run marked early-warning is never attributed to a credential lane', () => {
  it('attachExactLanes flags a run whose mode marker reads early-warning', () => {
    const gh = () =>
      JSON.stringify({
        artifacts: [{ name: 'compat-lane-bun' }, { name: 'compat-mode-early-warning' }],
      });
    const [run] = attachExactLanes(gh, [
      { id: 7, event: 'schedule', status: 'completed', created_at: 'x', run_started_at: null },
    ]);
    expect(run.exactLane).toBeNull();
    expect(run.earlyWarning).toBe(true);
  });

  it('attachExactLanes does not flag a run whose mode marker is missing (it may be a credential run)', () => {
    const gh = () => JSON.stringify({ artifacts: [{ name: 'compat-lane-bun' }] });
    const [run] = attachExactLanes(gh, [
      { id: 7, event: 'schedule', status: 'completed', created_at: 'x', run_started_at: null },
    ]);
    expect(run.earlyWarning).toBeUndefined();
  });

  it('the seed-203 shape: two late early-warning runs cannot cover a missing node-webpack run', () => {
    const runs = [
      fixtureRun(1, 'schedule', '2026-10-11T01:30:00Z', CRED('node')),
      fixtureRun(2, 'schedule', '2026-10-11T06:00:00Z', EW('node')), // 03:17 + 2.7 h, after bun 05:47
      fixtureRun(3, 'schedule', '2026-10-11T06:40:00Z', CRED('bun')),
      fixtureRun(4, 'schedule', '2026-10-11T07:00:00Z', EW('bun')), // 04:47 + 2.2 h, after node-webpack 06:17
      // node-webpack's 06:17 credential run is MISSING.
      fixtureRun(5, 'schedule', '2026-10-10T23:50:00Z', CRED('bun-webpack')),
    ];
    const { gh } = simGh(runs);
    const verdicts = evaluateWatchdog({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now: new Date('2026-10-11T15:00:00Z'),
      previousCheckAt: new Date('2026-10-11T07:00:00Z'),
      graceHours: 8,
    });
    const nodeWebpack = verdicts.find((v) => v.lane === 'node-webpack');
    expect(nodeWebpack?.slot).toBe('2026-10-11T06:17:00.000Z');
    expect(nodeWebpack?.verdict).toBe('missing');
  });
});
// ── A crashed watchdog run is never an anchor (PR #2013 round 3) ───────────
//
// Round 2 anchored the window on the previous run that concluded `success` OR
// `failure`, because an ALERTING run exited 1. But a run that CRASHED before
// evaluating its window (both run listings down, a job timeout) concludes
// `failure` too, so the next run started its window at the crashed run's start
// and the crashed run's fires were never checked. Round 3 separates the two:
// the CLI exits 0 whenever it evaluated its window and reports the alert
// through the `alert` job output, so `success` means "window evaluated" and is
// the only conclusion that anchors.

describe('a watchdog run that did not evaluate its window is never an anchor (round 3)', () => {
  const run = (
    id: number,
    started: string,
    status = 'completed',
    conclusion: string | null = 'success',
  ) => ({
    id,
    event: 'schedule',
    status,
    conclusion,
    created_at: started,
    run_started_at: started,
    html_url: `https://x/${id}`,
  });
  const listing = (runs: unknown[]) => () =>
    JSON.stringify({ total_count: runs.length, workflow_runs: runs });
  const now = new Date('2026-10-10T15:00:30Z');
  const anchorOf = (runs: unknown[], runId = '30', at = now) =>
    resolveCheckAnchors(listing(runs), { runId, eventName: 'schedule', now: at });

  it('a crashed previous run (failure) is skipped: the window widens back to the last success', () => {
    const a = anchorOf([
      run(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      run(29, '2026-10-10T06:30:00Z', 'completed', 'failure'),
      run(28, '2026-10-09T23:10:00Z'),
    ]);
    expect(a.previousCheckAt?.toISOString()).toBe('2026-10-09T23:10:00.000Z');
    // The crashed run would have checked (10-09 15:10, 10-09 22:30]; this
    // window, (10-09 15:10, 10-10 07:00], contains all of it.
    const w = watchdogWindow({ ...a, graceHours: 8 });
    expect(w.start.toISOString()).toBe('2026-10-09T15:10:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-10T07:00:00.000Z');
    expect(w.gap).toBe(false);
  });

  it.each([
    'cancelled',
    'timed_out',
  ])('a previous run that concluded %s (job timeout, runner loss) is skipped', (conclusion) => {
    const a = anchorOf([
      run(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      run(29, '2026-10-10T06:30:00Z', 'completed', conclusion),
      run(28, '2026-10-09T23:10:00Z'),
    ]);
    expect(a.previousCheckAt?.toISOString()).toBe('2026-10-09T23:10:00.000Z');
  });

  it('a successful DISPATCH run is never an anchor (a dispatch never raises the alert)', () => {
    const a = anchorOf([
      run(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      { ...run(29, '2026-10-10T06:30:00Z'), event: 'workflow_dispatch' },
      run(28, '2026-10-09T23:10:00Z'),
    ]);
    expect(a.previousCheckAt?.toISOString()).toBe('2026-10-09T23:10:00.000Z');
  });

  it('a previous run still in progress is skipped (it has not finished evaluating)', () => {
    const a = anchorOf([
      run(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      run(29, '2026-10-10T14:58:00Z', 'in_progress', null),
      run(28, '2026-10-10T06:30:00Z'),
    ]);
    expect(a.previousCheckAt?.toISOString()).toBe('2026-10-10T06:30:00.000Z');
  });

  it('a crash followed by a successful run: the success re-checked the crashed window, and the next run anchors on it', () => {
    const lanes = resolveCredentialLanes(REAL_WORKFLOW);
    const green28 = run(28, '2026-10-09T23:10:00Z');
    const crashed29 = run(29, '2026-10-10T06:30:00Z', 'completed', 'failure');
    const green30 = run(30, '2026-10-10T15:00:00Z');
    // Run 30, as it saw the listing: itself in progress, 29 crashed, 28 green.
    const at30 = anchorOf(
      [run(30, '2026-10-10T15:00:00Z', 'in_progress', null), crashed29, green28],
      '30',
    );
    // Run 31, eight hours later: 30 finished green.
    const at31 = anchorOf(
      [run(31, '2026-10-10T23:05:00Z', 'in_progress', null), green30, crashed29, green28],
      '31',
      new Date('2026-10-10T23:05:30Z'),
    );
    expect(at31.previousCheckAt?.toISOString()).toBe('2026-10-10T15:00:00.000Z');
    const fires = (a: { checkAt: Date; previousCheckAt: Date | null }) =>
      dueFiresInWindow(lanes, watchdogWindow({ ...a, graceHours: 8 })).map(
        (f) => `${f.lane}@${f.fire.toISOString()}`,
      );
    const crashedWindow = dueFiresInWindow(
      lanes,
      watchdogWindow({
        checkAt: new Date('2026-10-10T06:30:00Z'),
        previousCheckAt: new Date('2026-10-09T23:10:00Z'),
        graceHours: 8,
      }),
    ).map((f) => `${f.lane}@${f.fire.toISOString()}`);
    expect(crashedWindow.length).toBeGreaterThan(0);
    for (const f of crashedWindow) expect(fires(at30)).toContain(f);
    // Consecutive successful windows still meet exactly: nothing skipped, nothing repeated.
    expect(fires(at31).filter((f) => fires(at30).includes(f))).toEqual([]);
    expect(watchdogWindow({ ...at31, graceHours: 8 }).start.getTime()).toBe(
      watchdogWindow({ ...at30, graceHours: 8 }).end.getTime(),
    );
  });

  it('no successful run in view: the window reaches back past the oldest run it can see', () => {
    // The very first watchdog run (lookback window) crashed. Its window was
    // (start - grace - lookback, start - grace]; the next run must cover it.
    const a = anchorOf([
      run(30, '2026-10-10T15:00:00Z', 'in_progress', null),
      run(29, '2026-10-10T06:30:00Z', 'completed', 'failure'),
    ]);
    const w = watchdogWindow({ ...a, graceHours: 8 });
    expect(w.start.toISOString()).toBe(
      new Date(
        Date.parse('2026-10-10T06:30:00Z') - (8 + WATCHDOG_LOOKBACK_HOURS) * 3_600_000,
      ).toISOString(),
    );
    expect(w.gap).toBe(false);
  });

  it('a full listing with no successful run is clamped to the maximum window and flagged as a gap', () => {
    // 30 runs, every earlier one crashed, the oldest ten days back: the last
    // success is out of view, so the fires before the 72 h maximum are not checked.
    const runs = [run(30, '2026-10-20T15:00:00Z', 'in_progress', null)];
    for (let i = 1; i < 30; i += 1) {
      const t = new Date(Date.parse('2026-10-20T15:00:00Z') - i * 8 * 3_600_000).toISOString();
      runs.push(run(30 - i, t, 'completed', 'failure'));
    }
    const a = anchorOf(runs, '30', new Date('2026-10-20T15:00:30Z'));
    expect(watchdogWindow({ ...a, graceHours: 8 }).gap).toBe(true);
  });
});

describe('the CLI reports its verdict through the `alert` output and exits 0 once it evaluated (round 3)', () => {
  const watchdogRuns = [
    {
      id: 30,
      event: 'schedule',
      status: 'in_progress',
      conclusion: null,
      created_at: '2026-10-10T15:00:00Z',
      run_started_at: '2026-10-10T15:00:00Z',
      html_url: 'https://x/30',
    },
    {
      id: 29,
      event: 'schedule',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-10-10T07:00:00Z',
      run_started_at: '2026-10-10T07:00:00Z',
      html_url: 'https://x/29',
    },
  ];
  // (10-09 23:00, 10-10 07:00]: bun-webpack 23:47, node 01:17, bun 05:47, node-webpack 06:17.
  const WINDOW = '(2026-10-09T23:00:00.000Z, 2026-10-10T07:00:00.000Z]';
  const env = { GITHUB_RUN_ID: '30', GITHUB_EVENT_NAME: 'schedule', WATCHDOG_GRACE_HOURS: '8' };
  const now = new Date('2026-10-10T15:00:30Z');
  const ghWith = (e2eRuns: FixtureRun[] | 'down') => (args: string[]) => {
    const url = args[1] ?? '';
    if (url.includes('credential-slot-watchdog.yml/runs')) {
      return JSON.stringify({ total_count: watchdogRuns.length, workflow_runs: watchdogRuns });
    }
    if (e2eRuns === 'down') throw new Error('api down');
    return simGh(e2eRuns).gh(args);
  };
  const cli = (gh: (a: string[]) => string, withOutput = true) => {
    const outputs: Record<string, string> = {};
    const logs: string[] = [];
    const errors: string[] = [];
    const code = runCli({
      workflowYamlText: REAL_WORKFLOW,
      gh,
      now,
      env,
      writeOutput: withOutput
        ? (name: string, value: string) => {
            outputs[name] = value;
            return true;
          }
        : () => false,
      log: (m: string) => logs.push(m),
      error: (m: string) => errors.push(m),
    });
    return { code, outputs, logs, errors };
  };
  const everyFireHasItsRun = (): FixtureRun[] =>
    (
      [
        ['bun-webpack', '2026-10-09T23:50:00Z'],
        ['node', '2026-10-10T01:20:00Z'],
        ['bun', '2026-10-10T05:50:00Z'],
        ['node-webpack', '2026-10-10T06:20:00Z'],
      ] as const
    ).map(([lane, at], i) => fixtureRun(i + 1, 'schedule', at, CRED(lane)));

  it('an alerting window exits 0 and reports alert=true and the window it checked', () => {
    const r = cli(ghWith([]));
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({ window: WINDOW, alert: 'true' });
    expect(r.errors.join('\n')).toContain('4 fire(s) need alerting');
  });

  it('a quiet window exits 0 and reports alert=false', () => {
    const r = cli(ghWith(everyFireHasItsRun()));
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({ window: WINDOW, alert: 'false' });
  });

  it('a crash before evaluating (both run listings down) exits 1 and names the window it did not check', () => {
    const r = cli(ghWith('down'));
    expect(r.code).toBe(1);
    expect(r.outputs.alert).toBeUndefined();
    expect(r.outputs.window).toBe(WINDOW);
    const msg = r.errors.join('\n');
    expect(msg).toContain('::error::');
    expect(msg).toContain(`did NOT check the credential fires in ${WINDOW}`);
    expect(msg).toContain('api down');
  });

  it('an alert with nowhere to report it fails closed (exit 1), never a silent exit 0', () => {
    const r = cli(ghWith([]), false);
    expect(r.code).toBe(1);
  });
});

describe('the alert job keys on the check job `alert` output, or a check that did not finish (round 3)', () => {
  type Step = { id?: string; run?: string; env?: Record<string, string> };
  type Job = { if?: string; outputs?: Record<string, string>; steps?: Step[] };
  const doc = parseYaml(
    readFileSync(
      new URL('../.github/workflows/credential-slot-watchdog.yml', import.meta.url),
      'utf8',
    ),
  ) as { jobs: Record<string, Job> };
  const check = doc.jobs['check-credential-slots'] as Job;
  const alertJob = doc.jobs['slot-watchdog-alert'] as Job;

  /**
   * Evaluate the alert job's `if:` for one scenario. Only the tokens below are
   * substituted; anything else left over makes the evaluation THROW, so a
   * condition this cannot read fails the test rather than passing it.
   */
  function fires(ctx: { event: string; result: string; alert: string }): boolean {
    let js = String(alertJob.if)
      .replace(/\balways\(\)/g, 'true')
      .replace(/\bgithub\.event_name\b/g, JSON.stringify(ctx.event))
      .replace(/\bneeds\.check-credential-slots\.result\b/g, JSON.stringify(ctx.result))
      .replace(/\bneeds\.check-credential-slots\.outputs\.alert\b/g, JSON.stringify(ctx.alert));
    js = js.replace(/!=/g, '!==').replace(/([^!=])==([^=])/g, '$1===$2');
    const bare = js.replace(/'[^']*'|"[^"]*"/g, '');
    if (/[^\s()&|!=]/.test(bare.replace(/\btrue\b/g, ''))) {
      throw new Error(`unreadable alert condition: ${js}`);
    }
    return Function(`"use strict"; return (${js});`)() === true;
  }

  it('the check step exposes `alert` and `window` as job outputs', () => {
    const step = (check.steps ?? []).find((s) =>
      String(s.run ?? '').includes('scripts/credential-slot-watchdog.mjs'),
    );
    expect(step?.id).toBeTruthy();
    expect(check.outputs?.alert).toBe(`\${{ steps.${step?.id}.outputs.alert }}`);
    expect(check.outputs?.window).toBe(`\${{ steps.${step?.id}.outputs.window }}`);
  });

  it('fires on alert=true from a check that succeeded, and on a failed or cancelled check', () => {
    expect(fires({ event: 'schedule', result: 'success', alert: 'true' })).toBe(true);
    expect(fires({ event: 'schedule', result: 'failure', alert: '' })).toBe(true);
    expect(fires({ event: 'schedule', result: 'cancelled', alert: '' })).toBe(true);
  });

  it('stays quiet on alert=false, and never fires for a dispatch', () => {
    expect(fires({ event: 'schedule', result: 'success', alert: 'false' })).toBe(false);
    expect(fires({ event: 'workflow_dispatch', result: 'success', alert: 'true' })).toBe(false);
    expect(fires({ event: 'workflow_dispatch', result: 'failure', alert: '' })).toBe(false);
  });

  it('the issue body names the window a check that did not finish left unchecked', () => {
    const step = (alertJob.steps ?? []).find((s) =>
      String(s.run ?? '').includes('nightly-alert-issue.mjs'),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow text, not an interpolation
    expect(step?.env?.WINDOW).toBe('${{ needs.check-credential-slots.outputs.window }}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow text, not an interpolation
    expect(step?.env?.CHECK_RESULT).toBe('${{ needs.check-credential-slots.result }}');
    expect(step?.run).toContain('${WINDOW');
    expect(step?.run).toContain('CHECK_RESULT');
  });
});
