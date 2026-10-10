import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MARKER_PATHS } from '../scripts/list-changeset-marker-branches.mjs';
import {
  checkLaneMajor,
  checkPreMode,
  fixedGroupNames,
  PRE_MODE_TAGS,
  PUBLISH_LANES,
  parseSemver,
  RELEASE_CUT_MAJORS,
  RELEASE_CUT_REF,
  resolveLane,
} from '../scripts/publish-lane-guard.mjs';
import { readWorkspaceManifests } from '../scripts/publish-preflight.mjs';

/**
 * GUARD TESTS for the publish-lane guard (#2035, v2 task R0).
 *
 * Two questions, both answered fail-closed BEFORE any job holds the npm token:
 *
 *   1. Is this ref a publish lane at all? An EXACT allowlist, string equality
 *      on the FULL ref. No globs: `integration/v1-coldstart` is one of 242
 *      remote branches that still carry the changeset marker that once
 *      computed 2.0.0, and an `integration/v*` pattern admits it.
 *   2. Does the version changesets would publish carry the lane's major? A
 *      1.x lane that computes 2.0.0 is the accident this exists to stop.
 *
 * The last describe block runs the REAL `changeset version` on a scratch copy
 * of this repo's workspace manifests with the marker re-added, and requires the
 * major check to go red. That is the issue's exit criterion, executed rather
 * than asserted.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const GUARD = resolve(REPO_ROOT, 'scripts/publish-lane-guard.mjs');
const CHANGESET_BIN = resolve(REPO_ROOT, 'node_modules/@changesets/cli/bin.js');

/** The marker as it still sits on `integration/v1-coldstart` (and 241 others). */
const MARKER = [
  '---',
  '"@getknext/core": major',
  '---',
  '',
  'First v1.0 release candidate. This major bump reflects the v1.0 credential',
  'milestone: the fixed group moves to a new major line.',
  '',
].join('\n');

function runGuard(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('the lane map is the one place a lane major lives', () => {
  it('maps exactly the lanes the v2 plan names, to the plan majors', () => {
    // R4 flips `refs/heads/main` to 2 at 2.0 GA, before the first 2.x publish.
    // That flip is a deliberate edit to the map AND to this expectation.
    expect(Object.fromEntries(PUBLISH_LANES)).toEqual({
      'refs/heads/main': 1,
      'refs/heads/integration/v1.3': 1,
      'refs/heads/integration/v1.4': 1,
      'refs/heads/integration/v2': 2,
      'refs/heads/release/1.x': 1,
    });
  });

  it('every allowlist key is a full branch ref with no glob metacharacter', () => {
    // Scanned over whatever the map holds, so a widening edit such as
    // `refs/heads/integration/v*` reds here whatever else it changes.
    expect(PUBLISH_LANES.size).toBeGreaterThan(0);
    for (const ref of PUBLISH_LANES.keys()) {
      expect(ref, `${ref} is not a full branch ref`).toMatch(/^refs\/heads\/[^\s]+$/);
      expect(ref, `${ref} carries a glob metacharacter`).not.toMatch(/[*?[\]{}!]/);
    }
  });

  it('every mapped major is a positive integer', () => {
    for (const [ref, major] of PUBLISH_LANES) {
      expect(Number.isInteger(major) && major > 0, `${ref} -> ${major}`).toBe(true);
    }
    for (const major of RELEASE_CUT_MAJORS) {
      expect(Number.isInteger(major) && major > 0, `cut major ${major}`).toBe(true);
    }
  });

  it('the release-cut pattern is anchored at both ends and admits only release/vX.Y.Z[-rc.N]', () => {
    expect(RELEASE_CUT_REF.source.startsWith('^refs\\/heads\\/release\\/v')).toBe(true);
    expect(RELEASE_CUT_REF.source.endsWith('$')).toBe(true);
    expect(RELEASE_CUT_REF.flags).toBe('');
  });
});

describe('resolveLane — exact allowlist on the FULL ref', () => {
  it.each([...PUBLISH_LANES.entries()])('admits %s with expected major %d', (ref, major) => {
    const lane = resolveLane(ref);
    expect(lane.ok).toBe(true);
    if (lane.ok) {
      expect(lane.kind).toBe('lane');
      expect(lane.expectedMajor).toBe(major);
      expect(lane.expectedVersion).toBeNull();
    }
  });

  it.each([
    // The motivating case and its neighbours.
    'refs/heads/integration/v1-coldstart',
    'refs/heads/integration/v1.3-foo',
    'refs/heads/integration/v1.30',
    'refs/heads/integration/v1',
    'refs/heads/integration/v2.0',
    'refs/heads/integration/v',
    // A scratch branch, prefixes and suffixes of a lane.
    'refs/heads/scratch/r0-dispatch',
    'refs/heads/main2',
    'refs/heads/feature/main',
    'refs/heads/Main',
    'refs/heads/release/1.x/hotfix',
    'refs/heads/release/1.y',
    // Short names and non-branch refs: a tag literally named `main` has
    // `github.ref_name == "main"`, which is why the guard reads the full ref.
    'main',
    'refs/tags/main',
    'refs/tags/v1.3.0',
    'refs/pull/2035/merge',
    // Whitespace must not be trimmed into a match.
    ' refs/heads/main',
    'refs/heads/main\n',
    '',
    // Stale look-alikes of the release-cut naming that exist on origin today.
    'refs/heads/release/v1.3-prepare-rc.2',
    'refs/heads/release/v1.3-dist-tag-next',
    'refs/heads/release/prepare-v1.3.0',
    'refs/heads/release/prep-v1.3.0-rc.8',
    // Non-canonical semver in a cut name.
    'refs/heads/release/v1.3',
    'refs/heads/release/v01.3.0',
    'refs/heads/release/v1.3.0-rc.01',
    'refs/heads/release/v1.3.0-beta.1',
    'refs/heads/release/v1.3.0-rc.1/x',
    'refs/heads/release/v1.3.0-rc',
    // A cut for a major no lane publishes through cuts today.
    'refs/heads/release/v2.0.0',
    'refs/heads/release/v2.0.0-rc.1',
    'refs/heads/release/v0.4.0',
  ])('refuses %j', (ref) => {
    expect(resolveLane(ref).ok).toBe(false);
  });

  it('refuses a non-string ref', () => {
    expect(resolveLane(undefined as unknown as string).ok).toBe(false);
  });

  it.each([
    ['refs/heads/release/v1.3.0', 1, '1.3.0'],
    ['refs/heads/release/v1.3.0-rc.10', 1, '1.3.0-rc.10'],
    ['refs/heads/release/v1.4.0-rc.0', 1, '1.4.0-rc.0'],
    ['refs/heads/release/v1.10.2', 1, '1.10.2'],
  ])('admits the release cut %s and pins its version', (ref, major, version) => {
    const lane = resolveLane(ref);
    expect(lane.ok).toBe(true);
    if (lane.ok) {
      expect(lane.kind).toBe('cut');
      expect(lane.expectedMajor).toBe(major);
      expect(lane.expectedVersion).toBe(version);
    }
  });
});

describe('parseSemver', () => {
  it.each([
    ['1.0.0', 1],
    ['2.0.0-rc.0', 2],
    ['1.3.0-rc.10', 1],
    ['10.2.3+build.1', 10],
  ])('%s has major %d', (version, major) => {
    expect(parseSemver(version)?.major).toBe(major);
  });

  it.each([
    '',
    '1',
    '1.0',
    'v1.0.0',
    '01.0.0',
    '1.0.0.0',
    'latest',
    ' 1.0.0',
  ])('refuses %j', (version) => {
    expect(parseSemver(version)).toBeNull();
  });
});

describe('fixedGroupNames — read from .changeset/config.json, never re-listed', () => {
  it('returns every member of every fixed group in the real config', () => {
    const config = JSON.parse(readFileSync(resolve(REPO_ROOT, '.changeset/config.json'), 'utf8'));
    const names = fixedGroupNames(config);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual(config.fixed.flat());
  });

  it.each([
    [{}],
    [{ fixed: [] }],
    [{ fixed: [[]] }],
    [{ fixed: 'x' }],
    [{ fixed: [['@getknext/core', 3]] }],
  ])('refuses a config with no usable fixed group: %j', (config) => {
    expect(() => fixedGroupNames(config)).toThrow();
  });
});

describe('checkLaneMajor — the computed major must match the lane', () => {
  const FIXED = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];
  const at = (version: string, overrides: Record<string, string> = {}) =>
    FIXED.map((name) => ({ name, version: overrides[name] ?? version }));
  const lane = (ref: string) => {
    const resolved = resolveLane(ref);
    if (!resolved.ok) throw new Error(`fixture lane ${ref} refused: ${resolved.reason}`);
    return resolved;
  };

  it('passes main at 1.0.0', () => {
    const result = checkLaneMajor({
      lane: lane('refs/heads/main'),
      packages: at('1.0.0'),
      fixedNames: FIXED,
    });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('REDS main when the bump computed 2.0.0 (the marker accident)', () => {
    const result = checkLaneMajor({
      lane: lane('refs/heads/main'),
      packages: at('2.0.0'),
      fixedNames: FIXED,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('2.0.0');
    expect(result.problems).toHaveLength(FIXED.length);
  });

  it('REDS when only one member drifted to the wrong major', () => {
    const result = checkLaneMajor({
      lane: lane('refs/heads/integration/v1.3'),
      packages: at('1.3.1', { 'kn-next': '2.0.0' }),
      fixedNames: FIXED,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('kn-next');
  });

  it('passes integration/v2 at 2.0.0-rc.0 and REDS it at 1.4.0', () => {
    expect(
      checkLaneMajor({
        lane: lane('refs/heads/integration/v2'),
        packages: at('2.0.0-rc.0'),
        fixedNames: FIXED,
      }).ok,
    ).toBe(true);
    expect(
      checkLaneMajor({
        lane: lane('refs/heads/integration/v2'),
        packages: at('1.4.0'),
        fixedNames: FIXED,
      }).ok,
    ).toBe(false);
  });

  it('a release cut must publish EXACTLY the version its name declares', () => {
    const cut = lane('refs/heads/release/v1.3.0');
    expect(checkLaneMajor({ lane: cut, packages: at('1.3.0'), fixedNames: FIXED }).ok).toBe(true);
    const drifted = checkLaneMajor({ lane: cut, packages: at('1.3.1'), fixedNames: FIXED });
    expect(drifted.ok).toBe(false);
    expect(drifted.problems.join('\n')).toContain('1.3.1');
    expect(checkLaneMajor({ lane: cut, packages: at('2.0.0'), fixedNames: FIXED }).ok).toBe(false);
  });

  it('REDS when a fixed-group member has no manifest (never a silent pass)', () => {
    const result = checkLaneMajor({
      lane: lane('refs/heads/main'),
      packages: at('1.0.0').filter((p) => p.name !== '@getknext/db'),
      fixedNames: FIXED,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('@getknext/db');
  });

  it('REDS on a version that is not semver', () => {
    const result = checkLaneMajor({
      lane: lane('refs/heads/main'),
      packages: at('1.0.0', { '@getknext/lib': 'workspace:^' }),
      fixedNames: FIXED,
    });
    expect(result.ok).toBe(false);
  });

  it('REDS on an empty fixed group rather than passing vacuously', () => {
    const result = checkLaneMajor({
      lane: lane('refs/heads/main'),
      packages: at('1.0.0'),
      fixedNames: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe('CLI exit codes (the workflow branches on these, never on output)', () => {
  it('`ref` exits 0 for main and 1 for integration/v1-coldstart and a scratch branch', () => {
    expect(runGuard(['ref', '--ref', 'refs/heads/main']).status).toBe(0);
    const coldstart = runGuard(['ref', '--ref', 'refs/heads/integration/v1-coldstart']);
    expect(coldstart.status).toBe(1);
    expect(coldstart.out).toContain('integration/v1-coldstart');
    expect(runGuard(['ref', '--ref', 'refs/heads/scratch/r0-dispatch']).status).toBe(1);
  });

  it('`ref` with no --ref value refuses (fail-closed, never defaults to main)', () => {
    const result = runGuard(['ref'], { GITHUB_REF: 'refs/heads/main' });
    expect(result.status).not.toBe(0);
  });

  it('an unknown mode is a usage error, not a pass', () => {
    expect(runGuard(['bogus', '--ref', 'refs/heads/main']).status).toBe(2);
    expect(runGuard([]).status).toBe(2);
  });

  it('`major` exits 0 for the real tree on main', () => {
    const result = runGuard(['major', '--ref', 'refs/heads/main', '--root', REPO_ROOT]);
    expect(result.out).toContain('@getknext/core');
    expect(result.status).toBe(0);
  });

  it('`major` re-checks the ref itself and refuses a disallowed one', () => {
    expect(
      runGuard(['major', '--ref', 'refs/heads/integration/v1-coldstart', '--root', REPO_ROOT])
        .status,
    ).toBe(1);
  });
});

describe('exit criterion: a lane computing the next major reds (real `changeset version`, scratch copy)', () => {
  /** The lane the scratch copy is checked against, and the tree major it must hold. */
  const LANE_REF = 'refs/heads/main';
  const treeVersion = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/kn-next/package.json'), 'utf8'),
  ).version as string;
  const treeMajor = parseSemver(treeVersion)?.major ?? Number.NaN;

  /**
   * Copy exactly what `changeset version` reads into a temp dir: the root
   * manifest, `.changeset/config.json`, and every workspace manifest. The
   * repo's `node_modules` is symlinked in so the configured changelog module
   * resolves the way it does in CI. Then run the REAL bump with `changeset`
   * added, and the guard's `major` check against the result.
   */
  function versionThenCheck(changesetPath: string, changeset: string) {
    const dir = mkdtempSync(join(tmpdir(), 'r0-lane-major-'));
    try {
      const copy = (rel: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), readFileSync(join(REPO_ROOT, rel)));
      };
      copy('package.json');
      // The lockfile is how changesets' workspace discovery recognises a bun
      // workspace at all; without it every fixed-group name is "not a package".
      copy('bun.lock');
      copy('.changeset/config.json');
      for (const manifest of readWorkspaceManifests(REPO_ROOT)) {
        copy(`${manifest.dir}/package.json`);
      }
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
      mkdirSync(dirname(join(dir, changesetPath)), { recursive: true });
      writeFileSync(join(dir, changesetPath), changeset);
      const bump = spawnSync(process.execPath, [CHANGESET_BIN, 'version'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(bump.status, `changeset version failed:\n${bump.stdout}${bump.stderr}`).toBe(0);
      const core = JSON.parse(readFileSync(join(dir, 'packages/kn-next/package.json'), 'utf8'));
      return {
        coreVersion: core.version as string,
        ...runGuard(['major', '--ref', LANE_REF, '--root', dir]),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('precondition: the tree holds the major its lane expects', () => {
    // Without this, the red below could come from a tree that was already on
    // the wrong major rather than from the marker.
    expect(PUBLISH_LANES.get(LANE_REF)).toBe(treeMajor);
  });

  it.each([
    ...MARKER_PATHS,
  ])('with the marker re-added at %s, the lane computes the next major and the check exits 1', (markerPath) => {
    // `.changeset/pre/` is not inert: changesets reads `pre/*.md` as well as
    // the top level, which is how the stale branches compute the next major.
    const result = versionThenCheck(markerPath, MARKER);
    const nextMajor = `${treeMajor + 1}.0.0`;
    expect(result.coreVersion).toBe(nextMajor);
    expect(result.out).toContain(nextMajor);
    expect(result.status).toBe(1);
  }, 60_000);

  it('control: a patch changeset keeps the major and the same check exits 0', () => {
    const result = versionThenCheck(
      '.changeset/scratch-change.md',
      '---\n"@getknext/core": patch\n---\n\nA patch.\n',
    );
    expect(parseSemver(result.coreVersion)?.major).toBe(treeMajor);
    expect(result.coreVersion).not.toBe(treeVersion);
    expect(result.status).toBe(0);
  }, 60_000);
});
describe('integration/v2 pre-mode lane (#2038, v2 task R3a)', () => {
  const V2 = 'refs/heads/integration/v2';
  const laneOf = (ref: string) => {
    const resolved = resolveLane(ref);
    if (!resolved.ok) throw new Error(`fixture lane ${ref} refused: ${resolved.reason}`);
    return resolved;
  };

  it('the pre-mode tag map lives beside the lane map and only names mapped lanes', () => {
    expect(Object.fromEntries(PRE_MODE_TAGS)).toEqual({ [V2]: 'next' });
    for (const ref of PRE_MODE_TAGS.keys()) expect(PUBLISH_LANES.has(ref)).toBe(true);
  });

  it('admits integration/v2 on a 2.x group and refuses main on one (majors only on v2)', () => {
    const FIXED = ['@getknext/core'];
    const pkgs = [{ name: '@getknext/core', version: '2.0.0-next.0' }];
    expect(checkLaneMajor({ lane: laneOf(V2), packages: pkgs, fixedNames: FIXED }).ok).toBe(true);
    expect(
      checkLaneMajor({ lane: laneOf('refs/heads/main'), packages: pkgs, fixedNames: FIXED }).ok,
    ).toBe(false);
  });

  it('checkPreMode passes pre mode with tag next on integration/v2', () => {
    expect(checkPreMode({ lane: laneOf(V2), pre: { mode: 'pre', tag: 'next' } })).toEqual([]);
  });

  it.each([
    ['no pre.json', undefined],
    ['pre.json that is not an object', 'pre'],
    ['mode exit', { mode: 'exit', tag: 'next' }],
    ['tag rc', { mode: 'pre', tag: 'rc' }],
    ['no tag', { mode: 'pre' }],
  ])('checkPreMode REDS integration/v2 with %s', (_label, pre) => {
    expect(checkPreMode({ lane: laneOf(V2), pre }).length).toBeGreaterThan(0);
  });

  it('checkPreMode asks nothing of a lane with no required tag', () => {
    expect(checkPreMode({ lane: laneOf('refs/heads/main'), pre: undefined })).toEqual([]);
  });

  describe('CLI `major` on a scratch tree (exit code is the verdict)', () => {
    function scratch(version: string, pre: unknown) {
      const dir = mkdtempSync(join(tmpdir(), 'r3a-'));
      mkdirSync(join(dir, '.changeset'), { recursive: true });
      writeFileSync(
        join(dir, '.changeset/config.json'),
        JSON.stringify({ fixed: [['@getknext/core']] }),
      );
      if (pre !== undefined) writeFileSync(join(dir, '.changeset/pre.json'), JSON.stringify(pre));
      mkdirSync(join(dir, 'packages/core'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/core/package.json'),
        JSON.stringify({ name: '@getknext/core', version }),
      );
      return dir;
    }
    const run = (version: string, pre: unknown) => {
      const dir = scratch(version, pre);
      try {
        return runGuard(['major', '--ref', V2, '--root', dir]).status;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    it('exits 0 for 2.0.0-next.0 in pre mode tag next', () => {
      expect(run('2.0.0-next.0', { mode: 'pre', tag: 'next' })).toBe(0);
    });
    it('exits 1 when pre.json is missing', () => {
      expect(run('2.0.0-next.0', undefined)).toBe(1);
    });
    it('exits 1 when the tag is not next', () => {
      expect(run('2.0.0-rc.0', { mode: 'pre', tag: 'rc' })).toBe(1);
    });
    it('exits 1 on the wrong major even in pre mode', () => {
      expect(run('1.4.0', { mode: 'pre', tag: 'next' })).toBe(1);
    });
  });
});
