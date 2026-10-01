import { describe, expect, it } from 'bun:test';
import {
  applyLocalResolutions,
  buildOverrides,
  decideResolveStrategy,
  isGetknextScoped,
  isReleasePrepEtarget,
  parseEtargetPackages,
  stripRangePrefix,
} from '../scripts/lib/scaffold-npm10-resolve.mjs';

/**
 * Hermetic unit tests for the #1771 fix: the decision logic that lets
 * `verify-scaffold-resolves-npm10.mjs` resolve `@getknext/*` ranges against
 * local tarballs on a release-prep PR, while staying red for every other
 * ETARGET or failure (including the #985 `edgesOut` crash this guard exists
 * to catch). No network, no filesystem, no process spawn — pure functions
 * over sample npm output strings.
 */

const SAMPLE_SINGLE_ETARGET = `
npm error code ETARGET
npm error notarget No matching version found for @getknext/core@^1.0.0-rc.4.
npm error notarget In most cases you or one of your dependencies are requesting
npm error notarget a package version that doesn't exist.
`;

const SAMPLE_MULTI_ETARGET = `
npm error code ETARGET
npm error notarget No matching version found for @getknext/core@^1.0.0-rc.4.
npm error notarget No matching version found for @getknext/lib@^1.0.0-rc.4.
`;

const SAMPLE_UNRELATED_ETARGET = `
npm error code ETARGET
npm error notarget No matching version found for left-pad@^99.0.0.
`;

// Same version as the workspace, but NOT @getknext/* — isolates the scope
// check from the version-equality check (mutation-proof item 2).
const SAMPLE_NONSCOPED_SAME_VERSION_ETARGET = `
npm error code ETARGET
npm error notarget No matching version found for left-pad@^1.0.0-rc.4.
`;

const SAMPLE_VERSION_MISMATCH_ETARGET = `
npm error code ETARGET
npm error notarget No matching version found for @getknext/core@^1.0.0-rc.3.
`;

const SAMPLE_EDGESOUT = `
npm error Cannot read properties of null (reading 'edgesOut')
npm error A complete log of this run can be found in: ...
`;

// #1795: the scaffold template only names @getknext/core directly. This is
// the shape npm actually reports when @getknext/core's OWN package.json
// (inside the first-retry tarball) requests @getknext/lib at the same
// unpublished release-prep version — a TRANSITIVE ETARGET, not a direct one.
// The scaffold template itself never mentions @getknext/lib in this sample.
const SAMPLE_TRANSITIVE_ETARGET = `
npm error code ETARGET
npm error notarget No matching version found for @getknext/lib@^1.0.0-rc.5.
`;

describe('parseEtargetPackages', () => {
  it('extracts a single @scope/name@range entry', () => {
    expect(parseEtargetPackages(SAMPLE_SINGLE_ETARGET)).toEqual([
      { name: '@getknext/core', range: '^1.0.0-rc.4' },
    ]);
  });

  it('extracts multiple entries in order', () => {
    expect(parseEtargetPackages(SAMPLE_MULTI_ETARGET)).toEqual([
      { name: '@getknext/core', range: '^1.0.0-rc.4' },
      { name: '@getknext/lib', range: '^1.0.0-rc.4' },
    ]);
  });

  it('splits on the LAST @, not the first, for scoped packages', () => {
    const [entry] = parseEtargetPackages(SAMPLE_SINGLE_ETARGET);
    expect(entry.name).toBe('@getknext/core');
    expect(entry.name.startsWith('@getknext/')).toBe(true);
  });

  it('returns an empty array when there is no ETARGET line', () => {
    expect(parseEtargetPackages(SAMPLE_EDGESOUT)).toEqual([]);
    expect(parseEtargetPackages('all clean, nothing here')).toEqual([]);
  });
});

describe('stripRangePrefix', () => {
  it('strips a leading caret', () => {
    expect(stripRangePrefix('^1.0.0-rc.4')).toBe('1.0.0-rc.4');
  });
  it('strips a leading tilde', () => {
    expect(stripRangePrefix('~1.0.0')).toBe('1.0.0');
  });
  it('leaves a bare version untouched', () => {
    expect(stripRangePrefix('1.0.0-rc.4')).toBe('1.0.0-rc.4');
  });
});

describe('isGetknextScoped', () => {
  it('accepts @getknext/* names', () => {
    expect(isGetknextScoped('@getknext/core')).toBe(true);
    expect(isGetknextScoped('@getknext/lib')).toBe(true);
  });
  it('rejects the unscoped kn-next alias and other packages', () => {
    expect(isGetknextScoped('kn-next')).toBe(false);
    expect(isGetknextScoped('left-pad')).toBe(false);
    expect(isGetknextScoped('@other/core')).toBe(false);
  });
});

describe('isReleasePrepEtarget', () => {
  it('is true when every entry is @getknext/* at exactly the workspace version', () => {
    const entries = parseEtargetPackages(SAMPLE_MULTI_ETARGET);
    expect(isReleasePrepEtarget(entries, '1.0.0-rc.4')).toBe(true);
  });

  it('is false when a non-@getknext package ETARGETs alongside', () => {
    const entries = [
      ...parseEtargetPackages(SAMPLE_SINGLE_ETARGET),
      ...parseEtargetPackages(SAMPLE_UNRELATED_ETARGET),
    ];
    expect(isReleasePrepEtarget(entries, '1.0.0-rc.4')).toBe(false);
  });

  it('is false when the requested version does not equal the workspace version', () => {
    const entries = parseEtargetPackages(SAMPLE_VERSION_MISMATCH_ETARGET);
    expect(isReleasePrepEtarget(entries, '1.0.0-rc.4')).toBe(false);
  });

  it('is false for an empty entry list', () => {
    expect(isReleasePrepEtarget([], '1.0.0-rc.4')).toBe(false);
  });

  it('is false for a non-@getknext package even at the exact workspace version', () => {
    const entries = parseEtargetPackages(SAMPLE_NONSCOPED_SAME_VERSION_ETARGET);
    expect(isReleasePrepEtarget(entries, '1.0.0-rc.4')).toBe(false);
  });

  // #1795: npm's ETARGET text carries no "direct vs transitive" distinction —
  // a package reported only because a DEPENDENT's package.json requested it
  // (here: @getknext/lib, pulled in by @getknext/core, never named by the
  // scaffold template itself) must classify the same as a directly-named one.
  it('is true for a TRANSITIVE @getknext/* ETARGET the scaffold template never names directly', () => {
    const entries = parseEtargetPackages(SAMPLE_TRANSITIVE_ETARGET);
    expect(entries).toEqual([{ name: '@getknext/lib', range: '^1.0.0-rc.5' }]);
    expect(isReleasePrepEtarget(entries, '1.0.0-rc.5')).toBe(true);
  });
});

describe('decideResolveStrategy', () => {
  it('returns ok on a clean exit', () => {
    expect(
      decideResolveStrategy({ exitStatus: 0, output: '', workspaceVersion: '1.0.0-rc.4' }),
    ).toEqual({ kind: 'ok' });
  });

  it('returns edgesOut on the #985 arborist crash, even over ETARGET-shaped text', () => {
    const output = `${SAMPLE_EDGESOUT}\n${SAMPLE_SINGLE_ETARGET}`;
    expect(
      decideResolveStrategy({ exitStatus: 1, output, workspaceVersion: '1.0.0-rc.4' }),
    ).toEqual({ kind: 'edgesOut' });
  });

  it('returns release-prep-etarget for the exact release-prep shape', () => {
    expect(
      decideResolveStrategy({
        exitStatus: 1,
        output: SAMPLE_MULTI_ETARGET,
        workspaceVersion: '1.0.0-rc.4',
      }),
    ).toEqual({
      kind: 'release-prep-etarget',
      packages: ['@getknext/core', '@getknext/lib'],
    });
  });

  it('returns other-etarget when a non-@getknext package is involved', () => {
    expect(
      decideResolveStrategy({
        exitStatus: 1,
        output: SAMPLE_UNRELATED_ETARGET,
        workspaceVersion: '1.0.0-rc.4',
      }),
    ).toEqual({ kind: 'other-etarget', packages: ['left-pad'] });
  });

  it('returns other-etarget when the @getknext/* version does not match the workspace', () => {
    expect(
      decideResolveStrategy({
        exitStatus: 1,
        output: SAMPLE_VERSION_MISMATCH_ETARGET,
        workspaceVersion: '1.0.0-rc.4',
      }),
    ).toEqual({ kind: 'other-etarget', packages: ['@getknext/core'] });
  });

  it('returns other-etarget for a non-@getknext package even at the exact workspace version', () => {
    expect(
      decideResolveStrategy({
        exitStatus: 1,
        output: SAMPLE_NONSCOPED_SAME_VERSION_ETARGET,
        workspaceVersion: '1.0.0-rc.4',
      }),
    ).toEqual({ kind: 'other-etarget', packages: ['left-pad'] });
  });

  it('returns release-prep-etarget for a TRANSITIVE @getknext/* ETARGET (#1795)', () => {
    expect(
      decideResolveStrategy({
        exitStatus: 1,
        output: SAMPLE_TRANSITIVE_ETARGET,
        workspaceVersion: '1.0.0-rc.5',
      }),
    ).toEqual({ kind: 'release-prep-etarget', packages: ['@getknext/lib'] });
  });

  it('returns other-failure for a non-ETARGET, non-edgesOut failure', () => {
    expect(
      decideResolveStrategy({
        exitStatus: 1,
        output: 'npm error network timeout',
        workspaceVersion: '1.0.0-rc.4',
      }),
    ).toEqual({ kind: 'other-failure' });
  });
});

describe('applyLocalResolutions', () => {
  const pkg = {
    name: 'scaffold-resolve-probe',
    dependencies: { '@getknext/lib': '^1.0.0-rc.4', react: '^19.2.6' },
    devDependencies: { '@getknext/core': '^1.0.0-rc.4', typescript: '^5.9.3' },
  };

  it('rewrites only the named @getknext/* entries to file: tarball paths', () => {
    const tarballs = new Map([
      ['@getknext/lib', '/tmp/x/getknext-lib-1.0.0-rc.4.tgz'],
      ['@getknext/core', '/tmp/x/getknext-core-1.0.0-rc.4.tgz'],
    ]);
    const out = applyLocalResolutions(pkg, tarballs) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(out.dependencies['@getknext/lib']).toBe('file:/tmp/x/getknext-lib-1.0.0-rc.4.tgz');
    expect(out.dependencies.react).toBe('^19.2.6');
    expect(out.devDependencies['@getknext/core']).toBe('file:/tmp/x/getknext-core-1.0.0-rc.4.tgz');
    expect(out.devDependencies.typescript).toBe('^5.9.3');
  });

  it('does not mutate the input object', () => {
    const tarballs = new Map([['@getknext/lib', '/tmp/x/getknext-lib.tgz']]);
    const before = JSON.stringify(pkg);
    applyLocalResolutions(pkg, tarballs);
    expect(JSON.stringify(pkg)).toBe(before);
  });

  it('is a no-op (including overrides) when the tarball map is empty', () => {
    const out = applyLocalResolutions(pkg, new Map());
    expect(out).toEqual(pkg);
    expect(out.overrides).toBeUndefined();
  });

  // #1795: a transitive reference (e.g. @getknext/db, which the sample
  // package.json never lists directly) must still resolve locally via
  // `overrides` — this is the whole point of the #1795 fix, since a
  // dependencies/devDependencies rewrite alone cannot reach it.
  it('adds an overrides entry for every packed name, even one absent from dependencies/devDependencies', () => {
    const tarballs = new Map([
      ['@getknext/lib', '/tmp/x/getknext-lib.tgz'],
      ['@getknext/core', '/tmp/x/getknext-core.tgz'],
      ['@getknext/db', '/tmp/x/getknext-db.tgz'],
    ]);
    const out = applyLocalResolutions(pkg, tarballs) as { overrides: Record<string, string> };
    expect(out.overrides).toEqual({
      '@getknext/lib': 'file:/tmp/x/getknext-lib.tgz',
      '@getknext/core': 'file:/tmp/x/getknext-core.tgz',
      '@getknext/db': 'file:/tmp/x/getknext-db.tgz',
    });
  });

  it('preserves pre-existing overrides not named in tarballsByName', () => {
    const pkgWithOverrides = { ...pkg, overrides: { 'left-pad': '^1.0.0' } };
    const tarballs = new Map([['@getknext/lib', '/tmp/x/getknext-lib.tgz']]);
    const out = applyLocalResolutions(pkgWithOverrides, tarballs) as {
      overrides: Record<string, string>;
    };
    expect(out.overrides).toEqual({
      'left-pad': '^1.0.0',
      '@getknext/lib': 'file:/tmp/x/getknext-lib.tgz',
    });
  });

  it('leaves dependencies/devDependencies untouched, but still overrides, when the named package is absent from both', () => {
    const tarballs = new Map([['@getknext/db', '/tmp/x/getknext-db.tgz']]);
    const out = applyLocalResolutions(pkg, tarballs) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    expect(out.dependencies).toEqual(pkg.dependencies);
    expect(out.devDependencies).toEqual(pkg.devDependencies);
    expect(out.overrides).toEqual({ '@getknext/db': 'file:/tmp/x/getknext-db.tgz' });
  });
});

describe('buildOverrides', () => {
  it('maps every entry to a file: spec', () => {
    const tarballs = new Map([
      ['@getknext/core', '/tmp/x/core.tgz'],
      ['@getknext/lib', '/tmp/x/lib.tgz'],
    ]);
    expect(buildOverrides(tarballs)).toEqual({
      '@getknext/core': 'file:/tmp/x/core.tgz',
      '@getknext/lib': 'file:/tmp/x/lib.tgz',
    });
  });

  it('returns an empty object for an empty map', () => {
    expect(buildOverrides(new Map())).toEqual({});
  });
});
