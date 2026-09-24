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

describe("checkPullable's only network egress is the injected exec/crane (#1211 item 1)", () => {
  // #1211's review of #670c: the prior guard above is a NON-EXHAUSTIVE literal
  // scan (`/v2/`, `realm`, `www-authenticate`, `Basic`) — a hand-rolled
  // registry client using a bare `fetch` with none of those literals would
  // evade it (jev 0.14 when filed: shipped code does nothing of the kind, so
  // this hardens the INVARIANT rather than fixes a live defect). This block
  // asserts the stronger claim directly, two ways:
  //
  //   1. STATIC — checkPullable's own function body (extracted by brace
  //      balancing, not the whole file, since listPackageVersions legitimately
  //      takes an `http` parameter) contains no network PRIMITIVE at all:
  //      no `fetch(`, no `http.`/`https.` method call, no `XMLHttpRequest`,
  //      no `net.connect`/`tls.connect`/`WebSocket`, and no dynamic
  //      `require('http'|'https'|'net'|'tls')` or `import('node:http'|...)`.
  //      The ONLY call resembling network I/O in the body is `exec(...)`.
  //   2. DYNAMIC — `global.fetch` is monkey-patched to THROW for the duration
  //      of a real checkPullable() call with a passing injected `exec`
  //      double. If checkPullable ever touched it, the call would throw; it
  //      does not. This is the harder proof for that ONE primitive: a static
  //      scan can miss an obfuscated call (`globalThis['fe' + 'tch']`), but
  //      the dynamic patch catches ANY invocation, however it was spelled.
  //      (node:http/node:https ESM exports are read-only bindings in this
  //      runtime and cannot be monkey-patched the same way; the static scan
  //      above is what covers those two.)

  const raw = readFileSync(
    new URL('../scripts/resolve-scale-test-image.mjs', import.meta.url),
    'utf8',
  );

  /**
   * Extracts the verbatim source of `export async function <name>(...) { ... }`.
   *
   * First balances the PARAMETER LIST's parens (from the `(` right after the
   * function name to its matching `)`), because `checkPullable`'s own
   * signature destructures an options object — `(ref, { exec = defaultExec,
   * crane = 'crane' } = {})` — whose braces would otherwise be mistaken for
   * the function BODY's opening brace by a naive "first `{` after the
   * signature" scan, truncating the extraction at the destructuring's own
   * `}` long before the real body. Only after the parameter list closes does
   * this look for the body's opening `{` and balance braces from there.
   */
  function extractFunctionSource(source: string, name: string): string {
    const sigIdx = source.indexOf(`export async function ${name}(`);
    if (sigIdx < 0) throw new Error(`could not find the signature of ${name}`);
    const parenOpenIdx = source.indexOf('(', sigIdx);
    let parenDepth = 0;
    let parenCloseIdx = -1;
    for (let i = parenOpenIdx; i < source.length; i++) {
      if (source[i] === '(') parenDepth++;
      else if (source[i] === ')') {
        parenDepth--;
        if (parenDepth === 0) {
          parenCloseIdx = i;
          break;
        }
      }
    }
    if (parenCloseIdx < 0) throw new Error(`could not balance the parameter list of ${name}`);

    const openIdx = source.indexOf('{', parenCloseIdx);
    if (openIdx < 0) throw new Error(`could not find the opening brace of ${name}`);
    let depth = 0;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return source.slice(sigIdx, i + 1);
      }
    }
    throw new Error(`unbalanced braces extracting ${name}`);
  }

  const checkPullableSrc = extractFunctionSource(raw, 'checkPullable');

  it('extraction self-check: the extracted body is non-trivial and balanced (guard non-vacuity)', () => {
    expect(checkPullableSrc).toContain('export async function checkPullable');
    expect(checkPullableSrc).toContain('exec(crane');
    // Balance check: an unbalanced extraction (e.g. stopping at the first
    // nested `}`) would truncate the body and make every assertion below
    // pass vacuously on an empty/partial string.
    const opens = (checkPullableSrc.match(/\{/g) ?? []).length;
    const closes = (checkPullableSrc.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThan(1);
  });

  it("STATIC: checkPullable's own body contains no network primitive other than exec()", () => {
    const forbidden = [
      /\bfetch\(/,
      /\bhttp\.(request|get)\(/,
      /\bhttps\.(request|get)\(/,
      /\bXMLHttpRequest\b/,
      /\bnet\.connect\(/,
      /\btls\.connect\(/,
      /\bnew WebSocket\(/,
      /require\(\s*['"](node:)?(http|https|net|tls)['"]\s*\)/,
      /import\(\s*['"](node:)?(http|https|net|tls)['"]\s*\)/,
    ];
    const hits = forbidden.filter((re) => re.test(checkPullableSrc));
    expect(
      hits.map((re) => re.source),
      `checkPullable's body matched a forbidden network primitive:\n${checkPullableSrc}`,
    ).toEqual([]);
  });

  it('STATIC self-check: the forbidden-primitive scan actually fires on a synthetic violation', () => {
    // Non-vacuity for the scan itself: prove it CAN fail before trusting that
    // it passed for the right reason.
    const withFetch = `export async function checkPullable(ref) {\n  await fetch(ref);\n}`;
    expect(/\bfetch\(/.test(withFetch)).toBe(true);
  });

  it('DYNAMIC: a real checkPullable() call never invokes global.fetch, even if fetch is reachable and would throw', async () => {
    // node:http/node:https ESM namespace exports are read-only bindings in
    // this runtime (assigning `http.request = ...` throws
    // "Attempted to assign to readonly property"), so this dynamic proof is
    // scoped to `global.fetch` — a plain, writable property on `globalThis` —
    // which is also the primitive #670c's actual hand-rolled defect used.
    // The STATIC scan above independently covers the `http.`/`https.` call
    // shapes a monkey-patch cannot reach here.
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    // @ts-expect-error — intentional monkey-patch for the duration of this test
    globalThis.fetch = (...args: unknown[]) => {
      fetchCalled = true;
      throw new Error(
        `checkPullable invoked the real global fetch with args: ${JSON.stringify(args)}`,
      );
    };
    try {
      const manifest = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] });
      const exec = async () => ({ status: 0, stdout: manifest, stderr: '' });
      const ref = `ghcr.io/${OWNER}/${REPO}@sha256:${HEX('1')}`;
      const digest = await checkPullable(ref, { exec });
      expect(digest).toBe(`sha256:${HEX('1')}`);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('honours an explicit override input without touching the GHCR packages API, but STILL proves pullability via crane (#1211 item 3)', async () => {
    // #1211 item 3: the override path used to return verbatim with no
    // pullability proof at all — a human-supplied digest that was never
    // pushed (typo, wrong owner, wrong digest) would sail through the
    // resolver and only fail later, inside the scale job's crane copy /
    // crictl pull, where a real Knative-scale-timing flake ALSO reports
    // failure (making the two indistinguishable from the job's own output).
    // The override is documented as "Digest-pinned file-manager image" —
    // exactly checkPullable's precondition — so it gets the SAME proof the
    // resolved path always had, via the injected `exec`, never GHCR.
    const override = `ghcr.io/${OWNER}/${REPO}@sha256:${HEX('d')}`;
    const http = async () => {
      throw new Error('the GHCR packages API must not be touched on override');
    };
    let execCalledWith: unknown;
    const exec = async (crane: string, args: string[]) => {
      execCalledWith = args;
      return { status: 0, stdout: JSON.stringify({ schemaVersion: 2 }), stderr: '' };
    };
    const ref = await resolveScaleTestImage({
      input: override,
      registry: REGISTRY,
      owner: OWNER,
      repo: REPO,
      token: 't',
      http,
      exec,
    });
    expect(ref).toBe(override);
    expect(execCalledWith).toEqual(['manifest', override]);
  });

  it('fails closed when the override is NOT actually pullable — shape is not pullability, even on the human-supplied path', async () => {
    const override = `ghcr.io/${OWNER}/${REPO}@sha256:${HEX('e')}`;
    const http = async () => {
      throw new Error('the GHCR packages API must not be touched on override');
    };
    const exec = async () => ({ status: 1, stdout: '', stderr: 'MANIFEST_UNKNOWN' });
    await expect(
      resolveScaleTestImage({
        input: override,
        registry: REGISTRY,
        owner: OWNER,
        repo: REPO,
        token: 't',
        http,
        exec,
      }),
    ).rejects.toThrow(/NOT pullable/);
  });

  it('fails closed when the override is not digest-pinned at all (a tag, not "Digest-pinned…" as documented)', async () => {
    const http = async () => {
      throw new Error('the GHCR packages API must not be touched on override');
    };
    const exec = async () => {
      throw new Error('crane must not be invoked for a ref checkPullable already rejects by shape');
    };
    await expect(
      resolveScaleTestImage({
        input: `ghcr.io/${OWNER}/${REPO}:latest`,
        registry: REGISTRY,
        owner: OWNER,
        repo: REPO,
        token: 't',
        http,
        exec,
      }),
    ).rejects.toThrow(/not a digest-pinned reference/);
  });
});
