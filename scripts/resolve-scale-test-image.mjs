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
 * PULLABILITY IS PROVEN BY `crane`, NOT BY HAND-ROLLED HTTP (#670c)
 * -----------------------------------------------------------------
 * This program used to implement the OCI distribution auth flow itself against
 * `ghcr.io/v2/...`. That hand-rolled dance failed the live nightly TWICE, and the
 * second fix (#670b, Basic base64(user:token) at the token realm) was correct but
 * UNREACHABLE. Measured against the real registry:
 *
 *   anonymous GET manifest                 -> 401 + WWW-Authenticate challenge
 *   GET with `Bearer <raw github token>`   -> 403, NO challenge header
 *   anon -> Basic realm exchange -> retry  -> 200
 *
 * The 403 reproduces on a PUBLIC package too, so it was never about access: it is
 * GHCR rejecting a raw (non-base64) bearer credential outright. Because the
 * realm exchange was gated on `status === 401`, the pre-emptive raw Bearer on the
 * FIRST request skipped it entirely and threw "NOT pullable (HTTP 403)".
 *
 * The lesson is not "send a different header". It is that a bespoke registry-auth
 * client cannot be exercised against a real private package from a fake
 * transport, so a fake-transport test can be green and mutation-proved while the
 * live path is broken — which is exactly what happened. So pullability now goes
 * through `crane manifest`, the same binary+credential path `supply-chain.yml`
 * already uses successfully against this very package, reading the docker
 * credential store that `docker/login-action` populates. Do not reintroduce a
 * hand-rolled token exchange here.
 *
 * TESTABILITY
 * -----------
 * The HTTP transport is injected (`{ http }`) for the GitHub packages API, and
 * the crane invocation is injected (`{ exec }`), so
 * tests/resolve-scale-test-image.test.ts can run every path against doubles. The
 * CLI entrypoint at the bottom runs only when invoked directly.
 */

const GITHUB_API = 'https://api.github.com';

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
      // Fall back to the /users/ path ONLY on a FIRST-PAGE 404 ("this owner is a
      // user, not an org"). A 404 that appears after page 1 has already returned
      // data is a mid-pagination anomaly, not a wrong-owner-type signal —
      // diverting on it would discard the fetched pages and silently re-list a
      // different resource, so it must fall through to the fail-closed throw.
      if (ownerType === 'orgs' && res.status === 404 && page === 1) return null; // signal fallback
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

/** Default `crane` invocation, shaped so tests can inject a double. */
async function defaultExec(command, args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        // `error.code` is the exit status for a completed process and a string
        // (e.g. 'ENOENT') when the binary is missing — both are non-zero-ish, so
        // normalise to a number that is never 0 unless the process truly exited 0.
        status: error ? (typeof error.code === 'number' ? error.code : 127) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? (error ? error.message : '')),
      });
    });
  });
}

/**
 * Confirm the resolved digest ref is actually PULLABLE from the registry — shape
 * is not pullability.
 *
 * Delegates to `crane manifest <ref>`, the SAME mechanism `supply-chain.yml`
 * already uses against this exact private package: crane reads the docker
 * credential store that `docker/login-action` writes, so the workflow's
 * `packages: read` GITHUB_TOKEN is applied through a battle-tested client rather
 * than a bespoke OCI auth dance (see the header — that dance reddened the live
 * nightly twice while its fake-transport tests stayed green, #670c).
 *
 * A non-zero exit — a never-pushed digest (404/MANIFEST_UNKNOWN), a credential
 * failure, or a missing `crane` binary — is a FAILURE (fail closed), never a
 * pass. Returns the digest on success.
 *
 * @param {string} ref
 * @param {{ exec?: (command: string, args: string[]) => Promise<{status: number, stdout: string, stderr: string}>, crane?: string }} [options]
 */
export async function checkPullable(ref, { exec = defaultExec, crane = 'crane' } = {}) {
  const at = ref.lastIndexOf('@');
  if (at < 0) throw new Error(`not a digest-pinned reference: ${ref}`);
  const digest = ref.slice(at + 1);

  let result;
  try {
    result = await exec(crane, ['manifest', ref]);
  } catch (error) {
    // A THROWING exec is a failure, never a pass — the fail-closed rule applies
    // to the transport itself, not only to what it reports.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not run \`${crane} manifest ${ref}\` to prove pullability: ${message}. ` +
        'Refusing to proceed: a pullability check that goes green when it cannot run is worse than none.',
    );
  }

  if (!result || result.status !== 0) {
    const detail = String(result?.stderr ?? '').trim() || `exit status ${result?.status}`;
    throw new Error(
      `resolved image ${ref} is NOT pullable (\`${crane} manifest\` failed: ${detail}). ` +
        'Shape is not pullability: a well-formed digest for a never-pushed image would ErrImagePull ' +
        'inside the continue-on-error scale job where the failure is swallowed (#659). Failing here instead. ' +
        'If this is an auth failure, the GHCR login step must run BEFORE the resolver so crane sees the credential.',
    );
  }
  // crane prints the manifest JSON on success. An EMPTY stdout with a zero exit
  // would mean the binary answered without serving a manifest — treat it as a
  // failure rather than inferring pullability from an exit code alone.
  if (String(result.stdout ?? '').trim() === '') {
    throw new Error(
      `\`${crane} manifest ${ref}\` exited 0 but served no manifest body — refusing to call that pullable.`,
    );
  }
  return digest;
}

/**
 * Full resolution: an explicit `input` (the workflow_dispatch override)
 * SHORT-CIRCUITS GHCR — the human takes responsibility for WHICH digest to
 * deploy, never for WHETHER it is actually pullable. That is `checkPullable`'s
 * job on every path, the override included (#1211 item 3): the override is
 * documented as "Digest-pinned file-manager image", i.e. it carries exactly
 * the `@sha256:<digest>` shape `checkPullable` already requires, so it gets
 * the identical crane-backed proof the resolved path always had — never a
 * second, weaker standard for the human-supplied ref. Before this, a
 * mistyped/never-pushed override digest sailed through here and only failed
 * later inside the scale job's `continue-on-error`-adjacent crane copy /
 * crictl pull, indistinguishable there from a real Knative scale-timing
 * flake (#659's defect, reopened by a second door). GHCR's packages API
 * (`http`) is still never touched on this path — only `exec`/crane are.
 * Otherwise (no override) list versions, pick the newest signed publish
 * digest, build the ref, and confirm it is pullable. Any failure throws
 * (fail closed).
 */
export async function resolveScaleTestImage({
  input = '',
  registry = 'ghcr.io',
  owner,
  repo = 'file-manager',
  token,
  http = defaultHttp,
  exec = defaultExec,
  crane = 'crane',
}) {
  const override = (input ?? '').trim();
  if (override) {
    await checkPullable(override, { exec, crane });
    return override;
  }

  const versions = await listPackageVersions({ owner, repo, token, http });
  const { digest } = selectNewestSignedDigest(versions);
  const ref = buildRef({ registry, owner, repo, digest });
  await checkPullable(ref, { exec, crane });
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
  // The token authenticates the GitHub PACKAGES API (api.github.com), which does
  // take a raw `Bearer <token>`. The REGISTRY leg is crane's job and is
  // authenticated by the docker credential store `docker/login-action` writes —
  // the resolver never speaks registry auth itself any more (#670c).
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
