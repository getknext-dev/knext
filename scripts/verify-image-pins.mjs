#!/usr/bin/env node
/**
 * verify-image-pins — resolve every image THIS REPO RUNS ON A CLUSTER against
 * the tag its own reference claims, UPSTREAM, at run time (#471).
 *
 * Scope is the operator's Go sources AND the benchmark harnesses' YAML/shell.
 * The second half is not incidental: the two most privileged pins in the tree
 * are a benchmark's PRIVILEGED hostPID `nsenter` pod and its kaniko builder,
 * which holds the registry PUSH credential. A check whose scope excludes those
 * does not carry the finding it exists for.
 *
 * WHY THIS IS NOT A UNIT TEST
 * ---------------------------
 * The operator's prewarm helper is written `busybox:1.36.1-uclibc@sha256:0872…`.
 * Two Go unit tests guard it: one asserts a 64-hex digest exists, the other
 * asserts the TAG TEXT ends in `-uclibc`/`-musl` (only those variants are
 * `FROM scratch` static builds, and a dynamically linked helper staged into an
 * emptyDir cannot exec inside a musl or distroless app image — measured, it
 * CrashLoopBackOff'd on every OKE node).
 *
 * The kubelet resolves the DIGEST and ignores the tag. So
 * `busybox:1.36.1-uclibc@sha256:73aaf090…` — the uclibc tag carrying the GLIBC
 * digest — passes both Go tests and reinstates the exact regression, and the
 * documented bump procedure (`crane digest busybox:<tag>`) makes that one
 * copy-paste. Those tests prove the LABEL; this proves the ARTIFACT.
 *
 * The answer lives upstream and legitimately changes, so it cannot be frozen
 * into a committed assertion — freezing the VALUE is what made the equivalent
 * action-pin check decay into "edit the guard to get green" (security.md).
 * Hence the same division of labour as `verify-action-pins.mjs`: form at PR
 * time, value at run time, on a NIGHTLY.
 *
 * WHAT IT CATCHES
 *  - a well-formed pin whose digest is NOT what its tag resolves to (the bypass
 *    above);
 *  - a pin naming a tag that no longer exists upstream;
 *  - a digest-only pin: nothing states what the digest is SUPPOSED to be, so
 *    nothing can check it. Reported, never skipped — skipping would let a pin
 *    escape by deleting the field that makes it auditable.
 *
 * WHAT IT DOES NOT CATCH
 * It trusts the TAG as the statement of intent. A pin that correctly resolves to
 * a tag whose content is itself wrong (upstream repointing `-uclibc` at a glibc
 * build) is out of scope — as is linkage itself, which cannot be asserted
 * without a container runtime. It also cannot tell "we pinned the wrong digest"
 * from "upstream moved the tag"; both are reported, and both warrant a look.
 *
 * An unreachable registry is a FAILURE, never a pass.
 *
 * Usage: node scripts/verify-image-pins.mjs [--root <repo-root>]
 * Exits 1 on any finding, on an unrecognised argument, or if it can see no
 * sources to check.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The operator's NON-TEST Go sources, DISCOVERED rather than enumerated: a list
 * is how the second pinned image gets missed.
 *
 * `*_test.go` and the `test/` tree are excluded deliberately, and the exclusion
 * is about what the check MEANS rather than about noise: the question is
 * "does an image the operator RUNS on a cluster resolve to the tag it claims".
 * Specs are full of deliberately fake references (`registry.example.com/app:v1`,
 * `dev.local/file-manager@sha256:0000…`) that no registry serves and that
 * nothing ever pulls; resolving them would make the nightly permanently red for
 * reasons that are not findings. Nothing here weakens the real check — the
 * prewarm helper, and every future operator-run image, live in non-test source.
 */
export function discoverGoSources(repoRoot) {
  const root = resolve(repoRoot, 'packages/kn-next-operator');
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'vendor' ||
        entry.name === 'testdata' ||
        entry.name === 'test' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        found.push(relative(repoRoot, child));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The BENCHMARK sources that carry an image this repo RUNS on a cluster.
 *
 * Scope is not an implementation detail here, it is the check. The original walk
 * covered only the operator's Go sources — which excluded the two most
 * privileged pins in the tree: `nodesh.sh`'s image (a PRIVILEGED, hostPID pod
 * that `nsenter`s the host) and `build-unique-image.job.yaml`'s kaniko builder
 * (which holds the registry PUSH credential). The finding this whole check
 * exists to carry is that the artifact behind a tag is mutable and load-bearing;
 * a scope that skips those two does not carry it.
 *
 * Discovered by extension, not enumerated, for the same reason as the Go walk.
 */
export function discoverBenchmarkSources(repoRoot) {
  const root = resolve(repoRoot, 'benchmarks');
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'results' || entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(ya?ml|sh)$/.test(entry.name)) found.push(relative(repoRoot, child));
    }
  };
  walk(root);
  return found.sort();
}

/** Every source whose pins this check owns. */
export function discoverSources(repoRoot) {
  return [...discoverGoSources(repoRoot), ...discoverBenchmarkSources(repoRoot)];
}

/** The reference grammar, shared by the quoted (Go) and bare (YAML/shell) forms. */
const REF =
  '(?:[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\\d+)?\\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)' +
  '(?:\\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\\w][\\w.-]*)?@sha256:[0-9a-f]{64}';

/**
 * Every image reference in a source file.
 *
 * Both shapes are captured: `repo:tag@sha256:…` (checkable) and `repo@sha256:…`
 * (a finding — see the header). A bare `repo:tag` with no digest is NOT this
 * script's business: `TestPrewarmHelperImage_DigestPinned` and the operator's
 * own `:latest` rejection already make an undigested pin fail at PR time.
 *
 * Go pins live inside a string literal; YAML and shell pins do not (`image:
 * alpine:3.20@sha256:…`, `${NODESH_IMAGE:-alpine:3.20@sha256:…}`), so the bare
 * form is matched too. The left boundary excludes the characters that would make
 * the match a SUFFIX of a longer reference — but deliberately allows `-`, `{`
 * and `:` -adjacent shell expansion, which is how the shell default above is
 * written.
 */
const IMAGE_LITERAL = new RegExp(`(?<![\\w@./])(${REF})`, 'g');

/** Split `[registry/]repo[:tag]@digest` into its parts, Docker-Hub defaults applied. */
export function parseImageRef(ref) {
  const [nameAndTag, digest] = ref.split('@');
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
  // Docker Hub official images live under `library/`.
  if (registry === 'registry-1.docker.io' && !path.includes('/')) path = `library/${path}`;
  if (registry === 'docker.io') registry = 'registry-1.docker.io';

  return { registry, repository: path, tag, digest: `sha256:${digest.split('sha256:')[1]}`, ref };
}

export function parseImagePins(text, file) {
  const pins = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(IMAGE_LITERAL)) {
      pins.push({ file, line: index + 1, ...parseImageRef(match[1]) });
    }
  }
  return pins;
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

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Resolve `<registry>/<repository>:<tag>` to the digest the registry serves.
 *
 * The OCI distribution flow: an anonymous GET gets a 401 carrying a
 * `WWW-Authenticate: Bearer realm=…,service=…,scope=…` challenge; fetch a token
 * from that realm and retry. Implemented from the challenge rather than
 * hardcoding Docker Hub, so a gcr.io/ghcr.io pin added tomorrow resolves too.
 */
export async function resolveTagDigest({ registry, repository, tag }, { http = defaultHttp } = {}) {
  const url = `https://${registry}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;
  const base = { accept: MANIFEST_ACCEPT, 'user-agent': 'knext-verify-image-pins' };

  let response = await http(url, base);
  if (response.status === 401) {
    const challenge = response.headers?.['www-authenticate'] ?? '';
    const field = (name) => challenge.match(new RegExp(`${name}="([^"]+)"`))?.[1];
    const realm = field('realm');
    if (realm) {
      const params = new URLSearchParams();
      if (field('service')) params.set('service', field('service'));
      params.set('scope', field('scope') ?? `repository:${repository}:pull`);
      const auth = await http(`${realm}?${params}`, { accept: 'application/json' });
      const token = auth.status === 200 ? (await auth.json())?.token : undefined;
      if (token) response = await http(url, { ...base, authorization: `Bearer ${token}` });
    }
  }
  return { status: response.status, digest: response.headers?.['docker-content-digest'] };
}

/** Verify one parsed pin. Returns a finding, or undefined when it checks out. */
export async function verifyImagePin(pin, { api = resolveTagDigest } = {}) {
  if (!pin.tag) {
    return {
      ...pin,
      reason: 'no-tag',
      detail:
        'digest-only reference: nothing states which upstream tag this digest is meant to be, ' +
        'so nothing can verify it. Write it as `repo:<tag>@sha256:<digest>`.',
    };
  }
  let resolved;
  try {
    resolved = await api(pin);
  } catch (error) {
    // A transport that THROWS (DNS, TLS, offline runner) must read like every
    // other failure, and must never be a pass.
    return {
      ...pin,
      reason: 'api-error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (resolved.status === 404) return { ...pin, reason: 'tag-missing' };
  if (resolved.status !== 200 || !resolved.digest) {
    return {
      ...pin,
      reason: 'api-error',
      status: resolved.status,
      message: resolved.digest ? undefined : 'registry returned no Docker-Content-Digest',
    };
  }
  if (resolved.digest !== pin.digest) {
    return { ...pin, reason: 'digest-mismatch', actualDigest: resolved.digest };
  }
  return undefined;
}

export async function verifyRepo(repoRoot, { api = resolveTagDigest } = {}) {
  const files = discoverSources(repoRoot);
  if (files.length === 0) {
    return {
      files,
      pins: [],
      findings: [
        { reason: 'no-sources', detail: `no operator or benchmark sources under ${repoRoot}` },
      ],
    };
  }
  const pins = files.flatMap((file) =>
    parseImagePins(readFileSync(resolve(repoRoot, file), 'utf8'), file),
  );
  const findings = [];
  for (const pin of pins) {
    const finding = await verifyImagePin(pin, { api });
    if (finding) findings.push(finding);
  }
  return { files, pins, findings };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  let root = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else {
      console.error(`unrecognised argument: ${args[i]}`);
      process.exit(1);
    }
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`not a directory: ${root}`);
    process.exit(1);
  }

  const { files, pins, findings } = await verifyRepo(root);
  console.log(
    `scanned ${files.length} operator + benchmark source file(s), ${pins.length} digest-pinned image(s)`,
  );
  for (const pin of pins) {
    console.log(`  ${pin.file}:${pin.line}  ${pin.ref}`);
  }
  if (findings.length === 0) {
    console.log('OK: every pinned image digest is the one its tag resolves to upstream.');
    process.exit(0);
  }
  console.error(`\n${findings.length} finding(s):`);
  for (const f of findings) {
    console.error(
      `  [${f.reason}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.ref ?? ''}` +
        `${f.actualDigest ? `\n      pinned:   ${f.digest}\n      resolves: ${f.actualDigest}` : ''}` +
        `${f.detail ? `\n      ${f.detail}` : ''}` +
        `${f.message ? `\n      ${f.message}` : ''}` +
        `${f.status ? `\n      HTTP ${f.status}` : ''}`,
    );
  }
  process.exit(1);
}
/* c8 ignore stop */
