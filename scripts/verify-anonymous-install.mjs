#!/usr/bin/env node
/**
 * verify-anonymous-install — walk the DOCUMENTED install path as a STRANGER (#586).
 *
 * WHAT WENT WRONG. #586 was found by running our own documented procedure on a
 * clean cluster: the bundle applied and every pod sat in `ImagePullBackOff`,
 * because `ghcr.io/getknext-dev/kn-next-operator` is a PRIVATE GHCR package.
 * Re-measured while writing this check: an anonymous token request for
 * `repository:getknext-dev/kn-next-operator:pull` returns **401**. No external
 * user has been able to install knext.
 *
 * WHY EVERY EXISTING GATE STAYED GREEN — structurally, not by accident:
 *   - `operator-bundle-e2e.yml` builds the operator image LOCALLY, loads it into
 *     kind, and applies `dist/install.yaml` with the manager image OVERRIDDEN to
 *     that local image. The override is exactly what hides the published image;
 *   - `internal/install/*_test.go` asserts the bundle is digest-pinned and never
 *     `:latest`. A private image is a perfectly valid digest pin;
 *   - `verify-image-pins.mjs` resolves tag↔digest correspondence — which a
 *     private image satisfies as well as a public one — and its scope is the
 *     operator's own SOURCES, not the PUBLISHED bundle.
 * Every check verified an artifact we built ourselves, from a context that was
 * already authenticated. Nothing ever played the part of a stranger.
 *
 * WHAT THIS PROVES
 *   1. the URL the DOCS publish returns 200 and its body is the install bundle;
 *   2. EVERY container image in EVERY workload document of that bundle resolves
 *      anonymously, and serves the digest the bundle pins.
 *
 * WHAT THIS DOES NOT PROVE
 *   - that the bundle APPLIES, or that the operator runs. That needs a cluster;
 *     `operator-bundle-e2e.yml` owns it, from a locally built image;
 *   - that the image CONTENT is what we think it is. Anonymous pullability is
 *     reachability, not provenance — cosign verification is a separate concern;
 *   - anything about a registry that answers 200 to everyone including us. A
 *     mirror or a corporate proxy that injects credentials transparently would
 *     look identical from here, which is why the credential assertions below
 *     cover the WIRE and not just the environment.
 *
 * THE CREDENTIAL PROBLEM IS THE WHOLE POINT. A gate that passes because the
 * runner happened to be logged in is worse than no gate. Three independent
 * halves, none of which is a restatement of another:
 *   a. STRUCTURAL — this file speaks the OCI token dance itself, over `fetch`,
 *      with a dependency-free client. It has no code path that reads a
 *      credential, and it shells out to nothing (no `docker pull`, which would
 *      silently reuse `~/.docker/config.json` and report a green that means
 *      nothing);
 *   b. THE WIRE — every request is recorded, and `findRequestCredentialLeaks`
 *      re-derives from the recording that no request carried a header outside a
 *      three-entry ALLOWLIST, and that any `Authorization` header held a Bearer
 *      token THIS RUN minted anonymously. That is an assertion about what
 *      actually happened, not about what was configured;
 *   c. THE CONTEXT — the environment and the on-disk auth stores are checked, so
 *      a future implementation that DOES shell out cannot inherit one quietly.
 * And `auditAnonymousWorkflowJob` (used by `tests/anonymous-install-path.test.ts`)
 * keeps the workflow from being handed a credential in the first place, as an
 * allowlist over actions/expressions/commands rather than as a denylist of the
 * spellings someone happened to think of.
 *
 * AN UNREACHABLE REGISTRY IS A FAILURE, NEVER A PASS. This repo already made
 * that ruling for `scripts/verify-action-pins.mjs`: a checker that goes green
 * when it cannot reach upstream is worse than none.
 *
 * DEPENDENCY-FREE ON PURPOSE. It runs on the runner's built-in Node with no
 * install step, so a check auditing the supply chain cannot itself become part
 * of it. That is why the bundle is scanned rather than parsed with `yaml`.
 *
 * Usage: node scripts/verify-anonymous-install.mjs [--root <repo-root>] [--scrub]
 * Exits 1 on any finding. `--scrub` removes credential-shaped variables from the
 * process environment BEFORE anything else runs, and reports every name it
 * removed; it exists so a developer's own shell does not make a local run
 * permanently red. CI does NOT pass it — the workflow's run command is pinned by
 * an allowlist precisely so `--scrub` cannot be used to disarm the check there.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The user-facing docs page whose `kubectl apply` a stranger copies.
 *
 * Deliberately the docs SITE (`apps/docs/content/`) rather than `docs/`: the
 * site is what is published at knext.dev, so it is what an outside user reads.
 * The URL is read FROM it at run time and never duplicated here — a second copy
 * is a thing that drifts, and a check walking a URL nobody publishes proves
 * nothing about the path users take.
 */
export const DOCS_INSTALL_SOURCE = 'apps/docs/content/docs/install.mdx';

/**
 * A published install-bundle URL, in either GitHub release-asset form.
 *
 * `latest/download` is matched as well as `download/<tag>` even though #585
 * moved the docs to the tagged form: the check must keep working if the docs
 * legitimately move back, and — more to the point — it must NOT go quietly green
 * by failing to recognise the form the docs actually use.
 *
 * The scheme is required. `install.mdx` also contains the sentence "The
 * `latest/download/install.yaml` URL resolves only once a release has been cut",
 * which is a caveat rather than a command; matching prose would send the check
 * off to fetch a URL nobody published.
 */
const INSTALL_URL_RE =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/(?:latest\/download|download\/[\w.+-]+)\/install\.yaml/g;

/**
 * Resolve the documented install URL out of the docs source.
 *
 * FAILS CLOSED in both directions. Zero matches means the docs no longer publish
 * an install URL — which is either a docs regression or a rename, and in both
 * cases continuing would mean checking nothing. More than one DISTINCT URL is
 * refused rather than resolved by taking the first: an arbitrary pick is how the
 * check silently stops walking the path users are actually given. The same URL
 * repeated is not ambiguity and is accepted.
 *
 * @param {string} repoRoot
 * @param {{ text?: string }} [options] `text` overrides the file read (tests).
 * @returns {{ url: string, file: string, line: number }}
 */
export function discoverInstallUrl(repoRoot, options = {}) {
  const file = DOCS_INSTALL_SOURCE;
  const text = options.text ?? readFileSync(resolve(repoRoot, file), 'utf8');

  const hits = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(INSTALL_URL_RE)) {
      hits.push({ url: match[0], line: index + 1 });
    }
  }

  const distinct = [...new Set(hits.map((h) => h.url))];
  if (distinct.length === 0) {
    throw new Error(
      `no install.yaml URL found in ${file} — the docs no longer publish one, ` +
        'so there is no documented path left to walk',
    );
  }
  if (distinct.length > 1) {
    throw new Error(
      `ambiguous: ${distinct.length} distinct install.yaml URLs in ${file} ` +
        `(${distinct.join(', ')}) — refusing to guess which one users follow`,
    );
  }
  return { url: distinct[0], file, line: hits[0].line };
}

/** Directories that never contain published prose. */
const DOC_WALK_SKIP = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  'graphify-out',
]);

/** Every Markdown/MDX file in the tree — discovered, never enumerated. */
export function discoverDocSources(repoRoot) {
  const found = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (DOC_WALK_SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, rel);
      else if (/\.mdx?$/.test(entry.name)) found.push(rel);
    }
  };
  walk(resolve(repoRoot), '');
  return found.sort();
}

/**
 * Every published copy of an install URL, anywhere in the tree.
 *
 * THE OTHER HALF of `discoverInstallUrl`. That function proves the canonical
 * docs page carries a URL the check then walks; on its own that is exactly the
 * defect shape this repo keeps shipping — proving the sanctioned site HAS the
 * thing without proving nothing unsanctioned does. The URL is currently repeated
 * ten times across seven files (the docs site, `docs/QUICKSTART.md`,
 * `docs/COMPATIBILITY.md`, the operator READMEs, two runbooks), and a reader who
 * lands on any of them follows THAT one. If one is updated and the others are
 * not, the check would keep walking the one healthy copy and report green while
 * most readers hit a 404.
 *
 * @returns {{ url: string, file: string, line: number }[]}
 */
export function findAllInstallUrls(repoRoot, options = {}) {
  const files = options.files ?? discoverDocSources(repoRoot);
  const readDoc = options.read ?? ((file) => readFileSync(resolve(repoRoot, file), 'utf8'));
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readDoc(file);
    } catch {
      continue;
    }
    for (const [index, line] of text.split('\n').entries()) {
      for (const match of line.matchAll(INSTALL_URL_RE)) {
        hits.push({ url: match[0], file, line: index + 1 });
      }
    }
  }
  return hits;
}

/** Findings for every published copy that disagrees with the canonical URL. */
export function findUrlDriftFindings(canonicalUrl, hits) {
  return hits
    .filter((hit) => hit.url !== canonicalUrl)
    .map((hit) => ({
      reason: 'documented-url-drift',
      ref: hit.url,
      detail:
        `${hit.file}:${hit.line} publishes a DIFFERENT install URL from the canonical ` +
        `${DOCS_INSTALL_SOURCE} (${canonicalUrl}). A reader who lands here follows this one, ` +
        'and it is not the URL this check walked.',
    }));
}

// ── the bundle ───────────────────────────────────────────────────────────────

/**
 * Split a multi-document YAML stream on its `---` separators.
 *
 * Blank documents are dropped: a bundle that begins with a separator, or ends
 * with one, would otherwise contribute an empty document whose `kind` is
 * undefined and which no later step can say anything useful about.
 */
export function splitYamlDocuments(text) {
  return splitYamlDocumentsWithOffsets(text).map((doc) => doc.text);
}

/** The same split, retaining each document's starting line in the stream. */
function splitYamlDocumentsWithOffsets(text) {
  const docs = [];
  let current = [];
  let startLine = 1;
  for (const [index, line] of text.split('\n').entries()) {
    if (/^---\s*$/.test(line)) {
      if (current.join('').trim() !== '') docs.push({ text: current.join('\n'), startLine });
      current = [];
      startLine = index + 2;
      continue;
    }
    current.push(line);
  }
  if (current.join('').trim() !== '') docs.push({ text: current.join('\n'), startLine });
  return docs;
}

/**
 * Kubernetes kinds that actually RUN a container.
 *
 * The scope question matters more than it looks. The published bundle carries a
 * `CustomResourceDefinition` whose `NextApp` schema declares a PROPERTY named
 * `image` — a line-grep extractor reports it as a container image and the check
 * then tries to pull a type declaration. Selecting by document `kind` excludes
 * it structurally rather than by a special case that the next schema property
 * would defeat.
 */
export const WORKLOAD_KINDS = new Set([
  'Deployment',
  'DaemonSet',
  'StatefulSet',
  'Job',
  'CronJob',
  'Pod',
  'ReplicaSet',
  'ReplicationController',
]);

/** The document's top-level `kind:`, or undefined. */
function documentKind(docText) {
  return docText.match(/^kind:\s*(\S+)\s*$/m)?.[1];
}

/**
 * EVERY container image in EVERY workload document.
 *
 * Every, not "the manager's". Proving the one image we went looking for is
 * pullable says nothing about a sidecar added next quarter, and this repo's most
 * common defect is exactly that shape — a guard that proves the sanctioned site
 * has the thing without proving nothing unsanctioned does. Scanning for all of
 * them means a new image is covered on the day it lands, with nobody having to
 * remember to extend a list.
 *
 * @returns {{ image: string, line: number, kind: string }[]}
 */
export function extractContainerImages(bundleText) {
  const found = [];
  for (const doc of splitYamlDocumentsWithOffsets(bundleText)) {
    const kind = documentKind(doc.text);
    if (!kind || !WORKLOAD_KINDS.has(kind)) continue;
    for (const [index, line] of doc.text.split('\n').entries()) {
      const match = line.match(/^\s*(?:-\s+)?image:\s*(\S+)\s*$/);
      if (!match) continue;
      const value = match[1].replace(/^["']|["']$/g, '');
      // A block scalar or an anchor is not a reference; neither is a bare word
      // with no registry, repository separator, tag or digest.
      if (/^[|>&*]/.test(value)) continue;
      if (!/[:/@]/.test(value)) continue;
      found.push({ image: value, line: doc.startLine + index, kind });
    }
  }
  return found;
}

/** Split `[registry/]repo[:tag][@digest]` into its parts, Docker-Hub defaults applied. */
export function parseImageRef(ref) {
  const [nameAndTag, digestPart] = ref.split('@');
  const slash = nameAndTag.indexOf('/');
  const first = slash === -1 ? '' : nameAndTag.slice(0, slash);
  const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  let registry = hasRegistry ? first : 'registry-1.docker.io';
  let path = hasRegistry ? nameAndTag.slice(slash + 1) : nameAndTag;

  let tag;
  const colon = path.lastIndexOf(':');
  if (colon > path.lastIndexOf('/')) {
    tag = path.slice(colon + 1);
    path = path.slice(0, colon);
  }
  if (registry === 'registry-1.docker.io' && !path.includes('/')) path = `library/${path}`;
  if (registry === 'docker.io') registry = 'registry-1.docker.io';

  return {
    registry,
    repository: path,
    tag,
    digest: digestPart ? `sha256:${digestPart.split('sha256:')[1]}` : undefined,
    ref,
  };
}

// ── the anonymous pull ───────────────────────────────────────────────────────

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const USER_AGENT = 'knext-verify-anonymous-install';

/** Default HTTP transport, shaped so tests can inject a double. */
export async function defaultHttp(url, headers) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  const flat = {};
  response.headers.forEach((value, key) => {
    flat[key.toLowerCase()] = value;
  });
  return { status: response.status, headers: flat, json: () => response.json() };
}

/**
 * Wrap a transport so every request — and every token it mints — is recorded.
 *
 * The recording is what makes the credential claim an ASSERTION rather than a
 * promise: `findRequestCredentialLeaks` re-derives from it that nothing outside
 * a three-entry allowlist went on the wire. A token is captured by wrapping
 * `json()` (memoised, so the body is still read exactly once), which is how the
 * later check can tell a Bearer THIS RUN minted anonymously from one that came
 * from somewhere else.
 */
export function createRecordingHttp(inner = defaultHttp) {
  const requests = [];
  const http = async (url, headers = {}) => {
    const record = { url, headers };
    requests.push(record);
    const response = await inner(url, headers);
    if (!response || typeof response.json !== 'function') return response;
    let cached;
    let read = false;
    return {
      ...response,
      json: async () => {
        if (!read) {
          cached = await response.json();
          read = true;
          if (cached && typeof cached.token === 'string') record.minted = cached.token;
        }
        return cached;
      },
    };
  };
  return { http, requests };
}

/**
 * Resolve a reference ANONYMOUSLY through the OCI distribution flow.
 *
 * The manifest is addressed BY DIGEST when the bundle pins one — that is what a
 * kubelet does, and it is the only thing that answers "can a stranger pull the
 * bytes this bundle names". Resolving the tag instead would pass while the
 * pinned digest was unpullable.
 *
 * Implemented from the `WWW-Authenticate` challenge rather than hardcoding GHCR,
 * so a bundle that starts carrying a gcr.io or quay.io image still resolves.
 *
 * @returns {{ stage: 'token'|'manifest', status: number, digest?: string, message?: string }}
 */
export async function resolveAnonymousManifest(
  { registry, repository, tag, digest },
  options = {},
) {
  const http = options.http ?? defaultHttp;
  const reference = digest ?? tag;
  // NOT percent-encoded. `encodeURIComponent` turns the `:` of `sha256:<hex>`
  // into `%3A`, which registries do not resolve — the check would then report
  // every image as unpullable and be red for a reason that is not a finding.
  // Tags and digests are both restricted to this charset, so the reference is
  // safe raw; anything else is refused rather than sent.
  if (!/^[\w][\w.:-]*$/.test(String(reference))) {
    return { stage: 'manifest', status: 0, message: `unusable image reference: ${reference}` };
  }
  const url = `https://${registry}/v2/${repository}/manifests/${reference}`;
  const base = { accept: MANIFEST_ACCEPT, 'user-agent': USER_AGENT };

  let response = await http(url, base);
  if (response.status === 401) {
    const challenge = response.headers?.['www-authenticate'] ?? '';
    const field = (name) => challenge.match(new RegExp(`${name}="([^"]+)"`))?.[1];
    const realm = field('realm');
    if (!realm) {
      return {
        stage: 'manifest',
        status: response.status,
        message: 'registry returned 401 with no WWW-Authenticate challenge to follow',
      };
    }
    const params = new URLSearchParams();
    if (field('service')) params.set('service', field('service'));
    params.set('scope', `repository:${repository}:pull`);

    // NOTE: no `authorization` header. This request is the one #586 turns on —
    // GHCR answers 401 for a private package and 403 for one that is not there.
    const auth = await http(`${realm}?${params}`, { accept: 'application/json' });
    if (auth.status !== 200) {
      return {
        stage: 'token',
        status: auth.status,
        message:
          'the registry refused to mint an ANONYMOUS pull token — the package is private ' +
          '(401) or absent (403). A logged-in runner would not see this.',
      };
    }
    const token = (await auth.json())?.token;
    if (!token) {
      return { stage: 'token', status: auth.status, message: 'token endpoint returned no token' };
    }
    response = await http(url, { ...base, authorization: `Bearer ${token}` });
  }
  return {
    stage: 'manifest',
    status: response.status,
    digest: response.headers?.['docker-content-digest'],
  };
}

/**
 * Verify one reference is anonymously pullable. Returns a finding, or undefined.
 *
 * A transport that THROWS (DNS, TLS, an offline runner, a rate limit that closes
 * the connection) reads like every other failure and is NEVER a pass.
 */
export async function verifyAnonymousPull(ref, options = {}) {
  const api = options.api ?? ((r) => resolveAnonymousManifest(r, { http: options.http }));
  let resolved;
  try {
    resolved = await api(ref);
  } catch (error) {
    return {
      ...ref,
      reason: 'api-error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (resolved.stage === 'token') {
    return {
      ...ref,
      reason: 'anonymous-token-denied',
      status: resolved.status,
      message: resolved.message,
    };
  }
  if (resolved.status !== 200) {
    return {
      ...ref,
      reason: 'manifest-denied',
      status: resolved.status,
      message: resolved.message,
    };
  }
  if (!resolved.digest) {
    return {
      ...ref,
      reason: 'api-error',
      status: resolved.status,
      message: 'registry returned no Docker-Content-Digest',
    };
  }
  if (ref.digest && resolved.digest !== ref.digest) {
    return { ...ref, reason: 'digest-mismatch', actualDigest: resolved.digest };
  }
  return undefined;
}

/**
 * Check a downloaded bundle body: is it the install bundle, and is every image
 * in it anonymously pullable?
 *
 * The shape checks are not decoration. A 404 HTML page and a bundle stripped of
 * its workloads both download fine and both carry zero images — so a check that
 * only iterated images would report "0 findings" on the exact failure it exists
 * to catch. Zero images is a FINDING, and so is a bundle with no CRD.
 */
export async function verifyBundle(body, options = {}) {
  const findings = [];
  const docs = splitYamlDocumentsWithOffsets(body);
  const kinds = docs.map((d) => documentKind(d.text)).filter(Boolean);

  if (kinds.length === 0) {
    findings.push({
      reason: 'not-a-bundle',
      detail:
        'the downloaded body contains no Kubernetes document at all — a 404 page, an error ' +
        'body, or an asset that is not install.yaml',
    });
    return { images: [], findings };
  }
  if (!kinds.includes('CustomResourceDefinition')) {
    findings.push({
      reason: 'no-crd',
      detail: 'the bundle installs no CustomResourceDefinition, so it cannot be the install bundle',
    });
  }

  const images = extractContainerImages(body);
  if (images.length === 0) {
    findings.push({
      reason: 'no-images',
      detail:
        'no container image in any workload document. Nothing would be verified, so this is a ' +
        'finding rather than a vacuous pass.',
    });
    return { images, findings };
  }

  for (const image of images) {
    const ref = { ...parseImageRef(image.image), line: image.line, kind: image.kind };
    const finding = await verifyAnonymousPull(ref, options);
    if (finding) findings.push(finding);
  }
  return { images, findings };
}

// ── credential absence, asserted rather than assumed ─────────────────────────

/**
 * The shape of a variable name that can carry a credential.
 *
 * A SHAPE, not a list of the three spellings someone happened to think of. The
 * repo has already shipped a guard that banned `if: true` while `always()` — the
 * canonical idiom — sailed through, and the same failure here would be a check
 * that scrubs `GITHUB_TOKEN` and misses `CR_PAT`. Matching on `_`-delimited word
 * parts catches names nobody has written yet, which is the only version of this
 * that keeps working.
 *
 * Narrow enough not to fire on the dozens of `GITHUB_*` metadata variables a
 * runner always sets: a permanently-red nightly trains people to ignore it, and
 * an ignored gate is the thing this whole issue is about.
 */
export const CREDENTIAL_NAME_RE =
  /(^|_)(TOKENS?|SECRETS?|PASSWORDS?|PASSWD|CREDENTIALS?|APIKEYS?|PAT|AUTH|BEARER|COOKIES?|SESSION|KEYS?)(_|$)/i;

/**
 * Credential-shaped variables present in `env` WITH A NON-EMPTY VALUE.
 *
 * Findings carry the NAME only. A gate that echoes the token it found is a
 * secret leak of its own, and CI logs are the last place a value should land.
 */
export function findEnvCredentialLeaks(env) {
  const leaks = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value === '') continue;
    if (CREDENTIAL_NAME_RE.test(name)) leaks.push({ reason: 'env-credential', name });
  }
  return leaks.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The env vars that RELOCATE an on-disk auth store.
 *
 * Checking `~/.docker/config.json` alone is the half-guard: `DOCKER_CONFIG`
 * points the whole store somewhere else, and a runner that set it would sail
 * through a check that only knew the default path.
 */
export const CREDENTIAL_FILE_ENV_VARS = ['DOCKER_CONFIG', 'REGISTRY_AUTH_FILE'];

/** How each relocating variable names its store: a directory, or the file itself. */
const RELOCATED_STORE_SUFFIX = { DOCKER_CONFIG: '/config.json', REGISTRY_AUTH_FILE: '' };

/**
 * On-disk auth stores that exist.
 *
 * Scope is registry and GitHub-API credentials — the two this check could
 * possibly inherit. `~/.npmrc` is deliberately NOT here: it is an npm registry
 * credential, irrelevant to an OCI pull or a release-asset download, and
 * including it would make every developer's local run red for a reason that is
 * not a finding.
 */
export function findFileCredentialLeaks({ env = {}, home = homedir(), exists = existsSync } = {}) {
  const candidates = [
    `${home}/.docker/config.json`,
    `${home}/.config/gh/hosts.yml`,
    `${home}/.config/containers/auth.json`,
    `${home}/.netrc`,
  ];
  for (const name of CREDENTIAL_FILE_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') {
      candidates.push(`${value}${RELOCATED_STORE_SUFFIX[name] ?? ''}`);
    }
  }
  return [...new Set(candidates)]
    .filter((path) => exists(path))
    .map((path) => ({ reason: 'auth-store-present', path }));
}

/**
 * Every header this check may put on the wire.
 *
 * An ALLOWLIST, so the forbidden set is "everything not explicitly permitted".
 * A denylist would have to name `cookie`, `proxy-authorization`,
 * `x-registry-auth` and whatever the next one is called; this catches it on the
 * day it lands.
 */
export const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'authorization', 'user-agent']);

/**
 * What ACTUALLY went on the wire — the strongest of the three credential halves.
 *
 * `Authorization` is permitted only when it carries a Bearer token this same run
 * minted from an anonymous token request. That distinguishes the legitimate
 * second leg of the OCI dance from a credential that arrived from anywhere else,
 * which no amount of environment scrubbing can tell you.
 */
export function findRequestCredentialLeaks(requests) {
  const minted = new Set(requests.map((r) => r.minted).filter((t) => typeof t === 'string'));
  const findings = [];
  for (const request of requests) {
    // The URL is reported without its query string: a token can legitimately
    // appear in one, and a finding must never become the leak it reports.
    const url = String(request.url ?? '').split('?')[0];
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const header = name.toLowerCase();
      if (!ALLOWED_REQUEST_HEADERS.has(header)) {
        findings.push({ reason: 'unexpected-header', url, header });
        continue;
      }
      if (header !== 'authorization') continue;
      const bearer = /^Bearer (.+)$/.exec(String(value));
      if (!bearer || !minted.has(bearer[1])) {
        findings.push({
          reason: 'unminted-bearer',
          url,
          detail:
            'an Authorization header this run did not mint anonymously — the check would be ' +
            'testing the AUTHENTICATED path, which is not the path a stranger takes',
        });
      }
    }
  }
  return findings;
}

// ── the workflow may not be handed a credential ──────────────────────────────

/** The only actions the anonymous job may use. */
export const ALLOWED_JOB_ACTIONS = new Set(['actions/checkout']);

/**
 * The only `run:` commands the anonymous job may issue.
 *
 * Pinned exactly — which is also what stops `--scrub` from being used to disarm
 * the check in CI, since a run line carrying it is not this string.
 */
export const ALLOWED_JOB_RUN_COMMANDS = new Set(['node scripts/verify-anonymous-install.mjs']);

/**
 * The `${{ … }}` expressions the anonymous job may contain: NONE.
 *
 * Empty on purpose. The job needs no context at all, so anything interpolated
 * into it is by definition something it did not need — and `${{ secrets.X }}`
 * and `${{ github.token }}` are two spellings of the same credential, which is
 * precisely why this is an allowlist and not a search for the word "secrets".
 */
export const ALLOWED_JOB_EXPRESSIONS = new Set([]);

/**
 * Audit the job that performs the anonymous fetch.
 *
 * The job is FOUND by the script it runs, not named by a constant: if the check
 * is moved to another job the audit follows it, and if two jobs run it the
 * ambiguity is a finding rather than a silently-audited first match. `jobId`
 * being empty is itself the non-vacuity signal the guard test asserts on.
 *
 * The alert job is deliberately out of scope — it legitimately holds
 * `issues: write` and a `GH_TOKEN`, and it performs no fetch. Moving the fetch
 * into it would move the audit with it, so the exemption cannot be abused.
 *
 * @returns {{ jobId: string, findings: string[] }}
 */
export function auditAnonymousWorkflowJob(workflowText) {
  const findings = [];
  const lines = workflowText.split('\n');

  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return { jobId: '', findings: ['no `jobs:` block in the workflow'] };

  /** Job id -> its block text, split on the 2-space-indented keys under `jobs:`. */
  const blocks = new Map();
  let currentId = '';
  let current = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const header = line.match(/^ {2}([\w.-]+):\s*$/);
    if (header) {
      if (currentId) blocks.set(currentId, current.join('\n'));
      currentId = header[1];
      current = [];
      continue;
    }
    if (/^\S/.test(line) && line.trim() !== '') break;
    current.push(line);
  }
  if (currentId) blocks.set(currentId, current.join('\n'));

  const owners = [...blocks].filter(([, text]) => text.includes('verify-anonymous-install.mjs'));
  if (owners.length !== 1) {
    return {
      jobId: '',
      findings: [
        `expected exactly 1 job running verify-anonymous-install.mjs, found ${owners.length}`,
      ],
    };
  }
  const [jobId, block] = owners[0];

  // 1. permissions — declared, and granting nothing.
  const permissions = block.match(/^ {4}permissions:(.*)$/m);
  if (!permissions) {
    findings.push(`job \`${jobId}\` declares no \`permissions:\` — it must declare \`{}\``);
  } else if (permissions[1].trim() !== '{}') {
    findings.push(
      `job \`${jobId}\` grants permission(s) (\`permissions:${permissions[1]}\`) — the anonymous ` +
        'check must hold none',
    );
  }

  // 2. actions — allowlist.
  for (const match of block.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
    const action = match[1].split('@')[0];
    if (!ALLOWED_JOB_ACTIONS.has(action)) {
      findings.push(
        `job \`${jobId}\` uses \`${match[1]}\`, which is not permitted by the allowlist ` +
          `(${[...ALLOWED_JOB_ACTIONS].join(', ')})`,
      );
    }
  }

  // 3. run commands — allowlist. A block scalar (`run: |`) is not on it.
  for (const match of block.matchAll(/^\s*(?:-\s+)?run:(.*)$/gm)) {
    const command = match[1].trim();
    if (!ALLOWED_JOB_RUN_COMMANDS.has(command)) {
      findings.push(
        `job \`${jobId}\` runs \`${command || '<block scalar>'}\`, which is not on the run ` +
          'allowlist — the anonymous check runs one pinned command and nothing else',
      );
    }
  }

  // 4. expressions — allowlist (empty). `secrets.X` and `github.token` are two
  //    spellings of the same thing; neither is named here, and both are caught.
  for (const match of block.matchAll(/\$\{\{([^}]*)\}\}/g)) {
    const expression = match[1].trim();
    if (!ALLOWED_JOB_EXPRESSIONS.has(expression)) {
      findings.push(
        `job \`${jobId}\` interpolates \`\${{ ${expression} }}\` — the anonymous check needs no ` +
          'context, so anything interpolated into it is something it must not have',
      );
    }
  }

  // 5. env — the job sets none, so a variable that is not a credential today
  //    cannot quietly become one later.
  if (/^\s*env:\s*$/m.test(block)) {
    findings.push(
      `job \`${jobId}\` declares an \`env:\` block — the anonymous check inherits nothing on ` +
        'purpose, so any variable it is given is a finding',
    );
  }

  return { jobId, findings };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
/* c8 ignore start — CLI wrapper */

function formatFinding(finding) {
  const where = finding.line ? `install.yaml:${finding.line}` : '';
  return (
    `  [${finding.reason}] ${where} ${finding.ref ?? finding.name ?? finding.path ?? ''}` +
    `${finding.status ? `\n      HTTP ${finding.status}` : ''}` +
    `${finding.actualDigest ? `\n      pinned:  ${finding.digest}\n      serves:  ${finding.actualDigest}` : ''}` +
    `${finding.detail ? `\n      ${finding.detail}` : ''}` +
    `${finding.message ? `\n      ${finding.message}` : ''}` +
    `${finding.header ? `\n      header: ${finding.header}` : ''}`
  );
}

async function main(argv) {
  let root = process.cwd();
  let scrub = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = argv[++i];
    else if (argv[i] === '--scrub') scrub = true;
    else {
      console.error(`unrecognised argument: ${argv[i]}`);
      return 1;
    }
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`not a directory: ${root}`);
    return 1;
  }

  if (scrub) {
    const scrubbed = findEnvCredentialLeaks(process.env).map((f) => f.name);
    for (const name of scrubbed) delete process.env[name];
    console.log(
      scrubbed.length === 0
        ? '--scrub: nothing to remove'
        : `--scrub: removed ${scrubbed.length} credential-shaped variable(s): ${scrubbed.join(', ')}`,
    );
  }

  const findings = [];

  // The context, checked BEFORE the network work: a run that inherited a
  // credential has already failed, whatever the registry says next.
  findings.push(...findEnvCredentialLeaks(process.env));
  findings.push(...findFileCredentialLeaks({ env: process.env }));

  let documented;
  try {
    documented = discoverInstallUrl(root);
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    return 1;
  }
  console.log(`documented install URL (from ${documented.file}:${documented.line}):`);
  console.log(`  ${documented.url}`);

  // The other half: every OTHER published copy must name the same URL, or a
  // reader who lands on one of them follows a URL nothing checked.
  const allUrls = findAllInstallUrls(root);
  console.log(`  ${allUrls.length} published copy/copies across the tree\n`);
  findings.push(...findUrlDriftFindings(documented.url, allUrls));

  const { http, requests } = createRecordingHttp();
  let body;
  try {
    const response = await fetch(documented.url, {
      headers: { accept: '*/*', 'user-agent': USER_AGENT },
      redirect: 'follow',
    });
    if (response.status !== 200) {
      findings.push({
        reason: 'install-url-not-200',
        ref: documented.url,
        status: response.status,
        detail: 'the URL the docs publish does not serve the bundle to an anonymous client',
      });
    }
    body = await response.text();
  } catch (error) {
    findings.push({
      reason: 'install-url-unreachable',
      ref: documented.url,
      message: error instanceof Error ? error.message : String(error),
      detail: 'unreachable is a FAILURE, never a pass',
    });
    body = '';
  }

  if (body !== '') {
    const bundle = await verifyBundle(body, { http });
    console.log(`bundle: ${body.length} bytes, ${bundle.images.length} workload image(s)`);
    for (const image of bundle.images) {
      console.log(`  install.yaml:${image.line}  [${image.kind}]  ${image.image}`);
    }
    findings.push(...bundle.findings);
  }

  findings.push(...findRequestCredentialLeaks(requests));
  console.log(`\n${requests.length} registry request(s) made, all unauthenticated by construction`);

  if (findings.length === 0) {
    console.log('\nOK: a stranger can fetch the documented bundle and pull every image in it.');
    return 0;
  }
  console.error(`\n${findings.length} finding(s):`);
  for (const finding of findings) console.error(formatFinding(finding));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main(process.argv.slice(2)));
}
/* c8 ignore stop */
