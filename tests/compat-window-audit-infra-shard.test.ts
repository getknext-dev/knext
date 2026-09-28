import { describe, expect, it } from 'bun:test';
import { gradeNight } from '../scripts/compat-window-audit.mjs';

/**
 * #1530 (sprint B4) — a shard aborted by the free-disk-floor pre-check
 * (`scripts/compat-disk-floor-check.mjs`) must:
 *   - still disqualify the night (never a pass);
 *   - be labelled `infra-classified`, never a generic red or `deploy-classified`,
 *     so triage is not misdirected at a phantom `kind: 'assertion'` regression.
 */

type ShardRow = Record<string, unknown> & { shard: string };

function liveBytecode(runtime: string) {
  return { runtime, deploys: 3, live: 3, notLive: 0, reasons: [] };
}

function greenShard(id: string): ShardRow {
  return {
    shard: id,
    passed: 10,
    failed: 0,
    notRun: 0,
    runtime: 'node',
    bytecode: liveBytecode('node'),
  };
}

/** The exact shape `compat-disk-floor-check.mjs`'s workflow wiring produces. */
function infraShard(id: string): ShardRow {
  return {
    shard: id,
    passed: 0,
    failed: 0,
    notRun: 1,
    runtime: 'node',
    bytecode: liveBytecode('node'),
    failures: [{ file: '(infra: free-disk-floor)', kind: 'infra', cases: [] }],
  };
}

function night(shards: ShardRow[]) {
  return {
    runId: '1',
    runAttempt: '1',
    event: 'schedule',
    lane: 'node',
    ref: 'v16.2.0',
    compatMode: 'credential',
    credential: true,
    knextRef: 'refs/tags/v1.0.0-rc.1',
    knextSha: 'a'.repeat(40),
    complete: true,
    shardsExpected: shards.length,
    shardsSeen: shards.length,
    missingShards: [],
    windowFingerprint: 'sha256:aaaa',
    shards,
  };
}

describe('gradeNight: an infra-aborted shard', () => {
  it('disqualifies the night (never a pass)', () => {
    const graded = gradeNight(night([greenShard('1/2'), infraShard('2/2')]), {
      lane: 'node',
      scope: 'credential',
    });
    expect(graded.eligible).toBe(false);
  });

  it('is labelled infra-classified, not a generic red', () => {
    const graded = gradeNight(night([greenShard('1/2'), infraShard('2/2')]), {
      lane: 'node',
      scope: 'credential',
    });
    expect(graded.disqualifiers.some((d) => d.startsWith('infra-classified:'))).toBe(true);
  });

  it('is never labelled deploy-classified', () => {
    const graded = gradeNight(night([greenShard('1/2'), infraShard('2/2')]), {
      lane: 'node',
      scope: 'credential',
    });
    expect(graded.disqualifiers.some((d) => d.startsWith('deploy-classified:'))).toBe(false);
  });

  it('a real failure alongside an infra marker is NOT labelled infra-classified', () => {
    const mixedShard: ShardRow = {
      shard: '2/2',
      passed: 0,
      failed: 1,
      notRun: 0,
      runtime: 'node',
      bytecode: liveBytecode('node'),
      failures: [{ file: 'test/e2e/real-regression.test.ts', kind: 'assertion', cases: ['x'] }],
    };
    const graded = gradeNight(night([greenShard('1/2'), mixedShard]), {
      lane: 'node',
      scope: 'credential',
    });
    expect(graded.disqualifiers.some((d) => d.startsWith('infra-classified:'))).toBe(false);
    expect(graded.disqualifiers.some((d) => d === 'shard 2/2 red (failed=1 notRun=0)')).toBe(true);
  });

  it('a failedCount above zero is NEVER infra-classified, even if every named failure claims kind:infra', () => {
    // A malformed/corrupted attribution: `failed: 1` alongside a SINGLE
    // failure entry that claims `kind: 'infra'`. `isInfraOnlyRedShard`'s own
    // doc comment requires `failedCount === 0` because a genuine disk-floor
    // abort never reports a real `failed` count — only `notRun`. Without that
    // guard, `failures.every(kind === 'infra')` alone would still read this
    // as infra-classified.
    const corruptShard: ShardRow = {
      shard: '2/2',
      passed: 0,
      failed: 1,
      notRun: 0,
      runtime: 'node',
      bytecode: liveBytecode('node'),
      failures: [{ file: '(infra: free-disk-floor)', kind: 'infra', cases: [] }],
    };
    const graded = gradeNight(night([greenShard('1/2'), corruptShard]), {
      lane: 'node',
      scope: 'credential',
    });
    expect(graded.disqualifiers.some((d) => d.startsWith('infra-classified:'))).toBe(false);
    expect(graded.disqualifiers.some((d) => d === 'shard 2/2 red (failed=1 notRun=0)')).toBe(true);
  });
});
