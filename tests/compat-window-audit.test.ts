import { describe, expect, it } from 'vitest';
import {
  auditWindow,
  gradeNight,
  selectLaneNights,
  WINDOW_REQUIRED_NIGHTS,
} from '../scripts/compat-window-audit.mjs';

/**
 * #545 AC 1 + AC 3 — "per-shard outcomes for the last N scheduled runs are
 * recorded and queryable" and "make flakiness visible rather than incidental".
 *
 * WHY THIS EXISTS, MEASURED. The v1.0 gate is fourteen consecutive scheduled
 * node-lane nights (docs/compat/window-node-lane.md). Until now the only way to
 * know how many had accrued was to download the `compat-run-ledger` artifact of
 * every scheduled run by hand and eyeball it — which is exactly what
 * docs/wayfinder/w6-compat-flakiness.md had to do, and what this audit of
 * 2026-08-01 → 2026-08-24 had to do again. Two hand reconstructions of the same
 * number is the definition of folklore. This module makes the number a
 * function of the ledgers.
 *
 * The rules graded here are window-node-lane.md's own, plus two hardenings that
 * only ever point AWAY from green:
 *
 *   * the SHORT-LEDGER rule. window-node-lane.md says in its own words that
 *     rule 2 ("every shard failed:0/notRun:0") is satisfied VACUOUSLY by an
 *     absent shard, and that it "needs a shard-COUNT assertion (16 present)".
 *     Run 30790778590 (2026-08-03) is the live instance: fifteen green shards,
 *     one shard lost to a runner disconnect, ledger totals 730/0/0 — a clean
 *     sheet for a night the gate went red. #695 gave the ledger
 *     shardsExpected/shardsSeen; this grades on them.
 *   * the RERUN rule. #545's own architecture note: "a shard that needed a
 *     retry is not the same as a shard that passed, and the matrix should not
 *     treat them as equal". A night whose run was re-attempted is not a
 *     qualifying night here, whatever it concluded.
 */

type ShardRow = Record<string, unknown> & { shard: string };

/** A green 16-shard node night, as the real ledgers shape it. */
function night(over: Record<string, unknown> = {}) {
  const shards: ShardRow[] = Array.from({ length: 16 }, (_, i) => ({
    shard: `${i + 1}/16`,
    passed: 49,
    failed: 0,
    notRun: 0,
    runtime: 'node',
  }));
  return {
    runId: '31149348286',
    runAttempt: '1',
    event: 'schedule',
    lane: 'node',
    ref: 'v16.2.0',
    complete: true,
    shardsExpected: 16,
    shardsSeen: 16,
    missingShards: [],
    windowFingerprint: 'sha256:aaaa',
    shards,
    ...over,
  };
}

/**
 * Disqualifier reasons are `token` or `token: detail` — assert on the token so
 * a test does not pin the human-readable half.
 */
function hasReason(graded: { disqualifiers: string[] }, token: string) {
  return graded.disqualifiers.some((d) => d === token || d.startsWith(`${token}:`));
}

/** n consecutive green node nights sharing one fingerprint. */
function streakOf(n: number, fingerprint: string, startId = 40000000000) {
  return Array.from({ length: n }, (_, i) =>
    night({ runId: String(startId + i * 1000), windowFingerprint: fingerprint }),
  );
}

describe('compat-window-audit — the v1.0 node-lane window, computed not recalled', () => {
  it('the required-nights constant is the gate the roadmap states', () => {
    expect(WINDOW_REQUIRED_NIGHTS).toBe(14);
  });

  describe('gradeNight — one night against the rules it can be judged on alone', () => {
    it('a clean 16-shard scheduled node night is eligible', () => {
      const g = gradeNight(night());
      expect(g.disqualifiers).toEqual([]);
      expect(g.eligible).toBe(true);
      expect(g.passed).toBe(16 * 49);
      expect(g.failed).toBe(0);
    });

    it('SHORT LEDGER: fifteen green shards of an expected sixteen is NOT a green night (#695)', () => {
      // The 2026-08-03 shape, reduced: every PRESENT shard is failed:0/notRun:0,
      // so rule 2 read over the ledger's contents alone passes vacuously.
      const g = gradeNight(
        night({
          runId: '30790778590',
          shards: Array.from({ length: 15 }, (_, i) => ({
            shard: `${i + 1}/16`,
            passed: 49,
            failed: 0,
            notRun: 0,
          })),
          shardsSeen: 15,
          missingShards: ['16/16'],
          complete: false,
        }),
      );
      expect(g.eligible).toBe(false);
      expect(hasReason(g, 'short-ledger')).toBe(true);
      // The reason must name the count, not just say "incomplete" — the whole
      // point is that 15-vs-16 is the invisible part.
      expect(g.disqualifiers.join(' ')).toMatch(/15\D+16/);
    });

    it('SHORT LEDGER fires on a shard-count shortfall even if `complete` claims true', () => {
      // Fail closed: the ledger's own boolean is not the only evidence. A
      // producer bug that sets complete:true on a short ledger must not buy a
      // qualifying night.
      const g = gradeNight(
        night({
          shards: Array.from({ length: 15 }, (_, i) => ({
            shard: `${i + 1}/16`,
            passed: 49,
            failed: 0,
            notRun: 0,
          })),
          shardsSeen: 15,
          complete: true,
        }),
      );
      expect(g.eligible).toBe(false);
      expect(hasReason(g, 'short-ledger')).toBe(true);
    });

    it('a red shard disqualifies, and the reason names the shard', () => {
      const shards = night().shards;
      shards[5] = { ...shards[5], passed: 48, failed: 1 };
      const g = gradeNight(night({ shards }));
      expect(g.eligible).toBe(false);
      expect(g.disqualifiers.join(' ')).toContain('6/16');
      expect(g.failed).toBe(1);
    });

    it('notRun>0 disqualifies as hard as failed>0 (a shard that enumerated nothing is not a pass)', () => {
      const shards = night().shards;
      shards[0] = { ...shards[0], passed: 0, notRun: 49 };
      expect(gradeNight(night({ shards })).eligible).toBe(false);
    });

    it('a null-count shard row (the #695 "missing" row) disqualifies rather than summing as zero', () => {
      const shards = night().shards;
      shards[3] = { shard: '4/16', status: 'missing', passed: null, failed: null, notRun: null };
      const g = gradeNight(night({ shards }));
      expect(g.eligible).toBe(false);
      expect(g.disqualifiers.join(' ')).toContain('4/16');
    });

    it('RERUN: a second attempt is not a qualifying night, however it concluded (#545)', () => {
      const g = gradeNight(night({ runAttempt: '2' }));
      expect(g.eligible).toBe(false);
      expect(g.disqualifiers).toContain('rerun');
    });

    it('a night with no recorded fingerprint cannot count (ADR-0039 fails on a missing one)', () => {
      const g = gradeNight(night({ windowFingerprint: undefined }));
      expect(g.eligible).toBe(false);
      expect(g.disqualifiers).toContain('no-fingerprint');
    });

    it('a workflow_dispatch run is not a scheduled night', () => {
      expect(gradeNight(night({ event: 'workflow_dispatch' })).eligible).toBe(false);
    });

    it('the wrong lane is not this window`s night', () => {
      expect(gradeNight(night({ lane: 'bun' }), { lane: 'node' }).eligible).toBe(false);
    });
  });

  describe('selectLaneNights — the bun weekly must not break the node streak', () => {
    it('drops other-lane and non-scheduled runs, and sorts ascending by run id', () => {
      const ledgers = [
        night({ runId: '31294965728' }),
        night({ runId: '31297820716', lane: 'bun' }),
        night({ runId: '31239550517' }),
        night({ runId: '31300000000', event: 'workflow_dispatch' }),
      ];
      expect(selectLaneNights(ledgers, 'node').map((l) => l.runId)).toEqual([
        '31239550517',
        '31294965728',
      ]);
    });
  });

  describe('auditWindow — the streak, and what restarts it', () => {
    it('fourteen green nights on ONE fingerprint meets the gate', () => {
      const a = auditWindow(streakOf(14, 'sha256:aaaa'));
      expect(a.met).toBe(true);
      expect(a.longest.nights).toBe(14);
      expect(a.shortfall).toBe(0);
    });

    it('a FINGERPRINT CHANGE restarts the count even though every night is green', () => {
      // This is the measured 2026-08 shape: the node lane is green every night
      // and the window still never accrues, because the packed @getknext/*
      // closure moves on merges to main.
      const a = auditWindow([
        ...streakOf(7, 'sha256:aaaa', 40000000000),
        ...streakOf(5, 'sha256:bbbb', 41000000000),
      ]);
      expect(a.met).toBe(false);
      expect(a.longest.nights).toBe(7);
      expect(a.current.nights).toBe(5);
      expect(a.shortfall).toBe(9);
      expect(a.streaks).toHaveLength(2);
      expect(a.streaks[1].restartCause).toBe('fingerprint-changed');
    });

    it('an interleaved BUN weekly does not break a node streak', () => {
      const nights = streakOf(14, 'sha256:aaaa');
      const withBun = [
        ...nights.slice(0, 7),
        night({ runId: '40006500', lane: 'bun', windowFingerprint: 'sha256:aaaa' }),
        ...nights.slice(7),
      ];
      expect(auditWindow(withBun).met).toBe(true);
    });

    it('a red night restarts the count, and the restart names it', () => {
      const shards = night().shards;
      shards[7] = { ...shards[7], passed: 47, failed: 2 };
      const a = auditWindow([
        ...streakOf(6, 'sha256:aaaa', 40000000000),
        night({ runId: '40007000000', windowFingerprint: 'sha256:aaaa', shards }),
        ...streakOf(3, 'sha256:aaaa', 40008000000),
      ]);
      expect(a.met).toBe(false);
      expect(a.longest.nights).toBe(6);
      expect(a.current.nights).toBe(3);
      expect(a.streaks.at(-1)?.restartCause).toBe('night-disqualified');
    });

    it('an empty ledger set is an honest zero, never a vacuous pass', () => {
      const a = auditWindow([]);
      expect(a.met).toBe(false);
      expect(a.longest.nights).toBe(0);
      expect(a.current.nights).toBe(0);
      expect(a.shortfall).toBe(WINDOW_REQUIRED_NIGHTS);
    });

    it('every night is reported, disqualified ones included — a log of only successes is not evidence', () => {
      const a = auditWindow([
        ...streakOf(2, 'sha256:aaaa', 40000000000),
        night({ runId: '40002500', runAttempt: '2', windowFingerprint: 'sha256:aaaa' }),
      ]);
      expect(a.nights).toHaveLength(3);
      expect(a.nights.filter((n) => !n.eligible)).toHaveLength(1);
    });

    it('the fingerprint that restarts the count is reported, so the cause is attributable', () => {
      const a = auditWindow([
        ...streakOf(2, 'sha256:aaaa', 40000000000),
        ...streakOf(2, 'sha256:bbbb', 41000000000),
      ]);
      expect(a.streaks.map((s) => s.fingerprint)).toEqual(['sha256:aaaa', 'sha256:bbbb']);
    });
  });
});
