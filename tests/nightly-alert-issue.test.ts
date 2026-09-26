import { describe, expect, it } from 'bun:test';
import { ensureAlertIssue } from '../scripts/lib/nightly-alert-issue.mjs';

/**
 * #1347: the shared "create-or-update an idempotent nightly alert issue"
 * helper every nightly workflow should route through from now on. Its
 * defining property, and the whole point of #1347, is structural: this
 * function NEVER calls `gh issue pin` — there is no pin path to disable,
 * accidentally re-enable, or forget to remove. 9 nightly workflows
 * previously duplicated this exact create-or-update logic, each with its
 * own inline `gh issue pin ... || echo "::warning::..."` tail, all racing
 * for GitHub's hard 3-pinned-issue-per-repo cap. `tests/nightly-alert-pin-policy.test.ts`
 * is the companion scan proving none of them (or any future nightly) calls
 * `gh issue pin`/`pinIssue(` outside the one allowlisted tracker.
 */

function fakeGh(responses: { list?: unknown; create?: string; comment?: string }) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(responses.list ?? []);
    if (args[0] === 'issue' && args[1] === 'create')
      return responses.create ?? 'https://github.com/getknext-dev/knext/issues/999';
    if (args[0] === 'issue' && args[1] === 'comment') return responses.comment ?? '';
    if (args[0] === 'issue' && args[1] === 'pin')
      throw new Error('ensureAlertIssue must NEVER pin');
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

describe('ensureAlertIssue — creates when no open issue with this exact title exists', () => {
  it('creates a new issue and returns its number, created: true', () => {
    const { gh, calls } = fakeGh({
      list: [],
      create: 'https://github.com/getknext-dev/knext/issues/1234',
    });
    const result = ensureAlertIssue({
      gh,
      repo: 'getknext-dev/knext',
      title: 'Some nightly RED',
      body: 'the body',
    });
    expect(result).toEqual({ number: 1234, created: true });
    const createCall = calls.find((c) => c[0] === 'issue' && c[1] === 'create');
    expect(createCall).toContain('Some nightly RED');
    expect(createCall).toContain('the body');
  });

  it('NEVER calls gh issue pin on create (the entire point of #1347)', () => {
    const { gh, calls } = fakeGh({ list: [] });
    ensureAlertIssue({ gh, repo: 'getknext-dev/knext', title: 't', body: 'b' });
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'pin')).toBe(false);
  });
});

describe('ensureAlertIssue — comments on an existing open issue with the SAME title', () => {
  it('finds the existing issue by exact title match and comments, created: false', () => {
    const { gh, calls } = fakeGh({
      list: [
        { number: 55, title: 'Unrelated other alert' },
        { number: 77, title: 'Some nightly RED' },
      ],
    });
    const result = ensureAlertIssue({
      gh,
      repo: 'getknext-dev/knext',
      title: 'Some nightly RED',
      body: 'the body',
    });
    expect(result).toEqual({ number: 77, created: false });
    const commentCall = calls.find((c) => c[0] === 'issue' && c[1] === 'comment');
    expect(commentCall).toContain('77');
    expect(commentCall).toContain('the body');
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'create')).toBe(false);
  });

  it('does not match a DIFFERENT title, even a similar one (exact match, not substring)', () => {
    const { gh } = fakeGh({
      list: [{ number: 1, title: 'Some nightly RED (v2)' }],
      create: 'https://github.com/getknext-dev/knext/issues/2',
    });
    const result = ensureAlertIssue({
      gh,
      repo: 'getknext-dev/knext',
      title: 'Some nightly RED',
      body: 'b',
    });
    expect(result.created).toBe(true);
  });

  it('NEVER calls gh issue pin on comment either', () => {
    const { gh, calls } = fakeGh({ list: [{ number: 5, title: 't' }] });
    ensureAlertIssue({ gh, repo: 'getknext-dev/knext', title: 't', body: 'b' });
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'pin')).toBe(false);
  });
});

describe('ensureAlertIssue — lists a wide-enough page so the dedup does not fall off it', () => {
  it('passes --limit 100 (matching the pre-#1347 per-workflow convention)', () => {
    const { gh, calls } = fakeGh({ list: [] });
    ensureAlertIssue({ gh, repo: 'getknext-dev/knext', title: 't', body: 'b' });
    const listCall = calls.find((c) => c[0] === 'issue' && c[1] === 'list');
    expect(listCall).toContain('--limit');
    expect(listCall).toContain('100');
    expect(listCall).toContain('--state');
    expect(listCall).toContain('open');
  });
});

describe('ensureAlertIssue — fail closed', () => {
  it('a throwing gh (e.g. auth failure) propagates rather than being swallowed', () => {
    const gh = () => {
      throw new Error('gh: authentication required');
    };
    expect(() =>
      ensureAlertIssue({ gh, repo: 'getknext-dev/knext', title: 't', body: 'b' }),
    ).toThrow(/authentication required/);
  });

  it('an unparseable issue-list response propagates rather than treating it as empty', () => {
    const gh = (args: string[]) => {
      if (args[1] === 'list') return 'not json';
      throw new Error('should not reach further calls');
    };
    expect(() =>
      ensureAlertIssue({ gh, repo: 'getknext-dev/knext', title: 't', body: 'b' }),
    ).toThrow();
  });
});
