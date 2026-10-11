import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateBranchPolicy } from '../scripts/lib/npm-publish-drift-check.mjs';
import { classify } from '../scripts/list-changeset-marker-branches.mjs';
import {
  checkLaneMajor,
  PREPARED_LANES,
  PUBLISH_LANES,
  preparedDistTag,
  recognisedLane,
  resolveLane,
} from '../scripts/publish-lane-guard.mjs';

/**
 * GUARD TESTS for the PREPARED publish lanes (#2040, v2 task R4p).
 *
 * `release/1.x` is the 1.x maintenance lane (ADR-0063 Amendment): cut from the
 * 1.x tip at 2.0 GA, security-only, stable dist-tag `latest-1`. R4p makes the
 * guards recognise it NOW, but it must stay OFF the publish allowlist: the
 * `npm-publish` environment still has a null branch policy, and a branch NAME
 * policy admits whatever is pushed under that name, so a lane that does not
 * exist yet could be created at a stale marker SHA and dispatched.
 *
 * "Not yet publishable" is therefore a tested property, not a comment. The day
 * R4 adds `release/1.x` to `PUBLISH_LANES` (and deletes it from
 * `PREPARED_LANES`), these tests go red on purpose: that is the reviewed edit.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const GUARD = resolve(REPO_ROOT, 'scripts/publish-lane-guard.mjs');
const LANE = 'refs/heads/release/1.x';

function runGuard(args: string[]) {
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('the prepared-lane map', () => {
  it('holds exactly release/1.x -> major 1, dist-tag latest-1', () => {
    expect(Object.fromEntries(PREPARED_LANES)).toEqual({
      [LANE]: { major: 1, distTag: 'latest-1' },
    });
  });

  it('a prepared lane is never also a publish lane (the allowlist is unchanged)', () => {
    for (const ref of PREPARED_LANES.keys()) {
      expect(PUBLISH_LANES.has(ref), `${ref} is on the publish allowlist`).toBe(false);
    }
  });

  it('the publish allowlist is exactly the live lanes, without release/1.x', () => {
    expect(Object.fromEntries(PUBLISH_LANES)).toEqual({
      'refs/heads/main': 1,
      'refs/heads/integration/v1.3': 1,
      'refs/heads/integration/v1.4': 1,
      'refs/heads/integration/v2': 2,
    });
  });

  it('every prepared key is a full branch ref with no glob, and its dist-tag is not `latest`', () => {
    expect(PREPARED_LANES.size).toBeGreaterThan(0);
    for (const [ref, entry] of PREPARED_LANES) {
      expect(ref).toMatch(/^refs\/heads\/[^\s]+$/);
      expect(ref).not.toMatch(/[*?[\]{}!]/);
      expect(Number.isInteger(entry.major) && entry.major > 0).toBe(true);
      // A 1.x lane must never publish onto the tag that serves newest-stable.
      expect(entry.distTag).not.toBe('latest');
      expect(entry.distTag).toMatch(/^[a-z][a-z0-9.-]*$/);
    }
  });
});

describe('release/1.x is NOT publishable until the allowlist changes', () => {
  it('resolveLane refuses it, and says it is prepared rather than unknown', () => {
    const lane = resolveLane(LANE);
    expect(lane.ok).toBe(false);
    if (!lane.ok) expect(lane.reason).toMatch(/not yet publishable/);
  });

  it('the `ref` CLI exits 1 for it', () => {
    const r = runGuard(['ref', '--ref', LANE]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not yet publishable/);
  });

  it('the `major` CLI exits 1 for it (a prepared lane never reaches the token)', () => {
    expect(runGuard(['major', '--ref', LANE, '--root', REPO_ROOT]).status).toBe(1);
  });

  it('the npm-publish environment drift check REDS a policy that admits release/1.x', () => {
    const custom = { protected_branches: false, custom_branch_policies: true };
    const r = evaluateBranchPolicy(custom, [
      { name: 'main', type: 'branch' },
      { name: 'release/1.x', type: 'branch' },
    ]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/release\/1\.x/);
  });

  it('look-alikes are refused, not recognised', () => {
    for (const ref of [
      'refs/heads/release/1.x/hotfix',
      'refs/heads/release/1.y',
      'refs/heads/release/1.X',
      'release/1.x',
      'refs/tags/release/1.x',
      ' refs/heads/release/1.x',
      'refs/heads/release/1.x\n',
    ]) {
      expect(recognisedLane(ref), ref).toBeNull();
      expect(resolveLane(ref).ok, ref).toBe(false);
    }
  });
});

describe('release/1.x is a RECOGNISED 1.x lane (major + dist-tag), though not publishable', () => {
  it('recognisedLane reports kind=prepared, major 1, dist-tag latest-1, publishable=false', () => {
    expect(recognisedLane(LANE)).toMatchObject({
      ok: true,
      kind: 'prepared',
      expectedMajor: 1,
      expectedVersion: null,
      distTag: 'latest-1',
      publishable: false,
    });
  });

  it('recognisedLane also reports the live lanes, as publishable', () => {
    for (const [ref, major] of PUBLISH_LANES) {
      expect(recognisedLane(ref)).toMatchObject({
        ok: true,
        expectedMajor: major,
        publishable: true,
      });
    }
  });

  it('preparedDistTag maps release/1.x to latest-1 and nothing else', () => {
    expect(preparedDistTag(LANE)).toBe('latest-1');
    expect(preparedDistTag('refs/heads/main')).toBeNull();
    expect(preparedDistTag('refs/heads/release/1.y')).toBeNull();
  });

  it('fails closed on unreadable input', () => {
    for (const bad of [undefined, null, 42, {}, [], '']) {
      expect(recognisedLane(bad as unknown as string)).toBeNull();
      expect(preparedDistTag(bad as unknown as string)).toBeNull();
    }
  });

  it('the major check applies to it: 2.0.0 reds, 1.4.1 passes, an empty group reds', () => {
    const FIXED = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];
    const at = (version: string) => FIXED.map((name) => ({ name, version }));
    const lane = recognisedLane(LANE);
    if (!lane || !lane.ok) throw new Error('release/1.x is not recognised');
    expect(checkLaneMajor({ lane, packages: at('1.4.1'), fixedNames: FIXED }).ok).toBe(true);
    const bad = checkLaneMajor({ lane, packages: at('2.0.0'), fixedNames: FIXED });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toContain('2.0.0');
    expect(checkLaneMajor({ lane, packages: at('1.4.1'), fixedNames: [] }).ok).toBe(false);
  });

  it('the marker-branch lister treats it as a live lane, never a deletion candidate', () => {
    const r = classify([{ ref: LANE, branch: 'release/1.x', carries: true }]);
    expect(r.deletable).toEqual([]);
    expect(r.liveLanes).toEqual(['release/1.x']);
  });
});

describe('docs/RELEASING.md documents the lane', () => {
  // Fail closed: an unreadable doc throws and reds the suite.
  const doc = readFileSync(resolve(REPO_ROOT, 'docs/RELEASING.md'), 'utf8');

  it('names release/1.x, its dist-tag, and that it is not yet publishable', () => {
    expect(doc).toContain('release/1.x');
    expect(doc).toContain('latest-1');
    expect(doc).toMatch(/not yet publishable/i);
  });
});
