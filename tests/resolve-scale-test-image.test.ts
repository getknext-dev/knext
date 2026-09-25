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
  //
  // HONESTY, SO THE CLAIM IS NOT OVERSTATED (rev-1390 review):
  //   - the STATIC scan covers only checkPullable's OWN function body text —
  //     it does not follow calls into any HELPER function checkPullable
  //     might invoke. Today that is moot (checkPullable calls nothing but
  //     `exec`), but the scan itself proves nothing about a helper's body;
  //     if checkPullable is ever refactored to delegate to one, the helper
  //     needs its own scan, not an assumption this one already covers it.
  //   - the DYNAMIC check patches `global.fetch` ONLY. It says nothing about
  //     `node:http`/`node:https`/`node:net`/`node:tls` at runtime (those ESM
  //     exports are read-only bindings here and cannot be monkey-patched the
  //     same way) — that half of the claim rests entirely on the STATIC
  //     regex scan above, not on any dynamic proof.

  const raw = readFileSync(
    new URL('../scripts/resolve-scale-test-image.mjs', import.meta.url),
    'utf8',
  );

  /**
   * A delimiter-BALANCING scanner that skips over string/template literals
   * and comments — never a bare char-by-char brace/paren count (rev-1390
   * finding 3). The naive version of this extractor counted EVERY `{`/`}`
   * in the source, including ones inside a STRING LITERAL — a body
   * containing e.g. `'}}'.` (a real shape: GitHub Actions `${{ }}`
   * expression syntax quoted in an error message) closes the "function
   * body" early, silently truncating the extraction and hiding everything
   * after it from the STATIC scan below — precisely the failure mode a
   * later `import('node:https')` added past that point would evade
   * entirely. This scanner tracks single/double-quoted strings, template
   * literals (including one level of `${ ... }` interpolation, whose own
   * braces must NOT count toward the outer delimiter depth), `//` line
   * comments and `/* *\/` block comments, and only counts `openChar`/
   * `closeChar` occurrences seen in plain CODE state.
   *
   * Not a full JS parser (no regex-literal disambiguation, no nested
   * interpolation beyond one level) — sufficient for this repo's actual
   * source, and covered directly by
   * `describe('findMatchingDelimiter — resists string/comment content
   * that looks like a delimiter')` below, including the exact `'}}'.`
   * shape the review named.
   */
  function findMatchingDelimiter(
    source: string,
    openIdx: number,
    openChar: string,
    closeChar: string,
  ): number {
    let depth = 0;
    let state: 'code' | 'sq' | 'dq' | 'template' | 'templateExpr' | 'lineComment' | 'blockComment' =
      'code';
    const templateExprDepth: number[] = [];
    for (let i = openIdx; i < source.length; i++) {
      const c = source[i];
      const next = source[i + 1];
      if (state === 'code') {
        if (c === '/' && next === '/') {
          state = 'lineComment';
          i++;
          continue;
        }
        if (c === '/' && next === '*') {
          state = 'blockComment';
          i++;
          continue;
        }
        if (c === "'") {
          state = 'sq';
          continue;
        }
        if (c === '"') {
          state = 'dq';
          continue;
        }
        if (c === '`') {
          state = 'template';
          continue;
        }
        if (c === openChar) depth++;
        else if (c === closeChar) {
          depth--;
          if (depth === 0) return i;
        }
        continue;
      }
      if (state === 'lineComment') {
        if (c === '\n') state = 'code';
        continue;
      }
      if (state === 'blockComment') {
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        continue;
      }
      if (state === 'sq' || state === 'dq') {
        if (c === '\\') {
          i++;
          continue;
        }
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code';
        continue;
      }
      if (state === 'template') {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '`') {
          state = 'code';
          continue;
        }
        if (c === '$' && next === '{') {
          templateExprDepth.push(0);
          state = 'templateExpr';
          i++;
        }
        continue;
      }
      if (state === 'templateExpr') {
        // Braces inside a `${ ... }` interpolation are real CODE braces —
        // they must balance against EACH OTHER (so a nested object literal
        // doesn't end the interpolation early) but must NEVER be counted
        // toward the outer `depth` this function is balancing.
        if (c === '{') templateExprDepth[templateExprDepth.length - 1]++;
        else if (c === '}') {
          if (templateExprDepth[templateExprDepth.length - 1] === 0) {
            templateExprDepth.pop();
            state = 'template';
          } else {
            templateExprDepth[templateExprDepth.length - 1]--;
          }
        }
        continue;
      }
    }
    return -1;
  }

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
    const parenCloseIdx = findMatchingDelimiter(source, parenOpenIdx, '(', ')');
    if (parenCloseIdx < 0) throw new Error(`could not balance the parameter list of ${name}`);

    const openIdx = source.indexOf('{', parenCloseIdx);
    if (openIdx < 0) throw new Error(`could not find the opening brace of ${name}`);
    const closeIdx = findMatchingDelimiter(source, openIdx, '{', '}');
    if (closeIdx < 0) throw new Error(`unbalanced braces extracting ${name}`);
    return source.slice(sigIdx, closeIdx + 1);
  }

  describe('findMatchingDelimiter — resists string/comment content that looks like a delimiter', () => {
    it('a string literal containing "}}" does not close the brace early (the exact rev-1390 shape)', () => {
      // `'}}'.` is a real shape: a GitHub Actions `${{ }}` expression quoted
      // inside an error message string — checkPullable's own file has
      // similar prose. A naive char-count balancer closes at the FIRST `}`
      // inside the string; this one must not.
      const src =
        "function f() {\n  const s = '}}';\n  return s;\n}\nconst AFTER = 'unreached by a broken extractor';\n";
      const openIdx = src.indexOf('{');
      const closeIdx = findMatchingDelimiter(src, openIdx, '{', '}');
      expect(closeIdx).toBeGreaterThan(-1);
      const extracted = src.slice(0, closeIdx + 1);
      expect(extracted).toContain('return s;');
      expect(extracted).not.toContain('AFTER');
    });

    it('a hidden call AFTER the string-with-braces is still INSIDE the extracted body and visible to a scan', () => {
      // Reproduces the review's exact concern: a forbidden call
      // (`import('node:https')`) placed textually AFTER a `'}}'`-bearing
      // string must still be inside the extraction, not hidden past a
      // falsely-early close.
      const src =
        "function f() {\n  const s = '}}';\n  const mod = import('node:https');\n  return mod;\n}\n";
      const openIdx = src.indexOf('{');
      const closeIdx = findMatchingDelimiter(src, openIdx, '{', '}');
      const extracted = src.slice(0, closeIdx + 1);
      expect(extracted).toContain("import('node:https')");
    });

    it('skips block and line comments containing an unbalanced brace', () => {
      const src =
        'function f() {\n  // a comment with a stray }\n  /* another } here */\n  return 1;\n}\n';
      const openIdx = src.indexOf('{');
      const closeIdx = findMatchingDelimiter(src, openIdx, '{', '}');
      const extracted = src.slice(0, closeIdx + 1);
      expect(extracted).toContain('return 1;');
    });

    it('handles a template literal interpolation whose OWN braces do not count toward the outer depth', () => {
      const src = 'function f() {\n  const s = `${ { a: 1 } }`;\n  return s;\n}\n';
      const openIdx = src.indexOf('{');
      const closeIdx = findMatchingDelimiter(src, openIdx, '{', '}');
      const extracted = src.slice(0, closeIdx + 1);
      expect(extracted).toContain('return s;');
    });

    it('extracts the REAL checkPullable body unchanged by this rewrite (regression, not just synthetic fixtures)', () => {
      const extracted = extractFunctionSource(raw, 'checkPullable');
      expect(extracted).toContain('export async function checkPullable');
      expect(extracted).toContain("exec(crane, ['manifest', ref])");
    });
  });

  const checkPullableSrc = extractFunctionSource(raw, 'checkPullable');

  /** Shared between the STATIC test and its self-check, so the two can never
   * drift apart (the self-check proving a DIFFERENT filter than the real
   * test uses would prove nothing about the real test). */
  const FORBIDDEN_NETWORK_PRIMITIVES = [
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
    const hits = FORBIDDEN_NETWORK_PRIMITIVES.filter((re) => re.test(checkPullableSrc));
    expect(
      hits.map((re) => re.source),
      `checkPullable's body matched a forbidden network primitive:\n${checkPullableSrc}`,
    ).toEqual([]);
  });

  it('STATIC self-check: the REAL PIPELINE (extractFunctionSource + the forbidden-primitive filter) actually fires on a synthetic violation — not a bare regex tested in isolation', () => {
    // rev-1390 finding 4: the prior version of this self-check only asserted
    // a regex literal matches a hand-written string — it never called
    // `extractFunctionSource` or filtered with `FORBIDDEN_NETWORK_PRIMITIVES`,
    // so it proved nothing about whether THIS SUITE's actual scan would
    // catch a real violation. This version runs the identical two-step
    // pipeline the STATIC test above uses, against a synthetic FULL FILE —
    // including the exact rev-1390 finding-3 shape (a `'}}'`-bearing string
    // BEFORE the forbidden call), so a regression in either the extractor or
    // the filter is caught here, not just asserted never to have existed.
    const synthetic =
      "export async function checkPullable(ref, { exec = defaultExec, crane = 'crane' } = {}) {\n" +
      "  const decoy = '}}';\n" +
      '  await fetch(ref);\n' +
      "  return exec(crane, ['manifest', ref]);\n" +
      '}\n';
    const extracted = extractFunctionSource(synthetic, 'checkPullable');
    expect(extracted).toContain('await fetch(ref)'); // extraction itself must not truncate early
    const hits = FORBIDDEN_NETWORK_PRIMITIVES.filter((re) => re.test(extracted));
    expect(
      hits.length,
      'the real pipeline failed to catch a synthetic fetch() violation',
    ).toBeGreaterThan(0);
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
