import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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

  it('falls back to the /users path ONLY on a first-page 404 (the org is a user)', async () => {
    const versions = [
      version({
        digest: `sha256:${HEX('a')}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: ['a'.repeat(40)],
      }),
    ];
    const http = async (url: string) => {
      if (url.includes('/orgs/')) return { status: 404, headers: {}, json: async () => ({}) };
      return { status: 200, headers: {}, json: async () => versions };
    };
    const got = await listPackageVersions({ owner: OWNER, repo: REPO, token: 't', http });
    expect(got).toHaveLength(1);
  });

  it('does NOT swallow a 404 that appears MID-pagination (page 2+) — it fails closed', async () => {
    // A first-page 404 means "not an org, try users". A 404 AFTER page 1 has
    // already returned a full page is an anomaly, not a "wrong owner type" —
    // treating it as the fallback signal would discard fetched pages and
    // silently re-list a different resource. It must fail closed instead.
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      version({
        digest: `sha256:${(i % 10).toString().repeat(64)}`,
        created_at: '2026-01-01T00:00:00Z',
        tags: ['a'.repeat(40)],
      }),
    );
    // The /users/ path RESOLVES here on purpose: with the bug (fallback fires on
    // ANY-page 404) the mid-pagination 404 diverts to /users/ and the call
    // succeeds — so this test only passes when the code fails CLOSED on the
    // mid-pagination 404 instead of diverting. `.rejects` distinguishes the two.
    const http = async (url: string) => {
      if (url.includes('/users/')) return { status: 200, headers: {}, json: async () => [] };
      // endsWith, not includes: `per_page=100` also contains `page=1`.
      if (url.endsWith('page=1')) return { status: 200, headers: {}, json: async () => fullPage };
      return { status: 404, headers: {}, json: async () => ({}) };
    };
    await expect(
      listPackageVersions({ owner: OWNER, repo: REPO, token: 't', http }),
    ).rejects.toThrow();
  });
});

describe('checkPullable — pullability is proven by crane, never hand-rolled HTTP (#670c)', () => {
  // WHY THIS SUITE LOOKS LIKE THIS.
  //
  // The previous implementation spoke the OCI distribution auth flow itself and
  // was tested against a fake HTTP transport. It shipped broken TWICE and the
  // fake stayed green both times, because the fake could not reproduce what the
  // real registry does. Measured against ghcr.io:
  //
  //   anonymous manifest GET               -> 401 + WWW-Authenticate challenge
  //   manifest GET w/ `Bearer <raw token>` -> 403, NO challenge header
  //
  // The realm exchange was gated on `status === 401`, so the pre-emptive raw
  // Bearer on the FIRST request skipped it entirely — #670b fixed unreachable
  // code. The fix is not another header: it is to stop hand-rolling registry
  // auth and delegate to `crane manifest`, the client supply-chain.yml already
  // uses successfully against this same private package. So these tests assert
  // the DELEGATION and the fail-closed behaviour, not a bespoke wire protocol.
  const ref = `ghcr.io/${OWNER.toLowerCase()}/${REPO}@sha256:${HEX('a')}`;
  const DIGEST = `sha256:${HEX('a')}`;
  const MANIFEST = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] });

  it('invokes `crane manifest <ref>` and returns the digest on success', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: MANIFEST, stderr: '' };
    };
    await expect(checkPullable(ref, { exec })).resolves.toBe(DIGEST);
    // The load-bearing assertion: the proof goes through crane, with the exact
    // digest-pinned ref. No bespoke registry HTTP is performed.
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('crane');
    expect(calls[0].args).toEqual(['manifest', ref]);
  });

  it('THROWS on an unpullable digest (crane exits non-zero — never pushed)', async () => {
    const exec = async () => ({
      status: 1,
      stdout: '',
      stderr: 'MANIFEST_UNKNOWN: manifest unknown',
    });
    await expect(checkPullable(ref, { exec })).rejects.toThrow(/NOT pullable/);
  });

  it('surfaces crane stderr so an AUTH failure is distinguishable from a missing image', async () => {
    const exec = async () => ({
      status: 1,
      stdout: '',
      stderr: 'UNAUTHORIZED: authentication required',
    });
    await expect(checkPullable(ref, { exec })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('FAILS CLOSED when the crane binary is missing (exec throws)', async () => {
    // A checker that goes green when it cannot run is worse than none
    // (security.md's nightly-pin precedent).
    const exec = async () => {
      throw new Error('spawn crane ENOENT');
    };
    await expect(checkPullable(ref, { exec })).rejects.toThrow(/ENOENT|could not run/);
  });

  it('FAILS CLOSED on a zero exit that served NO manifest body', async () => {
    // Pullability must not be inferred from an exit code alone.
    const exec = async () => ({ status: 0, stdout: '   \n', stderr: '' });
    await expect(checkPullable(ref, { exec })).rejects.toThrow();
  });

  it('rejects a ref that is not digest-pinned', async () => {
    const exec = async () => ({ status: 0, stdout: MANIFEST, stderr: '' });
    await expect(checkPullable(`ghcr.io/${OWNER}/${REPO}:latest`, { exec })).rejects.toThrow(
      /not a digest-pinned reference/,
    );
  });
});

describe('the resolver never speaks registry auth itself (#670c regression guard)', () => {
  // A SCAN, not an enumeration: reintroducing a hand-rolled OCI token exchange
  // is the defect that reddened this lane twice, so make it FAIL here rather
  // than rely on a reviewer noticing. Anchored on the source text because the
  // defect is the PRESENCE of the code, not its behaviour on a fake transport
  // (a fake transport is exactly what stayed green while the live path was
  // broken). Comments are stripped first so the header's explanation of the bug
  // — which necessarily names /v2/, the realm and www-authenticate — does not
  // trip the guard on its own prose.
  const raw = readFileSync(
    new URL('../scripts/resolve-scale-test-image.mjs', import.meta.url),
    'utf8',
  );
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('strips comments without stripping the program (guard self-check)', () => {
    // If the stripper ate the code, every assertion below would pass vacuously.
    expect(code).toContain('export async function checkPullable');
    expect(code).toContain('export async function listPackageVersions');
    expect(code).not.toContain('PULLABILITY IS PROVEN BY');
  });

  it('issues no registry /v2/ manifest request and handles no auth challenge', () => {
    expect(code).not.toMatch(/\/v2\//);
    expect(code.toLowerCase()).not.toContain('www-authenticate');
    expect(code.toLowerCase()).not.toContain('realm');
  });

  it('builds no Basic credential — the docker credential store owns registry auth', () => {
    expect(code).not.toMatch(/Basic\s/);
    expect(code).not.toContain("toString('base64')");
  });

  it('proves pullability by invoking crane', () => {
    expect(code).toContain("exec(crane, ['manifest', ref])");
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

  // The packages API leg (HTTP) and the pullability leg (crane) are now separate
  // collaborators, so the end-to-end test injects both.
  const http = async (url: string) => {
    if (url.includes('api.github.com')) {
      return { status: 200, headers: {}, json: async () => versions };
    }
    throw new Error(`the resolver must not issue registry HTTP any more: ${url}`);
  };

  function exec(pullable: boolean) {
    return async () =>
      pullable
        ? { status: 0, stdout: '{"schemaVersion":2}', stderr: '' }
        : { status: 1, stdout: '', stderr: 'MANIFEST_UNKNOWN: manifest unknown' };
  }

  it('resolves the newest signed digest and confirms it is pullable', async () => {
    const ref = await resolveScaleTestImage({
      registry: REGISTRY,
      owner: OWNER,
      repo: REPO,
      token: 't',
      http,
      exec: exec(true),
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
        http,
        exec: exec(false),
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
