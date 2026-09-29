import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateWatchdog, fetchScheduledRuns } from '../scripts/credential-slot-watchdog.mjs';
import {
  anyLaneNeedsAlert,
  attributeRunsToLanes,
  computeExpectedSlots,
  DEFAULT_CREDENTIAL_LANES,
  DEFAULT_GRACE_HOURS,
  decideCredentialSlotVerdicts,
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
 * design rationale (why parsing rather than hardcoding, and the documented
 * lane-attribution caveat).
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

describe('resolveCredentialLanes — fallback behaviour', () => {
  it('uses live parsing (not the fallback) against real input', () => {
    const warn = mock(() => {});
    resolveCredentialLanes(REAL_WORKFLOW, { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to DEFAULT_CREDENTIAL_LANES and warns on unparseable input', () => {
    const warn = mock(() => {});
    const lanes = resolveCredentialLanes('not: a\nworkflow: file\n', {
      defaultGraceHours: 8,
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const stripped = lanes.map(({ cron, lane, hour, minute }) => ({ cron, lane, hour, minute }));
    expect(stripped).toEqual(DEFAULT_CREDENTIAL_LANES.map((l) => ({ ...l })));
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

// ── attributeRunsToLanes ─────────────────────────────────────────────────────

const ALL_SLOTS = parseAllDeclaredSlots(REAL_WORKFLOW);

describe('attributeRunsToLanes', () => {
  const now = new Date('2026-09-29T14:00:00Z'); // after every lane's slot today
  const lanes = computeExpectedSlots(resolveCredentialLanes(REAL_WORKFLOW), now);

  it('attributes an on-time run to its own lane', () => {
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
    ];
    const out = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(out).toEqual([
      {
        lane: 'node',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
    ]);
  });

  it('attributes a LATE run (still nearest to its own slot) to the right lane', () => {
    // bun credential slot is 05:47; a run created at 12:00 (the #1640 example)
    // is still nearest to 05:47 among all declared slots (next slot, node-webpack
    // at 22:17, is the PREVIOUS day's occurrence relative to 12:00 today — so
    // its nearest-at-or-before candidate is yesterday 22:17, further away).
    const runs = [
      {
        event: 'schedule',
        status: 'completed',
        created_at: '2026-09-29T12:00:00Z',
        run_started_at: '2026-09-29T12:05:00Z',
      },
    ];
    const out = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(out.map((r) => r.lane)).toEqual(['bun']);
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
    const out = attributeRunsToLanes(runs, lanes, ALL_SLOTS);
    expect(out).toEqual([]);
  });

  it('ignores non-schedule events', () => {
    const runs = [
      {
        event: 'workflow_dispatch',
        status: 'completed',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: '2026-09-29T01:19:00Z',
      },
    ];
    expect(attributeRunsToLanes(runs, lanes, ALL_SLOTS)).toEqual([]);
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
    expect(attributeRunsToLanes(runs, lanes, ALL_SLOTS)).toEqual([]);
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

describe('anyLaneNeedsAlert', () => {
  it('is true if any verdict is not quiet', () => {
    expect(anyLaneNeedsAlert([{ verdict: 'quiet' }, { verdict: 'missing' }])).toBe(true);
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
      {
        event: 'schedule',
        status: 'queued',
        created_at: '2026-09-29T01:18:00Z',
        run_started_at: null,
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
});
