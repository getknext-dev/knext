import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditWindow,
  fetchLedgers,
  formatReport,
  gradeNight,
  readLedgerDir,
  selectLaneNights,
  unresolvedNight,
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
      expect(selectLaneNights(ledgers, 'node').map((l: { runId: string }) => l.runId)).toEqual([
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
      expect(a.nights.filter((n: { eligible: boolean }) => !n.eligible)).toHaveLength(1);
    });

    it('the fingerprint that restarts the count is reported, so the cause is attributable', () => {
      const a = auditWindow([
        ...streakOf(2, 'sha256:aaaa', 40000000000),
        ...streakOf(2, 'sha256:bbbb', 41000000000),
      ]);
      expect(a.streaks.map((s) => s.fingerprint)).toEqual(['sha256:aaaa', 'sha256:bbbb']);
    });

    it('MET reads the LONGEST streak, SHORTFALL reads the CURRENT one — and the report says both', () => {
      // A completed window followed by a fingerprint change. The two fields
      // answer different questions on purpose (see auditWindow's comment); the
      // guard here is that the verdict LINE can never be read as "we are
      // fourteen nights green right now".
      const a = auditWindow([
        ...streakOf(14, 'sha256:aaaa', 40000000000),
        ...streakOf(2, 'sha256:bbbb', 41000000000),
      ]);
      expect(a.met).toBe(true);
      expect(a.longest.nights).toBe(14);
      expect(a.current.nights).toBe(2);
      expect(a.shortfall).toBe(12);
      const report = formatReport(a);
      expect(report).toContain('GATE MET');
      // Both numbers present, so the reader cannot take MET for "right now".
      expect(report).toMatch(/GATE MET[^\n]*CURRENT streak is 2 \/ 14/);
    });
  });

  /**
   * The arithmetic a reader would otherwise do by hand.
   *
   * `window-node-lane.md` and `docs/wayfinder/w6-compat-flakiness.md` both state
   * their restart and fingerprint numbers as "the audit's output". They were
   * not: they were hand arithmetic, and three of them disagreed with what the
   * script actually produced. A number a document attributes to an instrument
   * has to be a number that instrument emits.
   */
  describe('the counts a doc would otherwise derive by hand', () => {
    it('tallies restarts BY CAUSE, and does not conflate a move with a restart', () => {
      const shards = night().shards;
      shards[0] = { ...shards[0], passed: 48, failed: 1 };
      const a = auditWindow([
        ...streakOf(2, 'sha256:aaaa', 40000000000),
        // A red night that ALSO carries a new fingerprint. One move; the
        // restart is booked to the disqualification, because that is the rule
        // that reset the count.
        night({ runId: '40002500000', windowFingerprint: 'sha256:bbbb', shards }),
        ...streakOf(2, 'sha256:bbbb', 40003000000),
        ...streakOf(2, 'sha256:cccc', 40005000000),
      ]);
      expect(a.restartsByCause).toEqual({ 'night-disqualified': 1, 'fingerprint-changed': 1 });
      // Two moves (aaaa→bbbb, bbbb→cccc) but only one `fingerprint-changed`
      // restart — the counts are different questions and must not be equated.
      expect(a.fingerprintMoves).toHaveLength(2);
      expect(a.distinctFingerprints).toBe(3);
      expect(a.fingerprintsRecorded).toBe(7);
    });

    it('attributes each move to the frozen COMPONENTS that changed (ADR-0039 harness vs packed)', () => {
      // This is what decides whether "freeze the packed dist bytes" is a
      // sufficient remedy. A harness-only move is a counter-example to it.
      const withComponents = (runId: string, fp: string, components: Record<string, string>) =>
        night({
          runId,
          windowFingerprint: fp,
          windowFingerprintComponents: components,
        });
      const a = auditWindow([
        withComponents('40000000000', 'sha256:aaaa', { harness: 'h1', packed: 'p1' }),
        withComponents('40000001000', 'sha256:bbbb', { harness: 'h2', packed: 'p1' }),
        withComponents('40000002000', 'sha256:cccc', { harness: 'h2', packed: 'p2' }),
        withComponents('40000003000', 'sha256:dddd', { harness: 'h3', packed: 'p3' }),
      ]);
      expect(
        a.fingerprintMoves.map((m: { componentsChanged: string[] }) => m.componentsChanged),
      ).toEqual([['harness'], ['packed'], ['harness', 'packed']]);
      expect(a.movesByComponent).toEqual({ harness: 2, packed: 2 });

      // And it must SAY which moves a single-component freeze would not have
      // prevented, by run id — a summary count alone lets the reader assume the
      // remedy covers everything.
      const report = formatReport(a);
      expect(report).toContain('40000001000: harness ONLY');
      expect(report).toContain('40000002000: packed ONLY');
      expect(report).not.toContain('40000003000: ');
    });

    it('prints the restart and fingerprint tallies, so a doc can quote the instrument', () => {
      const report = formatReport(auditWindow(streakOf(3, 'sha256:aaaa')));
      expect(report).toContain('streak restarts: 0');
      expect(report).toContain('fingerprint moves: 0 across 3 night(s) carrying one');
      expect(report).toContain('1 distinct fingerprint(s)');
    });
  });

  /**
   * RULE 5 — a scheduled run whose ledger could not be obtained is a
   * DISQUALIFIED night, never an absence.
   *
   * WHY THIS IS THE SHARPEST RULE IN THE FILE. `auditWindow` joins the nights
   * it is given. A night that is silently dropped is therefore not neutral: the
   * nights on either side of it MERGE into one longer streak. A transient
   * `gh run download` failure — which is not hypothetical, it happened on run
   * 32621148829 during the 2026-08-24 review of this very script — would then
   * report a streak LONGER than reality, which is the one direction that
   * flatters us.
   *
   * This is `compat-run-ledger.mjs:200-206`'s own rule one level up: "the
   * expected shard count is DECLARED ... and NEVER inferred from what arrived —
   * inference is the bug". The audit must not infer its NIGHT set from what
   * arrived either.
   */
  describe('rule 5 — a night we could not read is disqualified, never absent', () => {
    it('a dropped night does NOT merge the streaks either side of it', () => {
      const before = streakOf(2, 'sha256:aaaa', 40000000000);
      const after = streakOf(2, 'sha256:aaaa', 41000000000);

      // The bug, stated as the contrast that makes it visible: with the night
      // simply MISSING, four nights on one fingerprint look like one streak.
      const silentlyDropped = auditWindow([...before, ...after]);
      expect(silentlyDropped.longest.nights).toBe(4);

      // With the same night RECORDED as unresolved, the streak is honestly 2.
      const honest = auditWindow([
        ...before,
        unresolvedNight('40500000000', 'artifact-download-failed'),
        ...after,
      ]);
      expect(honest.longest.nights).toBe(2);
      expect(honest.streaks).toHaveLength(2);
      expect(honest.streaks[1].restartCause).toBe('night-unresolved');
      expect(honest.current.nights).toBe(2);
    });

    it('an unresolved night is graded as disqualified, and the reason IS the disqualifier', () => {
      const g = gradeNight(unresolvedNight('32621148829', 'artifact-expired'));
      expect(g.eligible).toBe(false);
      expect(g.disqualifiers).toEqual(['artifact-expired']);
      expect(g.unresolved).toBe('artifact-expired');
      // It must not be scored as a clean sheet: null-ish everywhere, 0/0/0.
      expect(g.fingerprint).toBeNull();
      expect(g.passed).toBe(0);
    });

    it('an unresolved night enters EVERY lane`s window, because its lane is what we failed to read', () => {
      // Fail closed. Excluding it "because it is probably the bun weekly" is
      // the inference the ledger forbids — and it is what merges two streaks.
      const ledgers = [
        night({ runId: '40000000000' }),
        unresolvedNight('40000000001', 'no-ledger'),
        night({ runId: '40000000002', lane: 'bun' }),
      ];
      expect(selectLaneNights(ledgers, 'node').map((l: { runId: string }) => l.runId)).toEqual([
        '40000000000',
        '40000000001',
      ]);
      expect(selectLaneNights(ledgers, 'bun').map((l: { runId: string }) => l.runId)).toEqual([
        '40000000001',
        '40000000002',
      ]);
    });

    it('the audit surfaces every unresolved night by run id and reason, and prints them', () => {
      const a = auditWindow([
        ...streakOf(2, 'sha256:aaaa', 40000000000),
        unresolvedNight('40500000000', 'artifact-expired'),
      ]);
      expect(a.unresolvedNights).toEqual([{ runId: '40500000000', reason: 'artifact-expired' }]);
      const report = formatReport(a);
      expect(report).toContain('UNRESOLVED: 1 scheduled run(s)');
      expect(report).toContain('40500000000  artifact-expired');
    });

    it('the reason vocabulary is closed — an unenumerated reason throws rather than being recorded', () => {
      expect(() => unresolvedNight('1', 'probably-fine' as never)).toThrow(/unknown unresolved/);
    });
  });

  describe('readLedgerDir — an unreadable ledger is a hard failure, not a skipped night', () => {
    let dir: string | null = null;
    const makeDir = () => {
      dir = mkdtempSync(join(tmpdir(), 'compat-window-audit-spec-'));
      return dir;
    };
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    it('reads well-formed ledgers', () => {
      const d = makeDir();
      writeFileSync(join(d, 'a.json'), JSON.stringify(night()));
      expect(readLedgerDir(d)).toHaveLength(1);
    });

    it('THROWS on a file that does not parse — the old code returned null and filtered it away', () => {
      const d = makeDir();
      writeFileSync(join(d, 'a.json'), JSON.stringify(night()));
      writeFileSync(join(d, 'b.json'), '{ truncated');
      expect(() => readLedgerDir(d)).toThrow(/not readable JSON/);
    });

    it('THROWS on a JSON file that is not a ledger, rather than dropping it', () => {
      const d = makeDir();
      writeFileSync(join(d, 'a.json'), JSON.stringify({ runId: '1' }));
      expect(() => readLedgerDir(d)).toThrow(/shards/);
    });
  });

  /**
   * The reconciliation itself: `gh run list` is the DENOMINATOR. Every
   * completed scheduled run it names leaves `fetchLedgers` as either a ledger
   * or an unresolved night — never as nothing.
   */
  describe('fetchLedgers — the run list is the denominator, not the download results', () => {
    type GhCase = {
      artifacts?: Array<{ name: string; expired: boolean }>;
      artifactsThrow?: boolean;
      downloadThrow?: boolean;
      ledgers?: unknown[];
    };

    function fakeGh(runs: Array<Record<string, unknown>>, cases: Record<string, GhCase>) {
      const readDir = (dir: string) => {
        const id = dir.replace('.compat-window-audit-', '');
        return (cases[id]?.ledgers ?? []) as unknown[];
      };
      const gh = (args: string[]) => {
        if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runs);
        if (args[0] === 'api') {
          const id = /runs\/(\d+)\/artifacts/.exec(args[1])?.[1] ?? '';
          if (cases[id]?.artifactsThrow) throw new Error('gh api failed');
          return JSON.stringify({ artifacts: cases[id]?.artifacts ?? [] });
        }
        if (args[0] === 'run' && args[1] === 'download') {
          if (cases[args[2]]?.downloadThrow) throw new Error('gh run download failed');
          return '';
        }
        throw new Error(`unexpected gh ${args.join(' ')}`);
      };
      return { gh, readDir };
    }

    const live = [{ name: 'compat-run-ledger', expired: false }];

    it('a TRANSIENT download failure becomes an unresolved night, not a vanished one', () => {
      // The measured trigger: `gh run download 32621148829` failed once during
      // review on an artifact that existed and was not expired.
      const out = fetchLedgers(
        10,
        fakeGh(
          [
            { databaseId: 1, status: 'completed', event: 'schedule' },
            { databaseId: 2, status: 'completed', event: 'schedule' },
          ],
          {
            '1': { artifacts: live, ledgers: [night({ runId: '1' })] },
            '2': { artifacts: live, downloadThrow: true },
          },
        ),
      );
      expect(out).toHaveLength(2);
      expect(out[1]).toMatchObject({ runId: '2', unresolved: 'artifact-download-failed' });
    });

    it('an EXPIRED artifact is distinguished from one that never existed', () => {
      const out = fetchLedgers(
        10,
        fakeGh(
          [
            { databaseId: 1, status: 'completed', event: 'schedule' },
            { databaseId: 2, status: 'completed', event: 'schedule' },
          ],
          {
            '1': { artifacts: [{ name: 'compat-run-ledger', expired: true }] },
            '2': { artifacts: [{ name: 'something-else', expired: false }] },
          },
        ),
      );
      expect(out.map((l: { unresolved: string }) => l.unresolved)).toEqual([
        'artifact-expired',
        'no-ledger',
      ]);
    });

    it('an unreachable artifacts API is an unresolved night, not a skipped iteration', () => {
      const out = fetchLedgers(
        10,
        fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
          '1': { artifactsThrow: true },
        }),
      );
      expect(out).toMatchObject([{ runId: '1', unresolved: 'artifact-api-unreachable' }]);
    });

    it('a downloaded artifact containing no ledger is unresolved, not an empty success', () => {
      const out = fetchLedgers(
        10,
        fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
          '1': { artifacts: live, ledgers: [] },
        }),
      );
      expect(out).toMatchObject([{ runId: '1', unresolved: 'ledger-unreadable' }]);
    });

    it('every completed scheduled run in the list is accounted for — none may vanish', () => {
      const runs = Array.from({ length: 6 }, (_, i) => ({
        databaseId: i + 1,
        status: 'completed',
        event: 'schedule',
      }));
      const out = fetchLedgers(
        10,
        fakeGh(runs, {
          '1': { artifacts: live, ledgers: [night({ runId: '1' })] },
          '2': { artifactsThrow: true },
          '3': { artifacts: [] },
          '4': { artifacts: [{ name: 'compat-run-ledger', expired: true }] },
          '5': { artifacts: live, downloadThrow: true },
          '6': { artifacts: live, ledgers: [night({ runId: '6' })] },
        }),
      );
      expect(out.map((l: { runId: string }) => l.runId)).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    it('retries a transient read, and STILL records an unresolved night when every attempt fails', () => {
      // Retrying a READ is not the retry ADR-0007 forbids — nothing here can
      // change a verdict, only whether one was legible. The guard is that the
      // retry must not become a way for a night to disappear after all.
      let calls = 0;
      const flaky = {
        gh: (args: string[]) => {
          if (args[0] === 'run' && args[1] === 'list') {
            return JSON.stringify([
              { databaseId: 1, status: 'completed', event: 'schedule' },
              { databaseId: 2, status: 'completed', event: 'schedule' },
            ]);
          }
          if (args[0] === 'api') {
            const id = /runs\/(\d+)\/artifacts/.exec(args[1])?.[1] ?? '';
            // Run 1 fails once then succeeds; run 2 never succeeds.
            if (id === '1' && calls++ < 1) throw new Error('transient');
            if (id === '2') throw new Error('permanent');
            return JSON.stringify({ artifacts: live });
          }
          return '';
        },
        readDir: () => [night({ runId: '1' })],
        attempts: 3,
      };
      const out = fetchLedgers(10, flaky);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ runId: '1', lane: 'node' });
      expect(out[1]).toMatchObject({ runId: '2', unresolved: 'artifact-api-unreachable' });
    });

    it('an in-flight or non-scheduled run is not a night, and needs no placeholder', () => {
      const out = fetchLedgers(
        10,
        fakeGh(
          [
            { databaseId: 1, status: 'in_progress', event: 'schedule' },
            { databaseId: 2, status: 'completed', event: 'push' },
            { databaseId: 3, status: 'completed', event: 'workflow_dispatch' },
          ],
          {},
        ),
      );
      expect(out).toEqual([]);
    });
  });
});
