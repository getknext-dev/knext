import { describe, expect, it } from 'bun:test';
import {
  auditWindow,
  gradeNight,
  INVALID_REASONS,
  invalidNight,
  isInvalid,
  isUnresolved,
} from '../scripts/compat-window-audit.mjs';

/**
 * #1530 (sprint B4) — the operator-digest-mismatch pre-check must produce a
 * night that is neither red nor green, and — unlike an UNRESOLVED night
 * (rule 5) — must not reset the streak either. See INVALID_REASONS' doc
 * comment in the target file for the full reasoning; this spec proves the
 * mechanics.
 */

type ShardRow = Record<string, unknown> & { shard: string };

function liveBytecode(runtime: string) {
  return { runtime, deploys: 3, live: 3, notLive: 0, reasons: [] };
}

/** A green 2-shard node night, minimal but real-shaped. */
function night(over: Record<string, unknown> = {}) {
  const shards: ShardRow[] = Array.from({ length: 2 }, (_, i) => ({
    shard: `${i + 1}/2`,
    passed: 10,
    failed: 0,
    notRun: 0,
    runtime: 'node',
    bytecode: liveBytecode('node'),
  }));
  return {
    runId: '31149348286',
    runAttempt: '1',
    event: 'schedule',
    lane: 'node',
    ref: 'v16.2.0',
    compatMode: 'credential',
    credential: true,
    knextRef: 'refs/tags/v1.0.0-rc.1',
    knextSha: 'a'.repeat(40),
    complete: true,
    shardsExpected: 2,
    shardsSeen: 2,
    missingShards: [],
    windowFingerprint: 'sha256:aaaa',
    shards,
    ...over,
  };
}

describe('invalidNight / isInvalid', () => {
  it('rejects an unknown reason', () => {
    expect(() => invalidNight('1', 'not-a-real-reason' as never)).toThrow();
  });

  it('builds a stand-in ledger isInvalid() recognizes, and isUnresolved() does not', () => {
    const ledger = invalidNight('42', 'operator-digest-mismatch', 'node', 'credential');
    expect(isInvalid(ledger)).toBe(true);
    expect(isUnresolved(ledger)).toBe(false);
    expect(ledger.shards).toEqual([]);
  });

  it('every declared reason round-trips through invalidNight/isInvalid', () => {
    for (const reason of INVALID_REASONS) {
      expect(isInvalid(invalidNight('1', reason))).toBe(true);
    }
  });
});

describe('gradeNight on an invalid night', () => {
  const graded = gradeNight(invalidNight('42', 'operator-digest-mismatch', 'node', 'credential'), {
    lane: 'node',
    scope: 'credential',
  });

  it('is never eligible — an invalid night is never a green night', () => {
    expect(graded.eligible).toBe(false);
  });

  it('is tagged invalid, not unresolved', () => {
    expect(graded.invalid).toBe('operator-digest-mismatch');
    expect(graded.unresolved).toBeNull();
  });

  it('carries no fingerprint and no shard evidence', () => {
    expect(graded.fingerprint).toBeNull();
    expect(graded.shardsSeen).toBe(0);
    expect(graded.passed).toBe(0);
    expect(graded.failed).toBe(0);
  });
});

describe('auditWindow: an invalid night PAUSES the streak, never resets it', () => {
  it('joins two qualifying nights across an invalid one into a single streak', () => {
    const ledgers = [
      night({ runId: '1', windowFingerprint: 'fp1' }),
      invalidNight('2', 'operator-digest-mismatch', 'node', 'credential'),
      night({ runId: '3', windowFingerprint: 'fp1' }),
    ];
    const audit = auditWindow(ledgers, { lane: 'node', requiredNights: 2, scope: 'credential' });
    expect(audit.streaks).toHaveLength(1);
    expect(audit.streaks[0].nights).toBe(2);
    expect(audit.streaks[0].runIds).toEqual(['1', '3']);
    expect(audit.current.nights).toBe(2);
    expect(audit.met).toBe(true);
  });

  it('is surfaced in invalidNights, never silently dropped from the record', () => {
    const ledgers = [
      night({ runId: '1', windowFingerprint: 'fp1' }),
      invalidNight('2', 'operator-digest-mismatch', 'node', 'credential'),
      night({ runId: '3', windowFingerprint: 'fp1' }),
    ];
    const audit = auditWindow(ledgers, { lane: 'node', requiredNights: 2, scope: 'credential' });
    expect(audit.invalidNights).toEqual([{ runId: '2', reason: 'operator-digest-mismatch' }]);
    // An invalid night is never counted among the unresolved either — the two
    // reasons are distinct kinds and must not be conflated in the report.
    expect(audit.unresolvedNights).toEqual([]);
  });

  it('does not itself extend a streak (it contributes zero nights)', () => {
    const ledgers = [
      night({ runId: '1', windowFingerprint: 'fp1' }),
      invalidNight('2', 'operator-digest-mismatch', 'node', 'credential'),
    ];
    const audit = auditWindow(ledgers, { lane: 'node', requiredNights: 5, scope: 'credential' });
    expect(audit.current.nights).toBe(1);
  });

  it('an all-invalid window reports zero nights, not a false streak', () => {
    const ledgers = [
      invalidNight('1', 'operator-digest-mismatch', 'node', 'credential'),
      invalidNight('2', 'operator-digest-mismatch', 'node', 'credential'),
    ];
    const audit = auditWindow(ledgers, { lane: 'node', requiredNights: 2, scope: 'credential' });
    expect(audit.streaks).toHaveLength(0);
    expect(audit.current.nights).toBe(0);
    expect(audit.met).toBe(false);
    expect(audit.invalidNights).toHaveLength(2);
  });
});
