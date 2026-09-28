import { describe, expect, it } from 'bun:test';
import {
  evaluateOperatorDigest,
  extractDigest,
  extractDigestFromInstallYaml,
} from '../scripts/compat-operator-digest-check.mjs';

/**
 * #1530 (sprint B4) — the operator-digest pre-check must compare the LIVE OKE
 * operator digest against the RELEASE digest the credential ref resolved, and
 * must NEVER treat an unreadable side as a pass (fail closed).
 */

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;

describe('extractDigest', () => {
  it('pulls the digest out of a full image reference', () => {
    expect(extractDigest(`ghcr.io/getknext-dev/kn-next-operator:v1.0.0-rc.1@${SHA_A}`)).toBe(SHA_A);
  });

  it('returns null for a bare tag with no digest', () => {
    expect(extractDigest('ghcr.io/getknext-dev/kn-next-operator:v1.0.0-rc.1')).toBeNull();
  });

  it('returns null for :latest', () => {
    expect(extractDigest('ghcr.io/getknext-dev/kn-next-operator:latest')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(extractDigest(null)).toBeNull();
    expect(extractDigest(undefined)).toBeNull();
  });
});

describe('extractDigestFromInstallYaml', () => {
  it('reads the digest off an `image:` line only', () => {
    const yaml = [
      '# a comment mentioning sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      `      - image: ghcr.io/getknext-dev/kn-next-operator:v1.0.0-rc.1@${SHA_A}`,
      '        name: manager',
    ].join('\n');
    expect(extractDigestFromInstallYaml(yaml)).toBe(SHA_A);
  });

  it('returns null when no image line carries a digest', () => {
    const yaml = 'image: ghcr.io/getknext-dev/kn-next-operator:latest\n';
    expect(extractDigestFromInstallYaml(yaml)).toBeNull();
  });

  it('returns null for empty/garbage input', () => {
    expect(extractDigestFromInstallYaml('')).toBeNull();
    expect(extractDigestFromInstallYaml(null as unknown as string)).toBeNull();
  });
});

describe('evaluateOperatorDigest', () => {
  it('matches when live and release digests are identical', () => {
    const v = evaluateOperatorDigest({ liveDigest: SHA_A, releaseDigest: SHA_A });
    expect(v.ok).toBe(true);
    expect(v.state).toBe('match');
  });

  it('mismatches when they differ, and never passes', () => {
    const v = evaluateOperatorDigest({ liveDigest: SHA_A, releaseDigest: SHA_B });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('mismatch');
  });

  it('fails closed when the live digest could not be read', () => {
    const v = evaluateOperatorDigest({ liveDigest: null, releaseDigest: SHA_A });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('live-digest-missing');
  });

  it('fails closed when the release digest could not be read', () => {
    const v = evaluateOperatorDigest({ liveDigest: SHA_A, releaseDigest: null });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('release-digest-missing');
  });

  it('fails closed when both sides are unreadable — never a default match', () => {
    const v = evaluateOperatorDigest({ liveDigest: null, releaseDigest: null });
    expect(v.ok).toBe(false);
  });
});
