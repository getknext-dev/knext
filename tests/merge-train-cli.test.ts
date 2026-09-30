import { describe, expect, it } from 'bun:test';
import {
  deleteBaseBranch,
  enqueueAndWait,
  investigateFailure,
  listOpenChildPRs,
} from '../scripts/merge-train.mjs';

/**
 * #1439 — the CLI orchestration layer, exercised with a fake `gh` so no
 * network call is ever made. Real git plumbing (`isHeadAncestorOfMain`, the
 * scratch-worktree preflight) is intentionally NOT exercised here — those
 * are thin wrappers around real git and are covered by manual/OKE
 * verification, not unit tests; every DECISION they feed into
 * (`decidePollAction`, `computePreflightVerdict`) is unit-tested in
 * `tests/merge-train.test.ts`.
 */

const REPO = 'getknext-dev/knext';
const SHA = 'a'.repeat(40);

type GhHandler = [(args: string[]) => boolean, (args: string[]) => string];

function fakeGh(handlers: GhHandler[]) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    for (const [match, respond] of handlers) {
      if (match(args)) return respond(args);
    }
    throw new Error(`fakeGh: no handler for ${JSON.stringify(args)}`);
  };
  gh.calls = calls;
  return gh;
}

describe('enqueueAndWait — SHA-lock guards', () => {
  it('refuses a short SHA without calling gh at all', async () => {
    const gh = fakeGh([]);
    const code = await enqueueAndWait(gh, REPO, 123, 'abc1234');
    expect(code).toBe(3);
    expect(gh.calls.length).toBe(0);
  });

  it('refuses a SHA that does not resolve on the remote', async () => {
    const gh = fakeGh([
      [
        (a) => a[0] === 'api' && a[1].includes('/commits/'),
        () => {
          throw new Error('404');
        },
      ],
    ]);
    const code = await enqueueAndWait(gh, REPO, 123, SHA);
    expect(code).toBe(3);
  });

  it('reports HEAD MOVED before merging when the PR head has already changed', async () => {
    const gh = fakeGh([
      [(a) => a[0] === 'api' && a[1].includes('/commits/'), () => `${SHA}\n`],
      [
        (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefOid'),
        () => `${'b'.repeat(40)}\n`,
      ],
    ]);
    const code = await enqueueAndWait(gh, REPO, 123, SHA);
    expect(code).toBe(3);
    expect(gh.calls.some((c) => c[0] === 'pr' && c[1] === 'merge')).toBe(false);
  });
});

describe('enqueueAndWait — dequeue investigation', () => {
  it('runs investigateFailure and returns 1 when the PR closes without merging', async () => {
    const gh = fakeGh([
      [
        (a) => a[0] === 'api' && a[1].includes('/commits/') && a.includes('-q') && a[3] === '.sha',
        () => `${SHA}\n`,
      ],
      [
        (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefOid') && a.length === 9,
        () => `${SHA}\n`,
      ],
      [(a) => a[0] === 'pr' && a[1] === 'merge', () => ''],
      [
        (a) =>
          a[0] === 'pr' &&
          a[1] === 'view' &&
          a.includes('state,headRefOid,mergeCommit,baseRefName,headRefName'),
        () => JSON.stringify({ state: 'CLOSED', headRefOid: SHA, mergeCommit: null }),
      ],
      [
        (a) => a[0] === 'api' && a[1].includes('/check-runs'),
        () =>
          JSON.stringify([
            { name: 'unit', status: 'completed', conclusion: 'failure', detailsUrl: 'https://x/y' },
          ]),
      ],
    ]);
    const code = await enqueueAndWait(gh, REPO, 123, SHA, {
      skipPreflight: true,
      intervalSeconds: 0.01,
    });
    expect(code).toBe(1);
  });
});

describe('enqueueAndWait — timeout', () => {
  it('returns TIMEOUT (2) when the PR never resolves within the window', async () => {
    const gh = fakeGh([
      [(a) => a[0] === 'api' && a[1].includes('/commits/'), () => `${SHA}\n`],
      [
        (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefOid') && a.length === 9,
        () => `${SHA}\n`,
      ],
      [(a) => a[0] === 'pr' && a[1] === 'merge', () => ''],
      [
        (a) =>
          a[0] === 'pr' &&
          a[1] === 'view' &&
          a.includes('state,headRefOid,mergeCommit,baseRefName,headRefName'),
        () => JSON.stringify({ state: 'OPEN', headRefOid: SHA, mergeCommit: null }),
      ],
    ]);
    const code = await enqueueAndWait(gh, REPO, 123, SHA, {
      skipPreflight: true,
      timeoutSeconds: 0.02,
      intervalSeconds: 0.01,
    });
    expect(code).toBe(2);
  });
});

describe('investigateFailure', () => {
  it('prints failed check-runs and skips passing ones', async () => {
    const gh = fakeGh([
      [
        (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefOid') && a.length === 9,
        () => `${SHA}\n`,
      ],
      [
        (a) => a[0] === 'api' && a[1].includes('/check-runs'),
        () =>
          JSON.stringify([
            { name: 'lint', status: 'completed', conclusion: 'success' },
            { name: 'unit', status: 'completed', conclusion: 'failure', detailsUrl: 'https://x/y' },
          ]),
      ],
    ]);
    // Should not throw; correctness of the filtering itself is covered by
    // `failedCheckRuns` unit tests.
    await investigateFailure(gh, REPO, 123);
    expect(gh.calls.some((c) => c[1] && String(c[1]).includes('/check-runs'))).toBe(true);
  });
});

describe('deleteBaseBranch — stacked-child retarget guard', () => {
  it('refuses to delete and never calls the delete API when open children exist', () => {
    const gh = fakeGh([
      [
        (a) => a[0] === 'pr' && a[1] === 'list',
        () => JSON.stringify([{ number: 1428, title: 'stacked child', url: 'https://x/y/1428' }]),
      ],
    ]);
    const code = deleteBaseBranch(gh, REPO, 'feat/1406-base');
    expect(code).toBe(1);
    expect(gh.calls.some((c) => c.includes('DELETE'))).toBe(false);
  });

  it('retargets every open child to main, then deletes, when --retarget is passed', () => {
    const gh = fakeGh([
      [
        (a) => a[0] === 'pr' && a[1] === 'list',
        () => JSON.stringify([{ number: 1428, title: 'stacked child', url: 'https://x/y/1428' }]),
      ],
      [(a) => a[0] === 'pr' && a[1] === 'edit', () => ''],
      [(a) => a[0] === 'api' && a.includes('DELETE'), () => ''],
    ]);
    const code = deleteBaseBranch(gh, REPO, 'feat/1406-base', { retarget: true });
    expect(code).toBe(0);
    expect(gh.calls.some((c) => c[0] === 'pr' && c[1] === 'edit' && c.includes('1428'))).toBe(true);
    expect(gh.calls.some((c) => c.includes('DELETE'))).toBe(true);
  });

  it('deletes directly when there are no open children', () => {
    const gh = fakeGh([
      [(a) => a[0] === 'pr' && a[1] === 'list', () => JSON.stringify([])],
      [(a) => a[0] === 'api' && a.includes('DELETE'), () => ''],
    ]);
    const code = deleteBaseBranch(gh, REPO, 'feat/no-children');
    expect(code).toBe(0);
  });
});

describe('listOpenChildPRs', () => {
  it('parses the gh pr list JSON output', () => {
    const gh = fakeGh([
      [
        (a) => a[0] === 'pr' && a[1] === 'list',
        () => JSON.stringify([{ number: 7, title: 't', url: 'u' }]),
      ],
    ]);
    expect(listOpenChildPRs(gh, REPO, 'base')).toEqual([{ number: 7, title: 't', url: 'u' }]);
  });
});
