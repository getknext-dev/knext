import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineSpec } from '../scripts/compat-credential-line.mjs';
import { auditLine, fetchLineLedgers } from '../scripts/compat-line-tracker.mjs';
import {
  auditWindow,
  credentialCronForLane,
  DEFAULT_FETCH_LIMIT,
  fetchLedgers,
  formatReport,
  MIN_RUN_SPACING_HOURS,
  parseCredentialCronsFromWorkflow,
  parseScheduleCrons,
  WINDOW_REQUIRED_RUNS,
} from '../scripts/compat-window-audit.mjs';
import { cronsOverlap } from '../scripts/lib/cron-overlap.mjs';

/**
 * ADR-0056 Amendment 5 (founder decision, 2026-10-08): the credential is
 * FOURTEEN CONSECUTIVE GREEN INDEPENDENT RUNS per cell, not fourteen calendar
 * nights. Each cell runs several times a day from one cron literal with a
 * comma-listed hour field; the audit
 *
 *   * places every run on the fire of its cell's cron it belongs to (the latest
 *     fire at or before the run's creation), so a fire with no run is a missing
 *     run that restarts the count, exactly as a missing night did;
 *   * counts a green run only when it STARTED at least MIN_RUN_SPACING_HOURS
 *     after the previous COUNTED run of the same streak — a run that is too close
 *     is not counted, and does not reset the count either;
 *   * keeps every existing integrity rule (a red run resets, a dispatch never
 *     counts, the fingerprint is continuous, the tag is an RC tag).
 */

/** The v1.0 node cell's credential cron (three fires a day, 8 h apart). */
const NODE_CRON = '17 1,9,17 * * *';
const EIGHT_H = 8 * 60 * 60 * 1000;
const FIRST_FIRE = Date.parse('2026-01-01T01:17:00.000Z');

/** A green 16-shard credential run of the node cell, as real ledgers shape it. */
function run(over: Record<string, unknown> = {}) {
  const shards = Array.from({ length: 16 }, (_, i) => ({
    shard: `${i + 1}/16`,
    passed: 49,
    failed: 0,
    notRun: 0,
    runtime: 'node',
    bytecode: { runtime: 'node', deploys: 3, live: 3, notLive: 0, reasons: [] },
  }));
  return {
    runId: '1',
    runAttempt: '1',
    event: 'schedule',
    lane: 'node',
    ref: 'v16.3.8',
    compatMode: 'credential',
    credential: true,
    knextRef: 'refs/tags/v1.0.0-rc.6',
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

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * `n` runs, one per fire of NODE_CRON starting 2026-01-01 01:17 UTC. `delayMin(i)`
 * is GitHub's scheduler delay for run i (creation = start, as measured: every one
 * of 48 scheduled runs 2026-10-01..08 started the minute it was created).
 */
function runsOnFires(
  n: number,
  opts: {
    delayMin?: (i: number) => number;
    over?: (i: number) => Record<string, unknown>;
    skip?: number[];
  } = {},
) {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i += 1) {
    if (opts.skip?.includes(i)) continue;
    const at = FIRST_FIRE + i * EIGHT_H + (opts.delayMin?.(i) ?? 0) * 60_000;
    out.push(
      run({
        runId: String(60000000000 + i * 1000),
        scheduledAt: iso(at),
        startedAt: iso(at),
        ...(opts.over?.(i) ?? {}),
      }),
    );
  }
  return out;
}

/** Audit at a `now` whose cutoff is exactly fire `lastFire` (its 10 h grace elapsed, the next one's not). */
function auditAt(
  runs: Array<Record<string, unknown>>,
  lastFire: number,
  opts: Record<string, unknown> = {},
) {
  return auditWindow(runs, {
    lane: 'node',
    now: new Date(FIRST_FIRE + lastFire * EIGHT_H + 10 * 60 * 60 * 1000 + 60_000),
    credentialCronForLane: () => NODE_CRON,
    ...opts,
  });
}

describe('the credential is 14 consecutive RUNS per cell (ADR-0056 Amendment 5)', () => {
  it('the bar is fourteen runs, with a two-hour minimum spacing', () => {
    expect(WINDOW_REQUIRED_RUNS).toBe(14);
    expect(MIN_RUN_SPACING_HOURS).toBe(2);
  });

  it('14 spaced green runs on one fingerprint = MET, in under five days', () => {
    const a = auditAt(runsOnFires(14), 13);
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    expect(a.longest.nights).toBe(14);
    expect(a.met).toBe(true);
    expect(a.verdict).toBe('MET');
    // Fire 0 is 2026-01-01 01:17, fire 13 is 2026-01-05 17:17: 4 days 16 hours.
    expect(Date.parse(String(runsOnFires(14)[13].startedAt)) - FIRST_FIRE).toBeLessThan(
      5 * 24 * 60 * 60 * 1000,
    );
  });

  it('negative control: 13 spaced green runs are NOT MET', () => {
    const a = auditAt(runsOnFires(13), 12);
    expect(a.longest.nights).toBe(13);
    expect(a.met).toBe(false);
    expect(a.verdict).toBe('NOT MET');
  });

  it('every fire of a multi-hour cron is its own slot, labelled by fire time', () => {
    const a = auditAt(runsOnFires(3), 2);
    expect(a.nights.map((n: { date: string }) => n.date)).toEqual([
      '2026-01-01T01:17Z',
      '2026-01-01T09:17Z',
      '2026-01-01T17:17Z',
    ]);
  });
});

describe('spacing — a run closer than MIN_RUN_SPACING_HOURS to the previous counted run does not count', () => {
  it('a run that started 1 h after the previous counted run is NOT counted (13 of 14 count -> NOT MET)', () => {
    // Run 0 was delayed 7 h (started 08:17); run 1 fired on time at 09:17 — 1 h later.
    const runs = runsOnFires(14, { delayMin: (i) => (i === 0 ? 7 * 60 : 0) });
    const a = auditAt(runs, 13);
    expect(a.calendarChecked).toBe(true);
    expect(a.longest.nights).toBe(13);
    expect(a.met).toBe(false);
    const close = a.nights.find((n: { runId: string }) => n.runId === String(runs[1].runId));
    expect(close.eligible).toBe(true);
    expect(close.counted).toBe(false);
    expect(close.notCountedReason).toMatch(/spacing/);
    expect(a.spacingSkipped.map((s: { runId: string }) => s.runId)).toEqual([
      String(runs[1].runId),
    ]);
  });

  it('a too-close run does NOT reset the streak: the runs either side stay one streak', () => {
    const runs = runsOnFires(15, { delayMin: (i) => (i === 0 ? 7 * 60 : 0) });
    const a = auditAt(runs, 14);
    expect(a.streaks).toHaveLength(1);
    expect(a.longest.nights).toBe(14);
    expect(a.met).toBe(true);
    expect(a.restartsByCause).toEqual({});
  });

  it('spacing is measured on the ACTUAL start time, not on the creation (cron-slot) time', () => {
    // Run 0 was created on time at 01:17 but only STARTED at 08:17 (queued for
    // a runner). By creation time run 1 is 8 h later; by start time, 1 h.
    const runs = runsOnFires(14, {
      over: (i) => (i === 0 ? { startedAt: iso(FIRST_FIRE + 7 * 60 * 60 * 1000) } : {}),
    });
    const a = auditAt(runs, 13);
    expect(a.longest.nights).toBe(13);
    expect(a.met).toBe(false);
  });

  it('spacing is measured from the previous COUNTED run, never from a run that was itself not counted', () => {
    // An hourly cron so three runs can sit 0 h, 1 h and 2.5 h after the first:
    // run 1 is 1 h after run 0 (not counted); run 2 is 1.5 h after run 1 but
    // 2.5 h after run 0, the previous COUNTED run — so it counts.
    const hourly = `0 ${Array.from({ length: 24 }, (_, h) => h).join(',')} * * *`;
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    const H = 60 * 60 * 1000;
    const runs = [0, 1, 2.5].map((h, i) =>
      run({
        runId: String(70000000000 + i),
        scheduledAt: iso(t0 + h * H),
        startedAt: iso(t0 + h * H),
      }),
    );
    const a = auditWindow(runs, {
      lane: 'node',
      now: new Date(t0 + 2 * H + 10 * H + 60_000),
      credentialCronForLane: () => hourly,
    });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    expect(a.nights.map((n: { counted: boolean }) => n.counted)).toEqual([true, false, true]);
    expect(a.longest.nights).toBe(2);
  });

  it('a run with no start timestamp cannot prove its spacing, so it is not counted (fail closed)', () => {
    const runs = runsOnFires(14, { over: (i) => (i === 5 ? { startedAt: 'not-a-time' } : {}) });
    const a = auditAt(runs, 13);
    expect(a.longest.nights).toBe(13);
    expect(a.met).toBe(false);
  });
});

describe('every existing integrity rule still applies to runs', () => {
  it('a red run RESETS the count (7 green + 1 red + 7 green is NOT MET)', () => {
    const runs = runsOnFires(15, {
      over: (i) =>
        i === 7
          ? {
              shards: run().shards.map((s, j) => (j === 0 ? { ...s, failed: 1, passed: 48 } : s)),
            }
          : {},
    });
    const a = auditAt(runs, 14);
    expect(a.longest.nights).toBe(7);
    expect(a.met).toBe(false);
    expect(a.restartsByCause).toEqual({ 'night-disqualified': 1 });
  });

  it('a dispatch never counts — and the slot it does not fill is a missing run that resets', () => {
    const runs = runsOnFires(15, {
      over: (i) => (i === 7 ? { event: 'workflow_dispatch' } : {}),
    });
    const a = auditAt(runs, 14);
    expect(a.nights.some((n: { event: string }) => n.event === 'workflow_dispatch')).toBe(false);
    expect(a.longest.nights).toBe(7);
    expect(a.met).toBe(false);
    expect(a.restartsByCause).toEqual({ 'night-missing': 1 });
  });

  it('a fire with no run at all (dropped or deleted) breaks the streak on a multi-fire calendar', () => {
    const a = auditAt(runsOnFires(15, { skip: [7] }), 14);
    expect(a.missingNights.map((m: { date: string }) => m.date)).toEqual(['2026-01-03T09:17Z']);
    expect(a.unresolvedNights).toContainEqual({
      runId: 'missing:node:2026-01-03T09:17Z',
      reason: 'missing-night',
      date: '2026-01-03T09:17Z',
    });
    expect(a.longest.nights).toBe(7);
    expect(a.met).toBe(false);
  });

  it('a delay longer than the gap between fires fails CLOSED (missing + duplicate), never inflates', () => {
    // Run 7 is delayed 8 h 30 min, past fire 8: it lands in fire 8's slot, so
    // fire 7 reads missing and fire 8 holds two runs.
    const a = auditAt(runsOnFires(15, { delayMin: (i) => (i === 7 ? 8 * 60 + 30 : 0) }), 14);
    expect(a.missingNights.map((m: { date: string }) => m.date)).toEqual(['2026-01-03T09:17Z']);
    expect(
      a.nights.filter((n: { disqualifiers: string[] }) =>
        n.disqualifiers.includes('duplicate-slot'),
      ),
    ).toHaveLength(2);
    expect(a.longest.nights).toBeLessThan(14);
    expect(a.met).toBe(false);
  });

  it('a fingerprint change restarts the count even when the new run is well spaced', () => {
    const runs = runsOnFires(15, {
      over: (i) => (i >= 7 ? { windowFingerprint: 'sha256:bbbb' } : {}),
    });
    const a = auditAt(runs, 14);
    expect(a.longest.nights).toBe(8);
    expect(a.restartsByCause).toEqual({ 'fingerprint-changed': 1 });
  });

  it('a run on a non-RC ref never counts', () => {
    const runs = runsOnFires(14, {
      over: (i) => (i === 3 ? { knextRef: 'refs/heads/main' } : {}),
    });
    const a = auditAt(runs, 13);
    expect(a.met).toBe(false);
  });
});

describe('the report speaks in runs, not nights', () => {
  it('formatReport names the bar in runs and lists a too-close run as not counted', () => {
    const runs = runsOnFires(14, { delayMin: (i) => (i === 0 ? 7 * 60 : 0) });
    const report = formatReport(auditAt(runs, 13));
    expect(report).toContain('gate = 14 runs');
    expect(report).toContain('GATE NOT MET — 1 more consecutive qualifying run(s)');
    expect(report).toMatch(/NOT COUNTED — spacing/);
    expect(report).not.toMatch(/qualifying night/);
  });
});

describe('the real v1.0 workflow schedules three credential runs per cell per day', () => {
  const workflow = readFileSync(
    join(import.meta.dir, '..', '.github', 'workflows', 'test-e2e-deploy.yml'),
    'utf8',
  );

  it('each wired cell resolves to its multi-hour credential cron', () => {
    expect(credentialCronForLane('node')).toBe('17 1,9,17 * * *');
    expect(credentialCronForLane('bun')).toBe('47 5,13,21 * * *');
    expect(credentialCronForLane('node-webpack')).toBe('17 6,14,22 * * *');
    expect(credentialCronForLane('bun-webpack')).toBe('47 7,15,23 * * *');
  });

  it('every credential cron fires 3 times a day, exactly 8 h apart', () => {
    for (const cron of parseCredentialCronsFromWorkflow(workflow).values()) {
      const hours = cron.split(' ')[1].split(',').map(Number);
      expect(hours).toHaveLength(3);
      expect(hours[1] - hours[0]).toBe(8);
      expect(hours[2] - hours[1]).toBe(8);
    }
  });

  it('the parser refuses an hour range, a step or an out-of-range hour (it cannot place those fires)', () => {
    const wf = (cron: string) =>
      [
        'on:',
        '  schedule:',
        `    - cron: '${cron}'`,
        '',
        'env:',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        `  KNEXT_LANE: \${{ github.event.inputs.runtime || 'node' }}`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        `  KNEXT_COMPAT_MODE: \${{ (github.event.schedule == '${cron}' && 'credential') || 'early-warning' }}`,
        '',
      ].join('\n');
    expect(parseCredentialCronsFromWorkflow(wf('17 1,9,17 * * *')).get('node')).toBe(
      '17 1,9,17 * * *',
    );
    expect(() => parseCredentialCronsFromWorkflow(wf('17 1-17 * * *'))).toThrow();
    expect(() => parseCredentialCronsFromWorkflow(wf('17 */8 * * *'))).toThrow();
    expect(() => parseCredentialCronsFromWorkflow(wf('17 1,25 * * *'))).toThrow();
    expect(() => parseCredentialCronsFromWorkflow(wf('17 1,1,9 * * *'))).toThrow();
  });

  it('the fetch horizon holds two full 14-run windows of every scheduled run the workflow fires', () => {
    let firesPerDay = 0;
    for (const cron of parseScheduleCrons(workflow)) {
      firesPerDay += cron.split(' ')[1].split(',').length;
    }
    const daysPerWindow = Math.ceil(WINDOW_REQUIRED_RUNS / 3);
    expect(DEFAULT_FETCH_LIMIT).toBeGreaterThanOrEqual(2 * firesPerDay * daysPerWindow);
  });
});

describe('fetchLedgers records each run’s ACTUAL start time', () => {
  it('threads gh run list startedAt onto every fetched ledger', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 1,
            status: 'completed',
            event: 'schedule',
            createdAt: '2026-01-01T01:20:00Z',
            startedAt: '2026-01-01T03:00:00Z',
          },
        ]);
      }
      if (args[0] === 'api') {
        return JSON.stringify({
          artifacts: [{ name: 'compat-run-ledger', expired: false }],
          total_count: 1,
        });
      }
      return '';
    };
    const out = fetchLedgers(10, { gh, readDir: () => [run({ runId: '1' })] });
    expect(out[0]).toMatchObject({
      scheduledAt: '2026-01-01T01:20:00Z',
      startedAt: '2026-01-01T03:00:00Z',
    });
    expect(calls[0].join(' ')).toContain('startedAt');
  });
});

describe('v1.0 and v1.3 stay separated under the runs model', () => {
  const V13 = lineSpec('v1.3');
  const V13_WORKFLOW = readFileSync(
    join(import.meta.dir, '..', '.github', 'workflows', V13.workflowFile),
    'utf8',
  );
  const V10_WORKFLOW = readFileSync(
    join(import.meta.dir, '..', '.github', 'workflows', 'test-e2e-deploy.yml'),
    'utf8',
  );
  const listedWorkflow = (fetch: (gh: (a: string[]) => string) => unknown) => {
    const seen: string[] = [];
    fetch((args) => {
      if (args[0] === 'run' && args[1] === 'list') seen.push(args[args.indexOf('--workflow') + 1]);
      return '[]';
    });
    return seen;
  };

  it('each audit lists only its own workflow’s runs', () => {
    expect(listedWorkflow((gh) => fetchLedgers(10, { gh }))).toEqual(['test-e2e-deploy.yml']);
    expect(listedWorkflow((gh) => fetchLineLedgers('v1.3', 10, { gh }))).toEqual([
      V13.workflowFile,
    ]);
  });

  it('the two lines never share a fire (every credential cron of one against every cron of the other)', () => {
    const v10 = [...parseScheduleCrons(V10_WORKFLOW)];
    const v13 = [...parseScheduleCrons(V13_WORKFLOW)];
    expect(v13).toHaveLength(4);
    for (const a of v13)
      for (const b of v10) expect(cronsOverlap(a, b), `${a} vs ${b}`).toBe(false);
  });

  it('a v1.0-tag run never banks in the v1.3 window, even fourteen spaced green ones', () => {
    // node × turbopack on the v1.3 grid (00:32, 08:32, 16:32), 14 spaced
    // green runs — one of them on the v1.0 tag.
    const first = Date.parse('2026-01-01T00:32:00.000Z');
    const runs = Array.from({ length: 14 }, (_, i) => {
      const at = iso(first + i * EIGHT_H);
      return run({
        runId: String(80000000000 + i),
        scheduledAt: at,
        startedAt: at,
        knextRef: i === 6 ? 'refs/tags/v1.0.0-rc.6' : 'refs/tags/v1.3.0-rc.9',
      });
    });
    const now = new Date(first + 13 * EIGHT_H + 10 * 60 * 60 * 1000 + 60_000);
    const a = auditLine(runs, { line: 'v1.3', workflowText: V13_WORKFLOW, now });
    expect(a.cells.node.offLineNights).toHaveLength(1);
    expect(a.cells.node.met).toBe(false);
    // The other half: the same fourteen, all on the v1.3 tag, DO meet it.
    const clean = runs.map((r) => ({ ...r, knextRef: 'refs/tags/v1.3.0-rc.9' }));
    expect(auditLine(clean, { line: 'v1.3', workflowText: V13_WORKFLOW, now }).cells.node.met).toBe(
      true,
    );
  });
});
