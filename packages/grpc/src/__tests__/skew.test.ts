import { describe, expect, it } from 'bun:test';
import { compareVersions, parseVersion } from '../semver';
import { checkContractSkew, ROLLOUT_ORDER } from '../skew';

/**
 * The skew rule: a function's proto contract version must be >= the version
 * its zone was generated against, because the zone may call an RPC (or set a
 * field) only the newer contract has. So a rollout goes function first, then
 * zone. A function OLDER than its zone is skew, and it is flagged.
 */
describe('contract skew: function proto version >= zone proto version', () => {
  it('flags a function older than its zone', () => {
    const verdict = checkContractSkew({ functionVersion: '1.2.0', zoneVersion: '1.3.0' });
    expect(verdict.skew).toBe(true);
    if (!verdict.skew) throw new Error('unreachable: asserted above');
    expect(verdict.reason).toContain('1.2.0');
    expect(verdict.reason).toContain('1.3.0');
    // The remedy is the rollout order, stated in the verdict itself.
    expect(verdict.reason).toContain('function first');
  });

  it('flags an older patch and an older major alike', () => {
    expect(checkContractSkew({ functionVersion: '1.3.0', zoneVersion: '1.3.1' }).skew).toBe(true);
    expect(checkContractSkew({ functionVersion: '1.9.9', zoneVersion: '2.0.0' }).skew).toBe(true);
  });

  it('accepts a function at the same version as its zone', () => {
    expect(checkContractSkew({ functionVersion: '1.3.0', zoneVersion: '1.3.0' }).skew).toBe(false);
  });

  it('accepts a function NEWER than its zone (the function-first rollout window)', () => {
    expect(checkContractSkew({ functionVersion: '1.4.0', zoneVersion: '1.3.0' }).skew).toBe(false);
    expect(checkContractSkew({ functionVersion: '2.0.0', zoneVersion: '1.3.0' }).skew).toBe(false);
  });

  it('compares numerically, not as strings', () => {
    // '1.10.0' < '1.9.0' as strings; as versions it is newer.
    expect(checkContractSkew({ functionVersion: '1.10.0', zoneVersion: '1.9.0' }).skew).toBe(false);
    expect(checkContractSkew({ functionVersion: '1.9.0', zoneVersion: '1.10.0' }).skew).toBe(true);
  });

  it('fails closed: an unreadable version on either side is flagged as skew', () => {
    expect(checkContractSkew({ functionVersion: 'latest', zoneVersion: '1.0.0' }).skew).toBe(true);
    expect(checkContractSkew({ functionVersion: '1.0.0', zoneVersion: '' }).skew).toBe(true);
    expect(checkContractSkew({ functionVersion: undefined, zoneVersion: '1.0.0' }).skew).toBe(true);
  });

  it('documents the rollout order as function first, then zone', () => {
    expect(ROLLOUT_ORDER).toEqual(['function', 'zone']);
  });
});

describe('semver precedence', () => {
  it('parses MAJOR.MINOR.PATCH with an optional prerelease', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('2.0.0-next.4')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: ['next', 4],
    });
    expect(parseVersion('1.2.3+build.7')?.patch).toBe(3);
  });

  it('rejects what is not a version', () => {
    for (const bad of ['', '1', '1.2', 'v1.2.3', '01.2.3', '1.2.3-', 'latest', ' 1.2.3']) {
      expect(parseVersion(bad), bad).toBeUndefined();
    }
  });

  it('orders a prerelease before its release, and prerelease identifiers numerically', () => {
    expect(compareVersions('2.0.0-next.0', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0-next.2', '2.0.0-next.10')).toBe(-1);
    expect(compareVersions('2.0.0-alpha', '2.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('2.0.0-1', '2.0.0-alpha')).toBe(-1);
    expect(compareVersions('2.1.0', '2.0.9')).toBe(1);
    expect(compareVersions('1.2.3+a', '1.2.3+b')).toBe(0);
  });

  it('throws on an unparseable operand rather than guessing an order', () => {
    expect(() => compareVersions('1.2', '1.2.0')).toThrow(/not a version/);
  });
});
