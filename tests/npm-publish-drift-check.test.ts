import { describe, expect, it } from 'bun:test';
import {
  evaluateReviewerProtection,
  evaluateTagRulesetProtection,
  fetchReviewerProtection,
  fetchTagRulesetProtection,
  matchesVStarGlob,
  runDriftCheck,
  tagRulesetCoversVStar,
} from '../scripts/lib/npm-publish-drift-check.mjs';

/**
 * #1638 item 2: nightly detector for the `npm-publish` environment's missing
 * required-reviewer rule and the missing `v*`-covering tag ruleset. Live,
 * confirmed empty today (`gh api repos/getknext-dev/knext/environments/npm-publish`
 * → `"protection_rules":[]`; `gh api repos/getknext-dev/knext/rulesets` →
 * only a `main` branch ruleset). These tests exercise the pure decision
 * functions and the fetch layer entirely offline against an injected `api`.
 */

// ── evaluateReviewerProtection (pure) ────────────────────────────────────────

describe('evaluateReviewerProtection', () => {
  it('fails on an empty protection_rules array (the LIVE state today)', () => {
    const result = evaluateReviewerProtection([]);
    expect(result.ok).toBe(false);
  });

  it('fails when protection_rules is not an array at all', () => {
    expect(evaluateReviewerProtection(undefined).ok).toBe(false);
    expect(evaluateReviewerProtection(null).ok).toBe(false);
    expect(evaluateReviewerProtection('nope').ok).toBe(false);
  });

  it('fails when a required_reviewers rule exists but names zero reviewers', () => {
    const result = evaluateReviewerProtection([{ type: 'required_reviewers', reviewers: [] }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/zero reviewers/);
  });

  it('fails when other protection rule types exist but no required_reviewers rule does', () => {
    const result = evaluateReviewerProtection([{ type: 'wait_timer', wait_timer: 30 }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no required_reviewers/);
  });

  it('passes when a required_reviewers rule names at least one reviewer', () => {
    const result = evaluateReviewerProtection([
      { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] },
    ]);
    expect(result).toEqual({ ok: true });
  });
});

// ── matchesVStarGlob / tagRulesetCoversVStar (pure) ──────────────────────────

describe('matchesVStarGlob', () => {
  it('matches the plain glob v*', () => {
    expect(matchesVStarGlob('v*')).toBe(true);
  });

  it('matches refs/tags/v* (the ref_name.include shape GitHub actually stores)', () => {
    expect(matchesVStarGlob('refs/tags/v*')).toBe(true);
  });

  it("matches GitHub's ~ALL literal (covers every tag, including v*)", () => {
    expect(matchesVStarGlob('~ALL')).toBe(true);
  });

  it('does not match an unrelated prefix glob', () => {
    expect(matchesVStarGlob('refs/tags/release-*')).toBe(false);
  });

  it('does not match an exact non-v tag', () => {
    expect(matchesVStarGlob('refs/tags/latest')).toBe(false);
  });

  it('rejects non-string / empty input rather than throwing', () => {
    expect(matchesVStarGlob(undefined)).toBe(false);
    expect(matchesVStarGlob(null)).toBe(false);
    expect(matchesVStarGlob('')).toBe(false);
    expect(matchesVStarGlob(42)).toBe(false);
  });
});

describe('tagRulesetCoversVStar', () => {
  it('true when include contains a v*-covering pattern', () => {
    expect(tagRulesetCoversVStar({ conditions: { ref_name: { include: ['refs/tags/v*'] } } })).toBe(
      true,
    );
  });

  it('false when include exists but none cover v*', () => {
    expect(
      tagRulesetCoversVStar({ conditions: { ref_name: { include: ['refs/tags/release-*'] } } }),
    ).toBe(false);
  });

  it('false when conditions/ref_name/include is absent or malformed', () => {
    expect(tagRulesetCoversVStar({})).toBe(false);
    expect(tagRulesetCoversVStar({ conditions: {} })).toBe(false);
    expect(tagRulesetCoversVStar({ conditions: { ref_name: {} } })).toBe(false);
    expect(tagRulesetCoversVStar({ conditions: { ref_name: { include: 'v*' } } })).toBe(false);
  });
});

// ── evaluateTagRulesetProtection (pure) ──────────────────────────────────────

describe('evaluateTagRulesetProtection', () => {
  it('fails when the candidate list is empty (the LIVE state today — no tag ruleset at all)', () => {
    const result = evaluateTagRulesetProtection([]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no enabled ruleset/);
  });

  it('fails when candidates exist but none cover v*', () => {
    const result = evaluateTagRulesetProtection([
      { conditions: { ref_name: { include: ['refs/tags/release-*'] } } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/none of its ref_name/);
  });

  it('passes when at least one candidate covers v*', () => {
    const result = evaluateTagRulesetProtection([
      { conditions: { ref_name: { include: ['refs/tags/release-*'] } } },
      { conditions: { ref_name: { include: ['refs/tags/v*'] } } },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('fails closed on a non-array input rather than throwing', () => {
    expect(evaluateTagRulesetProtection(undefined).ok).toBe(false);
  });
});

// ── fetchReviewerProtection (fetch layer, injected api) ──────────────────────

function fakeApi(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    const route = routes[path];
    if (!route) throw new Error(`unexpected path: ${path}`);
    return route;
  };
  return { api, calls };
}

describe('fetchReviewerProtection', () => {
  const args = { owner: 'getknext-dev', repo: 'knext', environment: 'npm-publish' };

  it('kind: missing — mirrors the LIVE empty protection_rules response', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 200,
        body: { protection_rules: [] },
      },
    });
    const result = await fetchReviewerProtection({ ...args, api });
    expect(result.kind).toBe('missing');
  });

  it('kind: ok — a required_reviewers rule with reviewers', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 200,
        body: {
          protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }],
        },
      },
    });
    const result = await fetchReviewerProtection({ ...args, api });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('kind: permission-error on 403 — NEVER reported as missing', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 403,
        body: { message: 'Forbidden' },
      },
    });
    const result = await fetchReviewerProtection({ ...args, api });
    expect(result.kind).toBe('permission-error');
    expect(result.kind).not.toBe('missing');
  });

  it('kind: permission-error on 404 — distinct from missing', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 404,
        body: { message: 'Not Found' },
      },
    });
    const result = await fetchReviewerProtection({ ...args, api });
    expect(result.kind).toBe('permission-error');
  });

  it('kind: api-error on a thrown transport failure — a failure, never a silent pass', async () => {
    const api = async () => {
      throw new Error('fetch failed');
    };
    const result = await fetchReviewerProtection({ ...args, api });
    expect(result.kind).toBe('api-error');
  });

  it('kind: api-error on an unexpected status (5xx)', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': { status: 500, body: {} },
    });
    const result = await fetchReviewerProtection({ ...args, api });
    expect(result.kind).toBe('api-error');
  });
});

// ── fetchTagRulesetProtection (fetch layer, injected api) ────────────────────

describe('fetchTagRulesetProtection', () => {
  const args = { owner: 'getknext-dev', repo: 'knext' };

  it('kind: missing — mirrors the LIVE state (only a branch ruleset exists)', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 13073078, name: 'main', target: 'branch', enforcement: 'disabled' }],
      },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('missing');
  });

  it('kind: missing — a tag ruleset exists but is disabled (filtered out before fetching detail)', async () => {
    const { api, calls } = fakeApi({
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 1, name: 'v-tags', target: 'tag', enforcement: 'disabled' }],
      },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('missing');
    expect(calls).not.toContain('repos/getknext-dev/knext/rulesets/1');
  });

  it('kind: missing — an enabled tag ruleset exists but does not cover v*', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 2, name: 'release-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/2': {
        status: 200,
        body: { conditions: { ref_name: { include: ['refs/tags/release-*'] } } },
      },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('missing');
  });

  it('kind: ok — an enabled tag ruleset covers v*', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 3, name: 'v-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/3': {
        status: 200,
        body: { conditions: { ref_name: { include: ['refs/tags/v*'] } } },
      },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('kind: permission-error on the list call (403) — never reported as missing', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/rulesets': { status: 403, body: { message: 'Forbidden' } },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('permission-error');
  });

  it('kind: permission-error on a ruleset DETAIL call, even if the list succeeded', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 4, name: 'v-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/4': { status: 403, body: { message: 'Forbidden' } },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('permission-error');
  });

  it('kind: api-error on a thrown transport failure on the list call', async () => {
    const api = async () => {
      throw new Error('fetch failed');
    };
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('api-error');
  });
});

// ── runDriftCheck (combines both, names exactly which is missing) ───────────

describe('runDriftCheck', () => {
  const args = { owner: 'getknext-dev', repo: 'knext', environment: 'npm-publish' };

  it('ok: false with BOTH findings when both settings are missing (the LIVE state today)', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 200,
        body: { protection_rules: [] },
      },
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 13073078, name: 'main', target: 'branch', enforcement: 'disabled' }],
      },
    });
    const report = await runDriftCheck({ ...args, api });
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.map((f) => f.setting)).toEqual([
      'npm-publish environment required reviewer',
      'v*-covering tag ruleset',
    ]);
    expect(report.findings.every((f) => f.kind === 'missing')).toBe(true);
  });

  it('ok: true when both settings verify as present', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 200,
        body: {
          protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }],
        },
      },
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 3, name: 'v-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/3': {
        status: 200,
        body: { conditions: { ref_name: { include: ['refs/tags/v*'] } } },
      },
    });
    const report = await runDriftCheck({ ...args, api });
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it('names ONLY the setting that is actually missing when the other is fine', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 200,
        body: {
          protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }],
        },
      },
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 13073078, name: 'main', target: 'branch', enforcement: 'disabled' }],
      },
    });
    const report = await runDriftCheck({ ...args, api });
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].setting).toBe('v*-covering tag ruleset');
  });

  it('a permission-error finding reads differently from a missing finding (never conflated)', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 403,
        body: { message: 'Forbidden' },
      },
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 13073078, name: 'main', target: 'branch', enforcement: 'disabled' }],
      },
    });
    const report = await runDriftCheck({ ...args, api });
    expect(report.ok).toBe(false);
    const reviewerFinding = report.findings.find(
      (f) => f.setting === 'npm-publish environment required reviewer',
    );
    const tagFinding = report.findings.find((f) => f.setting === 'v*-covering tag ruleset');
    expect(reviewerFinding?.kind).toBe('permission-error');
    expect(reviewerFinding?.message).toMatch(/UNVERIFIED/);
    expect(tagFinding?.kind).toBe('missing');
    expect(tagFinding?.message).toMatch(/MISSING/);
  });
});
