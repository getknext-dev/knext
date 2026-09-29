import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  auditCredentialMatrix,
  auditWindow,
  CREDENTIAL_CELLS,
  credentialCronForLane,
  DEFAULT_FETCH_LIMIT,
  fetchLedgers,
  formatMatrix,
  formatReport,
  gradeNight,
  MISSING_NIGHT_GRACE_HOURS,
  parseCredentialCronsFromWorkflow,
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

/** Live bytecode-caching evidence for one shard (tests/bytecode-liveness.test.ts). */
function liveBytecode(runtime: string) {
  return { runtime, deploys: 3, live: 3, notLive: 0, reasons: [] };
}

/** A green 16-shard node night, as the real ledgers shape it. */
function night(over: Record<string, unknown> = {}) {
  const lane = (over.lane as string) ?? 'node';
  const shards: ShardRow[] = Array.from({ length: 16 }, (_, i) => ({
    shard: `${i + 1}/16`,
    passed: 49,
    failed: 0,
    notRun: 0,
    runtime: 'node',
    bytecode: liveBytecode(lane.startsWith('bun') ? 'bun' : 'node'),
  }));
  return {
    runId: '31149348286',
    runAttempt: '1',
    event: 'schedule',
    lane: 'node',
    ref: 'v16.2.0',
    // #850 / ADR-0056 — a CREDENTIAL night on a frozen RC tag, because that is
    // the only kind the credential window grades. Every rule below is asserted
    // on the nights that can actually count; `main` (early-warning) nights are
    // covered in tests/compat-credential-ref.test.ts.
    compatMode: 'credential',
    credential: true,
    knextRef: 'refs/tags/v1.0.0-rc.1',
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

/**
 * Disqualifier reasons are `token` or `token: detail` — assert on the token so
 * a test does not pin the human-readable half.
 */
function hasReason(graded: { disqualifiers: string[] }, token: string) {
  return graded.disqualifiers.some((d) => d === token || d.startsWith(`${token}:`));
}

/**
 * #1612 round 2 — rule 8 fails CLOSED: a credential window whose nights carry
 * no scheduling date can never meet the gate. So every fixture that asserts
 * `met: true` must sit on a real calendar. This stamps the in-scope nights of
 * `lane` (in the order given) onto consecutive daily slots of the node cron
 * (01:17 UTC) from 2026-01-01, and audits at a `now` whose cutoff is exactly
 * the last stamped slot — so no gap exists except one a test puts there.
 */
function auditDated(ledgers: Array<Record<string, unknown>>, opts: Record<string, unknown> = {}) {
  const lane = (opts.lane as string) ?? 'node';
  let i = 0;
  const stamped = ledgers.map((l) => {
    if (l.lane !== lane || l.compatMode === 'early-warning') return l;
    const d = new Date('2026-01-01T01:17:00.000Z');
    d.setUTCDate(d.getUTCDate() + i);
    i += 1;
    return { ...l, scheduledAt: d.toISOString() };
  });
  const last = new Date('2026-01-01T12:00:00.000Z');
  last.setUTCDate(last.getUTCDate() + Math.max(i - 1, 0));
  return auditWindow(stamped, { now: last, ...opts });
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
      const a = auditDated(streakOf(14, 'sha256:aaaa'));
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
      expect(auditDated(withBun).met).toBe(true);
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
  });

  // ───────────────────────────────────────────────────────────────────────
  // #1605 (found in the #1604 round-2 review, fixture A "unscoped" variant):
  // `auditWindow` used to DROP a resolved ledger that carries no credential
  // mode BEFORE grading — `inScope` returned `claimsCredential(ledger)` for a
  // scheduled, lane-matched entry, which is `false` for a mode-less one, so
  // `selectLaneNights` filtered it out of `nights` entirely. On origin/main
  // this let 13 green + 30 mode-less + 1 green nights on the SAME lane read
  // as current=14, met=true — the exact unbounded-bridging shape the #1550
  // and #1604 reviews rejected for a different outcome kind, reachable here
  // with no new field at all.
  //
  // DECISION (this PR): a resolved ledger that has ALREADY matched this
  // window's `lane` and `event: 'schedule'` (selectLaneNights's own first
  // filter, which runs before `inScope`) is a scheduled run of THIS credential
  // lane by definition — it is never "some other lane's night" the way a bun
  // weekly or a workflow_dispatch run is. So:
  //   * an EXPLICIT `compatMode: 'early-warning'` night stays excluded, not
  //     disqualifying — that is a real main night and rule 6 says it must
  //     neither advance nor break the credential streak.
  //   * anything else that does not claim credential (`compatMode` absent or
  //     `null`, whether from a workflow that never wrote `KNEXT_COMPAT_MODE`
  //     or from a ledger produced before ADR-0056 existed) now stays IN the
  //     sequence and is GRADED — which disqualifies it via `gradeNight`'s
  //     existing `not-a-credential-run`/`non-credential-ref` checks — instead
  //     of vanishing. This applies uniformly to legacy pre-ADR-0056 history:
  //     nothing in a ledger's shape distinguishes "predates the mode field"
  //     from "forgot to set it", and carving out an exception for the former
  //     would reopen this exact bridging hole for old runs still inside the
  //     fetch horizon.
  // ───────────────────────────────────────────────────────────────────────
  describe('#1605 — a mode-less scheduled night on the credential lane disqualifies, never skips', () => {
    /** A resolved ledger that never claimed credential — no mode at all. */
    function modeLessNight(over: Record<string, unknown> = {}) {
      return night({
        compatMode: null,
        credential: false,
        knextRef: null,
        knextSha: null,
        ...over,
      });
    }

    it('does NOT merge the streaks either side of it (rule-5 shape, one level up)', () => {
      const before = streakOf(2, 'sha256:aaaa', 40000000000);
      const after = streakOf(2, 'sha256:aaaa', 41000000000);

      // The bug, stated as the contrast that makes it visible: with the
      // mode-less night simply dropped before grading, four nights on one
      // fingerprint look like one streak.
      const silentlyDropped = auditWindow(
        [...before, ...after].filter((l) => (l as { runId: string }).runId !== '40500000000'),
      );
      expect(silentlyDropped.longest.nights).toBe(4);

      // With the mode-less night RECORDED and graded, the streak is honestly 2.
      const honest = auditWindow([
        ...before,
        modeLessNight({ runId: '40500000000', windowFingerprint: 'sha256:aaaa' }),
        ...after,
      ]);
      expect(honest.longest.nights).toBe(2);
      expect(honest.streaks).toHaveLength(2);
      expect(honest.streaks[1].restartCause).toBe('night-disqualified');
      expect(honest.current.nights).toBe(2);
    });

    it('13 green + 30 mode-less + 1 green is met=false, not the 14-night bridge on origin/main', () => {
      let id = 40000000000;
      const ledgers = [
        ...Array.from({ length: 13 }, () =>
          night({ runId: String(id++), windowFingerprint: 'sha256:aaaa' }),
        ),
        ...Array.from({ length: 30 }, () =>
          modeLessNight({ runId: String(id++), windowFingerprint: 'sha256:aaaa' }),
        ),
        night({ runId: String(id++), windowFingerprint: 'sha256:aaaa' }),
      ];
      const a = auditWindow(ledgers, { lane: 'node' });
      expect(a.nights).toHaveLength(13 + 30 + 1);
      const modeLessGraded = a.nights.slice(13, 43);
      expect(modeLessGraded.every((n: { eligible: boolean }) => n.eligible === false)).toBe(true);
      expect(
        modeLessGraded.every((n: { disqualifiers: string[] }) =>
          hasReason(n, 'not-a-credential-run'),
        ),
      ).toBe(true);
      expect(a.longest.nights).toBe(13);
      expect(a.current.nights).toBe(1);
      expect(a.met).toBe(false);
    });

    it('an EXPLICIT early-warning night, by contrast, stays excluded — not a disqualifier', () => {
      const nights14 = streakOf(14, 'sha256:aaaa');
      const withEarlyWarning = [
        ...nights14.slice(0, 7),
        night({
          runId: '40006500000',
          windowFingerprint: 'sha256:aaaa',
          compatMode: 'early-warning',
          credential: false,
          knextRef: 'refs/heads/main',
        }),
        ...nights14.slice(7),
      ];
      const a = auditDated(withEarlyWarning, { lane: 'node' });
      // Unlike the mode-less case above, the early-warning night never enters
      // `nights` at all — it is filtered out before grading, exactly like a
      // bun weekly is, so it neither breaks nor advances the credential streak.
      expect(a.nights).toHaveLength(14);
      expect(a.met).toBe(true);
    });

    it('a pre-ADR-0056 ledger (no `compatMode` KEY at all, not merely null) is graded the same way', () => {
      const full = night();
      const { compatMode: _cm, credential: _cr, knextRef: _kr, knextSha: _ks, ...legacy } = full;
      const selected = selectLaneNights([legacy], 'node', 'credential');
      expect(selected).toHaveLength(1);
      const graded = gradeNight(selected[0], { lane: 'node', scope: 'credential' });
      expect(graded.eligible).toBe(false);
      expect(hasReason(graded, 'not-a-credential-run')).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // #1520 (raised from #1515) — an infra/deploy-classified shard red gets a
  // readable `deploy-classified:` label in the disqualifier text. Round 1 of
  // #1550 also graded such a night VOID (bridged over: neither counted nor a
  // reset). Round 2 (lead-directed, #1550) REMOVED that grade: a round-1
  // review found `scripts/e2e-deploy.sh` reports the exact same "Custom
  // deploy script failed" sentence for an adapter build crash or a
  // crash-on-boot — genuine product regressions — so bridging it let a real
  // regression go uncounted. The credential's integrity wins: a
  // deploy-classified red now disqualifies a night, and resets the streak,
  // exactly like any other red. Whether some proven-safe subset should someday
  // be exempted is tracked as #1553, undecided here.
  // ───────────────────────────────────────────────────────────────────────
  describe('#1520 — a deploy-classified shard red is labelled, but grades like any other red', () => {
    /** A shard whose ENTIRE redness is one `kind: 'deploy'` failure. */
    function deployOnlyShard(base: ShardRow, over: Record<string, unknown> = {}) {
      return {
        ...base,
        passed: 48,
        failed: 1,
        failures: [{ file: 'test/e2e/app-dir/actions/actions.test.ts', kind: 'deploy', cases: [] }],
        ...over,
      };
    }

    it('gradeNight: a shard whose every named failure is kind:deploy is disqualified — same as any other red', () => {
      const shards = night().shards;
      shards[5] = deployOnlyShard(shards[5]);
      const g = gradeNight(night({ shards }));
      expect(g.eligible).toBe(false);
      expect(hasReason(g, 'deploy-classified')).toBe(true);
    });

    it('gradeNight: a MIXED shard (one deploy failure, one assertion failure) is disqualified — no deploy label (partial attribution)', () => {
      const shards = night().shards;
      shards[5] = {
        ...shards[5],
        passed: 47,
        failed: 2,
        failures: [
          { file: 'test/e2e/a.test.ts', kind: 'deploy', cases: [] },
          { file: 'test/e2e/b.test.ts', kind: 'assertion', cases: ['c'] },
        ],
      };
      const g = gradeNight(night({ shards }));
      expect(g.eligible).toBe(false);
      expect(hasReason(g, 'deploy-classified')).toBe(false);
    });

    it('gradeNight: a PARTIALLY-attributed shard (failed=2, only 1 failure named) never gets the deploy-classified label — the count-match guard fails closed', () => {
      const shards = night().shards;
      shards[5] = {
        ...shards[5],
        passed: 47,
        failed: 2,
        // Only ONE of the two counted failures is named, and it is kind:deploy.
        failures: [{ file: 'test/e2e/a.test.ts', kind: 'deploy', cases: [] }],
      };
      const g = gradeNight(night({ shards }));
      expect(g.eligible).toBe(false);
      expect(hasReason(g, 'deploy-classified')).toBe(false);
      expect(g.disqualifiers.some((d: string) => d.startsWith('shard 6/16 red'))).toBe(true);
    });

    it('gradeNight: a deploy-only red shard PLUS a real disqualifier (rerun) is still disqualified on both', () => {
      const shards = night().shards;
      shards[5] = deployOnlyShard(shards[5]);
      const g = gradeNight(night({ shards, runAttempt: '2' }));
      expect(g.eligible).toBe(false);
      expect(g.disqualifiers).toContain('rerun');
      expect(hasReason(g, 'deploy-classified')).toBe(true);
    });

    it('auditWindow: a deploy-only red night RESETS the streak — it is not bridged', () => {
      const before = streakOf(6, 'sha256:aaaa', 40000000000);
      const redShards = night().shards;
      redShards[0] = deployOnlyShard(redShards[0]);
      const redNight = night({
        // Numerically BETWEEN the "before" and "after" streaks
        // (`auditWindow` sorts nights by run id as a number, not by array
        // position).
        runId: '40000006000',
        windowFingerprint: 'sha256:aaaa',
        shards: redShards,
      });
      const after = streakOf(8, 'sha256:aaaa', 40007000000);
      const a = auditWindow([...before, redNight, ...after]);
      // The deploy-classified red is a REAL disqualifier now: it resets the
      // streak, so the two halves never join — longest is the larger half (8),
      // never the bridged 6+8=14.
      expect(a.met).toBe(false);
      expect(a.longest.nights).toBe(8);
      expect(a.streaks).toHaveLength(2);
      expect(a.streaks.at(-1)?.restartCause).toBe('night-disqualified');
    });

    it('auditWindow: an assertion-kind red STILL resets the streak (unchanged by #1520)', () => {
      const shards = night().shards;
      shards[7] = {
        ...shards[7],
        passed: 47,
        failed: 2,
        failures: [{ file: 'test/e2e/x.test.ts', kind: 'assertion', cases: ['a', 'b'] }],
      };
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

    it('auditWindow: a deploy-only red night at the END of the window ZEROES OUT the current streak', () => {
      const trailingShards = night().shards;
      trailingShards[0] = deployOnlyShard(trailingShards[0]);
      const trailingRed = night({
        // Numerically AFTER streakOf(14, …, 40000000000)'s last id (40000013000).
        runId: '40000014000',
        windowFingerprint: 'sha256:aaaa',
        shards: trailingShards,
      });
      const a = auditDated([...streakOf(14, 'sha256:aaaa', 40000000000), trailingRed]);
      // The earned 14-night window still shows up as the LONGEST streak on
      // record (history is not un-earned), but the CURRENT streak — the one
      // still running from here — is reset to zero by the trailing red.
      expect(a.met).toBe(true);
      expect(a.longest.nights).toBe(14);
      expect(a.current.nights).toBe(0);
      expect(a.shortfall).toBe(WINDOW_REQUIRED_NIGHTS);
    });

    it('formatReport prints a deploy-classified red as an ordinary NO, never VOID', () => {
      const shards = night().shards;
      shards[0] = deployOnlyShard(shards[0]);
      const a = auditWindow([night({ shards })]);
      const report = formatReport(a);
      expect(report).not.toMatch(/VOID/);
      expect(report).toMatch(/NO —.*deploy-classified/);
    });
  });

  describe('auditWindow — reporting and the arithmetic it emits', () => {
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
      const a = auditDated([
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

    /**
     * cr-1179 #3. The rule above is fail-closed and correct when the lane is
     * genuinely unknowable — but #1147 activated a SECOND scheduled lane, so
     * "unknowable" now has a price it did not have when there was only one:
     * a bun night that loses its ledger (runner loss — the class that produced
     * node run 30790778590) would disqualify a night in the NODE window and
     * restart the v1.0 credential streak for a failure on the other lane.
     *
     * The fix is not to soften fail-closed; it is to make the lane knowable
     * WITHOUT the ledger, via a lane-marker artifact whose NAME carries the
     * lane. When that marker is readable the night is attributed to exactly one
     * lane; when it is not, the old fail-closed rule stands unchanged (the test
     * above still passes, and must).
     */
    it('an unresolved night whose lane IS known does not reset the other lane', () => {
      const ledgers = [
        night({ runId: '40000000000' }),
        unresolvedNight('40000000001', 'no-ledger', 'bun'),
        night({ runId: '40000000002' }),
      ];
      // The node window never sees the bun casualty...
      expect(selectLaneNights(ledgers, 'node').map((l: { runId: string }) => l.runId)).toEqual([
        '40000000000',
        '40000000002',
      ]);
      // ...and the bun window still carries it, disqualified.
      expect(selectLaneNights(ledgers, 'bun').map((l: { runId: string }) => l.runId)).toEqual([
        '40000000001',
      ]);
    });

    it('a lost BUN night does not break a 14-night NODE streak', () => {
      // The end-to-end consequence, stated as the gate reads it.
      const nights = [
        ...streakOf(7, 'sha256:aaaa', 40000000000),
        unresolvedNight('40006500000', 'artifact-download-failed', 'bun'),
        ...streakOf(7, 'sha256:aaaa', 40007000000),
      ];
      const a = auditDated(nights, { lane: 'node' });
      expect(a.longest.nights).toBe(WINDOW_REQUIRED_NIGHTS);
      expect(a.met).toBe(true);
      expect(a.unresolvedNights).toEqual([]);
      // ...while the bun lane owns the casualty.
      expect(auditWindow(nights, { lane: 'bun' }).unresolvedNights).toEqual([
        { runId: '40006500000', reason: 'artifact-download-failed' },
      ]);
    });

    it('an unresolved night attributed to THIS lane still breaks THIS lane`s streak', () => {
      // The fix must not become a way to launder a lane`s own lost nights.
      const nights = [
        ...streakOf(7, 'sha256:aaaa', 40000000000),
        unresolvedNight('40006500000', 'artifact-download-failed', 'node'),
        ...streakOf(7, 'sha256:aaaa', 40007000000),
      ];
      const a = auditWindow(nights, { lane: 'node' });
      expect(a.longest.nights).toBe(7);
      expect(a.met).toBe(false);
      expect(a.unresolvedNights).toEqual([
        { runId: '40006500000', reason: 'artifact-download-failed' },
      ]);
    });

    it('an unknown lane is still admitted to a lane it is not named for — fail closed', () => {
      // Restated as a property so the fix above cannot quietly become
      // "attribute unresolved nights to the bun lane by default".
      expect(unresolvedNight('1', 'no-ledger').lane).toBeNull();
      expect(unresolvedNight('1', 'no-ledger', null).lane).toBeNull();
      expect(selectLaneNights([unresolvedNight('1', 'no-ledger')], 'node')).toHaveLength(1);
      expect(selectLaneNights([unresolvedNight('1', 'no-ledger')], 'bun')).toHaveLength(1);
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
      /** Override `total_count`; defaults to the listing's own length. */
      totalCount?: number;
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
          const artifacts = cases[id]?.artifacts ?? [];
          const total_count = cases[id]?.totalCount ?? artifacts.length;
          return JSON.stringify({ artifacts, total_count });
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

    /**
     * cr-1179 #3 — the lane must be knowable WITHOUT the ledger, or a lost bun
     * night resets the node credential streak. The marker is read from the
     * artifacts LISTING, never downloaded: an expired artifact is still NAMED
     * in that listing (which is exactly how `artifact-expired` is already
     * distinguished from `no-ledger`), so attribution survives expiry.
     */
    describe('lane attribution from the marker artifact (cr-1179 #3)', () => {
      const marker = (lane: string) => ({ name: `compat-lane-${lane}`, expired: false });

      it('a night with NO ledger is still attributed to its lane by the marker', () => {
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': { artifacts: [marker('bun')] },
          }),
        );
        expect(out[0]).toMatchObject({ unresolved: 'no-ledger', lane: 'bun' });
      });

      it('an EXPIRED ledger keeps its lane — the marker name survives in the listing', () => {
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': {
              artifacts: [
                { name: 'compat-run-ledger', expired: true },
                { name: 'compat-lane-bun', expired: true },
              ],
            },
          }),
        );
        expect(out[0]).toMatchObject({ unresolved: 'artifact-expired', lane: 'bun' });
      });

      it('a FAILED download keeps its lane', () => {
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': {
              artifacts: [{ name: 'compat-run-ledger', expired: false }, marker('bun')],
              downloadThrow: true,
            },
          }),
        );
        expect(out[0]).toMatchObject({ unresolved: 'artifact-download-failed', lane: 'bun' });
      });

      it('an UNREADABLE ledger keeps its lane', () => {
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': {
              artifacts: [{ name: 'compat-run-ledger', expired: false }, marker('bun')],
              ledgers: [],
            },
          }),
        );
        expect(out[0]).toMatchObject({ unresolved: 'ledger-unreadable', lane: 'bun' });
      });

      it('an UNREACHABLE artifacts API leaves the lane unknown — the marker is unreadable too', () => {
        // Fail closed where we genuinely cannot know: this night still enters
        // every lane's window.
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': { artifactsThrow: true },
          }),
        );
        expect(out[0]).toMatchObject({ unresolved: 'artifact-api-unreachable', lane: null });
      });

      it('AMBIGUOUS markers fail closed to an unknown lane rather than picking one', () => {
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': { artifacts: [marker('bun'), marker('node')] },
          }),
        );
        expect(out[0]).toMatchObject({ unresolved: 'no-ledger', lane: null });
      });

      it('a marker never overrides a ledger that DID resolve', () => {
        // The ledger stays the source of truth when it is readable; the marker
        // is a fallback, not a second opinion.
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': {
              artifacts: [{ name: 'compat-run-ledger', expired: false }, marker('bun')],
              ledgers: [night({ runId: '1', lane: 'node' })],
            },
          }),
        );
        expect(out[0]).toMatchObject({ runId: '1', lane: 'node' });
        expect(out[0]).not.toHaveProperty('unresolved');
      });
    });

    /**
     * cr-1179b #1 — the artifacts LISTING itself must not silently truncate.
     * `gh api …/artifacts` carries no pagination by default, so the REST
     * `per_page=30` default applies. Measured on the latest scheduled run:
     * total_count 19, +1 for the lane marker = 20 — the shard matrix already
     * went 4→16 once, so crossing 30 is not hypothetical. A truncated page
     * would make `laneFromArtifacts` return `null` and silently fall an
     * unresolved night back into BOTH lanes' windows — reverting cr-1179 #3.
     */
    describe('the artifacts listing must not silently truncate (cr-1179b #1)', () => {
      it('requests the artifacts listing with per_page=100, not the truncating REST default', () => {
        const seenApiArgs: string[][] = [];
        const gh = (args: string[]) => {
          if (args[0] === 'run' && args[1] === 'list') {
            return JSON.stringify([{ databaseId: 1, status: 'completed', event: 'schedule' }]);
          }
          if (args[0] === 'api') {
            seenApiArgs.push(args);
            return JSON.stringify({ artifacts: live, total_count: live.length });
          }
          if (args[0] === 'run' && args[1] === 'download') return '';
          throw new Error(`unexpected gh ${args.join(' ')}`);
        };
        fetchLedgers(10, { gh, readDir: () => [night({ runId: '1' })] });
        expect(seenApiArgs).toHaveLength(1);
        // Anchor-assert: the URL must literally carry per_page=100. A mutation
        // that drops the query param (reverting to the REST default of 30)
        // fails this exact assertion.
        expect(seenApiArgs[0][1]).toMatch(/\/artifacts\?per_page=100$/);
      });

      it('a total_count that disagrees with the listing length is an incomplete listing, never a complete one', () => {
        // GitHub's own count of the FULL set disagrees with what this page
        // returned (29 more exist than the 1 that came back) — exactly the
        // shape a per_page truncation produces. This must NOT be treated as a
        // complete listing (which would resolve the lane / find the ledger
        // from a partial page); it must be treated the same as an unreachable
        // API — an unresolved night, fail-closed lane.
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': { artifacts: live, totalCount: live.length + 29 },
          }),
        );
        expect(out[0]).toMatchObject({ unresolved: 'artifact-api-unreachable', lane: null });
      });

      it('a total_count that AGREES with the listing length still resolves normally', () => {
        // Guards against the fix overshooting into "always unresolved".
        const out = fetchLedgers(
          10,
          fakeGh([{ databaseId: 1, status: 'completed', event: 'schedule' }], {
            '1': { artifacts: live, totalCount: live.length, ledgers: [night({ runId: '1' })] },
          }),
        );
        expect(out[0]).toMatchObject({ runId: '1', lane: 'node' });
        expect(out[0]).not.toHaveProperty('unresolved');
      });
    });
  });

  describe('the fetch horizon must hold a full window of EVERY lane (cr-1179 #3)', () => {
    it('the default --limit accommodates two scheduled lanes plus non-schedule events', () => {
      // #1147 activated a second nightly cron, so a `--limit` sized for one
      // lane silently halves the observable node horizon: the 14-night window
      // would fall off the end of the list and read as shorter than it is.
      // `gh run list` spans ALL events (push/PR/dispatch included), so the
      // denominator is not 2×14 either.
      expect(DEFAULT_FETCH_LIMIT).toBeGreaterThanOrEqual(2 * WINDOW_REQUIRED_NIGHTS * 2);
    });

    it('the CLI default and the documented default are the same number', () => {
      const src = readFileSync(
        join(import.meta.dir, '..', 'scripts', 'compat-window-audit.mjs'),
        'utf8',
      );
      expect(src).toContain(`--limit ${DEFAULT_FETCH_LIMIT}`);
      expect(src).toMatch(/arg\('--limit',\s*String\(DEFAULT_FETCH_LIMIT\)\)/);
    });
  });
});

// ── Bytecode caching must be LIVE for a night to credential ───────────────────
// Founder rule: bytecode caching is mandatory in every runtime×builder cell,
// and a cell must not credential unless caching is proven LIVE at runtime, not
// merely configured. The evidence travels shard summary → run ledger; the audit
// refuses a credential night any of whose shards lacks it. The rule is keyed on
// the cell's RUNTIME (CREDENTIAL_CELLS), so a lane wired later inherits it.
describe('rule 7 — bytecode caching proven LIVE on every shard of a credential night', () => {
  it('a night whose every shard carries live evidence of the cell runtime is eligible', () => {
    expect(gradeNight(night()).eligible).toBe(true);
    expect(gradeNight(night({ lane: 'bun' }), { lane: 'bun' }).eligible).toBe(true);
  });

  it('ONE shard with a cold (not-live) deploy disqualifies the night, naming the shard', () => {
    const n = night();
    n.shards[6] = {
      ...n.shards[6],
      bytecode: { runtime: 'node', deploys: 3, live: 2, notLive: 1, reasons: ['deploy 2: cold'] },
    };
    const g = gradeNight(n);
    expect(g.eligible).toBe(false);
    expect(hasReason(g, 'bytecode-not-live')).toBe(true);
    expect(g.disqualifiers.join(' ')).toContain('7/16');
  });

  it('a shard with NO evidence at all disqualifies (fail closed — absence is not liveness)', () => {
    const n = night();
    const { bytecode: _dropped, ...rest } = n.shards[0];
    n.shards[0] = rest as ShardRow;
    const g = gradeNight(n);
    expect(g.eligible).toBe(false);
    expect(hasReason(g, 'bytecode-not-live')).toBe(true);
  });

  it('a bun night whose shards booted a NON-bytecode server (node-runtime evidence) disqualifies', () => {
    const g = gradeNight(
      night({
        lane: 'bun',
        shards: night().shards.map((s) => ({ ...s, bytecode: liveBytecode('node') })),
      }),
      { lane: 'bun' },
    );
    expect(g.eligible).toBe(false);
    expect(hasReason(g, 'bytecode-not-live')).toBe(true);
  });

  it('a lane that is not a known credential cell cannot prove its runtime, so it disqualifies', () => {
    const g = gradeNight(night({ lane: 'deno' }), { lane: 'deno' });
    expect(hasReason(g, 'bytecode-not-live')).toBe(true);
  });

  it('a non-live night RESTARTS the credential streak (it is disqualified, not skipped)', () => {
    // streakOf(13) spans run ids 40000000000..40000012000; the cold night sits
    // right after it and the resumed streak after that (the audit sorts by id).
    const cold = night({ runId: '40000012500' });
    cold.shards = cold.shards.map((s) => ({
      ...s,
      bytecode: { runtime: 'node', deploys: 3, live: 0, notLive: 3, reasons: [] },
    }));
    const a = auditWindow([
      ...streakOf(13, 'sha256:aaaa'),
      cold,
      ...streakOf(2, 'sha256:aaaa', 40000020000),
    ]);
    expect(a.longest.nights).toBe(13);
    expect(a.current.nights).toBe(2);
    expect(a.met).toBe(false);
  });

  it('the other half: fourteen live nights meet the gate', () => {
    expect(auditDated(streakOf(14, 'sha256:aaaa')).met).toBe(true);
  });

  it('early-warning (main) nights are NOT graded on it — that scope stays a comparable report', () => {
    const n = night({
      compatMode: 'early-warning',
      credential: false,
      knextRef: 'refs/heads/main',
    });
    n.shards = n.shards.map(({ bytecode: _b, ...s }) => s as ShardRow);
    const g = gradeNight(n, { scope: 'early-warning' });
    expect(hasReason(g, 'bytecode-not-live')).toBe(false);
  });
});

/**
 * #1294 round 2 (low finding, jev 0.55) — `CREDENTIAL_CELLS.workflowFile` must
 * name a workflow that actually RUNS the cell's own runtime. `compat-vinext.yml`
 * hardcodes `KNEXT_RUNTIME: bun` (the nitro bun-preset entry calls that
 * runtime's global `serve()`; there is no node arm to select), so mapping
 * `node-vinext` to it would fingerprint bytes that never execute as `node`.
 */
describe('CREDENTIAL_CELLS.workflowFile names a workflow that runs the cell’s OWN runtime (#1294 round 2)', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '..');

  /** A workflow's STATIC `KNEXT_RUNTIME: <literal>` env line, or null if templated/absent. */
  function staticRuntime(workflowFile: string): string | null {
    const src = readFileSync(resolve(REPO_ROOT, '.github/workflows', workflowFile), 'utf8');
    const m = src.match(/^\s*KNEXT_RUNTIME:\s*(\S+)\s*$/m);
    if (!m) return null;
    // A templated value (`${{ ... }}`) is not "static" — that workflow selects
    // its runtime per-run (e.g. test-e2e-deploy.yml, which the caller already
    // pins with `--lane "${KNEXT_RUNTIME}"`, so lane and runtime self-agree by
    // construction there).
    return m[1].startsWith('${{') ? null : m[1];
  }

  it('node-vinext has NO workflow wired (compat-vinext.yml is bun-only) — never guessed', () => {
    const cell = CREDENTIAL_CELLS.find((c) => c.lane === 'node-vinext');
    expect(cell?.workflowFile).toBeNull();
  });

  for (const cell of CREDENTIAL_CELLS) {
    if (!cell.workflowFile) continue;
    const runtime = staticRuntime(cell.workflowFile);
    if (runtime === null) continue; // templated — the workflow selects its own runtime per run
    it(`lane "${cell.lane}": ${cell.workflowFile}'s static KNEXT_RUNTIME (${runtime}) matches the cell's runtime (${cell.runtime})`, () => {
      expect(runtime).toBe(cell.runtime);
    });
  }
});

/**
 * #1607 — rule 8: a scheduled credential cron GitHub never fires (dropped
 * under load, a workflow disabled after 60 days of inactivity, an outage)
 * leaves no run and no ledger. Before this rule `auditWindow` only checked
 * SEQUENCE adjacency between the nights it was handed, so a dropped night on
 * an otherwise-unchanged fingerprint would silently bridge two streaks into
 * one that never ran on the day in between. These tests prove the fix from
 * both directions: a real gap breaks the streak, and nothing that ISN'T a
 * genuine gap (a same-day rerun, today's not-yet-due night, an unwired lane,
 * offline/undated input) is ever mistaken for one.
 */
describe('the missing-night calendar (#1607, rule 8)', () => {
  /** A credential night on `date` (UTC), at the node lane's own cron time (01:17 UTC). */
  function nightAt(date: string, over: Record<string, unknown> = {}) {
    return night({
      runId: String(Date.parse(`${date}T00:00:00.000Z`)),
      scheduledAt: `${date}T01:17:00.000Z`,
      ...over,
    });
  }

  it('a calendar gap between two same-fingerprint nights breaks the streak, even though sequence adjacency would bridge it', () => {
    const n1 = nightAt('2026-01-01');
    const n2 = nightAt('2026-01-03'); // 2026-01-02 never ran
    // Past 2026-01-03's own due time (its grace bound), but not yet past
    // 2026-01-04's, so the calendar's cutoff lands ON 2026-01-03 and the ONLY
    // gap in range is the one under test.
    const now = new Date('2026-01-03T20:00:00.000Z');
    const a = auditWindow([n1, n2], { now });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights.map((m: { date: string | null }) => m.date)).toEqual(['2026-01-02']);
    expect(a.restartsByCause).toEqual({ 'night-missing': 1 });
    // The whole point: sequence adjacency alone would read this as one
    // 2-night streak. It must read as two separate 1-night streaks instead.
    expect(a.streaks).toHaveLength(2);
    expect(a.longest.nights).toBe(1);
  });

  it('the missing night is graded and reported like any other unresolved night, disqualified never skipped', () => {
    const n1 = nightAt('2026-01-01');
    const n2 = nightAt('2026-01-03');
    const now = new Date('2026-01-03T20:00:00.000Z');
    const a = auditWindow([n1, n2], { now });
    const missing = a.nights.find(
      (n: { unresolved: string | null }) => n.unresolved === 'missing-night',
    );
    expect(missing).toBeDefined();
    expect(missing.eligible).toBe(false);
    expect(missing.date).toBe('2026-01-02');
    expect(a.unresolvedNights).toContainEqual({
      runId: 'missing:node:2026-01-02',
      reason: 'missing-night',
      date: '2026-01-02',
    });
    const report = formatReport(a);
    expect(report).toContain('missing-night');
    expect(report).toContain('calendar check (rule 8): verified');
  });

  it('two ledgers on the same calendar date (e.g. a same-day rerun) still count as one known date, never a missing one', () => {
    const firstAttempt = nightAt('2026-01-01', { runId: 'r1' });
    const rerun = nightAt('2026-01-01', { runId: 'r2', runAttempt: '2' });
    const n2 = nightAt('2026-01-02', { runId: 'r3' });
    const now = new Date('2026-01-02T20:00:00.000Z'); // past 01-02's due, cutoff lands on 01-02
    const a = auditWindow([firstAttempt, rerun, n2], { now });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    // The rerun itself still disqualifies — via the PRE-EXISTING rerun rule,
    // never relabelled as a calendar gap.
    const rerunNight = a.nights.find((n: { runId: string }) => n.runId === rerun.runId);
    expect(rerunNight?.disqualifiers).toContain('rerun');
  });

  it('the current in-progress night is not counted missing before its cron time plus the grace bound', () => {
    const n1 = nightAt('2026-01-01');
    // 01:17 UTC on 2026-01-02 is the exact cron minute — the grace bound has
    // not elapsed yet, so today's night is not yet overdue.
    const now = new Date('2026-01-02T01:17:00.000Z');
    const a = auditWindow([n1], { now });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
  });

  it('once the grace bound elapses with no run, the overdue night IS counted missing', () => {
    const n1 = nightAt('2026-01-01');
    const graceHour = 1 + MISSING_NIGHT_GRACE_HOURS + 1; // one hour past due
    const now = new Date(`2026-01-02T${String(graceHour).padStart(2, '0')}:17:00.000Z`);
    const a = auditWindow([n1], { now });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights.map((m: { date: string | null }) => m.date)).toEqual(['2026-01-02']);
  });

  it('an unwired lane has no discovered credential cron, so the calendar check is SKIPPED, never guessed', () => {
    const n1 = nightAt('2026-01-01', { lane: 'node-vinext' });
    const a = auditWindow([n1], { lane: 'node-vinext', now: new Date('2026-01-05T00:00:00.000Z') });
    expect(a.calendarChecked).toBe(false);
    expect(a.calendarSkippedReason).toMatch(/no discovered credential cron/);
    expect(a.missingNights).toEqual([]);
  });

  it('a mix of dated and undated graded nights skips the check rather than applying it partially', () => {
    const dated = nightAt('2026-01-01');
    const undated = night({ runId: '2', windowFingerprint: dated.windowFingerprint as string });
    const a = auditWindow([dated, undated], { now: new Date('2026-01-05T00:00:00.000Z') });
    expect(a.calendarChecked).toBe(false);
    expect(a.calendarSkippedReason).toMatch(/no scheduling date/);
  });

  it('legacy ledgers with no scheduledAt at all (every pre-#1607 fixture) skip the check, never falsely pass it', () => {
    const a = auditWindow(streakOf(3, 'sha256:aaaa'));
    expect(a.calendarChecked).toBe(false);
    expect(a.calendarSkippedReason).toMatch(/no scheduling date/);
    // Unaffected otherwise — this is the backward-compatibility guarantee for
    // every test above this describe block, and for `--dir` input generally.
    expect(a.longest.nights).toBe(3);
  });

  it('an empty lane has nothing to bridge — vacuously on-calendar, and 0 nights still never meets the gate', () => {
    // #1612 round 2: vacuous rather than UNVERIFIED, so a wired cell that has
    // simply not run a credential night yet reads `not met`, not a calendar
    // fault. It cannot fail open: `met` still needs 14 nights.
    const a = auditWindow([], { now: new Date('2026-01-05T00:00:00.000Z') });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    expect(a.met).toBe(false);
    expect(a.verdict).toBe('NOT MET');
  });

  it('the calendar check is scoped to credential nights only — early-warning stays sequence-only', () => {
    const n1 = nightAt('2026-01-01', {
      compatMode: 'early-warning',
      credential: false,
      knextRef: 'refs/heads/main',
    });
    const a = auditWindow([n1], {
      scope: 'early-warning',
      now: new Date('2026-01-05T00:00:00.000Z'),
    });
    expect(a.calendarChecked).toBe(false);
    expect(a.calendarSkippedReason).toMatch(/scoped to credential nights only/);
  });
});

describe('parseCredentialCronsFromWorkflow (#1607) — reads the cron↔lane mapping from real workflow text, never hardcoded', () => {
  it('extracts one credential cron per lane from text shaped like the real KNEXT_LANE/KNEXT_COMPAT_MODE lines', () => {
    const fixture = [
      'on:',
      '  schedule:',
      "    - cron: '17 1 * * *'",
      "    - cron: '47 5 * * *'",
      "    - cron: '17 22 * * *'",
      'env:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed, not a JS template placeholder
      "  KNEXT_LANE: ${{ (github.event.schedule == '17 22 * * *' && 'node-webpack') || (github.event.schedule == '47 5 * * *' && 'bun') || 'node' }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed, not a JS template placeholder
      "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') || (github.event.schedule == '47 5 * * *' && 'credential') || (github.event.schedule == '17 22 * * *' && 'credential') || 'early-warning' }}",
      '',
    ].join('\n');
    const map = parseCredentialCronsFromWorkflow(fixture);
    expect(Object.fromEntries(map)).toEqual({
      node: '17 1 * * *',
      bun: '47 5 * * *',
      'node-webpack': '17 22 * * *',
    });
  });

  it('throws when two credential crons resolve to the same lane — one cron per lane is assumed', () => {
    const fixture = [
      'on:',
      '  schedule:',
      "    - cron: '17 1 * * *'",
      "    - cron: '18 1 * * *'",
      'env:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed, not a JS template placeholder
      "  KNEXT_LANE: ${{ github.event.inputs.runtime || 'node' }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed, not a JS template placeholder
      "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') || (github.event.schedule == '18 1 * * *' && 'credential') || 'early-warning' }}",
      '',
    ].join('\n');
    expect(() => parseCredentialCronsFromWorkflow(fixture)).toThrow(/both.*map to lane/);
  });

  it('throws when KNEXT_COMPAT_MODE is absent — refuses to derive crons from nothing', () => {
    expect(() => parseCredentialCronsFromWorkflow('env:\n  FOO: bar\n')).toThrow(
      /KNEXT_COMPAT_MODE/,
    );
  });

  it('throws when KNEXT_LANE has no trailing default lane literal', () => {
    const fixture = [
      'on:',
      '  schedule:',
      "    - cron: '17 1 * * *'",
      'env:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed, not a JS template placeholder
      '  KNEXT_LANE: ${{ github.event.inputs.runtime }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed, not a JS template placeholder
      "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') || 'early-warning' }}",
      '',
    ].join('\n');
    expect(() => parseCredentialCronsFromWorkflow(fixture)).toThrow(/no trailing default/);
  });
});

describe('credentialCronForLane + the real workflow (#1607) — drift guard', () => {
  it('matches the real test-e2e-deploy.yml cron literals for every wired credential cell', () => {
    expect(credentialCronForLane('node')).toBe('17 1 * * *');
    expect(credentialCronForLane('bun')).toBe('47 5 * * *');
    expect(credentialCronForLane('node-webpack')).toBe('17 22 * * *');
    expect(credentialCronForLane('bun-webpack')).toBe('47 23 * * *');
  });

  it('an unwired lane (no workflow, or no credential mode wired yet) has no credential cron', () => {
    expect(credentialCronForLane('node-vinext')).toBeNull();
    expect(credentialCronForLane('bun-vinext')).toBeNull();
  });

  it('an unknown lane has no credential cron', () => {
    expect(credentialCronForLane('not-a-real-lane')).toBeNull();
  });
});

// ── #1612 round 2 — fail closed, date by cron slot, parse loudly ────────────

/** A workflow fixture shaped like test-e2e-deploy.yml's schedule + env lines. */
function workflowFixture(
  opts: { schedule?: string[]; lane?: string[]; mode?: string[]; tail?: string[] } = {},
) {
  const schedule = opts.schedule ?? [
    '  schedule:',
    "    - cron: '17 3 * * *'",
    "    - cron: '47 4 * * *'",
    "    - cron: '17 1 * * *'",
    "    - cron: '47 5 * * *'",
    "    - cron: '17 22 * * *'",
    "    - cron: '47 23 * * *'",
  ];
  const lane = opts.lane ?? [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
    "  KNEXT_LANE: ${{ (github.event.inputs.builder == 'webpack' && format('{0}-webpack', github.event.inputs.runtime)) || github.event.inputs.runtime || (github.event.schedule == '17 22 * * *' && 'node-webpack') || (github.event.schedule == '47 23 * * *' && 'bun-webpack') || (github.event.schedule == '47 4 * * *' && 'bun') || (github.event.schedule == '47 5 * * *' && 'bun') || 'node' }}",
  ];
  const mode = opts.mode ?? [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
    "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') || (github.event.schedule == '47 5 * * *' && 'credential') || (github.event.schedule == '17 22 * * *' && 'credential') || (github.event.schedule == '47 23 * * *' && 'credential') || 'early-warning' }}",
  ];
  return ['on:', ...schedule, '', 'env:', ...lane, ...mode, ...(opts.tail ?? []), ''].join('\n');
}

const FOUR_LANES = ['node', 'bun', 'node-webpack', 'bun-webpack'];
const EXPECTED_FOUR = {
  node: '17 1 * * *',
  bun: '47 5 * * *',
  'node-webpack': '17 22 * * *',
  'bun-webpack': '47 23 * * *',
};

/** `n` consecutive daily credential nights on `lane`, one per cron slot, starting `startDate`. */
function slotStreak(
  n: number,
  lane: string,
  hhmm: string,
  startDate = '2026-01-01',
  over: (i: number) => Record<string, unknown> = () => ({}),
): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(`${startDate}T${hhmm}:00.000Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return night({
      lane,
      runId: String(50000000000 + i * 1000),
      scheduledAt: d.toISOString(),
      ...over(i),
    });
  });
}

/** Shift an ISO timestamp by `minutes`. */
function late(iso: string, minutes: number) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

describe('#1612 finding 1 — an unverifiable calendar can NEVER produce GATE MET (fail closed)', () => {
  it('positive control: 14 consecutive dated slots on one fingerprint DO meet the gate', () => {
    const nights = slotStreak(14, 'node', '01:17');
    const a = auditWindow(nights, { now: new Date('2026-01-14T12:00:00.000Z') });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    expect(a.met).toBe(true);
    expect(formatReport(a)).toContain('GATE MET');
  });

  it('F1: 14 green nights with NO scheduling date → met:false, verdict CALENDAR UNVERIFIED, never GATE MET', () => {
    const a = auditWindow(streakOf(14, 'sha256:aaaa'));
    expect(a.longest.nights).toBe(14);
    expect(a.calendarChecked).toBe(false);
    expect(a.met).toBe(false);
    expect(a.verdict).toBe('CALENDAR UNVERIFIED');
    const report = formatReport(a);
    expect(report).toContain('CALENDAR UNVERIFIED');
    expect(report).not.toContain('GATE MET');
  });

  it('F2b: 20 dated nights over 21 slots (one missing) + ONE undated ledger → met:false (the gap cannot hide behind a skip)', () => {
    const dated = slotStreak(21, 'node', '01:17').filter(
      (n) => !String(n.scheduledAt).startsWith('2026-01-08'),
    );
    const undated = night({ runId: '59999999999' });
    const a = auditWindow([...dated, undated], { now: new Date('2026-01-21T12:00:00.000Z') });
    expect(a.calendarChecked).toBe(false);
    expect(a.met).toBe(false);
    expect(a.verdict).toBe('CALENDAR UNVERIFIED');
    expect(formatReport(a)).not.toContain('GATE MET');
    const m = auditCredentialMatrix([...dated, undated], {
      cells: ['node'],
      now: new Date('2026-01-21T12:00:00.000Z'),
    });
    expect(m.cells.node.met).toBe(false);
    expect(m.allMet).toBe(false);
  });

  it('a lane whose cron cannot be resolved (parser throws) → met:false with the error as the reason', () => {
    const nights = slotStreak(14, 'node', '01:17');
    const a = auditWindow(nights, {
      now: new Date('2026-01-14T12:00:00.000Z'),
      credentialCronForLane: () => {
        throw new Error('boom: unparseable workflow');
      },
    });
    expect(a.longest.nights).toBe(14);
    expect(a.calendarChecked).toBe(false);
    expect(a.calendarSkippedReason).toMatch(/boom: unparseable workflow/);
    expect(a.met).toBe(false);
    expect(formatReport(a)).not.toContain('GATE MET');
  });

  it('a lane with no cron at all (null) → met:false', () => {
    const nights = slotStreak(14, 'node', '01:17');
    const a = auditWindow(nights, {
      now: new Date('2026-01-14T12:00:00.000Z'),
      credentialCronForLane: () => null,
    });
    expect(a.calendarChecked).toBe(false);
    expect(a.met).toBe(false);
  });

  it('a non-daily cron (cronTimeUTC throws) → met:false, never a crash and never a pass', () => {
    const nights = slotStreak(14, 'node', '01:17');
    const a = auditWindow(nights, {
      now: new Date('2026-01-14T12:00:00.000Z'),
      credentialCronForLane: () => '17 1 * * 1-5',
    });
    expect(a.calendarChecked).toBe(false);
    expect(a.met).toBe(false);
  });

  it('the pre-existing skip paths all hold met:false (mixed, legacy, unwired)', () => {
    const now = new Date('2026-01-20T12:00:00.000Z');
    const mixed = [...slotStreak(14, 'node', '01:17'), night({ runId: '1' })];
    expect(auditWindow(mixed, { now }).met).toBe(false);
    expect(auditWindow(streakOf(20, 'sha256:aaaa'), { now }).met).toBe(false);
    const vinext = slotStreak(14, 'node-vinext', '01:17');
    expect(auditWindow(vinext, { lane: 'node-vinext', now }).met).toBe(false);
  });

  it('--matrix text: an unverified cell prints CALENDAR UNVERIFIED and the verdict is never MET', () => {
    const m = auditCredentialMatrix(streakOf(14, 'sha256:aaaa'), { cells: ['node'] });
    expect(m.allMet).toBe(false);
    expect(m.calendarUnverified).toContain('node');
    const text = formatMatrix(m);
    expect(text).toContain('CALENDAR UNVERIFIED');
    const nodeRow = text.split('\n').find((l) => l.includes('lane=node '));
    expect(nodeRow).toMatch(/CALENDAR UNVERIFIED$/);
    expect(text).not.toContain('v1.0 CREDENTIAL MET');
  });
});

describe('#1612 finding 2 — a night is dated by its CRON SLOT, not the wall clock of createdAt', () => {
  it('G1: bun-webpack (23:47) run enqueued 18 min late (00:05 next day) → no spurious gap, still met', () => {
    const nights = slotStreak(14, 'bun-webpack', '23:47');
    nights[6] = { ...nights[6], scheduledAt: late(String(nights[6].scheduledAt), 18) };
    const a = auditWindow(nights, {
      lane: 'bun-webpack',
      now: new Date('2026-01-15T12:00:00.000Z'),
    });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    expect(a.restartsByCause).toEqual({});
    expect(a.longest.nights).toBe(14);
    expect(a.met).toBe(true);
    const lateNight = a.nights.find((n: { runId: string }) => n.runId === nights[6].runId);
    expect(lateNight.date).toBe('2026-01-07');
  });

  it('the late run as the ANCHOR (earliest ledger) is still dated to its own slot', () => {
    const nights = slotStreak(14, 'bun-webpack', '23:47');
    nights[0] = { ...nights[0], scheduledAt: late(String(nights[0].scheduledAt), 18) };
    const a = auditWindow(nights, {
      lane: 'bun-webpack',
      now: new Date('2026-01-15T12:00:00.000Z'),
    });
    expect(a.nights[0].date).toBe('2026-01-01');
    expect(a.missingNights).toEqual([]);
    expect(a.met).toBe(true);
  });

  it('14 runs over 13 slots (two runs in one slot) → NOT met; the doubled slot is one disqualified slot, not two nights', () => {
    const thirteen = slotStreak(13, 'node', '01:17');
    const extra = night({
      runId: '50000000500',
      scheduledAt: late(String(thirteen[4].scheduledAt), 90),
    });
    const a = auditWindow([...thirteen, extra], { now: new Date('2026-01-13T12:00:00.000Z') });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    expect(a.met).toBe(false);
    expect(a.longest.nights).toBeLessThan(14);
    const doubled = a.nights.filter((n: { date: string }) => n.date === '2026-01-05');
    expect(doubled).toHaveLength(2);
    for (const n of doubled) {
      expect(n.eligible).toBe(false);
      expect(hasReason(n, 'duplicate-slot')).toBe(true);
    }
  });

  it('the late-anchor double: a late first run cannot let 14 runs cover 13 slots', () => {
    // Slot 01-01 ran on time AND a second run landed in the same slot late —
    // under wall-clock dating the late one was "01-02", masking 01-02's absence.
    const nights = slotStreak(14, 'bun-webpack', '23:47').filter((_, i) => i !== 1);
    const lateDouble = night({
      lane: 'bun-webpack',
      runId: '50000000001',
      scheduledAt: late(String(nights[0].scheduledAt), 18),
    });
    const a = auditWindow([...nights, lateDouble], {
      lane: 'bun-webpack',
      now: new Date('2026-01-15T12:00:00.000Z'),
    });
    expect(a.missingNights.map((m: { date: string }) => m.date)).toEqual(['2026-01-02']);
    expect(a.met).toBe(false);
  });

  it('a node run 23 h late is dated to its OWN slot (no gap, no double) — and 25 h late fails closed', () => {
    const nights = slotStreak(14, 'node', '01:17');
    const now = new Date('2026-01-15T05:00:00.000Z'); // 01-15's slot not yet due
    const on23 = [...nights];
    on23[5] = { ...on23[5], scheduledAt: late(String(on23[5].scheduledAt), 23 * 60) };
    const a23 = auditWindow(on23, { now });
    expect(a23.nights.find((n: { runId: string }) => n.runId === on23[5].runId).date).toBe(
      '2026-01-06',
    );
    expect(a23.missingNights).toEqual([]);
    expect(a23.met).toBe(true);

    const on25 = [...nights];
    on25[5] = { ...on25[5], scheduledAt: late(String(on25[5].scheduledAt), 25 * 60) };
    const a25 = auditWindow(on25, { now });
    expect(a25.missingNights.map((m: { date: string }) => m.date)).toEqual(['2026-01-06']);
    expect(a25.met).toBe(false);
  });

  it('G2: grace is measured from the SLOT fire time — a 23:47 night is not missing at D+1 03:00', () => {
    const nights = slotStreak(3, 'bun-webpack', '23:47'); // 01-01..01-03
    const before = auditWindow(nights, {
      lane: 'bun-webpack',
      now: new Date('2026-01-05T03:00:00.000Z'), // 01-04's slot fired 01-04 23:47; +10h = 01-05 09:47
    });
    expect(before.calendarChecked).toBe(true);
    expect(before.missingNights).toEqual([]);
    const after = auditWindow(nights, {
      lane: 'bun-webpack',
      now: new Date('2026-01-05T09:47:00.000Z'),
    });
    expect(after.missingNights.map((m: { date: string }) => m.date)).toEqual(['2026-01-04']);
  });

  it('grace boundary: one millisecond before slot+grace is not missing; exactly slot+grace is', () => {
    const nights = slotStreak(1, 'node', '01:17'); // 01-01
    const due = Date.parse('2026-01-02T01:17:00.000Z') + MISSING_NIGHT_GRACE_HOURS * 3_600_000;
    expect(auditWindow(nights, { now: new Date(due - 1) }).missingNights).toEqual([]);
    expect(
      auditWindow(nights, { now: new Date(due) }).missingNights.map(
        (m: { date: string }) => m.date,
      ),
    ).toEqual(['2026-01-02']);
  });
});

describe('#1642 — the missed-night grace is 10h: a merely queued night is not a missing one', () => {
  it('the grace constant is 10 hours', () => {
    expect(MISSING_NIGHT_GRACE_HOURS).toBe(10);
  });

  it('a run still queued 9h after its slot fired is NOT yet a missing night', () => {
    const nights = slotStreak(1, 'node', '01:17'); // 01-01
    const a = auditWindow(nights, { now: new Date('2026-01-02T10:17:00.000Z') }); // 01-02 slot +9h
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
  });

  it('a run that lands 9h late is dated to its own slot and counts — no gap, no missing night', () => {
    const nights = slotStreak(2, 'node', '01:17'); // 01-01, 01-02
    const lateNight = night({
      lane: 'node',
      runId: String(50000000000 + 2 * 1000),
      scheduledAt: late('2026-01-03T01:17:00.000Z', 9 * 60),
    });
    const a = auditWindow([...nights, lateNight], { now: new Date('2026-01-03T12:00:00.000Z') });
    expect(a.calendarChecked).toBe(true);
    expect(a.missingNights).toEqual([]);
    expect(
      a.nights.find((n: { runId: string }) => n.runId === lateNight.runId)?.disqualifiers,
    ).toEqual([]);
  });

  it('past the 10h grace with no run, the slot IS a missing night', () => {
    const nights = slotStreak(1, 'node', '01:17'); // 01-01
    const a = auditWindow(nights, { now: new Date('2026-01-02T11:18:00.000Z') }); // 01-02 slot +10h01m
    expect(a.missingNights.map((m: { date: string }) => m.date)).toEqual(['2026-01-02']);
  });
});

describe('#1612 finding 3 — cron parsing reads on.schedule and fails loudly, never silently drops a lane', () => {
  it('the real shape parses to one cron per credential lane', () => {
    expect(
      Object.fromEntries(
        parseCredentialCronsFromWorkflow(workflowFixture(), { requiredLanes: FOUR_LANES }),
      ),
    ).toEqual(EXPECTED_FOUR);
  });

  it('M4: double-quoted strings (expression and cron list) still parse', () => {
    const text = workflowFixture().replaceAll("'", '"');
    expect(
      Object.fromEntries(parseCredentialCronsFromWorkflow(text, { requiredLanes: FOUR_LANES })),
    ).toEqual(EXPECTED_FOUR);
  });

  it("M5: swapped operands ('credential' && schedule == …, 'cron' == schedule) still parse", () => {
    const text = workflowFixture({
      mode: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        "  KNEXT_COMPAT_MODE: ${{ ('credential' && github.event.schedule == '17 1 * * *') || ('47 5 * * *' == github.event.schedule && 'credential') || (github.event.schedule == '17 22 * * *' && 'credential') || ('credential' && '47 23 * * *' == github.event.schedule) || 'early-warning' }}",
      ],
    });
    expect(
      Object.fromEntries(parseCredentialCronsFromWorkflow(text, { requiredLanes: FOUR_LANES })),
    ).toEqual(EXPECTED_FOUR);
  });

  it('M6: a `>-` folded block scalar still parses', () => {
    const text = workflowFixture({
      mode: [
        '  KNEXT_COMPAT_MODE: >-',
        "    ${{ (github.event.schedule == '17 1 * * *' && 'credential')",
        "    || (github.event.schedule == '47 5 * * *' && 'credential')",
        "    || (github.event.schedule == '17 22 * * *' && 'credential')",
        "    || (github.event.schedule == '47 23 * * *' && 'credential')",
        "    || 'early-warning' }}",
      ],
    });
    expect(
      Object.fromEntries(parseCredentialCronsFromWorkflow(text, { requiredLanes: FOUR_LANES })),
    ).toEqual(EXPECTED_FOUR);
  });

  it('M7: a required lane with no credential cron THROWS (never silently absent)', () => {
    const text = workflowFixture({
      mode: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') || (github.event.schedule == '17 22 * * *' && 'credential') || (github.event.schedule == '47 23 * * *' && 'credential') || 'early-warning' }}",
      ],
    });
    expect(() => parseCredentialCronsFromWorkflow(text, { requiredLanes: FOUR_LANES })).toThrow(
      /bun/,
    );
  });

  it('M1: a credential cron that is not in on.schedule THROWS (stale mapping)', () => {
    const text = workflowFixture({
      schedule: [
        '  schedule:',
        "    - cron: '19 2 * * *'",
        "    - cron: '47 5 * * *'",
        "    - cron: '17 22 * * *'",
        "    - cron: '47 23 * * *'",
      ],
    });
    expect(() => parseCredentialCronsFromWorkflow(text, { requiredLanes: FOUR_LANES })).toThrow(
      /17 1 \* \* \*.*schedule/,
    );
  });

  it('no on.schedule block at all THROWS', () => {
    const text = workflowFixture({ schedule: ['  workflow_dispatch:'] });
    expect(() => parseCredentialCronsFromWorkflow(text)).toThrow(/schedule/);
  });

  it('a schedule clause in a shape it cannot read THROWS rather than dropping it', () => {
    const text = workflowFixture({
      mode: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') || (contains(github.event.schedule, '47 5') && 'credential') || 'early-warning' }}",
      ],
    });
    expect(() => parseCredentialCronsFromWorkflow(text)).toThrow(/cannot parse/);
  });

  it('a non-daily credential cron THROWS at parse time', () => {
    const text = workflowFixture({
      schedule: ['  schedule:', "    - cron: '17 1 * * 1-5'"],
      lane: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        "  KNEXT_LANE: ${{ github.event.inputs.runtime || 'node' }}",
      ],
      mode: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * 1-5' && 'credential') || 'early-warning' }}",
      ],
    });
    expect(() => parseCredentialCronsFromWorkflow(text)).toThrow(/daily/);
  });

  it('credentialCronForLane throws for a wired lane whose workflow lost its cron — and auditWindow turns that into met:false', () => {
    const broken = workflowFixture({
      mode: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax being parsed
        "  KNEXT_COMPAT_MODE: ${{ (github.event.schedule == '17 1 * * *' && 'credential') || 'early-warning' }}",
      ],
    });
    expect(() => credentialCronForLane('node', { readWorkflow: () => broken })).toThrow(
      /no credential cron/,
    );
    const a = auditWindow(slotStreak(14, 'node', '01:17'), {
      now: new Date('2026-01-14T12:00:00.000Z'),
      credentialCronForLane: (lane: string) =>
        credentialCronForLane(lane, { readWorkflow: () => broken }),
    });
    expect(a.calendarChecked).toBe(false);
    expect(a.met).toBe(false);
  });
});
