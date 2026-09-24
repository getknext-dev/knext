import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isRedConclusion,
  isTerminalStatus,
  pickDispatchedRun,
  SHIPPED_PIN_CELLS,
  shippedPinRef,
} from '../scripts/lib/dispatch-poll.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, '.github/compat-credentialed-next-version.json');

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
    const before = [];
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
    const before = [];
    const after = [
      { databaseId: 5, event: 'schedule', headBranch, createdAt: '2026-01-01T00:00:00Z' },
    ];
    expect(pickDispatchedRun(before, after, { headBranch })).toBeNull();
  });

  it('breaks ties on the newest createdAt', () => {
    const before = [];
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
      const before = [];
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
      const before = [];
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
      const before = [];
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
      const before = [];
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
