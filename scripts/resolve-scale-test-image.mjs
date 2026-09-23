#!/usr/bin/env node
/**
 * resolve-scale-test-image — resolve, AT RUN TIME, the newest cosign-SIGNED
 * `file-manager` image digest from GHCR and confirm it is pullable, for the
 * `e2e_scale` nightly's `scale-image-preflight` job (#670, closes #659's
 * starvation).
 *
 * WHY THIS EXISTS
 * ---------------
 * The nightly used to read `vars.SCALE_TEST_IMAGE`, an UNSET repo variable, so
 * the lane was permanently red — `test/e2e/image_prewarm_e2e_test.go`, the only
 * end-to-end guard on the #471 glibc-helper regression, never ran (#659 made the
 * skip a fail; #670 owns the red). `supply-chain.yml` already builds the
 * file-manager image, Trivy-gates it (fail on HIGH/CRITICAL), pushes it to GHCR
 * and cosign-signs the pushed digest. This resolves what that lane vouched for,
 * at run time, with no standing `variables: write` credential and no repo-config
 * mutation (design option (b)).
 *
 * "SIGNED" WITHOUT THE COSIGN BINARY
 * ----------------------------------
 * cosign stores a keyless signature in GHCR as a sibling manifest TAGGED
 * `sha256-<digest>.sig` (attestations as `.att`). So a pushed image digest is
 * "signed" iff a `sha256-<digest>.sig` tag exists in the same package — a fact
 * readable from the registry's own version list, no binary required. The
 * workflow additionally runs `cosign verify` on the resolved ref for
 * defense-in-depth; this program establishes the SELECTION.
 *
 * FAIL CLOSED, ALWAYS
 * -------------------
 * Per security.md's nightly-pin precedent: a checker that goes green when it
 * cannot reach upstream is worse than none. An unreachable/erroring GHCR API, no
 * signed candidate, or a resolved-but-UNPULLABLE digest each => throw => exit 1,
 * with the fix in the message. Shape is not pullability, and the difference is
 * exactly #659's defect by another door: a well-formed digest for a never-pushed
 * image ErrImagePulls inside the `continue-on-error` scale job, where the failure
 * is swallowed. So pullability is proven HERE, in the preflight, where there is
 * no `continue-on-error`.
 *
 * TESTABILITY
 * -----------
 * The HTTP transport is injected (`{ http }`) so tests/resolve-scale-test-image
 * .test.ts can run every path against fake GHCR responses. The CLI entrypoint at
 * the bottom runs only when invoked directly.
 */

const GITHUB_API = 'https://api.github.com';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** A cosign signature/attestation tag: `sha256-<64 hex>.sig` or `.att`. */
const COSIGN_TAG_RE = /^sha256-([0-9a-f]{64})\.(sig|att)$/;
/** The signature form specifically, from which we recover the SIGNED digest. */
const SIG_TAG_RE = /^sha256-([0-9a-f]{64})\.sig$/;

/** True for a cosign `.sig`/`.att` sidecar tag (never a real publish). */
export function isCosignTag(tag) {
  return COSIGN_TAG_RE.test(tag);
}

/**
 * True for a tag that identifies a REAL publish of the app image — a 40-hex
 * commit sha (what supply-chain.yml tags with `${{ github.sha }}`), a
 * `sha-<hex>` variant, or a semver. NEVER `:latest` (mutable) and never a cosign
 * sidecar tag. A positive scan, not a blocklist: a value that is not clearly a
 * publish identifier is not accepted.
 */
export function isPublishTag(tag) {
  if (typeof tag !== 'string') return false;
  if (tag === 'latest') return false;
  if (isCosignTag(tag)) return false;
  if (/^[0-9a-f]{40}$/.test(tag)) return true; // raw commit sha
  if (/^sha-[0-9a-f]{7,40}$/.test(tag)) return true; // sha-prefixed commit
  if (/^v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(tag)) return true; // semver
  return false;
}

/** All image digests that carry a cosign `.sig` tag somewhere in the versions. */
export function collectSignatureDigests(versions) {
  const signed = new Set();
  for (const v of versions ?? []) {
    const tags = v?.metadata?.container?.tags ?? [];
    for (const tag of tags) {
      const m = SIG_TAG_RE.exec(tag);
      if (m) signed.add(`sha256:${m[1]}`);
    }
  }
  return signed;
}

/**
 * Choose the newest SIGNED publish image, deterministically. A candidate is a
 * version whose own `name` is a `sha256:<64 hex>` digest, that carries at least
 * one real publish tag, and whose digest is in the signature set. Newest by
 * `created_at`; ties broken by digest string so the choice is reproducible.
 * Throws when there is no such candidate (fail closed).
 */
export function selectNewestSignedDigest(versions) {
  const signed = collectSignatureDigests(versions);
  const candidates = (versions ?? []).filter((v) => {
    const digest = v?.name;
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) return false;
    if (!signed.has(digest)) return false;
    const tags = v?.metadata?.container?.tags ?? [];
    return tags.some((t) => isPublishTag(t));
  });

  if (candidates.length === 0) {
    throw new Error(
      'no signed, digest-pinned file-manager publish image found in GHCR. ' +
        'supply-chain.yml must have pushed AND cosign-signed a file-manager image ' +
        '(a version carrying a real publish tag with a matching sha256-<digest>.sig).',
    );
  }

  candidates.sort((a, b) => {
    const ta = Date.parse(a.created_at ?? '') || 0;
    const tb = Date.parse(b.created_at ?? '') || 0;
    if (tb !== ta) return tb - ta;
    return String(b.name).localeCompare(String(a.name));
  });

  return { digest: candidates[0].name, version: candidates[0] };
}

/** `ghcr.io/<owner-lowercased>/<repo>@sha256:<digest>`. */
export function buildRef({ registry, owner, repo, digest }) {
  return `${registry}/${owner.toLowerCase()}/${repo}@${digest}`;
}

/** Default HTTP transport, shaped so tests can inject a double. */
async function defaultHttp(url, headers) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  const flat = {};
  response.headers.forEach((value, key) => {
    flat[key.toLowerCase()] = value;
  });
  return { status: response.status, headers: flat, json: () => response.json() };
}

/**
 * List every container-package version for `<owner>/<repo>` from the GitHub
 * packages API, paginating. A non-2xx status or a throwing transport is a
 * FAILURE (fail closed) — never an empty list, which would silently degrade to
 * "no candidate". Tries the org path, then falls back to the user path on a 404.
 */
export async function listPackageVersions({
  owner,
  repo,
  token,
  http = defaultHttp,
  perPage = 100,
}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'knext-resolve-scale-test-image',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  async function fetchAll(ownerType) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const url = `${GITHUB_API}/${ownerType}/${owner}/packages/container/${repo}/versions?per_page=${perPage}&page=${page}`;
      const res = await http(url, headers);
      if (ownerType === 'orgs' && res.status === 404) return null; // signal fallback
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          `GHCR packages API returned HTTP ${res.status} for ${ownerType}/${owner}/${repo}. ` +
            'Refusing to proceed: a resolver that goes green when it cannot reach upstream is worse than none.',
        );
      }
      const batch = await res.json();
      if (!Array.isArray(batch)) {
        throw new Error(
          `GHCR packages API returned a non-array body for ${ownerType}/${owner}/${repo}.`,
        );
      }
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }

  const org = await fetchAll('orgs');
  if (org !== null) return org;
  return fetchAll('users');
}

/**
 * Confirm the resolved digest ref is actually PULLABLE from the registry — shape
 * is not pullability. Follows the OCI distribution auth flow: an anonymous GET
 * gets a 401 with a Bearer challenge; fetch a token and retry. A non-200 final
 * status (e.g. 404 for a never-pushed image) or a throwing transport is a
 * FAILURE (fail closed). Returns the served digest on success.
 */
export async function checkPullable(ref, { token, http = defaultHttp } = {}) {
  const at = ref.lastIndexOf('@');
  if (at < 0) throw new Error(`not a digest-pinned reference: ${ref}`);
  const digest = ref.slice(at + 1);
  const withoutDigest = ref.slice(0, at);
  const firstSlash = withoutDigest.indexOf('/');
  const registry = withoutDigest.slice(0, firstSlash);
  const repository = withoutDigest.slice(firstSlash + 1);

  const url = `https://${registry}/v2/${repository}/manifests/${encodeURIComponent(digest)}`;
  const base = { accept: MANIFEST_ACCEPT, 'user-agent': 'knext-resolve-scale-test-image' };
  const authed = token ? { ...base, authorization: `Bearer ${token}` } : base;

  let response = await http(url, authed);
  if (response.status === 401) {
    const challenge = response.headers?.['www-authenticate'] ?? '';
    const field = (name) => challenge.match(new RegExp(`${name}="([^"]+)"`))?.[1];
    const realm = field('realm');
    if (realm) {
      const params = new URLSearchParams();
      if (field('service')) params.set('service', field('service'));
      params.set('scope', field('scope') ?? `repository:${repository}:pull`);
      // GHCR accepts a base64 GITHUB_TOKEN as the bearer for its token realm.
      const tokenHeaders = token
        ? {
            accept: 'application/json',
            authorization: `Bearer ${Buffer.from(token).toString('base64')}`,
          }
        : { accept: 'application/json' };
      const auth = await http(`${realm}?${params}`, tokenHeaders);
      const realmToken = auth.status === 200 ? (await auth.json())?.token : undefined;
      if (realmToken)
        response = await http(url, { ...base, authorization: `Bearer ${realmToken}` });
    }
  }

  if (response.status !== 200) {
    throw new Error(
      `resolved image ${ref} is NOT pullable (registry returned HTTP ${response.status}). ` +
        'Shape is not pullability: a well-formed digest for a never-pushed image would ErrImagePull ' +
        'inside the continue-on-error scale job where the failure is swallowed (#659). Failing here instead.',
    );
  }
  return response.headers?.['docker-content-digest'] ?? digest;
}

/**
 * Full resolution: an explicit `input` (the workflow_dispatch override) is
 * returned verbatim and short-circuits GHCR — the human takes responsibility and
 * the downstream shape guard still validates it. Otherwise list versions, pick
 * the newest signed publish digest, build the ref, and confirm it is pullable.
 * Any failure throws (fail closed).
 */
export async function resolveScaleTestImage({
  input,
  registry = 'ghcr.io',
  owner,
  repo = 'file-manager',
  token,
  http = defaultHttp,
}) {
  const override = (input ?? '').trim();
  if (override) return override;

  const versions = await listPackageVersions({ owner, repo, token, http });
  const { digest } = selectNewestSignedDigest(versions);
  const ref = buildRef({ registry, owner, repo, digest });
  await checkPullable(ref, { token, http });
  return ref;
}

// ---------------------------------------------------------------------------
// CLI entrypoint — runs only when invoked directly, not when imported by tests.
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const owner = process.env.IMAGE_OWNER || process.env.GITHUB_REPOSITORY_OWNER;
  const repo = process.env.IMAGE_NAME || 'file-manager';
  const registry = process.env.IMAGE_REGISTRY || 'ghcr.io';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const input = process.env.SCALE_TEST_IMAGE_INPUT || '';

  if (!owner) {
    console.error(
      '::error::IMAGE_OWNER (or GITHUB_REPOSITORY_OWNER) is not set — cannot resolve the file-manager package.',
    );
    process.exit(1);
  }

  try {
    const ref = await resolveScaleTestImage({ input, registry, owner, repo, token });
    console.log(`Resolved SCALE_TEST_IMAGE candidate: ${ref}`);
    const out = process.env.GITHUB_OUTPUT;
    if (out) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(out, `resolved=${ref}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::could not resolve a signed, pullable file-manager image: ${message}`);
    console.error(
      'The e2e_scale lane needs a real, signed, pullable, digest-pinned file-manager image (#670).',
    );
    process.exit(1);
  }
}
