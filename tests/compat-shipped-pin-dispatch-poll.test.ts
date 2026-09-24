import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isRedConclusion,
  isTerminalStatus,
  pickDispatchedRun,
  SHIPPED_PIN_CELLS,
  shippedPinRef,
  withRetry,
} from '../scripts/lib/dispatch-poll.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json');

/**
 * The shape `pickDispatchedRun`'s `runsBefore`/`runsAfter` take (see
 * `scripts/lib/dispatch-poll.mjs`'s JSDoc). rev-1382 review: a bare
 * `const before = []` is implicit `any[]` (TS7034/TS7005) under this repo's
 * root `tsconfig.typecheck.json` strict gate — annotate every such fixture
 * explicitly rather than let the type flow from an untyped empty literal.
 */
type CredentialRunFixture = {
  databaseId: number;
  event?: string;
  headBranch?: string;
  createdAt?: string;
  displayTitle?: string;
};

describe('shippedPinRef', () => {
  it('derives the v-prefixed ref from shippedNextPin', () => {
    expect(shippedPinRef({ shippedNextPin: '16.3.3' })).toBe('v16.3.3');
    expect(shippedPinRef({ shippedNextPin: '16.4.0' })).toBe('v16.4.0');
  });

  it('matches the REAL manifest today, proving the tie is live, not just unit-tested', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(shippedPinRef(manifest)).toBe(`v${manifest.shippedNextPin}`);
  });
});

describe('SHIPPED_PIN_CELLS', () => {
  it('is the 4 real (non-excluded) runtime x builder cells', () => {
    expect(SHIPPED_PIN_CELLS).toHaveLength(4);
    const keys = SHIPPED_PIN_CELLS.map((c) => `${c.runtime}-${c.builder}`).sort();
    expect(keys).toEqual(['bun-turbopack', 'bun-webpack', 'node-turbopack', 'node-webpack']);
  });
});

describe('pickDispatchedRun', () => {
  const headBranch = 'main';

  it('picks the run not present before dispatch, on the same branch', () => {
    const before = [{ databaseId: 1 }, { databaseId: 2 }];
    const after = [
      { databaseId: 1, event: 'schedule', headBranch, createdAt: '2026-01-01T00:00:00Z' },
      { databaseId: 2, event: 'workflow_dispatch', headBranch, createdAt: '2026-01-01T00:01:00Z' },
      { databaseId: 3, event: 'workflow_dispatch', headBranch, createdAt: '2026-01-01T00:05:00Z' },
    ];
    expect(pickDispatchedRun(before, after, { headBranch })?.databaseId).toBe(3);
  });

  it('ignores a new run on a DIFFERENT branch', () => {
    const before: CredentialRunFixture[] = [];
    const after = [
      {
        databaseId: 5,
        event: 'workflow_dispatch',
        headBranch: 'other',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    expect(pickDispatchedRun(before, after, { headBranch })).toBeNull();
  });

  it('ignores a new SCHEDULED run — only workflow_dispatch counts', () => {
    const before: CredentialRunFixture[] = [];
    const after = [
      { databaseId: 5, event: 'schedule', headBranch, createdAt: '2026-01-01T00:00:00Z' },
    ];
    expect(pickDispatchedRun(before, after, { headBranch })).toBeNull();
  });

  it('breaks ties on the newest createdAt', () => {
    const before: CredentialRunFixture[] = [];
    const after = [
      { databaseId: 10, event: 'workflow_dispatch', headBranch, createdAt: '2026-01-01T00:00:00Z' },
      { databaseId: 11, event: 'workflow_dispatch', headBranch, createdAt: '2026-01-01T00:10:00Z' },
    ];
    expect(pickDispatchedRun(before, after, { headBranch })?.databaseId).toBe(11);
  });

  it('returns null when nothing new is present', () => {
    const before = [{ databaseId: 1 }];
    const after = [
      { databaseId: 1, event: 'workflow_dispatch', headBranch, createdAt: '2026-01-01T00:00:00Z' },
    ];
    expect(pickDispatchedRun(before, after, { headBranch })).toBeNull();
  });

  // ── rev-1382 finding 2: 4 legs dispatched within seconds must never latch
  // onto the SAME run. With a dispatchId, matching is by EXACT displayTitle
  // equality — no recency heuristic at all, even among multiple real
  // candidates.
  describe('with dispatchId — exact displayTitle match, no recency heuristic', () => {
    it('picks the run whose displayTitle equals dispatchId, among 4 concurrent legs', () => {
      const before: CredentialRunFixture[] = [];
      const after = [
        {
          databaseId: 101,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: '104-node-turbopack',
          createdAt: '2026-01-01T00:00:01Z',
        },
        {
          databaseId: 102,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: '104-node-webpack',
          createdAt: '2026-01-01T00:00:02Z',
        },
        {
          databaseId: 103,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: '104-bun-turbopack',
          createdAt: '2026-01-01T00:00:03Z',
        },
        {
          databaseId: 104,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: '104-bun-webpack',
          createdAt: '2026-01-01T00:00:04Z',
        },
      ];
      expect(
        pickDispatchedRun(before, after, { headBranch, dispatchId: '104-node-turbopack' })
          ?.databaseId,
      ).toBe(101);
      expect(
        pickDispatchedRun(before, after, { headBranch, dispatchId: '104-bun-webpack' })?.databaseId,
      ).toBe(104);
    });

    it('ignores a NEWER run with a different dispatchId — no "newest wins" fallback', () => {
      const before: CredentialRunFixture[] = [];
      const after = [
        {
          databaseId: 1,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: '104-node-turbopack',
          createdAt: '2026-01-01T00:00:01Z',
        },
        {
          databaseId: 2,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: 'some other manual dispatch',
          createdAt: '2026-01-01T00:00:99Z',
        },
      ];
      expect(
        pickDispatchedRun(before, after, { headBranch, dispatchId: '104-node-turbopack' })
          ?.databaseId,
      ).toBe(1);
    });

    it("matching is EXACT equality, not substring — a dispatchId that is a PREFIX of another run's displayTitle must not match it", () => {
      const before: CredentialRunFixture[] = [];
      const after = [
        {
          databaseId: 1,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: '104-node-turbopack',
          createdAt: '2026-01-01T00:00:01Z',
        },
      ];
      // '104-node' is a PREFIX of '104-node-turbopack' — an includes()-based
      // matcher would wrongly pick run 1 for a leg that never dispatched it.
      expect(pickDispatchedRun(before, after, { headBranch, dispatchId: '104-node' })).toBeNull();
    });

    it('fails closed (null) when no run carries the exact dispatchId, even with other candidates present', () => {
      const before: CredentialRunFixture[] = [];
      const after = [
        {
          databaseId: 1,
          event: 'workflow_dispatch',
          headBranch,
          displayTitle: 'some other manual dispatch',
          createdAt: '2026-01-01T00:00:01Z',
        },
      ];
      expect(
        pickDispatchedRun(before, after, { headBranch, dispatchId: '104-node-turbopack' }),
      ).toBeNull();
    });

    it('an EMPTY dispatchId falls back to the old recency heuristic (backward compat)', () => {
      const before = [{ databaseId: 1 }];
      const after = [
        {
          databaseId: 1,
          event: 'workflow_dispatch',
          headBranch,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          databaseId: 2,
          event: 'workflow_dispatch',
          headBranch,
          createdAt: '2026-01-01T00:01:00Z',
        },
      ];
      expect(pickDispatchedRun(before, after, { headBranch, dispatchId: '' })?.databaseId).toBe(2);
    });
  });
});

describe('isTerminalStatus / isRedConclusion', () => {
  it('only "completed" is terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('in_progress')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  it('success/neutral are the only non-red conclusions', () => {
    expect(isRedConclusion('success')).toBe(false);
    expect(isRedConclusion('neutral')).toBe(false);
    expect(isRedConclusion('failure')).toBe(true);
    expect(isRedConclusion('cancelled')).toBe(true);
    expect(isRedConclusion('timed_out')).toBe(true);
    expect(isRedConclusion('action_required')).toBe(true);
    // An unrecognised/future conclusion string must default to RED, never green.
    expect(isRedConclusion('some_future_conclusion_shape')).toBe(true);
    expect(isRedConclusion(null)).toBe(true);
    expect(isRedConclusion(undefined)).toBe(true);
  });
});

describe('withRetry — a bounded retry for transient `gh` errors during the 90-min poll', () => {
  // rev-1382 review (optional item): one transient gh API blip during the
  // poll loop used to crash the whole script immediately (uncaught, exit 1)
  // — a real credential/early-warning red would be indistinguishable from a
  // one-off network hiccup. A bounded retry with backoff absorbs the blip
  // without absorbing a REAL, persistent failure (which must still surface).

  it('returns the result on the first success, calling fn exactly once', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a THROWING fn up to the bound, then returns the eventual success', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient: rate limited');
        return 'ok on 3rd attempt';
      },
      {
        attempts: 5,
        delayMs: 10,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toBe('ok on 3rd attempt');
    expect(calls).toBe(3);
    // 2 retries -> 2 sleeps, never a sleep after the final (successful) call.
    // Exponential: the 2nd retry's delay is double the 1st's.
    expect(sleeps).toEqual([10, 20]);
  });

  it('gives up and re-throws the LAST error once the attempt bound is exhausted — never silently swallowed', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`persistent failure #${calls}`);
        },
        { attempts: 3, delayMs: 0, sleep: async () => {} },
      ),
    ).rejects.toThrow('persistent failure #3');
    expect(calls).toBe(3);
  });

  it('never sleeps/retries at all with attempts=1 (self-test: the bound is honoured exactly, not off-by-one)', async () => {
    let calls = 0;
    let slept = false;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('nope');
        },
        {
          attempts: 1,
          delayMs: 999,
          sleep: async () => {
            slept = true;
          },
        },
      ),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
    expect(slept).toBe(false);
  });

  it('applies exponential backoff by default (each retry doubles the delay), not a flat delay', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('nope');
        },
        {
          attempts: 4,
          delayMs: 100,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });
});
