import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateBranchPolicy,
  evaluateReviewerProtection,
  evaluateTagRulesetProtection,
  fetchBranchPolicy,
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
    expect((result as { ok: false; reason: string }).reason).toMatch(/zero reviewers/);
  });

  it('fails when other protection rule types exist but no required_reviewers rule does', () => {
    const result = evaluateReviewerProtection([{ type: 'wait_timer', wait_timer: 30 }]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/no required_reviewers/);
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
  it('true when include contains a v*-covering pattern and enforcement is active', () => {
    expect(
      tagRulesetCoversVStar({
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/tags/v*'] } },
      }),
    ).toBe(true);
  });

  it('false when include exists but none cover v*', () => {
    expect(
      tagRulesetCoversVStar({
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/tags/release-*'] } },
      }),
    ).toBe(false);
  });

  it('false when conditions/ref_name/include is absent or malformed', () => {
    expect(tagRulesetCoversVStar({ enforcement: 'active' })).toBe(false);
    expect(tagRulesetCoversVStar({ enforcement: 'active', conditions: {} })).toBe(false);
    expect(tagRulesetCoversVStar({ enforcement: 'active', conditions: { ref_name: {} } })).toBe(
      false,
    );
    expect(
      tagRulesetCoversVStar({
        enforcement: 'active',
        conditions: { ref_name: { include: 'v*' } },
      }),
    ).toBe(false);
  });

  // #1650 round 2, finding 3 — BOTH halves of the exclude-carve-out gap.
  it('false when an exclude pattern carves v* back out of an otherwise-covering include (#1650 round 2)', () => {
    expect(
      tagRulesetCoversVStar({
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v*'] } },
      }),
    ).toBe(false);
  });

  it('true when include covers v* and exclude does NOT overlap it (the other half)', () => {
    expect(
      tagRulesetCoversVStar({
        enforcement: 'active',
        conditions: {
          ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/release-*'] },
        },
      }),
    ).toBe(true);
  });

  it('a malformed (non-array) exclude is ignored rather than throwing', () => {
    expect(
      tagRulesetCoversVStar({
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/tags/v*'], exclude: 'not-an-array' } },
      }),
    ).toBe(true);
  });

  // #1650 round 2, finding 3 — BOTH halves of the enforcement gap.
  it('false when enforcement is "evaluate" (dry-run — a matching pattern exists but nothing is blocked) (#1650 round 2)', () => {
    expect(
      tagRulesetCoversVStar({
        enforcement: 'evaluate',
        conditions: { ref_name: { include: ['refs/tags/v*'] } },
      }),
    ).toBe(false);
  });

  it('false when enforcement is "disabled"', () => {
    expect(
      tagRulesetCoversVStar({
        enforcement: 'disabled',
        conditions: { ref_name: { include: ['refs/tags/v*'] } },
      }),
    ).toBe(false);
  });

  it('false when enforcement is missing entirely (fails closed, does not assume active)', () => {
    expect(tagRulesetCoversVStar({ conditions: { ref_name: { include: ['refs/tags/v*'] } } })).toBe(
      false,
    );
  });
});

// ── evaluateTagRulesetProtection (pure) ──────────────────────────────────────

describe('evaluateTagRulesetProtection', () => {
  it('fails when the candidate list is empty (the LIVE state today — no tag ruleset at all)', () => {
    const result = evaluateTagRulesetProtection([]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/no enabled ruleset/);
  });

  it('fails when candidates exist but none cover v*', () => {
    const result = evaluateTagRulesetProtection([
      { conditions: { ref_name: { include: ['refs/tags/release-*'] } } },
    ]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/none of its ref_name/);
  });

  it('passes when at least one candidate covers v*', () => {
    const result = evaluateTagRulesetProtection([
      { enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/release-*'] } } },
      { enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'] } } },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('fails when the only covering candidate is evaluate-mode (dry-run, blocks nothing)', () => {
    const result = evaluateTagRulesetProtection([
      { enforcement: 'evaluate', conditions: { ref_name: { include: ['refs/tags/v*'] } } },
    ]);
    expect(result.ok).toBe(false);
  });

  it('fails closed on a non-array input rather than throwing', () => {
    expect(evaluateTagRulesetProtection(undefined).ok).toBe(false);
  });
});

// ── fetchReviewerProtection (fetch layer, injected api) ──────────────────────

function fakeApi(routes: Record<string, { status: number; body: unknown }>) {
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
        body: { enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'] } } },
      },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('kind: missing — the ruleset LIST reports it active, but its own DETAIL is evaluate-mode (#1650 round 2)', async () => {
    // GitHub's summary and detail responses can disagree in principle; the
    // module must trust the DETAIL's own `enforcement`, since that is what
    // `tagRulesetCoversVStar` actually reads.
    const { api } = fakeApi({
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 5, name: 'v-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/5': {
        status: 200,
        body: { enforcement: 'evaluate', conditions: { ref_name: { include: ['refs/tags/v*'] } } },
      },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('missing');
  });

  it('kind: missing — an active ruleset covers v* via include but an exclude carves it back out (#1650 round 2)', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 6, name: 'v-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/6': {
        status: 200,
        body: {
          enforcement: 'active',
          conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v*'] } },
        },
      },
    });
    const result = await fetchTagRulesetProtection({ ...args, api });
    expect(result.kind).toBe('missing');
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

const GOOD_POLICY_ROUTES = {
  'repos/getknext-dev/knext/environments/npm-publish/deployment-branch-policies': {
    status: 200,
    body: { branch_policies: [{ name: 'main', type: 'branch' }] },
  },
};

/** Wrap a fake api so the branch-policy axis reads healthy (tests of OTHER axes). */
function withGoodPolicy(api: (p: string) => Promise<{ status: number; body: unknown }>) {
  return async (path: string) => {
    if (path in GOOD_POLICY_ROUTES)
      return GOOD_POLICY_ROUTES[path as keyof typeof GOOD_POLICY_ROUTES];
    const res = await api(path);
    if (path === 'repos/getknext-dev/knext/environments/npm-publish' && res.status === 200) {
      return {
        status: 200,
        body: {
          ...(res.body as object),
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
      };
    }
    return res;
  };
}

describe('runDriftCheck', () => {
  const args = { owner: 'getknext-dev', repo: 'knext', environment: 'npm-publish' };

  // #1638 (settings applied 2026-10-02): the npm-publish environment
  // deliberately has NO required-reviewer rule, by founder decision — that
  // axis is reported back for logging (`report.reviewer`) but must NEVER
  // produce a finding or affect `ok`. Only the tag ruleset is pass/fail.

  it('ok: false with exactly one finding when the tag ruleset is missing, even though the reviewer rule is ALSO missing (the pre-2026-10-02 state)', async () => {
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
    const tagFindings = report.findings.filter((f) => f.setting === 'v*-covering tag ruleset');
    expect(tagFindings).toHaveLength(1);
    expect(tagFindings[0].setting).toBe('v*-covering tag ruleset');
    expect((report.reviewer as { kind: string }).kind).toBe('missing');
  });

  it('ok: true when the tag ruleset verifies as present, regardless of the reviewer rule being absent (the LIVE state today)', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 200,
        body: { protection_rules: [] },
      },
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 3, name: 'v-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/3': {
        status: 200,
        body: { enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'] } } },
      },
    });
    const report = await runDriftCheck({ ...args, api: withGoodPolicy(api) });
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
    expect((report.reviewer as { kind: string }).kind).toBe('missing');
  });

  it('a reviewer permission-error is reported on `report.reviewer` but never turned into a finding', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 403,
        body: { message: 'Forbidden' },
      },
      'repos/getknext-dev/knext/rulesets': {
        status: 200,
        body: [{ id: 3, name: 'v-tags', target: 'tag', enforcement: 'active' }],
      },
      'repos/getknext-dev/knext/rulesets/3': {
        status: 200,
        body: { enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'] } } },
      },
    });
    const report = await runDriftCheck({ ...args, api });
    // The reviewer axis is never a finding; the SAME unreadable environment
    // makes the branch-policy axis UNVERIFIED (#2109) -- the only finding.
    expect(report.findings.map((f) => f.setting)).toEqual(['npm-publish deployment-branch policy']);
    expect(report.findings[0].kind).toBe('permission-error');
    expect((report.reviewer as { kind: string }).kind).toBe('permission-error');
  });

  it('a tag-ruleset permission-error finding reads as UNVERIFIED, never relabelled as MISSING', async () => {
    const { api } = fakeApi({
      'repos/getknext-dev/knext/environments/npm-publish': {
        status: 200,
        body: {
          protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }],
        },
      },
      'repos/getknext-dev/knext/rulesets': { status: 403, body: { message: 'Forbidden' } },
    });
    const report = await runDriftCheck({ ...args, api });
    expect(report.ok).toBe(false);
    const tagFindings = report.findings.filter((f) => f.setting === 'v*-covering tag ruleset');
    expect(tagFindings).toHaveLength(1);
    expect(tagFindings[0].setting).toBe('v*-covering tag ruleset');
    expect(tagFindings[0].kind).toBe('permission-error');
    expect(tagFindings[0].message).toMatch(/UNVERIFIED/);
    expect(tagFindings[0].message).not.toMatch(/MISSING/);
  });

  it('names the tag ruleset when it is missing, with a MISSING-worded message', async () => {
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
    const tagFindings = report.findings.filter((f) => f.setting === 'v*-covering tag ruleset');
    expect(tagFindings).toHaveLength(1);
    expect(tagFindings[0].setting).toBe('v*-covering tag ruleset');
    expect(tagFindings[0].kind).toBe('missing');
    expect(tagFindings[0].message).toMatch(/MISSING/);
  });
});

// ── #2109: deployment-branch policy ─────────────────────────────────────────

describe('evaluateBranchPolicy', () => {
  const custom = { protected_branches: false, custom_branch_policies: true };

  it('fails on a null policy (the LIVE state: any branch gets NPM_TOKEN)', () => {
    const r = evaluateBranchPolicy(null, undefined);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/null/);
  });

  it('fails on protected_branches-only (not an exact allowlist)', () => {
    const r = evaluateBranchPolicy({ protected_branches: true, custom_branch_policies: false }, [
      { name: 'main', type: 'branch' },
    ]);
    expect(r.ok).toBe(false);
  });

  it('fails when custom policies are on but none are listed', () => {
    expect(evaluateBranchPolicy(custom, []).ok).toBe(false);
  });

  it('passes the exact lane allowlist, taken from publish-lane-guard', () => {
    const names = ['main', 'integration/v1.3', 'integration/v1.4', 'integration/v2', 'release/1.x'];
    const r = evaluateBranchPolicy(
      custom,
      names.map((name) => ({ name, type: 'branch' })),
    );
    expect(r).toEqual({ ok: true });
  });

  it('passes an exact release-cut name', () => {
    expect(evaluateBranchPolicy(custom, [{ name: 'release/v1.3.0-rc.2', type: 'branch' }]).ok).toBe(
      true,
    );
  });

  it('fails when a policy admits integration/v1-coldstart by name', () => {
    const r = evaluateBranchPolicy(custom, [
      { name: 'main', type: 'branch' },
      { name: 'integration/v1-coldstart', type: 'branch' },
    ]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/integration\/v1-coldstart/);
  });

  it('fails on wildcard policies (integration/v*, release/*, *)', () => {
    for (const name of ['integration/v*', 'release/*', '*']) {
      expect(evaluateBranchPolicy(custom, [{ name, type: 'branch' }]).ok).toBe(false);
    }
  });

  it('fails on a tag-type policy', () => {
    expect(evaluateBranchPolicy(custom, [{ name: 'main', type: 'tag' }]).ok).toBe(false);
  });
});

describe('fetchBranchPolicy + runDriftCheck wiring', () => {
  const args = { owner: 'getknext-dev', repo: 'knext', environment: 'npm-publish' };
  const ENV = 'repos/getknext-dev/knext/environments/npm-publish';

  it('null policy -> kind missing, and runDriftCheck is NOT ok', async () => {
    const { api } = fakeApi({ [ENV]: { status: 200, body: { deployment_branch_policy: null } } });
    expect((await fetchBranchPolicy({ ...args, api })).kind).toBe('missing');
    const report = await runDriftCheck({
      ...args,
      api: fakeApiAll({ [ENV]: { status: 200, body: { deployment_branch_policy: null } } }),
    });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.setting.includes('deployment-branch policy'))).toBe(true);
  });

  it('correct policy -> ok', async () => {
    const { api } = fakeApi({
      [ENV]: {
        status: 200,
        body: {
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
      },
      ...GOOD_POLICY_ROUTES,
    });
    expect(await fetchBranchPolicy({ ...args, api })).toEqual({ kind: 'ok' });
  });

  it('403 reads as permission-error, never as missing', async () => {
    const { api } = fakeApi({ [ENV]: { status: 403, body: {} } });
    expect((await fetchBranchPolicy({ ...args, api })).kind).toBe('permission-error');
  });
});

function fakeApiAll(routes: Record<string, { status: number; body: unknown }>) {
  const empty = { status: 200, body: [] };
  return async (path: string) => routes[path] ?? empty;
}

// Exit-code proof through the real CLI against fixture JSON (no network).
describe('check-npm-publish-drift CLI exit codes (--fixture)', () => {
  const ENV = 'repos/getknext-dev/knext/environments/npm-publish';
  const tagRoutes = {
    'repos/getknext-dev/knext/rulesets': {
      status: 200,
      body: [{ id: 3, name: 'v-tags', target: 'tag', enforcement: 'active' }],
    },
    'repos/getknext-dev/knext/rulesets/3': {
      status: 200,
      body: { enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'] } } },
    },
  };
  function run(routes: object) {
    const dir = mkdtempSync(join(tmpdir(), 'drift-fixture-'));
    try {
      const file = join(dir, 'fixture.json');
      writeFileSync(file, JSON.stringify(routes));
      return spawnSync('node', ['scripts/check-npm-publish-drift.mjs', '--fixture', file], {
        encoding: 'utf8',
      }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('null deployment_branch_policy exits 1', () => {
    expect(
      run({
        ...tagRoutes,
        [ENV]: { status: 200, body: { protection_rules: [], deployment_branch_policy: null } },
      }),
    ).toBe(1);
  });

  it('policy admitting integration/v1-coldstart exits 1', () => {
    expect(
      run({
        ...tagRoutes,
        [ENV]: {
          status: 200,
          body: {
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          },
        },
        [`${ENV}/deployment-branch-policies`]: {
          status: 200,
          body: { branch_policies: [{ name: 'integration/v1-coldstart', type: 'branch' }] },
        },
      }),
    ).toBe(1);
  });

  it('correct exact-allowlist policy exits 0', () => {
    expect(
      run({
        ...tagRoutes,
        [ENV]: {
          status: 200,
          body: {
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          },
        },
        [`${ENV}/deployment-branch-policies`]: {
          status: 200,
          body: {
            branch_policies: [
              { name: 'main', type: 'branch' },
              { name: 'integration/v1.3', type: 'branch' },
            ],
          },
        },
      }),
    ).toBe(0);
  });
});
