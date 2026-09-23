import { describe, expect, it } from 'bun:test';
import {
  buildRef,
  checkPullable,
  collectSignatureDigests,
  isCosignTag,
  isPublishTag,
  listPackageVersions,
  resolveScaleTestImage,
  selectNewestSignedDigest,
} from '../scripts/resolve-scale-test-image.mjs';

/**
 * Unit tests for the run-time signed-digest resolver (#670, closes #659's
 * starvation).
 *
 * The `e2e_scale` nightly used to read the unset repo variable
 * `vars.SCALE_TEST_IMAGE` and was permanently red. This resolver replaces that
 * read with a run-time GHCR lookup of the NEWEST cosign-signed `file-manager`
 * digest — the same image `supply-chain.yml` pushes + Trivy-gates + cosign-signs.
 *
 * The resolver is a program (`scripts/resolve-scale-test-image.mjs`) precisely so
 * this suite can execute it against FAKE GHCR responses (no network): the HTTP
 * transport is injected. An UNREACHABLE / unresolvable API must be a FAILURE,
 * never a pass — same rule as the action-pin and image-pin nightlies.
 */

const OWNER = 'getknext-dev';
const REPO = 'file-manager';
const REGISTRY = 'ghcr.io';
const HEX = (c: string) => c.repeat(64);

/** A GHCR container package version, in the shape the GitHub packages API returns. */
function version(opts: { digest: string; created_at: string; tags: string[] }) {
  return {
    id: Math.floor(Math.random() * 1e9),
    name: opts.digest,
    created_at: opts.created_at,
    updated_at: opts.created_at,
    metadata: { package_type: 'container', container: { tags: opts.tags } },
  };
}

/** The cosign signature tag GHCR stores for a signed digest `sha256:<hex>`. */
function sigTagFor(digest: string): string {
  return `${digest.replace(':', '-')}.sig`;
}

describe('tag classification', () => {
  it('recognises a real publish tag (40-hex commit sha, sha-prefixed, semver)', () => {
    expect(isPublishTag('a'.repeat(40))).toBe(true);
    expect(isPublishTag('sha-' + 'a'.repeat(40))).toBe(true);
    expect(isPublishTag('v1.2.3')).toBe(true);
    expect(isPublishTag('1.2.3')).toBe(true);
  });

  it('rejects :latest and cosign .sig/.att tags as publish tags', () => {
    expect(isPublishTag('latest')).toBe(false);
    expect(isPublishTag(`sha256-${HEX('a')}.sig`)).toBe(false);
    expect(isPublishTag(`sha256-${HEX('a')}.att`)).toBe(false);
    expect(isPublishTag('main')).toBe(false);
  });

  it('identifies cosign .sig/.att tags', () => {
    expect(isCosignTag(`sha256-${HEX('a')}.sig`)).toBe(true);
    expect(isCosignTag(`sha256-${HEX('a')}.att`)).toBe(true);
    expect(isCosignTag('latest')).toBe(false);
    expect(isCosignTag('a'.repeat(40))).toBe(false);
  });
});

describe('collectSignatureDigests', () => {
  it('maps every cosign .sig tag back to the digest it signs', () => {
    const signed = `sha256:${HEX('a')}`;
    const versions = [
      version({ digest: signed, created_at: '2026-01-01T00:00:00Z', tags: ['a'.repeat(40)] }),
      version({
        digest: `sha256:${HEX('b')}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: [sigTagFor(signed)],
      }),
    ];
    const set = collectSignatureDigests(versions);
    expect(set.has(signed)).toBe(true);
    expect(set.has(`sha256:${HEX('c')}`)).toBe(false);
  });
});

describe('selectNewestSignedDigest', () => {
  it('resolves the NEWEST signed publish digest by created_at', () => {
    const older = `sha256:${HEX('1')}`;
    const newer = `sha256:${HEX('2')}`;
    const versions = [
      version({ digest: older, created_at: '2026-01-01T00:00:00Z', tags: ['a'.repeat(40)] }),
      version({ digest: newer, created_at: '2026-06-01T00:00:00Z', tags: ['b'.repeat(40)] }),
      // signatures for both
      version({
        digest: `sha256:${HEX('9')}`,
        created_at: '2026-06-01T00:00:00Z',
        tags: [sigTagFor(newer)],
      }),
      version({
        digest: `sha256:${HEX('8')}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: [sigTagFor(older)],
      }),
    ];
    expect(selectNewestSignedDigest(versions).digest).toBe(newer);
  });

  it('excludes :latest-only, .sig, and .att versions even when they are newest', () => {
    const signedPublish = `sha256:${HEX('1')}`;
    const versions = [
      // the only legitimately-signed publish image, but OLD
      version({
        digest: signedPublish,
        created_at: '2026-01-01T00:00:00Z',
        tags: ['a'.repeat(40)],
      }),
      version({
        digest: `sha256:${HEX('7')}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: [sigTagFor(signedPublish)],
      }),
      // NEWER decoys that must never be selected
      version({
        digest: `sha256:${HEX('2')}`,
        created_at: '2026-09-01T00:00:00Z',
        tags: ['latest'],
      }),
      version({
        digest: `sha256:${HEX('3')}`,
        created_at: '2026-09-02T00:00:00Z',
        tags: [`sha256-${HEX('3')}.sig`],
      }),
      version({
        digest: `sha256:${HEX('4')}`,
        created_at: '2026-09-03T00:00:00Z',
        tags: [`sha256-${HEX('4')}.att`],
      }),
    ];
    expect(selectNewestSignedDigest(versions).digest).toBe(signedPublish);
  });

  it('excludes an UNSIGNED publish image even when it is newest', () => {
    const signedOld = `sha256:${HEX('1')}`;
    const unsignedNew = `sha256:${HEX('2')}`;
    const versions = [
      version({ digest: signedOld, created_at: '2026-01-01T00:00:00Z', tags: ['a'.repeat(40)] }),
      version({
        digest: `sha256:${HEX('7')}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: [sigTagFor(signedOld)],
      }),
      // newer, correctly-tagged publish image, but NO signature exists for it
      version({ digest: unsignedNew, created_at: '2026-09-01T00:00:00Z', tags: ['b'.repeat(40)] }),
    ];
    expect(selectNewestSignedDigest(versions).digest).toBe(signedOld);
  });

  it('throws when there is no signed publish candidate at all', () => {
    const versions = [
      version({
        digest: `sha256:${HEX('2')}`,
        created_at: '2026-09-01T00:00:00Z',
        tags: ['latest'],
      }),
      version({
        digest: `sha256:${HEX('3')}`,
        created_at: '2026-09-02T00:00:00Z',
        tags: [`sha256-${HEX('3')}.sig`],
      }),
    ];
    expect(() => selectNewestSignedDigest(versions)).toThrow();
  });
});

describe('buildRef', () => {
  it('builds a lowercase, digest-pinned ghcr ref that passes the preflight shape check', () => {
    const digest = `sha256:${HEX('a')}`;
    const ref = buildRef({ registry: REGISTRY, owner: 'GetKnext-Dev', repo: REPO, digest });
    expect(ref).toBe(`ghcr.io/getknext-dev/file-manager@${digest}`);
    expect(ref).toMatch(/^[^\s]+@sha256:[0-9a-f]{64}$/);
  });
});

describe('listPackageVersions — fail-closed on an unreachable / erroring API', () => {
  it('returns the parsed versions on a 200', async () => {
    const versions = [
      version({
        digest: `sha256:${HEX('a')}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: ['a'.repeat(40)],
      }),
    ];
    const http = async () => ({ status: 200, headers: {}, json: async () => versions });
    const got = await listPackageVersions({ owner: OWNER, repo: REPO, token: 't', http });
    expect(got).toHaveLength(1);
  });

  it('THROWS on a non-2xx status even when the body is a parseable version list', async () => {
    // The teeth of fail-closed: a 503 whose body would otherwise resolve must
    // still fail. A resolver that goes green when it cannot reach upstream is
    // worse than none (security.md).
    const versions = [
      version({
        digest: `sha256:${HEX('a')}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: ['a'.repeat(40)],
      }),
    ];
    const http = async () => ({ status: 503, headers: {}, json: async () => versions });
    await expect(
      listPackageVersions({ owner: OWNER, repo: REPO, token: 't', http }),
    ).rejects.toThrow();
  });

  it('THROWS when the transport itself rejects (DNS/TLS/offline)', async () => {
    const http = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    };
    await expect(
      listPackageVersions({ owner: OWNER, repo: REPO, token: 't', http }),
    ).rejects.toThrow();
  });
});

describe('checkPullable — shape is not pullability', () => {
  const ref = `ghcr.io/${OWNER}/${REPO}@sha256:${HEX('a')}`;

  it('resolves when the registry serves the manifest (200)', async () => {
    const http = async () => ({
      status: 200,
      headers: { 'docker-content-digest': `sha256:${HEX('a')}` },
      json: async () => ({}),
    });
    await expect(checkPullable(ref, { token: 't', http })).resolves.toBeTruthy();
  });

  it('THROWS on an unpullable digest (404 — never pushed)', async () => {
    const http = async () => ({ status: 404, headers: {}, json: async () => ({}) });
    await expect(checkPullable(ref, { token: 't', http })).rejects.toThrow();
  });

  it('THROWS when the registry is unreachable (transport rejects)', async () => {
    const http = async () => {
      throw new Error('socket hang up');
    };
    await expect(checkPullable(ref, { token: 't', http })).rejects.toThrow();
  });
});

describe('resolveScaleTestImage — end to end (injected transport)', () => {
  const newer = `sha256:${HEX('2')}`;
  const older = `sha256:${HEX('1')}`;
  const versions = [
    version({ digest: older, created_at: '2026-01-01T00:00:00Z', tags: ['a'.repeat(40)] }),
    version({ digest: newer, created_at: '2026-06-01T00:00:00Z', tags: ['b'.repeat(40)] }),
    version({
      digest: `sha256:${HEX('9')}`,
      created_at: '2026-06-01T00:00:00Z',
      tags: [sigTagFor(newer)],
    }),
    version({
      digest: `sha256:${HEX('8')}`,
      created_at: '2026-01-01T00:00:00Z',
      tags: [sigTagFor(older)],
    }),
  ];

  function http(pullable: boolean) {
    return async (url: string) => {
      if (url.includes('api.github.com')) {
        return { status: 200, headers: {}, json: async () => versions };
      }
      // registry manifest (pullability probe)
      return pullable
        ? { status: 200, headers: { 'docker-content-digest': newer }, json: async () => ({}) }
        : { status: 404, headers: {}, json: async () => ({}) };
    };
  }

  it('resolves the newest signed digest and confirms it is pullable', async () => {
    const ref = await resolveScaleTestImage({
      registry: REGISTRY,
      owner: OWNER,
      repo: REPO,
      token: 't',
      http: http(true),
    });
    expect(ref).toBe(`ghcr.io/${OWNER}/${REPO}@${newer}`);
  });

  it('FAILS CLOSED when the resolved digest is not pullable', async () => {
    await expect(
      resolveScaleTestImage({
        registry: REGISTRY,
        owner: OWNER,
        repo: REPO,
        token: 't',
        http: http(false),
      }),
    ).rejects.toThrow();
  });

  it('FAILS CLOSED when the GHCR API is unreachable', async () => {
    const http = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(
      resolveScaleTestImage({ registry: REGISTRY, owner: OWNER, repo: REPO, token: 't', http }),
    ).rejects.toThrow();
  });

  it('honours an explicit override input without touching GHCR', async () => {
    const override = `ghcr.io/${OWNER}/${REPO}@sha256:${HEX('d')}`;
    const http = async () => {
      throw new Error('network must not be touched on override');
    };
    const ref = await resolveScaleTestImage({
      input: override,
      registry: REGISTRY,
      owner: OWNER,
      repo: REPO,
      token: 't',
      http,
    });
    expect(ref).toBe(override);
  });
});
