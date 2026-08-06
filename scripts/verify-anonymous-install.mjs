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
 * Exits 1 on any finding.
 *
 * `--scrub` removes credential-shaped variables from the process ENVIRONMENT
 * before anything else runs, and reports every name it removed.
 *
 * It does NOT — and cannot — remove the on-disk auth stores. A developer logged
 * in to ghcr or `gh` still gets `auth-store-present` findings and still exits 1,
 * measured, on a real `HOME`. That is correct rather than a shortcoming: the
 * check cannot honestly claim to have run anonymously on a machine holding those
 * credentials, and a flag that silenced the finding would be manufacturing the
 * green this whole gate exists to refuse. So `--scrub` narrows local noise; it
 * does not make a logged-in machine pass.
 *
 * CI does NOT pass it — the workflow's run command is pinned by an allowlist
 * precisely so `--scrub` cannot be used to disarm the check there.
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
 * ten times across seven files — `apps/docs/content/docs/install.mdx`,
 * `docs/QUICKSTART.md` (twice), `docs/COMPATIBILITY.md`, `docs/RELEASING.md`,
 * `docs/runbooks/upgrade.md`, `packages/kn-next-operator/README.md` (twice) and
 * `packages/kn-next-operator/docs/RUNBOOK-first-publish.md` (twice) — and a
 * reader who lands on any of them follows THAT one. If one is updated and the
 * others are not, the check would keep walking the one healthy copy and report
 * green while most readers hit a 404. The count is not asserted anywhere on
 * purpose: the walk is derived, so a new file is covered without an edit here.
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
  for (const [index, line] of normaliseNewlines(text).split('\n').entries()) {
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

/**
 * The spellings a YAML key can legally take, as a regex fragment.
 *
 * ONE primitive, used by every rule in this file, because the alternative has
 * now failed twice. Round 3 asked "does this rule hold at every SITE?" and fixed
 * four places; it never asked "does it hold at every SPELLING?", so each rule
 * ended up tolerant of exactly the variants some earlier round had been burned
 * by — `permissions:`, `env:` and the block-level `uses:` allowlist learned
 * quotes while `stepUses`, `container:`/`services:` and `kind:` did not. A quoted
 * `uses:` then defeated the entire per-step credential rule.
 *
 * Centralising it means the next rule cannot forget, and the next spelling is
 * fixed in one place rather than in however many were remembered.
 *
 * Covers: bare, "double-quoted", 'single-quoted', and space-before-colon.
 * Deliberately `[ \t]*` rather than `\s*` before the colon — `\s` spans
 * newlines, which would let a key match across lines.
 */
export function yamlKey(name) {
  return `["']?${name}["']?[ \\t]*:`;
}

/**
 * Strip a trailing YAML comment from a single line.
 *
 * Space-preceded `#` only — `reg.io/a#b:v1` is one scalar, and stripping on a
 * bare `#` would corrupt values rather than tidy them.
 */
function withoutTrailingComment(line) {
  return line.replace(/\s+#.*$/, '');
}

/** Unwrap a quoted YAML scalar. */
function unquote(value) {
  return value.replace(/^["']|["']$/g, '');
}

/**
 * Normalise line endings so every rule below can assume `\n`.
 *
 * Done ONCE at the entry points rather than per-regex. Under CRLF, `.` does not
 * match `\r` and `$` will not match before it, which silently blanked every
 * `with:` entry and made a CORRECT workflow report `persist-credentials` absent.
 * Crying wolf ends the same way as never firing — the guard gets deleted — so
 * this belongs with the comment-blanking fix, not in a backlog.
 */
function normaliseNewlines(text) {
  // A BOM is stripped anywhere it appears, not just at offset 0: documents are
  // split on `---`, so a BOM can land at the start of the SECOND document and
  // hide its `kind:` from a column-0 anchor. U+FEFF has no legitimate place in a
  // Kubernetes manifest, and an internet-downloaded body is exactly where one
  // turns up. The exhaustive partition would REPORT such a document rather than
  // drop it, but reading through the BOM is better than reporting a bundle that
  // is actually fine.
  // Written `\uFEFF`, never as the literal character: a raw BOM in source is
  // invisible in a diff, which is the same reviewability problem the control-byte
  // guard exists for.
  return text.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n');
}

/**
 * The document's top-level `kind:`, or undefined.
 *
 * Comment-stripped and quote-tolerant — the SAME anchor shape round 2 fixed in
 * `imageOnLine`, one scope out, and missed there.
 *
 * Returning `undefined` is SAFE, and deliberately so. An earlier revision of
 * this comment diagnosed the danger exactly — both scanners skipped on `!kind`,
 * so an unreadable kind was dropped by both — and then only the comment and
 * quote *spellings* were fixed, leaving the mechanism live for every other one.
 * Widening this parser can never close that, because the next unforeseen
 * spelling reopens it. `partitionDocuments` closes it instead, by making
 * "neither bucket" inexpressible. So this function is free to be strict:
 * anything it cannot read confidently becomes `undefined` and is REPORTED, and
 * being strict here is better than guessing a kind and scanning the wrong thing.
 */
function documentKind(docText) {
  const line = docText.match(new RegExp(`^${yamlKey('kind')}(.*)$`, 'm'))?.[1];
  if (line === undefined) return undefined;
  const value = unquote(withoutTrailingComment(line).trim());
  return value === '' ? undefined : value;
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
function imageOnLine(line) {
  // Strip a trailing YAML comment FIRST. `# pinned by release job` after a
  // reference is legal YAML and kustomize/kubebuilder emit it; the original
  // `(\S+)\s*$` anchor silently dropped the whole entry, so with two images and
  // a comment on one the commented image was never pulled and nothing reported
  // the undercount.
  //
  // The `\s+` before `#` is required, not cosmetic: only a SPACE-preceded `#`
  // opens a comment in YAML, so `reg.io/a#b:v1` is one scalar. Stripping on a
  // bare `#` would corrupt the reference instead of dropping it — a worse bug
  // than the one being fixed.
  const match = withoutTrailingComment(line).match(
    new RegExp(`^\\s*(?:-\\s+)?${yamlKey('image')}\\s*(\\S+)\\s*$`),
  );
  if (!match) return undefined;
  const value = unquote(match[1]);
  // A block scalar or an anchor is not a reference; neither is a bare word with
  // no registry, repository separator, tag or digest.
  if (/^[|>&*]/.test(value)) return undefined;
  if (!/[:/@]/.test(value)) return undefined;
  return value;
}

/**
 * Split every document into exactly TWO buckets: `workload` and `other`.
 *
 * EXHAUSTIVE BY CONSTRUCTION, and that is the entire point. The two scanners
 * used to test independent conditions — `!kind || !WORKLOAD_KINDS.has(kind)` and
 * `!kind || WORKLOAD_KINDS.has(kind)` — which are NOT complements: a document
 * whose kind is *unreadable* satisfies the skip in both, so it was neither
 * scanned nor reported. Five spellings reached it (`kind` absent, empty,
 * comment-only, indented off column 0, or a block-sequence value), and each one
 * hid an unpullable image behind zero findings and exit 0 — #586's own shape.
 *
 * A single ternary cannot have that gap. `other` is the literal complement of
 * `workload`, so a spelling nobody has thought of still lands in one of them,
 * and "neither" stops being expressible rather than stopping by inspection.
 * This is "make an unparseable construct fail rather than pass", applied one
 * level up from `imageOnLine`, where round 4 applied it and stopped.
 */
function partitionDocuments(bundleText) {
  const workload = [];
  const other = [];
  for (const doc of splitYamlDocumentsWithOffsets(bundleText)) {
    const kind = documentKind(doc.text);
    const readable = kind !== undefined;
    (readable && WORKLOAD_KINDS.has(kind) ? workload : other).push({
      ...doc,
      // `<unreadable>` rather than undefined so a finding can NAME what it saw.
      kind: readable ? kind : '<unreadable>',
    });
  }
  return { workload, other };
}

/**
 * Every image reference inside one already-classified document.
 *
 * @typedef {{ image: string, line: number, kind: string }} ImageRef
 * @returns {ImageRef[]}
 */
function imagesInDocument(doc) {
  const found = [];
  for (const [index, line] of doc.text.split('\n').entries()) {
    const image = imageOnLine(line);
    if (image) found.push({ image, line: doc.startLine + index, kind: doc.kind });
  }
  return found;
}

export function extractContainerImages(bundleText) {
  // A loop rather than `.flatMap(imagesInDocument)`: `flatMap`'s signature is
  // `(…) => U | ReadonlyArray<U>`, so a callback returning `ImageRef[]` lets TS
  // resolve `U` as `ImageRef[]` and the result nests one level. The root
  // typecheck gate caught it; spelling it out costs nothing and cannot drift.
  /** @type {ImageRef[]} */
  const found = [];
  for (const doc of partitionDocuments(bundleText).workload) found.push(...imagesInDocument(doc));
  return found;
}

/**
 * Images sitting in a document kind `extractContainerImages` does NOT scan.
 *
 * `WORKLOAD_KINDS` is an enumeration, so it is permanently one step behind
 * reality — a Knative `Service` is the obvious near-term gap, and this repo
 * deploys Knative Services for a living. Enumerating is still the right call
 * (selecting by kind is what excludes the CRD's `image` schema property), but
 * "prefer scanning to enumerating" applies: the trade is only acceptable if an
 * unrecognised kind carrying an image is a FINDING rather than a silent skip.
 *
 * No false positive on the real bundle's CRD: its `image` is a schema PROPERTY
 * with no value, and `imageOnLine` requires a reference-shaped one.
 */
export function findUnscannedKindImages(bundleText) {
  // The COMPLEMENT of `extractContainerImages`, taken from the same partition
  // rather than re-derived from a second condition. Re-deriving it is what let
  // the two conditions stop being complements without anyone noticing.
  /** @type {ImageRef[]} */
  const found = [];
  for (const doc of partitionDocuments(bundleText).other) found.push(...imagesInDocument(doc));
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

  for (const unscanned of findUnscannedKindImages(body)) {
    findings.push({
      reason: 'unscanned-kind-image',
      ref: unscanned.image,
      line: unscanned.line,
      detail:
        `a \`${unscanned.kind}\` document carries an \`image:\` value, and that kind is not in ` +
        'WORKLOAD_KINDS — so nothing verified it is anonymously pullable. If the kind really ' +
        'runs a container, add it to WORKLOAD_KINDS; if this is data that merely looks like an ' +
        'image reference (a ConfigMap value, a template), the value is not a workload image and ' +
        'the extractor needs to learn to tell them apart.',
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
 * The only `with:` keys the anonymous job's steps may set.
 *
 * `persist-credentials` is on it because it must be set to `false`, not because
 * it is optional — see the required-key rule below. Everything else, notably
 * `token:`, is refused: handing checkout a token is the simplest way to put a
 * credential in the workspace.
 */
export const ALLOWED_JOB_WITH_KEYS = new Set(['persist-credentials']);

/**
 * Workflow-level keys that leak into every job, and so may not appear at all.
 *
 * `env:` is the important one: a workflow-level `env:` is inherited by every
 * job, which makes it the most likely place an inherited credential actually
 * comes from — and it is *outside* the job block, where the original audit could
 * not see it. `defaults:` can rewrite how every `run:` is executed.
 */
export const FORBIDDEN_TOP_LEVEL_KEYS = ['env', 'defaults'];

/**
 * Job-level keys that introduce a registry login by construction.
 *
 * `container:` and `services:` both take a `credentials:` mapping — a registry
 * username/password for pulling the image the job runs in. A job that has one is
 * not anonymous, whatever its steps do.
 */
export const FORBIDDEN_JOB_KEYS = ['container', 'services'];

/**
 * Audit the job that performs the anonymous fetch, AND the workflow scope
 * around it.
 *
 * The job is FOUND by the script it runs, not named by a constant: if the check
 * is moved to another job the audit follows it, and if two jobs run it the
 * ambiguity is a finding rather than a silently-audited first match. `jobId`
 * being empty is itself the non-vacuity signal the guard test asserts on.
 *
 * SCOPE, and why it is wider than the job block. The first version started at
 * `jobs:` and stopped at the next column-0 key, so everything outside the job
 * was invisible — and a workflow-level `env:` carrying `${{ secrets.GITHUB_TOKEN }}`
 * scored zero findings whether it was written before or after `jobs:`. That made
 * the "the empty expression allowlist catches `secrets.X` and `github.token`
 * without naming either" claim true only *inside* the job block, which is not
 * where an inherited credential comes from. Top-level keys are now audited too,
 * and because YAML mappings are unordered the scan cannot stop at `jobs:` — it
 * takes every column-0 key wherever it sits in the file.
 *
 * The ALERT job stays out of scope. It legitimately holds `issues: write` and
 * `${{ github.token }}`, and it performs no fetch — sweeping it in would leave
 * the guard permanently red, which is how a guard gets deleted. The exemption
 * cannot be abused: the audit locates the job by the script it runs, so moving
 * the fetch into the alert job moves the audit with it.
 *
 * @returns {{ jobId: string, findings: string[] }}
 */
/**
 * Blank out YAML comments, preserving line count and indentation.
 *
 * Not optional. Caught while writing this: the required-input check below was
 * satisfied by the workflow's own explanatory COMMENT, which quotes
 * `persist-credentials: false` verbatim — so deleting the real `with:` input
 * left the guard GREEN. That is the #680 failure again (a raw scan satisfied by
 * an occurrence in a comment or a string), and a guard a comment can satisfy is
 * decoration.
 *
 * Only a SPACE-preceded `#` opens a comment in YAML, matching `imageOnLine`.
 */
function blankYamlComments(text) {
  return normaliseNewlines(text)
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n');
}

/**
 * Split a job block into its `steps:` sequence items.
 *
 * Structural rather than indent-coupled. The first version of the `with:` scan
 * filtered on a literal 10-space indent as a stand-in for "inside `with:`", and
 * both legal alternatives escaped it completely: 4-space sequence items put the
 * keys at 8, and a flow-style `with: { … }` has no indented keys at all. The
 * indent could not simply be loosened — widening it reddens the real workflow —
 * so the fix has to be a parse, not a laxer regex.
 *
 * The item indent is DISCOVERED from the first `- ` after `steps:`, so any
 * consistent layout works.
 */
export function parseJobSteps(block) {
  const lines = block.split('\n');
  const stepsRe = new RegExp(`^\\s*${yamlKey('steps')}\\s*$`);
  const stepsAt = lines.findIndex((line) => stepsRe.test(line));
  if (stepsAt === -1) return [];

  const steps = [];
  let itemIndent = null;
  let current = null;
  for (const line of lines.slice(stepsAt + 1)) {
    const item = line.match(/^(\s*)-\s/);
    if (item && (itemIndent === null || item[1].length === itemIndent)) {
      if (itemIndent === null) itemIndent = item[1].length;
      if (current) steps.push(current.join('\n'));
      current = [line];
      continue;
    }
    if (current === null) continue;
    // A non-blank line at or left of the item indent ends the sequence.
    if (line.trim() !== '' && line.match(/^(\s*)/)[1].length <= itemIndent) break;
    current.push(line);
  }
  if (current) steps.push(current.join('\n'));
  return steps;
}

/**
 * The action a step runs.
 *
 * Three-valued on purpose:
 *   - `undefined` — the step declares no `uses` at all (a `run:` step);
 *   - `null`      — it declares `uses` but the value is not readable inline;
 *   - a string    — the action reference.
 *
 * The `null` case is the fail-closed one, and it has to be per-STEP. The
 * previous net was `steps.length === 0 && block.includes('uses:')` — per JOB, so
 * a step whose `uses` was unreadable while its siblings parsed fine produced no
 * finding at all. That is precisely the per-job-vs-per-step error this round
 * exists to eliminate, reintroduced inside the net added to prevent it.
 *
 * Quote-tolerant via the shared `yamlKey`. Without that, `- "uses": actions/checkout@…`
 * was recognised as checkout by the block-level allowlist fifteen lines away and
 * returned `undefined` here, skipping the `persist-credentials` rule entirely.
 */
export function stepUses(stepText) {
  const match = stepText.match(new RegExp(`^\\s*(?:-\\s+)?${yamlKey('uses')}(.*)$`, 'm'));
  if (!match) return undefined;
  const value = unquote(withoutTrailingComment(match[1]).trim());
  return value === '' ? null : value;
}

/**
 * A step's own `with:` inputs as `{ key, value }`, block or flow style.
 *
 * Per-STEP is the whole point. The `persist-credentials` rule used to ask "does
 * `persist-credentials: false` appear anywhere in this job", which is satisfied
 * by the first checkout no matter what a second one does — and adding a second
 * checkout is the most ordinary edit this workflow will ever receive. Reading
 * each step's own inputs closes the wrong-value case and the missing-`with:`
 * case together.
 */
export function parseWithEntries(stepText) {
  const lines = stepText.split('\n');
  const withRe = new RegExp(`^\\s*${yamlKey('with')}`);
  const index = lines.findIndex((line) => withRe.test(line));
  if (index === -1) return [];

  const line = lines[index];
  const inline = line.replace(withRe, '').trim();
  if (inline !== '') {
    return inline
      .replace(/^\{/, '')
      .replace(/\}$/, '')
      .split(',')
      .map((pair) => {
        const at = pair.indexOf(':');
        if (at === -1) return undefined;
        return {
          key: pair
            .slice(0, at)
            .trim()
            .replace(/^["']|["']$/g, ''),
          value: pair.slice(at + 1).trim(),
        };
      })
      .filter(Boolean);
  }

  const withIndent = line.match(/^(\s*)/)[1].length;
  const entries = [];
  for (const next of lines.slice(index + 1)) {
    if (next.trim() === '') continue;
    if (next.match(/^(\s*)/)[1].length <= withIndent) break;
    const entry = next.match(/^\s*["']?([\w.-]+)["']?\s*:\s*(.*)$/);
    if (entry) entries.push({ key: entry[1], value: entry[2].trim() });
  }
  return entries;
}

export function auditAnonymousWorkflowJob(workflowText) {
  const findings = [];
  const lines = blankYamlComments(workflowText).split('\n');

  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return { jobId: '', findings: ['no `jobs:` block in the workflow'] };

  // ── workflow scope: every column-0 key, wherever it appears ───────────────
  for (const [index, line] of lines.entries()) {
    // Quotes and space-before-colon are legal YAML and both spell the same key.
    // `^([\w.-]+):` matched neither, so `"env":` and `env :` scored zero.
    const key = line.match(/^["']?([\w.-]+)["']?\s*:/)?.[1];
    if (!key || !FORBIDDEN_TOP_LEVEL_KEYS.includes(key)) continue;
    // Collect the block so the finding can quote what was actually set.
    const block = [];
    for (const next of lines.slice(index + 1)) {
      if (/^\S/.test(next) && next.trim() !== '') break;
      block.push(next);
    }
    findings.push(
      `the workflow declares a top-level \`${key}:\` block, which every job inherits — the ` +
        `anonymous check must inherit nothing:${block.length > 0 ? `\n${block.join('\n')}` : ''}`,
    );
  }

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
      // The workflow-scope findings above are kept, not discarded: "the job could
      // not be located" and "the workflow leaks an env var" are both true, and
      // dropping one because the other fired hides half the report.
      findings: [
        ...findings,
        `expected exactly 1 job running verify-anonymous-install.mjs, found ${owners.length}`,
      ],
    };
  }
  const [jobId, block] = owners[0];

  // 1. permissions — declared, and EVERY declaration granting nothing.
  //
  // `matchAll`, not `match`: the first-match-only form answered "is there a
  // `permissions:` that is `{}`" rather than "is every one of them `{}`" — the
  // same shape as the per-job `persist-credentials` defect, one level up. The
  // indent is no longer pinned to four spaces either.
  const permissions = [...block.matchAll(/^\s*["']?permissions["']?\s*:(.*)$/gm)];
  if (permissions.length === 0) {
    findings.push(`job \`${jobId}\` declares no \`permissions:\` — it must declare \`{}\``);
  }
  for (const grant of permissions) {
    if (grant[1].trim() !== '{}') {
      findings.push(
        `job \`${jobId}\` grants permission(s) (\`permissions:${grant[1]}\`) — the anonymous ` +
          'check must hold none',
      );
    }
  }

  // 1b. container/services — a `credentials:` mapping is a registry login.
  // NOT pinned to four spaces. Job keys only need more indentation than the
  // 2-space job id, so 6 and 8 are legal YAML — and this was the one rule still
  // pinned while the comment above claimed the pin was gone. Nothing caught it
  // because the only test ever written for it used the 4-space case.
  for (const key of FORBIDDEN_JOB_KEYS) {
    if (new RegExp(`^\\s+${yamlKey(key)}`, 'm').test(block)) {
      findings.push(
        `job \`${jobId}\` declares \`${key}:\`, which takes a \`credentials:\` registry ` +
          'username/password — a job that has one is not anonymous whatever its steps do',
      );
    }
  }

  // 2. actions — allowlist.
  for (const match of block.matchAll(/^\s*(?:-\s+)?["']?uses["']?\s*:\s*(\S+)/gm)) {
    const action = match[1].split('@')[0];
    if (!ALLOWED_JOB_ACTIONS.has(action)) {
      findings.push(
        `job \`${jobId}\` uses \`${match[1]}\`, which is not permitted by the allowlist ` +
          `(${[...ALLOWED_JOB_ACTIONS].join(', ')})`,
      );
    }
  }

  // 2b. `with:` inputs — allowlist, plus the one input that is REQUIRED.
  //
  // `actions/checkout` defaults to `persist-credentials: true`, which writes
  // `AUTHORIZATION: basic <token>` into the workspace `.git/config` keyed on the
  // github.com PREFIX — so every github.com request made from the workspace
  // carries the runner's token. Harmless for a `fetch`-only implementation, but
  // the credential half of this check exists precisely so a future
  // implementation that DOES shell out cannot inherit one quietly, and this is
  // exactly the credential it would inherit: invisible to
  // `findFileCredentialLeaks` (`.git/config` is not one of the auth stores) and
  // invisible to the expression allowlist (nothing is interpolated).
  // `action-pin-resolution-nightly.yml` and `mutation-prover-nightly.yml` both
  // set it false already; this makes it enforced rather than remembered.
  // Asserted PER STEP, at every site — not once for the job. The previous shape
  // asked "does `persist-credentials: false` appear ANYWHERE in this job", which
  // the first checkout satisfies no matter what a second one does. Measured: a
  // second `actions/checkout` with no `with:` at all (defaulting to
  // `persist-credentials: true`), and one with an EXPLICIT `true`, both scored
  // zero findings. Adding a second checkout is the most ordinary edit this
  // workflow will ever receive.
  const steps = parseJobSteps(block);
  if (steps.length === 0 && new RegExp(yamlKey('uses')).test(block)) {
    // Fail closed at the JOB level: the parse yielded nothing at all while the
    // job clearly has steps, so every per-step rule below would be vacuous.
    findings.push(
      `job \`${jobId}\` has \`uses:\` steps that could not be parsed as a \`steps:\` sequence — ` +
        'the per-step credential rules would pass vacuously',
    );
  }
  for (const [index, stepText] of steps.entries()) {
    const uses = stepUses(stepText);
    const entries = parseWithEntries(stepText);
    const where = `job \`${jobId}\` step ${index + 1}`;

    // Fail closed at the STEP level. The job-level net above only fires when
    // NOTHING parsed; a single unreadable step among readable siblings slipped
    // through it, which is the same per-job-vs-per-step error one scope in.
    if (uses === null) {
      findings.push(
        `${where} declares \`uses\` with a value the parser cannot read inline — refusing to ` +
          'guess whether it is a checkout, because guessing wrong silently skips the ' +
          '`persist-credentials` rule',
      );
    }

    for (const { key } of entries) {
      if (!ALLOWED_JOB_WITH_KEYS.has(key)) {
        findings.push(
          `${where} passes the input \`${key}\`, which is not on the \`with:\` allowlist ` +
            `(${[...ALLOWED_JOB_WITH_KEYS].join(', ')}) — a token handed to an action is a ` +
            'credential the check must not hold',
        );
      }
    }

    if (uses?.split('@')[0] === 'actions/checkout') {
      const persist = entries.find((entry) => entry.key === 'persist-credentials');
      if (!persist || persist.value !== 'false') {
        findings.push(
          `${where} (\`${uses}\`) does not set \`persist-credentials: false\` ` +
            `(it is ${persist ? `\`${persist.value}\`` : 'absent, which defaults to `true`'}) — ` +
            'the runner token is left in the workspace `.git/config`, where every github.com ' +
            'request from the workspace picks it up',
        );
      }
    }
  }

  // 3. run commands — allowlist. A block scalar (`run: |`) is not on it.
  for (const match of block.matchAll(/^\s*(?:-\s+)?["']?run["']?\s*:(.*)$/gm)) {
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
  //
  //    NOT anchored to end-of-line. `env:\s*$` missed the inline flow form
  //    `env: { GH_TOKEN: aLiteralToken }`, which interpolates nothing and so is
  //    not covered by the expression allowlist either — the same "only the
  //    spelling that exists today" shape as the `persist-credentials` defect.
  if (/^\s*["']?env["']?\s*:/m.test(block)) {
    findings.push(
      `job \`${jobId}\` declares an \`env:\` block — the anonymous check inherits nothing on ` +
        'purpose, so any variable it is given is a finding',
    );
  }

  return { jobId, findings };
}

// ── the download, and the whole check ────────────────────────────────────────

/**
 * Download the documented bundle. Returns `{ body, status, findings }`.
 *
 * `body` is `null` — never `''` — when the fetch THREW. That distinction is the
 * entire point of this function existing separately, and getting it wrong was a
 * real bug in this file: an empty string was the sentinel for "unreachable", so
 * a **zero-length 200** was indistinguishable from a thrown fetch, and the
 * caller's `if (body !== '')` skipped bundle verification for both. A 0-byte
 * `install.yaml` therefore produced ZERO findings and exit 0 — a vacuous green on
 * precisely the "release nobody can install" case this gate exists to catch, and
 * a second door around the `not-a-bundle` / `no-crd` / `no-images` checks.
 *
 * It survived because the download half lived inside the `c8 ignore`d CLI and no
 * spec or mutation touched it. Everything else here is defended by a mutation;
 * this half was not, which is why it had the bug.
 *
 * A zero-length 200 is now its own finding as well as failing `verifyBundle`:
 * the two answer different triage questions ("the asset is empty" vs "the body
 * is not a bundle"), and on this path more information is better than less.
 */
/**
 * The narrow slice of `fetch` this check actually uses.
 *
 * Declared rather than inferred from the `= fetch` default. Inferring gives the
 * full `typeof fetch`, which forces every test double to fabricate the fourteen
 * `Response` members the check never touches — and a double that elaborate stops
 * being readable as a statement of what the code depends on. Two fields is the
 * real contract.
 *
 * @typedef {(url: string, init?: object) => Promise<{ status: number, text: () => Promise<string> }>} BundleFetch
 */

/**
 * @param {string} url
 * @param {{ fetchImpl?: BundleFetch }} [options]
 */
export async function fetchInstallBundle(url, { fetchImpl = fetch } = {}) {
  const findings = [];
  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      headers: { accept: '*/*', 'user-agent': USER_AGENT },
      redirect: 'follow',
    });
    body = await response.text();
  } catch (error) {
    return {
      body: null,
      status: 0,
      findings: [
        {
          reason: 'install-url-unreachable',
          ref: url,
          message: error instanceof Error ? error.message : String(error),
          detail: 'unreachable is a FAILURE, never a pass',
        },
      ],
    };
  }

  if (response.status !== 200) {
    findings.push({
      reason: 'install-url-not-200',
      ref: url,
      status: response.status,
      detail: 'the URL the docs publish does not serve the bundle to an anonymous client',
    });
  } else if (body.length === 0) {
    findings.push({
      reason: 'empty-bundle',
      ref: url,
      status: 200,
      detail:
        'the documented URL returned 200 with a ZERO-LENGTH body — a release job that uploaded ' +
        'an empty asset, or a CDN empty-200. It downloads cleanly and installs nothing.',
    });
  }
  return { body, status: response.status, findings };
}

/**
 * The whole check, as one testable function.
 *
 * Extracted out of `main()` deliberately. `main()` is `c8 ignore`d and no spec
 * could reach it, which is exactly where the empty-200 bug lived: the orchestration
 * — *which* findings get collected, and *whether* the bundle half runs at all —
 * is behaviour, and unreachable behaviour is unmutatable behaviour.
 *
 * Every collaborator is injectable so the spec stays offline and so a developer's
 * real `HOME` cannot change the verdict under test.
 */
export async function runAnonymousInstallCheck(root, options = {}) {
  const {
    fetchImpl,
    http,
    api,
    env = process.env,
    home = homedir(),
    exists = existsSync,
  } = options;

  const findings = [];

  // The context, checked BEFORE the network work: a run that inherited a
  // credential has already failed, whatever the registry says next.
  findings.push(...findEnvCredentialLeaks(env));
  findings.push(...findFileCredentialLeaks({ env, home, exists }));

  const documented = discoverInstallUrl(root);
  const allUrls = findAllInstallUrls(root);
  findings.push(...findUrlDriftFindings(documented.url, allUrls));

  const recorder = createRecordingHttp(http);
  const download = await fetchInstallBundle(documented.url, { fetchImpl });
  findings.push(...download.findings);

  // `!== null`, NOT `!== ''`. An empty body is a body: it has to reach
  // `verifyBundle` so `not-a-bundle` can fire. Only a THROWN fetch yields null,
  // and there is genuinely nothing to say about a bundle that never arrived —
  // adding `not-a-bundle` on top of `install-url-unreachable` would be two
  // findings for one cause.
  let images = [];
  if (download.body !== null) {
    const bundle = await verifyBundle(download.body, { http: recorder.http, api });
    images = bundle.images;
    findings.push(...bundle.findings);
  }

  findings.push(...findRequestCredentialLeaks(recorder.requests));
  return { documented, allUrls, download, images, findings, requests: recorder.requests };
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

  let result;
  try {
    result = await runAnonymousInstallCheck(root);
  } catch (error) {
    // Only `discoverInstallUrl` throws here, and it does so exactly when there
    // is no documented path left to walk. That is fatal, not a finding.
    console.error(`FATAL: ${error.message}`);
    return 1;
  }
  const { documented, allUrls, download, images, findings, requests } = result;

  console.log(`documented install URL (from ${documented.file}:${documented.line}):`);
  console.log(`  ${documented.url}`);
  console.log(`  ${allUrls.length} published copy/copies across the tree\n`);

  if (download.body !== null) {
    console.log(`bundle: ${download.body.length} bytes, ${images.length} workload image(s)`);
    for (const image of images) {
      console.log(`  install.yaml:${image.line}  [${image.kind}]  ${image.image}`);
    }
  }
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
