import { describe, expect, it } from 'bun:test';
import {
  computePreflightVerdict,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  decidePollAction,
  detectRunnerForContent,
  extractFailingTestLines,
  failedCheckRuns,
  formatBlockedDeletionMessage,
  groupChangedTestFilesByRunner,
  headLockHolds,
  isFullSha,
  isTestFilePath,
  parseDurationSeconds,
  resolveRemoteSha,
} from '../scripts/lib/merge-train.mjs';

/**
 * #1439 — promote the lead's scratch merge scripts into a tested tool.
 * Each guard is proven by `scripts/mutation-prove-merge-train.mjs`; these
 * are the unit tests that prover runs against.
 */

// ── SHA-lock: only full 40-hex SHAs, and only ones that resolve ────────────

describe('isFullSha', () => {
  it('accepts a full 40-hex SHA', () => {
    expect(isFullSha('a'.repeat(40))).toBe(true);
    expect(isFullSha('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe(true);
  });

  it('rejects a short SHA', () => {
    expect(isFullSha('abc1234')).toBe(false);
  });

  it('rejects a branch name or non-hex garbage', () => {
    expect(isFullSha('feat/my-branch')).toBe(false);
    expect(isFullSha('g'.repeat(40))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isFullSha(undefined)).toBe(false);
    expect(isFullSha(null)).toBe(false);
  });
});

describe('resolveRemoteSha', () => {
  const sha = 'a'.repeat(40);

  it('returns the canonical sha when the remote resolves it', () => {
    const gh = () => `${sha}\n`;
    expect(resolveRemoteSha(gh, 'getknext-dev/knext', sha)).toBe(sha);
  });

  it('returns null when the remote does not know the commit (gh throws)', () => {
    const gh = () => {
      throw new Error('gh: 422 No commit found for SHA');
    };
    expect(resolveRemoteSha(gh, 'getknext-dev/knext', sha)).toBeNull();
  });

  it('returns null for a non-SHA input without calling gh', () => {
    let called = false;
    const gh = () => {
      called = true;
      return sha;
    };
    expect(resolveRemoteSha(gh, 'getknext-dev/knext', 'not-a-sha')).toBeNull();
    expect(called).toBe(false);
  });
});

// ── head-lock re-check on every poll tick ───────────────────────────────────

describe('headLockHolds', () => {
  it('holds when current equals expected', () => {
    expect(headLockHolds('abc', 'abc')).toBe(true);
  });

  it('fails when a push moved the head', () => {
    expect(headLockHolds('def', 'abc')).toBe(false);
  });
});

describe('decidePollAction', () => {
  const expectedHead = 'a'.repeat(40);

  it('reports HEAD_MOVED before anything else, even if the PR also merged', () => {
    const r = decidePollAction({
      currentHead: 'b'.repeat(40),
      expectedHead,
      prState: 'MERGED',
      headInMain: true,
    });
    expect(r.action).toBe('HEAD_MOVED');
  });

  it('reports MERGED head-in-main when the head is unchanged and merged', () => {
    const r = decidePollAction({
      currentHead: expectedHead,
      expectedHead,
      prState: 'MERGED',
      headInMain: true,
    });
    expect(r.action).toBe('MERGED');
    expect(r.detail).toBe('head-in-main');
  });

  it('reports MERGED HEAD-NOT-IN-MAIN when the merge commit does not carry the reviewed head', () => {
    const r = decidePollAction({
      currentHead: expectedHead,
      expectedHead,
      prState: 'MERGED',
      headInMain: false,
    });
    expect(r.detail).toBe('HEAD-NOT-IN-MAIN');
  });

  it('reports DEQUEUED when the PR closed without merging', () => {
    const r = decidePollAction({ currentHead: expectedHead, expectedHead, prState: 'CLOSED' });
    expect(r.action).toBe('DEQUEUED');
  });

  it('reports CONTINUE while still open with a matching head', () => {
    const r = decidePollAction({ currentHead: expectedHead, expectedHead, prState: 'OPEN' });
    expect(r.action).toBe('CONTINUE');
  });
});

// ── pre-enqueue preflight: runner detection + red verdict ──────────────────

describe('isTestFilePath', () => {
  it('matches __tests__ and *.test.ts conventions', () => {
    expect(isTestFilePath('scripts/lib/__tests__/foo.ts')).toBe(true); // anything under __tests__/
    expect(isTestFilePath('tests/merge-train.test.ts')).toBe(true);
    expect(isTestFilePath('packages/kn-next/src/__tests__/deploy.test.ts')).toBe(true);
    expect(isTestFilePath('scripts/foo.spec.mjs')).toBe(true);
  });

  it('does not match non-test source', () => {
    expect(isTestFilePath('scripts/lib/merge-train.mjs')).toBe(false);
  });
});

describe('detectRunnerForContent', () => {
  it('picks bun for a bun:test import', () => {
    expect(detectRunnerForContent("import { describe } from 'bun:test';")).toBe('bun');
  });

  it('picks vitest otherwise', () => {
    expect(detectRunnerForContent("import { describe } from 'vitest';")).toBe('vitest');
  });
});

describe('groupChangedTestFilesByRunner', () => {
  it('splits changed test files by runner and ignores non-test files', () => {
    const files = [
      { path: 'tests/merge-train.test.ts', content: "from 'bun:test'" },
      { path: 'packages/kn-next/src/__tests__/x.test.ts', content: "from 'vitest'" },
      { path: 'scripts/lib/merge-train.mjs', content: 'export const x = 1;' },
    ];
    const groups = groupChangedTestFilesByRunner(files);
    expect(groups.bun).toEqual(['tests/merge-train.test.ts']);
    expect(groups.vitest).toEqual(['packages/kn-next/src/__tests__/x.test.ts']);
  });
});

describe('extractFailingTestLines', () => {
  it('finds bun:test (fail) markers', () => {
    const out = 'ok (pass)\nsomething (fail)\n  expected 1 to be 2\n1 pass\n1 fail';
    expect(extractFailingTestLines(out)).toContain('something (fail)');
  });

  it('finds vitest FAIL markers', () => {
    const out = ' FAIL  tests/foo.test.ts > does a thing';
    expect(extractFailingTestLines(out).some((l) => l.startsWith('FAIL'))).toBe(true);
  });

  it('returns an empty array on clean output', () => {
    expect(extractFailingTestLines('5 pass\n0 fail\n')).toEqual([]);
  });
});

describe('computePreflightVerdict', () => {
  it('is ok on exit code 0', () => {
    expect(computePreflightVerdict({ exitCode: 0, output: 'irrelevant' })).toEqual({ ok: true });
  });

  it('refuses and surfaces the failing line on a red run', () => {
    const v = computePreflightVerdict({
      exitCode: 1,
      output: 'setup\nmy assertion (fail)\n  expected true\n1 fail',
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.reason).toMatch(/preflight tests failed/);
    expect(v.failing.some((l) => l.includes('(fail)'))).toBe(true);
  });

  it('falls back to a tail of raw output when no known failure marker is found', () => {
    const v = computePreflightVerdict({ exitCode: 1, output: 'segfault, no markers here' });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.failing[0]).toContain('segfault');
  });
});

// ── post-dequeue: failing check-run extraction ──────────────────────────────

describe('failedCheckRuns', () => {
  it('keeps only completed, non-success/neutral runs', () => {
    const runs = [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'unit', status: 'completed', conclusion: 'failure' },
      { name: 'e2e', status: 'in_progress', conclusion: null },
      { name: 'docs', status: 'completed', conclusion: 'neutral' },
      { name: 'typecheck', status: 'completed', conclusion: 'cancelled' },
    ];
    const failed = failedCheckRuns(runs);
    expect(failed.map((r) => r.name)).toEqual(['unit', 'typecheck']);
  });

  it('returns an empty array when everything passed', () => {
    const runs = [{ name: 'lint', status: 'completed', conclusion: 'success' }];
    expect(failedCheckRuns(runs)).toEqual([]);
  });
});

// ── pre-branch-deletion: stacked-child retarget planning ────────────────────

describe('formatBlockedDeletionMessage', () => {
  it('lists every open child PR and names the retarget flag', () => {
    const msg = formatBlockedDeletionMessage('feat/1406-base', [
      { number: 1428, title: 'stacked child', url: 'https://github.com/x/y/pull/1428' },
    ]);
    expect(msg).toContain('REFUSING to delete "feat/1406-base"');
    expect(msg).toContain('#1428 stacked child');
    expect(msg).toContain('--retarget');
  });
});

// ── timeout parsing ──────────────────────────────────────────────────────────

describe('parseDurationSeconds', () => {
  it('parses hours, minutes, seconds, and bare integers', () => {
    expect(parseDurationSeconds('8h')).toBe(8 * 3600);
    expect(parseDurationSeconds('30m')).toBe(30 * 60);
    expect(parseDurationSeconds('90s')).toBe(90);
    expect(parseDurationSeconds('120')).toBe(120);
    expect(parseDurationSeconds(45)).toBe(45);
  });

  it('throws on an unparsable value', () => {
    expect(() => parseDurationSeconds('forever')).toThrow(/cannot parse duration/);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(8 * 3600);
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBeGreaterThan(0);
  });
});
