import { describe, expect, it } from 'bun:test';
import {
  applyLocalResolutions,
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

  it('is a no-op when no named package is present', () => {
    const tarballs = new Map([['@getknext/db', '/tmp/x/getknext-db.tgz']]);
    const out = applyLocalResolutions(pkg, tarballs);
    expect(out).toEqual(pkg);
  });
});
