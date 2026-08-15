/**
 * Offline coverage for `scripts/verify-anonymous-install.mjs` — the check that
 * walks the DOCUMENTED install path as a STRANGER (#586).
 *
 * WHY IT EXISTS. #586 was found by running our own documented procedure on a
 * clean cluster: the bundle applied, and every pod sat in `ImagePullBackOff`
 * because `ghcr.io/getknext-dev/kn-next-operator` is a PRIVATE GHCR package.
 * Re-measured while writing this: an anonymous token request for
 * `repository:getknext-dev/kn-next-operator:pull` still returns **401**.
 *
 * Every existing gate stayed green, and the reasons are structural rather than
 * accidental:
 *   - `operator-bundle-e2e.yml` builds the image LOCALLY, loads it into kind and
 *     applies `dist/install.yaml` with the manager image OVERRIDDEN to that local
 *     image. The override is precisely what hides the published image;
 *   - `internal/install/*_test.go` asserts the bundle is digest-pinned and never
 *     `:latest`. A private image is a perfectly valid digest pin;
 *   - `verify-image-pins.mjs` resolves tag↔digest correspondence, which a private
 *     image can satisfy as well as a public one — and its scope is the operator's
 *     own sources, not the PUBLISHED bundle.
 * Nothing fetched the URL the docs tell users to fetch, from a context that was
 * not already authenticated.
 *
 * WHAT THESE TESTS COVER — both halves, because this repo's most common defect is
 * a guard that proves the sanctioned site HAS the thing without proving nothing
 * unsanctioned does:
 *   1. the URL is RESOLVED FROM THE DOCS, never a second hardcoded copy that can
 *      drift, and resolution FAILS CLOSED on zero or on ambiguity;
 *   2. the bundle is parsed structurally and EVERY container image in EVERY
 *      workload document is verified — not just the one we went looking for;
 *   3. the anonymous pull is the OCI token dance with NO credential, and an
 *      unreachable registry is a FAILURE, never a pass (the ruling this repo
 *      already made for `scripts/verify-action-pins.mjs`);
 *   4. credential absence is ASSERTED, not assumed — over the environment, the
 *      on-disk auth stores, AND the headers actually put on the wire;
 *   5. the workflow that runs it cannot be handed a credential, expressed as an
 *      ALLOWLIST that fails closed rather than as one literal spelling.
 *
 * Everything here runs against an INJECTED transport, so the suite stays offline
 * and deterministic. The live resolution happens in the nightly, at run time.
 */
import { type PathLike, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  ALLOWED_REQUEST_HEADERS,
  auditAnonymousWorkflowJob,
  CREDENTIAL_FILE_ENV_VARS,
  createRecordingHttp,
  discoverDocSources,
  discoverInstallUrl,
  extractContainerImages,
  fetchInstallBundle,
  findAllInstallUrls,
  findEnvCredentialLeaks,
  findFileCredentialLeaks,
  findRequestCredentialLeaks,
  findUrlDriftFindings,
  parseImageRef,
  runAnonymousInstallCheck,
  splitYamlDocuments,
  verifyAnonymousPull,
  verifyBundle,
} from '../scripts/verify-anonymous-install.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/anonymous-install-nightly.yml');
const DIGEST = `sha256:${'b'.repeat(64)}`;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// ── 1. the URL comes from the docs, and resolution fails closed ──────────────

describe('discoverInstallUrl — resolved from the docs, never a second copy', () => {
  it('finds exactly one install URL in the real docs source', () => {
    const found = discoverInstallUrl(REPO_ROOT);
    expect(found.url).toMatch(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/(download\/[^/]+|latest\/download)\/install\.yaml$/,
    );
    // The file it read must be the USER-FACING docs site, not an internal doc:
    // a stranger follows what is published, and that is what must be walked.
    expect(found.file).toBe('apps/docs/content/docs/install.mdx');
  });

  it('the URL it resolves is the one the docs command actually tells users to run', () => {
    const found = discoverInstallUrl(REPO_ROOT);
    const docs = read(resolve(REPO_ROOT, found.file));
    // Not just "the string is somewhere in the file" — it must be on a line that
    // is an executable `kubectl apply`, which is what a reader copies.
    const applyLines = docs
      .split('\n')
      .filter((line) => line.includes('kubectl apply') && line.includes(found.url));
    expect(applyLines.length).toBeGreaterThan(0);
  });

  it('fails closed when the docs carry NO install URL', () => {
    expect(() => discoverInstallUrl(REPO_ROOT, { text: '# nothing here\n' })).toThrow(
      /no install\.yaml URL/i,
    );
  });

  it('fails closed when the docs carry TWO DIFFERENT install URLs', () => {
    // Ambiguity must be refused rather than resolved by picking the first: an
    // arbitrary pick is how the check silently stops walking the documented path.
    const text = [
      'kubectl apply -f https://github.com/o/r/releases/download/a/install.yaml',
      'kubectl apply -f https://github.com/o/r/releases/download/b/install.yaml',
    ].join('\n');
    expect(() => discoverInstallUrl(REPO_ROOT, { text })).toThrow(/ambiguous|2 distinct/i);
  });

  it('accepts the same URL repeated — repetition is not ambiguity', () => {
    const url = 'https://github.com/o/r/releases/download/operator-latest/install.yaml';
    expect(discoverInstallUrl(REPO_ROOT, { text: `${url}\nand again ${url}\n` }).url).toBe(url);
  });

  it('does not match PROSE that merely names the path without a scheme', () => {
    // install.mdx contains the sentence "The `latest/download/install.yaml` URL
    // resolves only once a release has been cut" — a caveat, not a command.
    // Matching it would make the check fetch a URL nobody published.
    expect(() =>
      discoverInstallUrl(REPO_ROOT, {
        text: 'The `latest/download/install.yaml` URL resolves only once a release has been cut.',
      }),
    ).toThrow(/no install\.yaml URL/i);
  });
});

describe('findAllInstallUrls — no OTHER published copy may point elsewhere', () => {
  it('every published copy in the real tree agrees with the canonical URL', () => {
    // The other half. Proving the docs SITE carries a working URL says nothing
    // about `docs/QUICKSTART.md` or the operator README, and a reader who lands
    // on one of those follows THAT copy. The URL is currently repeated ten times
    // across seven files; if one moves and the rest do not, this reddens.
    const canonical = discoverInstallUrl(REPO_ROOT).url;
    const hits = findAllInstallUrls(REPO_ROOT);
    expect(
      findUrlDriftFindings(canonical, hits),
      hits.map((h) => `${h.file}:${h.line} ${h.url}`).join('\n'),
    ).toEqual([]);
  });

  it('is NOT vacuous — it really finds the copies outside the docs site', () => {
    // A walk that silently matched nothing would make the assertion above pass
    // for the wrong reason, which is the failure mode this repo has shipped.
    const hits = findAllInstallUrls(REPO_ROOT);
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.some((h) => !h.file.startsWith('apps/docs/'))).toBe(true);
  });

  it('flags a copy that points somewhere else', () => {
    const canonical = 'https://github.com/o/r/releases/download/operator-latest/install.yaml';
    const hits = [
      { url: canonical, file: 'apps/docs/content/docs/install.mdx', line: 111 },
      {
        url: 'https://github.com/o/r/releases/latest/download/install.yaml',
        file: 'docs/QUICKSTART.md',
        line: 64,
      },
    ];
    const findings = findUrlDriftFindings(canonical, hits);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('docs/QUICKSTART.md:64');
  });

  it('discoverDocSources skips node_modules and build output', () => {
    const sources = discoverDocSources(REPO_ROOT);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((f) => f.includes('node_modules'))).toBe(false);
    expect(sources.some((f) => f.includes('graphify-out'))).toBe(false);
    expect(sources).toContain('apps/docs/content/docs/install.mdx');
  });
});

// ── 2. the bundle is parsed structurally, and EVERY image is in scope ────────

describe('extractContainerImages — every workload image, not the one we sought', () => {
  const bundle = [
    'apiVersion: apiextensions.k8s.io/v1',
    'kind: CustomResourceDefinition',
    'spec:',
    '  versions:',
    '    - schema:',
    '        properties:',
    '          image:',
    '            description: The bundled Next.js image',
    '            type: string',
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    `      - image: ghcr.io/o/manager:v1@${DIGEST}`,
    `      - image: ghcr.io/o/sidecar:v2@${DIGEST}`,
    '',
  ].join('\n');

  it('ignores an `image:` PROPERTY inside a CRD schema', () => {
    // The published bundle really does carry one: a `NextApp` spec property named
    // `image`. A line-grep extractor reports it as a container image and the
    // check then tries to pull a type declaration.
    const images = extractContainerImages(bundle);
    expect(images.map((i) => i.image)).toEqual([
      `ghcr.io/o/manager:v1@${DIGEST}`,
      `ghcr.io/o/sidecar:v2@${DIGEST}`,
    ]);
  });

  it('returns EVERY image in the workload, not just the first', () => {
    // The half this repo keeps getting wrong: proving the manager image pulls
    // says nothing about a sidecar added next quarter. Scope is every image, so
    // a new one is covered without anyone remembering to extend a list.
    expect(extractContainerImages(bundle)).toHaveLength(2);
  });

  it('covers every workload kind, not only Deployment', () => {
    for (const kind of ['DaemonSet', 'StatefulSet', 'Job', 'CronJob', 'Pod', 'ReplicaSet']) {
      const doc = [
        'apiVersion: apps/v1',
        `kind: ${kind}`,
        'spec:',
        '  containers:',
        `  - image: ghcr.io/o/x:v1@${DIGEST}`,
      ].join('\n');
      expect(extractContainerImages(doc), kind).toHaveLength(1);
    }
  });

  it('extracts an image carrying a trailing YAML comment', () => {
    // Legal YAML, and emitted by kustomize/kubebuilder. The old `(\S+)\s*$`
    // anchor silently dropped it — with two images and a comment on one, the
    // commented image was never pulled and NOTHING reported the undercount.
    const doc = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/r:v1@${DIGEST} # pinned by release job`,
    ].join('\n');
    expect(extractContainerImages(doc).map((i) => i.image)).toEqual([`ghcr.io/o/r:v1@${DIGEST}`]);
  });

  it('does not truncate a reference containing a `#` with no preceding space', () => {
    // `a#b` is part of the scalar in YAML; only ` #` starts a comment. Stripping
    // on a bare `#` would corrupt the reference rather than drop it.
    const doc = ['kind: Pod', 'spec:', '  containers:', '  - image: reg.io/a#b:v1'].join('\n');
    expect(extractContainerImages(doc).map((i) => i.image)).toEqual(['reg.io/a#b:v1']);
  });

  it.each([
    ['a trailing comment', 'kind: Deployment # the manager'],
    ['a quoted value', 'kind: "Deployment"'],
    ['a single-quoted value', "kind: 'Deployment'"],
    ['a spaced colon', 'kind : Deployment'],
    ['a quoted key', '"kind": Deployment'],
  ])('recognises a workload document whose kind carries %s', (_label, kindLine) => {
    // The SAME anchor shape round 2 fixed in `imageOnLine`, one scope out.
    // `documentKind` returning undefined is worse than returning a wrong kind:
    // BOTH `extractContainerImages` and `findUnscannedKindImages` skip on
    // `!kind`, so the document is dropped by both — no scan, and no finding
    // either. Measured end to end, the operator image #586 is about was never
    // pulled and nothing said so.
    const doc = [
      'apiVersion: apps/v1',
      kindLine,
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/r:v1@${DIGEST}`,
    ].join('\n');
    expect(extractContainerImages(doc).map((i) => i.image)).toEqual([`ghcr.io/o/r:v1@${DIGEST}`]);
  });

  /**
   * A bundle whose SECOND document is malformed in some way, alongside a healthy
   * CRD and a healthy manager Deployment — the real published shape.
   *
   * The image under test is named SNEAKY and asserted on BY NAME. The previous
   * version of this test asked `images.length > 0 || findings.some(…)`, which the
   * healthy manager image satisfies on its own: the assertion passed no matter
   * what happened to the document actually being tested.
   */
  const bundleWithMalformedDoc = (head: string) =>
    [
      'apiVersion: apiextensions.k8s.io/v1',
      'kind: CustomResourceDefinition',
      'metadata:',
      '  name: x',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/manager:v1@${DIGEST}`,
      '---',
      head,
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/SNEAKY:v1@${DIGEST}`,
    ].join('\n');

  it.each([
    ['kind absent entirely', 'apiVersion: v1'],
    ['an empty kind value', 'apiVersion: v1\nkind:'],
    ['a kind that is only a comment', 'apiVersion: v1\nkind: # nothing here'],
    ['a kind indented off column 0', 'apiVersion: v1\n kind: Deployment'],
    ['a kind whose value is a block sequence', 'apiVersion: v1\nkind:\n  - Deployment'],
  ])('an image in a document with %s is REPORTED, never dropped by both scans', async (_label, head) => {
    // `documentKind` returns undefined for each of these, and BOTH scans used to
    // `continue` on `!kind` — so the document was neither pulled nor reported.
    // Zero findings, exit 0, and an image nobody can pull: #586's own shape.
    //
    // The five spellings are illustrative, not the guarantee. The guarantee is
    // that the two buckets are exhaustive by construction, so a spelling nobody
    // has thought of still lands in one of them.
    const { images, findings } = await verifyBundle(bundleWithMalformedDoc(head), {
      api: async () => ({ stage: 'manifest', status: 200, digest: DIGEST }),
    });
    const scanned = images.some((i) => i.image.includes('SNEAKY'));
    const reported = findings.some((f) => String(f.ref ?? '').includes('SNEAKY'));
    expect(scanned || reported, 'SNEAKY must be either scanned or reported — never neither').toBe(
      true,
    );
  });

  it('an UNRECOGNISED (but readable) kind is reported — the already-covered path', async () => {
    // Kept, but honestly titled. `kind: [Deployment]` READS fine as the string
    // "[Deployment]"; it exercises the unrecognised path, not the unreadable one.
    // Conflating the two is what let the unreadable path go untested while a test
    // named for it passed.
    const { findings } = await verifyBundle(bundleWithMalformedDoc('kind: [Deployment]'), {
      api: async () => ({ stage: 'manifest', status: 200, digest: DIGEST }),
    });
    expect(findings.map((f) => f.reason)).toContain('unscanned-kind-image');
  });

  it('strips a BOM so a BOM-prefixed document is scanned normally', async () => {
    // An internet-downloaded body may carry a BOM. Reporting it as unreadable
    // would be correct-but-useless; reading through it is better, and the
    // exhaustive partition still covers whatever a BOM cannot fix.
    const { images } = await verifyBundle(bundleWithMalformedDoc('\uFEFFkind: Deployment'), {
      api: async () => ({ stage: 'manifest', status: 200, digest: DIGEST }),
    });
    expect(images.some((i) => i.image.includes('SNEAKY'))).toBe(true);
  });

  it('recognises an image whose KEY is quoted', () => {
    const doc = ['kind: Pod', 'spec:', '  containers:', `  - "image": ghcr.io/o/r:v1`].join('\n');
    expect(extractContainerImages(doc).map((i) => i.image)).toEqual(['ghcr.io/o/r:v1']);
  });

  it('parses a CRLF bundle', () => {
    const doc = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/r:v1@${DIGEST}`,
    ].join('\r\n');
    expect(extractContainerImages(doc).map((i) => i.image)).toEqual([`ghcr.io/o/r:v1@${DIGEST}`]);
  });

  it('parses the REAL published bundle shape', () => {
    // A fixture that drifts from reality proves nothing, so the shape asserted
    // here is the one `operator-latest/install.yaml` actually ships: many docs,
    // a CRD carrying an `image` property, one manager Deployment.
    const docs = splitYamlDocuments(bundle);
    expect(docs.length).toBeGreaterThan(1);
    expect(docs.map((d) => parse(d)?.kind)).toContain('CustomResourceDefinition');
    expect(docs.map((d) => parse(d)?.kind)).toContain('Deployment');
  });
});

describe('verifyBundle — a bundle that is not an install bundle is a finding', () => {
  it('reports a bundle with no workload image at all', async () => {
    const { findings } = await verifyBundle('kind: ConfigMap\n', { api: async () => ({}) });
    expect(findings.map((f) => f.reason)).toContain('no-images');
  });

  it('reports a body that is not the install bundle (an HTML 404 page)', async () => {
    const { findings } = await verifyBundle('<!DOCTYPE html><title>Not Found</title>', {
      api: async () => ({}),
    });
    expect(findings.map((f) => f.reason)).toContain('not-a-bundle');
  });

  it('reports an image in a kind the extractor does NOT scan, rather than skipping it', async () => {
    // `WORKLOAD_KINDS` is an enumeration, so it will always be behind reality —
    // a Knative `Service` is the obvious near-term gap. The trade is acceptable
    // only if an unrecognised kind carrying an image is a FINDING; a silent skip
    // is the same family of undercount as the trailing-comment bug.
    const body = [
      'apiVersion: apiextensions.k8s.io/v1',
      'kind: CustomResourceDefinition',
      'metadata:',
      '  name: x',
      '---',
      'apiVersion: serving.knative.dev/v1',
      'kind: Service',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/r:v1@${DIGEST}`,
    ].join('\n');
    const { findings } = await verifyBundle(body, { api: async () => ({}) });
    expect(findings.map((f) => f.reason)).toContain('unscanned-kind-image');
  });

  it('does not report the CRD schema `image:` property as an unscanned kind', async () => {
    // The false positive that would make the rule above unusable: the real
    // bundle's CRD declares a PROPERTY named `image` with no value.
    const body = [
      'apiVersion: apiextensions.k8s.io/v1',
      'kind: CustomResourceDefinition',
      'spec:',
      '  properties:',
      '    image:',
      '      description: The bundled Next.js image',
      '      type: string',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/r:v1@${DIGEST}`,
    ].join('\n');
    const { findings } = await verifyBundle(body, {
      api: async () => ({ stage: 'manifest', status: 200, digest: DIGEST }),
    });
    expect(findings).toEqual([]);
  });

  it('VERIFIES every image, not just the first — a bad second image is reported', async () => {
    // `extractContainerImages` returning both images is not the same claim as
    // `verifyBundle` pulling both. The mutation prover found the gap: slicing
    // the consumer to one image left the whole spec green, so the second image
    // could have gone unpulled with nothing to say so.
    const body = [
      'apiVersion: apiextensions.k8s.io/v1',
      'kind: CustomResourceDefinition',
      'metadata:',
      '  name: x',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/first:v1@${DIGEST}`,
      `  - image: ghcr.io/o/second:v1@${DIGEST}`,
    ].join('\n');
    const { images, findings } = await verifyBundle(body, {
      api: async ({ repository }: { repository: string }) =>
        repository.endsWith('second')
          ? { stage: 'token', status: 401 }
          : { stage: 'manifest', status: 200, digest: DIGEST },
    });
    expect(images).toHaveLength(2);
    expect(findings.map((f) => f.reason)).toEqual(['anonymous-token-denied']);
    expect(findings[0].repository).toBe('o/second');
  });

  it('reports a bundle missing the CRD it is supposed to install', async () => {
    const body = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/x:v1@${DIGEST}`,
    ].join('\n');
    const { findings } = await verifyBundle(body, {
      api: async () => ({ status: 200, digest: DIGEST }),
    });
    expect(findings.map((f) => f.reason)).toContain('no-crd');
  });
});

// ── 2b. the DOWNLOAD half — the door F1 found open ───────────────────────────

describe('fetchInstallBundle — a 200 is not automatically a success', () => {
  const ok =
    (body: string, status = 200) =>
    async () => ({
      status,
      text: async () => body,
    });

  it('returns the body and no finding for a real 200', async () => {
    const result = await fetchInstallBundle('https://x/install.yaml', {
      fetchImpl: ok('kind: Deployment\n'),
    });
    expect(result.findings).toEqual([]);
    expect(result.body).toBe('kind: Deployment\n');
  });

  it('a ZERO-LENGTH 200 is a finding, not a success', async () => {
    // The #586 shape exactly: a release job that uploads a 0-byte
    // `dist/install.yaml`, or a CDN empty-200. It downloads "fine" and installs
    // nothing.
    const result = await fetchInstallBundle('https://x/install.yaml', {
      fetchImpl: ok(''),
    });
    expect(result.findings.map((f) => f.reason)).toContain('empty-bundle');
  });

  it('reports a non-200', async () => {
    const result = await fetchInstallBundle('https://x/install.yaml', {
      fetchImpl: ok('Not Found', 404),
    });
    expect(result.findings.map((f) => f.reason)).toContain('install-url-not-200');
  });

  it('a thrown fetch is a finding and yields a NULL body, never an empty string', async () => {
    // `null` vs `''` is the whole bug: with `''` as the sentinel for "threw",
    // a zero-length 200 became indistinguishable from unreachable — and the
    // caller skipped bundle verification for both.
    const result = await fetchInstallBundle('https://x/install.yaml', {
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND github.com');
      },
    });
    expect(result.findings.map((f) => f.reason)).toContain('install-url-unreachable');
    expect(result.body).toBeNull();
  });

  // `fetch` rejects with `TypeError: fetch failed` and puts the actual reason in
  // `cause`. Reporting only `message` is why this nightly emitted the literal string
  // "fetch failed" for five consecutive red runs on `main` while the documented URL
  // returned 200 from a developer machine: the gate was correct and undiagnosable, and
  // an undiagnosable red gate is one that gets ignored rather than fixed.
  it('surfaces the cause chain, not just "fetch failed"', async () => {
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND objects.githubusercontent.com'), {
      code: 'ENOTFOUND',
    });
    const result = await fetchInstallBundle('https://x/install.yaml', {
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: inner });
      },
    });
    const finding = result.findings.find((f) => f.reason === 'install-url-unreachable') as
      | { message?: string }
      | undefined;
    expect(finding?.message).toContain('fetch failed');
    expect(finding?.message).toContain('ENOTFOUND');
    expect(finding?.message).toContain('objects.githubusercontent.com');
  });

  it('walks a nested cause chain to the root', async () => {
    const root = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    const mid = Object.assign(new Error('socket error'), { cause: root });
    const result = await fetchInstallBundle('https://x/install.yaml', {
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: mid });
      },
    });
    const finding = result.findings.find((f) => f.reason === 'install-url-unreachable') as
      | { message?: string }
      | undefined;
    expect(finding?.message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  // A self-referential cause is not hypothetical — wrapper libraries produce them —
  // and a check that hangs is a check that gets deleted.
  it('terminates on a self-referential cause', async () => {
    const loop: Error & { cause?: unknown } = new Error('loop');
    loop.cause = loop;
    const result = await fetchInstallBundle('https://x/install.yaml', {
      fetchImpl: async () => {
        throw loop;
      },
    });
    expect(result.findings.map((f) => f.reason)).toContain('install-url-unreachable');
  });
});

describe('runAnonymousInstallCheck — the download half is actually verified', () => {
  const clean = { env: {}, home: '/nowhere', exists: () => false };

  it('a zero-length 200 ALSO runs bundle verification — no vacuous green', async () => {
    // The regression guard for F1. `empty-bundle` alone would still pass under
    // the old `if (body !== '')` sentinel, because that finding comes from the
    // fetch half. `not-a-bundle` can ONLY appear if `verifyBundle` ran, so
    // asserting both is what makes the skipped-verification bug visible.
    const { findings } = await runAnonymousInstallCheck(REPO_ROOT, {
      ...clean,
      fetchImpl: async () => ({ status: 200, text: async () => '' }),
      http: async () => {
        throw new Error('the registry must not be reached — there are no images');
      },
    });
    const reasons = findings.map((f) => f.reason);
    expect(reasons).toContain('empty-bundle');
    expect(reasons).toContain('not-a-bundle');
  });

  it('an all-whitespace 200 is caught the same way', async () => {
    const { findings } = await runAnonymousInstallCheck(REPO_ROOT, {
      ...clean,
      fetchImpl: async () => ({ status: 200, text: async () => '   \n\n  \n' }),
      http: async () => {
        throw new Error('unreachable');
      },
    });
    expect(findings.map((f) => f.reason)).toContain('not-a-bundle');
  });

  it('an unreachable fetch reports exactly one download finding and no bundle noise', async () => {
    const { findings } = await runAnonymousInstallCheck(REPO_ROOT, {
      ...clean,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
      http: async () => {
        throw new Error('unreachable');
      },
    });
    const reasons = findings.map((f) => f.reason);
    expect(reasons).toContain('install-url-unreachable');
    // A null body means there is nothing to say about the bundle; inventing a
    // `not-a-bundle` on top would be a second finding for one cause.
    expect(reasons).not.toContain('not-a-bundle');
  });

  it('a healthy bundle with a pullable image yields no findings at all', async () => {
    const body = [
      'apiVersion: apiextensions.k8s.io/v1',
      'kind: CustomResourceDefinition',
      'metadata:',
      '  name: nextapps.apps.kn-next.dev',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  containers:',
      `  - image: ghcr.io/o/r:v1@${DIGEST}`,
    ].join('\n');
    const { findings } = await runAnonymousInstallCheck(REPO_ROOT, {
      ...clean,
      fetchImpl: async () => ({ status: 200, text: async () => body }),
      api: async () => ({ stage: 'manifest', status: 200, digest: DIGEST }),
    });
    expect(findings, JSON.stringify(findings)).toEqual([]);
  });
});

// ── 3. the anonymous pull, against an injected transport ─────────────────────

describe('parseImageRef', () => {
  it('splits registry, repository, tag and digest', () => {
    expect(parseImageRef(`ghcr.io/getknext-dev/kn-next-operator:v0.1.0@${DIGEST}`)).toMatchObject({
      registry: 'ghcr.io',
      repository: 'getknext-dev/kn-next-operator',
      tag: 'v0.1.0',
      digest: DIGEST,
    });
  });

  it('defaults a bare name to Docker Hub library/', () => {
    expect(parseImageRef('busybox:1.36')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'library/busybox',
      tag: '1.36',
    });
  });
});

describe('verifyAnonymousPull', () => {
  const ref = parseImageRef(`ghcr.io/getknext-dev/kn-next-operator:v0.1.0@${DIGEST}`);

  /** A GHCR double: the real three-step OCI flow, keyed by URL. */
  const ghcr = ({
    tokenStatus = 200,
    manifestStatus = 200,
    digest = DIGEST,
  }: {
    tokenStatus?: number;
    manifestStatus?: number;
    digest?: string;
  }) => {
    return async (url: string, headers: Record<string, string>) => {
      if (url.includes('/token')) {
        return tokenStatus === 200
          ? { status: 200, headers: {}, json: async () => ({ token: 'anon-token' }) }
          : { status: tokenStatus, headers: {}, json: async () => ({}) };
      }
      if (!headers.authorization) {
        return {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",' +
              'scope="repository:getknext-dev/kn-next-operator:pull"',
          },
          json: async () => ({}),
        };
      }
      return {
        status: manifestStatus,
        headers: manifestStatus === 200 ? { 'docker-content-digest': digest } : {},
        json: async () => ({}),
      };
    };
  };

  it('passes when the anonymous token flow yields the pinned manifest', async () => {
    expect(await verifyAnonymousPull(ref, { http: ghcr({}) })).toBeUndefined();
  });

  it('FAILS when the anonymous token endpoint returns 401 — the #586 defect', async () => {
    // This is the exact live shape, re-measured: GET
    // ghcr.io/token?scope=repository:getknext-dev/kn-next-operator:pull -> 401.
    const finding = await verifyAnonymousPull(ref, { http: ghcr({ tokenStatus: 401 }) });
    expect(finding).toMatchObject({ reason: 'anonymous-token-denied', status: 401 });
  });

  it('FAILS when the token endpoint returns 403 — a package that is not there', async () => {
    // Measured: GHCR answers 403, not 404, for a package that does not exist. A
    // check that only knew about 401 would call this a pass.
    const finding = await verifyAnonymousPull(ref, { http: ghcr({ tokenStatus: 403 }) });
    expect(finding).toMatchObject({ reason: 'anonymous-token-denied', status: 403 });
  });

  it('FAILS when the manifest is denied even after a token was minted', async () => {
    const finding = await verifyAnonymousPull(ref, { http: ghcr({ manifestStatus: 403 }) });
    expect(finding).toMatchObject({ reason: 'manifest-denied' });
  });

  it('FAILS when the served digest is not the digest the bundle pins', async () => {
    const other = `sha256:${'c'.repeat(64)}`;
    const finding = await verifyAnonymousPull(ref, { http: ghcr({ digest: other }) });
    expect(finding).toMatchObject({ reason: 'digest-mismatch', actualDigest: other });
  });

  it('an UNREACHABLE registry is a FAILURE, never a silent pass', async () => {
    // The ruling this repo already made for verify-action-pins.mjs: a checker
    // that goes green when it cannot reach upstream is worse than none.
    const finding = await verifyAnonymousPull(ref, {
      http: async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      },
    });
    expect(finding).toMatchObject({ reason: 'api-error' });
    expect(finding?.message).toMatch(/ENOTFOUND/);
  });

  it('addresses the manifest BY DIGEST, the way a kubelet does', async () => {
    const seen: string[] = [];
    await verifyAnonymousPull(ref, {
      http: async (url: string, headers: Record<string, string>) => {
        seen.push(url);
        return ghcr({})(url, headers);
      },
    });
    expect(seen.some((u) => u.endsWith(`/manifests/${DIGEST}`))).toBe(true);
  });
});

// ── 4. credential absence is ASSERTED, over env, disk, and the wire ──────────

describe('findEnvCredentialLeaks — a pattern, not a list of three literals', () => {
  it.each([
    ['GITHUB_TOKEN'],
    ['GH_TOKEN'],
    ['CR_PAT'],
    ['NODE_AUTH_TOKEN'],
    ['NPM_TOKEN'],
    ['ACTIONS_RUNTIME_TOKEN'],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
    ['DOCKER_AUTH_CONFIG'],
    ['REGISTRY_PASSWORD'],
    ['GHCR_SECRET'],
  ])('flags %s', (name) => {
    expect(findEnvCredentialLeaks({ [name]: 'x' }).map((f) => f.name)).toContain(name);
  });

  it('flags a credential name NOBODY enumerated — the whole point', () => {
    // A guard written as three literal spellings passes the day someone adds a
    // fourth. The forbidden set is a shape, so an unforeseen name is caught.
    expect(findEnvCredentialLeaks({ SOME_FUTURE_REGISTRY_TOKEN: 'x' })).toHaveLength(1);
  });

  it('ignores an EMPTY value — an unset-but-declared var carries no credential', () => {
    expect(findEnvCredentialLeaks({ GITHUB_TOKEN: '' })).toEqual([]);
  });

  it('does not flag the benign GitHub Actions metadata a runner always sets', () => {
    // A permanently-red nightly trains people to ignore it, so the pattern must
    // not fire on the dozens of GITHUB_* vars that carry no secret.
    expect(
      findEnvCredentialLeaks({
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_SHA: 'abc',
        GITHUB_WORKSPACE: '/w',
        GITHUB_RUN_ID: '1',
        GITHUB_ACTOR: 'someone',
        RUNNER_OS: 'Linux',
        PATH: '/usr/bin',
        HOME: '/home/runner',
      }),
    ).toEqual([]);
  });

  it('never puts the VALUE of a credential in the finding', () => {
    // A gate that echoes the token it found is a secret-leak of its own.
    const [finding] = findEnvCredentialLeaks({ GITHUB_TOKEN: 'ghp_supersecretvalue' });
    expect(JSON.stringify(finding)).not.toContain('ghp_supersecretvalue');
  });
});

describe('findFileCredentialLeaks — the on-disk auth stores', () => {
  // Typed `PathLike`, not `string`: the real default is `existsSync`, so a
  // narrower double is not a substitute for it and the root typecheck gate says
  // so (TS2322 — `Buffer` is not assignable to `string`).
  const exists = (paths: string[]) => (p: PathLike) => paths.includes(String(p));

  it.each([
    ['/home/runner/.docker/config.json'],
    ['/home/runner/.config/gh/hosts.yml'],
    ['/home/runner/.config/containers/auth.json'],
    ['/home/runner/.netrc'],
  ])('flags %s', (path) => {
    const leaks = findFileCredentialLeaks({
      env: {},
      home: '/home/runner',
      exists: exists([path]),
    });
    expect(leaks.map((f) => f.path)).toContain(path);
  });

  it('follows the env vars that RELOCATE an auth store', () => {
    // Scrubbing `~/.docker/config.json` proves nothing if DOCKER_CONFIG points
    // somewhere else — checking the default path only is the half-guard.
    const leaks = findFileCredentialLeaks({
      env: { DOCKER_CONFIG: '/opt/auth' },
      home: '/home/runner',
      exists: exists(['/opt/auth/config.json']),
    });
    expect(leaks.map((f) => f.path)).toContain('/opt/auth/config.json');
  });

  it('names every relocating env var it honours', () => {
    expect(CREDENTIAL_FILE_ENV_VARS).toEqual(
      expect.arrayContaining(['DOCKER_CONFIG', 'REGISTRY_AUTH_FILE']),
    );
  });

  it('is clean when nothing exists', () => {
    expect(findFileCredentialLeaks({ env: {}, home: '/home/runner', exists: () => false })).toEqual(
      [],
    );
  });
});

describe('findRequestCredentialLeaks — an ALLOWLIST over what went on the wire', () => {
  it('accepts the anonymous flow: accept + user-agent, then a minted Bearer', () => {
    const requests = [
      { url: 'https://ghcr.io/v2/o/r/manifests/x', headers: { accept: 'a', 'user-agent': 'u' } },
      { url: 'https://ghcr.io/token?x', headers: { accept: 'application/json' }, minted: 'tok' },
      {
        url: 'https://ghcr.io/v2/o/r/manifests/x',
        headers: { accept: 'a', 'user-agent': 'u', authorization: 'Bearer tok' },
      },
    ];
    expect(findRequestCredentialLeaks(requests)).toEqual([]);
  });

  it('flags an Authorization header carrying a token this run did NOT mint', () => {
    const requests = [
      {
        url: 'https://ghcr.io/v2/o/r/manifests/x',
        headers: { accept: 'a', authorization: 'Bearer sneaked-in-from-the-environment' },
      },
    ];
    expect(findRequestCredentialLeaks(requests).map((f) => f.reason)).toContain('unminted-bearer');
  });

  it('flags Basic auth even though it is not spelled "Bearer"', () => {
    const requests = [
      {
        url: 'https://ghcr.io/v2/o/r/manifests/x',
        headers: { authorization: 'Basic dXNlcjpwdw==' },
      },
    ];
    expect(findRequestCredentialLeaks(requests).map((f) => f.reason)).toContain('unminted-bearer');
  });

  it('flags ANY header outside the allowlist, including one nobody thought of', () => {
    // Fail-closed: the forbidden set is "everything not explicitly permitted",
    // so a future `x-registry-auth` or a cookie is a finding on the day it lands
    // rather than on the day someone adds it to a denylist.
    for (const header of ['cookie', 'x-registry-auth', 'proxy-authorization']) {
      const requests = [{ url: 'https://ghcr.io/v2/x', headers: { [header]: 'v' } }];
      expect(
        findRequestCredentialLeaks(requests).map((f) => f.reason),
        header,
      ).toContain('unexpected-header');
    }
  });

  it('the allowlist is small and states exactly what may go on the wire', () => {
    expect([...ALLOWED_REQUEST_HEADERS].sort()).toEqual(['accept', 'authorization', 'user-agent']);
  });

  it('never puts the credential VALUE in the finding', () => {
    const requests = [{ url: 'https://ghcr.io/v2/x', headers: { authorization: 'Bearer leakme' } }];
    expect(JSON.stringify(findRequestCredentialLeaks(requests))).not.toContain('leakme');
  });
});

describe('createRecordingHttp — the wire assertion has something to assert on', () => {
  it('records every request the verifier makes, with its headers', async () => {
    const { http, requests } = createRecordingHttp(async () => ({
      status: 200,
      headers: {},
      json: async () => ({}),
    }));
    await http('https://ghcr.io/v2/', { accept: 'a' });
    expect(requests).toEqual([{ url: 'https://ghcr.io/v2/', headers: { accept: 'a' } }]);
  });
});

// ── 5. the workflow cannot be handed a credential (allowlist, fails closed) ──

describe('anonymous-install-nightly.yml — the runner must have no credential', () => {
  const workflow = () => parse(read(WORKFLOW));

  it('exists', () => {
    expect(() => read(WORKFLOW)).not.toThrow();
  });

  it('runs on a schedule and is dispatchable', () => {
    const on = workflow().on;
    expect(on.schedule?.[0]?.cron).toBeTruthy();
    expect(on).toHaveProperty('workflow_dispatch');
  });

  it('the check job declares NO write permission', () => {
    const audit = auditAnonymousWorkflowJob(read(WORKFLOW));
    expect(audit.findings.filter((f) => f.includes('permission'))).toEqual([]);
  });

  it('the real workflow passes the full audit', () => {
    const audit = auditAnonymousWorkflowJob(read(WORKFLOW));
    expect(audit.findings, audit.findings.join(' | ')).toEqual([]);
  });

  it('the audit is NOT vacuous — it names the job it audited', () => {
    // A workflow-shape guard that silently matched no job is the failure mode
    // this repo has hit before; the job id it resolved is part of the verdict.
    expect(auditAnonymousWorkflowJob(read(WORKFLOW)).jobId).toBeTruthy();
  });

  it('flags a `secrets.` reference anywhere in the job', () => {
    const mutated = read(WORKFLOW).replace(
      'run: node scripts/verify-anonymous-install.mjs',
      'run: node scripts/verify-anonymous-install.mjs\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    );
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/secret/i);
  });

  it('flags `github.token` even though it is not spelled "secrets."', () => {
    // The `if: true` vs `always()` lesson: one literal spelling is not the
    // forbidden form. `${{ github.token }}` is the canonical second spelling.
    const mutated = read(WORKFLOW).replace(
      'run: node scripts/verify-anonymous-install.mjs',
      'run: node scripts/verify-anonymous-install.mjs\n        env:\n          GH_TOKEN: ${{ github.token }}',
    );
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/token/i);
  });

  it('flags a granted permission on the JOB', () => {
    // Anchored on the JOB's four-space-indented key, not the workflow-level one:
    // a job `permissions:` overrides the top-level block entirely, so the job's
    // is the only one that decides what this runner holds.
    const mutated = read(WORKFLOW).replace(
      '    permissions: {}',
      '    permissions:\n      packages: read',
    );
    expect(mutated, 'the mutation must actually change the file').not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/permission/i);
  });

  it('flags a job that declares NO permissions at all — fail closed', () => {
    // The dangerous case, and the one an "is `permissions: {}` present?" check
    // gets backwards: with the key absent the workflow-level block applies, and
    // a later edit granting something there would silently reach this job.
    const mutated = read(WORKFLOW).replace('    permissions: {}\n', '');
    expect(mutated).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/permission/i);
  });

  it('flags a registry login step nobody put on a denylist', () => {
    const mutated = read(WORKFLOW).replace(
      '      - name: Checkout code',
      '      - name: Log in\n        uses: docker/login-action@v3\n      - name: Checkout code',
    );
    // Caught as "an action outside the allowlist", not as "docker/login-action".
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(
      /allowlist|not permitted/i,
    );
  });

  // ── F2: a credential does not have to be inside the job block ──────────────

  it('flags a workflow-level `env:` carrying a secret, BEFORE `jobs:`', () => {
    // The audit used to start at `jobs:`, so everything above it was invisible.
    // A workflow-level `env:` is inherited by every job — it is the most likely
    // place an inherited credential actually comes from.
    const mutated = read(WORKFLOW).replace(
      'permissions: {}\n',
      'permissions: {}\nenv:\n  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n',
    );
    expect(mutated).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/env|secret/i);
  });

  it('flags a workflow-level `env:` placed AFTER the `jobs:` block', () => {
    // YAML mappings are unordered, so "before `jobs:`" is not where a preamble
    // scan can stop. Trailing top-level keys are equally in scope.
    const mutated = `${read(WORKFLOW)}\nenv:\n  GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`;
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/env|secret/i);
  });

  it('flags a workflow-level `defaults:` block', () => {
    const mutated = read(WORKFLOW).replace(
      'permissions: {}\n',
      'permissions: {}\ndefaults:\n  run:\n    shell: bash -e {0}\n',
    );
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/defaults/i);
  });

  it('flags a job-level `container:` (its `credentials:` are a registry login)', () => {
    const mutated = read(WORKFLOW).replace(
      '    permissions: {}',
      '    permissions: {}\n    container:\n      image: ghcr.io/o/r:v1\n      credentials:\n        username: x\n        password: y',
    );
    expect(mutated).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/container/i);
  });

  it('does NOT flag the alert job, which legitimately holds a token', () => {
    // Scope discipline: the alert job performs no fetch and needs `issues: write`
    // plus `${{ github.token }}`. If auditing "outside the job" swept it in, the
    // guard would be permanently red and would get deleted.
    expect(auditAnonymousWorkflowJob(read(WORKFLOW)).findings).toEqual([]);
  });

  // ── F3: the checkout credential ────────────────────────────────────────────

  it('requires `persist-credentials: false` on checkout', () => {
    // The default writes `AUTHORIZATION: basic <token>` into the workspace
    // `.git/config`, keyed on the github.com PREFIX — so every github.com request
    // made from the workspace carries the runner's token. Invisible to
    // findFileCredentialLeaks (it is not one of the auth stores) and to the
    // expression allowlist (nothing is interpolated).
    const mutated = read(WORKFLOW).replace('          persist-credentials: false\n', '');
    expect(mutated).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it.each([
    ['token'],
    ['ssh-key'],
    ['fetch-depth'],
    ['submodules'],
  ])('flags the `with:` input %s, which no denylist enumerated', (key) => {
    // `token` alone is NOT a sufficient assertion — the prover proved it:
    // rewriting the allowlist as `if (key === 'token')` kept the spec green.
    // The forbidden set has to be "everything not permitted", so the keys that
    // demonstrate it are the ones nobody would have thought to ban.
    const mutated = read(WORKFLOW).replace(
      '          persist-credentials: false',
      `          persist-credentials: false\n          ${key}: x`,
    );
    expect(mutated).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/with|allowlist/i);
  });

  it('flags `persist-credentials: true` as loudly as its absence', () => {
    // Anchored on the 10-space `with:` input, NOT the bare string: the workflow's
    // own comment quotes `persist-credentials: false` verbatim, and an unanchored
    // replace rewrites the COMMENT while leaving the real input untouched — a
    // mutation that proves nothing.
    const mutated = read(WORKFLOW).replace(
      '          persist-credentials: false',
      '          persist-credentials: true',
    );
    expect(mutated).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it('reads a `with:` value that carries a trailing comment', () => {
    // The case that keeps comment-blanking load-bearing after the per-step
    // rewrite. Raw, the value reads as `false # keep it off` — not `false` — so
    // the guard would fire on a workflow that is entirely correct. A guard that
    // cries wolf on valid input gets deleted, which is the same end state as one
    // that never fires.
    const steps = [
      '      - uses: actions/checkout@abc',
      '        with:',
      '          persist-credentials: false # the runner token must not land in .git/config',
      '      - run: node scripts/verify-anonymous-install.mjs # nightly, no credentials',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(steps)).findings).toEqual([]);
  });

  it('a COMMENT quoting the required input does not satisfy the guard', () => {
    // The defect this nearly shipped with: the audit read the raw text, so the
    // workflow's explanatory comment — which quotes `persist-credentials: false`
    // — kept the guard green after the real input was deleted.
    const mutated = read(WORKFLOW).replace('          persist-credentials: false\n', '');
    expect(mutated).toContain('persist-credentials: false'); // still in the comment
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  // ── R3 BLOCKING: the guard must hold at EVERY step, not the one that exists ──

  /**
   * A minimal workflow the audit can locate, so structural cases can be stated
   * without reproducing the real file's indentation. `stepsBlock` is spliced in
   * verbatim, which is the point — these tests are about layout.
   */
  const synthetic = (stepsBlock: string) =>
    [
      'name: x',
      'on:',
      '  workflow_dispatch: {}',
      'permissions: {}',
      'jobs:',
      '  anonymous-install:',
      '    runs-on: ubuntu-latest',
      '    permissions: {}',
      '    steps:',
      stepsBlock,
      '',
    ].join('\n');

  const GOOD_STEPS = [
    '      - uses: actions/checkout@abc',
    '        with:',
    '          persist-credentials: false',
    '      - run: node scripts/verify-anonymous-install.mjs',
  ].join('\n');

  it('the synthetic baseline is clean — otherwise these cases prove nothing', () => {
    expect(auditAnonymousWorkflowJob(synthetic(GOOD_STEPS)).findings).toEqual([]);
  });

  it('flags a SECOND checkout that sets no `with:` at all', () => {
    // The most ordinary edit this workflow will ever receive. `actions/checkout`
    // defaults to `persist-credentials: true`, so a bare second checkout puts the
    // runner token back in the workspace — and a job-wide "does the string appear
    // anywhere" check sees the FIRST step's `false` and stays green.
    const mutated = synthetic(`${GOOD_STEPS}\n      - uses: actions/checkout@abc`);
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it('flags a SECOND checkout that sets `persist-credentials: true` explicitly', () => {
    const mutated = synthetic(
      `${GOOD_STEPS}\n      - uses: actions/checkout@abc\n        with:\n          persist-credentials: true`,
    );
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it('names WHICH step is at fault, so a two-checkout job is triageable', () => {
    const mutated = synthetic(`${GOOD_STEPS}\n      - uses: actions/checkout@abc`);
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/step\s+3|step #?3/i);
  });

  // ── R3 LOWER: the `with:` scan must not depend on one indentation ───────────

  it('flags a forbidden `with:` key at a 4-space step indent', () => {
    // Legal YAML that this repo simply does not happen to use today. Under an
    // indent-coupled scan the keys land at 8 spaces and escape entirely.
    const steps = [
      '    - uses: actions/checkout@abc',
      '      with:',
      '        persist-credentials: false',
      '        token: aSecretLiteral',
      '    - run: node scripts/verify-anonymous-install.mjs',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(steps)).findings.join(' ')).toMatch(
      /with|allowlist/i,
    );
  });

  it('accepts a CLEAN 4-space step indent — the fix is structural, not "red on everything"', () => {
    const steps = [
      '    - uses: actions/checkout@abc',
      '      with:',
      '        persist-credentials: false',
      '    - run: node scripts/verify-anonymous-install.mjs',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(steps)).findings).toEqual([]);
  });

  it('flags a forbidden key in a FLOW-STYLE `with:` mapping', () => {
    const steps = [
      '      - uses: actions/checkout@abc',
      '        with: { persist-credentials: false, token: xyz }',
      '      - run: node scripts/verify-anonymous-install.mjs',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(steps)).findings.join(' ')).toMatch(
      /with|allowlist/i,
    );
  });

  it('reads `persist-credentials` out of a FLOW-STYLE `with:` too', () => {
    const bad = [
      '      - uses: actions/checkout@abc',
      '        with: { persist-credentials: true }',
      '      - run: node scripts/verify-anonymous-install.mjs',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(bad)).findings.join(' ')).toMatch(
      /persist-credentials/i,
    );
    const good = [
      '      - uses: actions/checkout@abc',
      '        with: { persist-credentials: false }',
      '      - run: node scripts/verify-anonymous-install.mjs',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(good)).findings).toEqual([]);
  });

  // ── R3 LOWER: top-level key spellings ──────────────────────────────────────

  it.each([
    ['"env":'],
    ["'env':"],
    ['env :'],
  ])('flags the top-level key written as %s', (spelling) => {
    const mutated = read(WORKFLOW).replace(
      'permissions: {}\n',
      `permissions: {}\n${spelling}\n  GH_TOKEN: literal\n`,
    );
    expect(mutated).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/env/i);
  });

  it('flags an inline flow-style `env:` in the job, which needs no expression', () => {
    // The `env:`-must-end-the-line rule missed `env: { X: y }`. A literal token
    // written inline interpolates nothing, so the expression allowlist does not
    // cover it either.
    const steps = [
      '      - uses: actions/checkout@abc',
      '        with:',
      '          persist-credentials: false',
      '      - run: node scripts/verify-anonymous-install.mjs',
      '        env: { GH_TOKEN: aLiteralToken }',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(steps)).findings.join(' ')).toMatch(/env/i);
  });

  // ── R4: does each rule hold at every SPELLING, not just every site? ─────────

  it.each([
    ['"uses"', '      - "uses": actions/checkout@abc'],
    ["'uses'", "      - 'uses': actions/checkout@abc"],
    ['uses with a spaced colon', '      - uses : actions/checkout@abc'],
  ])('flags a SECOND checkout declared with %s and no `with:`', (_label, line) => {
    // The per-step rule is only as good as its ability to RECOGNISE a checkout.
    // The block-level action allowlist was already quote-tolerant, so a quoted
    // `uses:` reads as checkout there while `stepUses` returned undefined and
    // skipped the `persist-credentials` rule entirely.
    const mutated = synthetic(`${GOOD_STEPS}\n${line}`);
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it('flags a SECOND checkout with a quoted `uses:` AND an explicit `true`', () => {
    const mutated = synthetic(
      `${GOOD_STEPS}\n      - "uses": actions/checkout@abc\n        with:\n          persist-credentials: true`,
    );
    expect(auditAnonymousWorkflowJob(mutated).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it('reads a quoted `with:` mapping rather than treating it as absent', () => {
    const good = [
      '      - uses: actions/checkout@abc',
      '        "with":',
      '          persist-credentials: false',
      '      - run: node scripts/verify-anonymous-install.mjs',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(synthetic(good)).findings).toEqual([]);
  });

  it('FAILS CLOSED per STEP when a step declares `uses` the parser cannot read', () => {
    // The safety net was `steps.length === 0 && block.includes('uses:')` — per
    // JOB. A step whose `uses` is unreadable while its siblings parse fine
    // produced no finding at all: the per-job-vs-per-step error this whole round
    // exists to eliminate, reintroduced inside the net meant to prevent it.
    const steps = [
      '      - uses:',
      '          actions/checkout@abc',
      '      - run: node scripts/verify-anonymous-install.mjs',
    ].join('\n');
    const audit = auditAnonymousWorkflowJob(synthetic(steps));
    expect(audit.findings.join(' ')).toMatch(/cannot read|unreadable/i);
    expect(audit.findings.join(' ')).toMatch(/step\s+1/i);
  });

  it.each([[4], [6], [8]])('flags a job-level `container:` at a %s-space indent', (indent) => {
    // Job keys only need MORE indentation than the 2-space job id, so 6 and 8
    // are legal YAML. This was the one rule still pinned to four spaces — while
    // the comment fifteen lines above claimed the pin was gone.
    const pad = ' '.repeat(indent);
    const workflow = [
      'name: x',
      'on:',
      '  workflow_dispatch: {}',
      'permissions: {}',
      'jobs:',
      '  anonymous-install:',
      `${pad}runs-on: ubuntu-latest`,
      `${pad}permissions: {}`,
      `${pad}container:`,
      `${pad}  image: ghcr.io/o/r:v1`,
      `${pad}  credentials:`,
      `${pad}    username: x`,
      `${pad}steps:`,
      `${pad}  - run: node scripts/verify-anonymous-install.mjs`,
      '',
    ].join('\n');
    expect(auditAnonymousWorkflowJob(workflow).findings.join(' ')).toMatch(/container/i);
  });

  it('flags a quoted job-level `"services":`', () => {
    const workflow = read(WORKFLOW).replace(
      '    permissions: {}',
      '    permissions: {}\n    "services":\n      db:\n        image: postgres:16',
    );
    expect(workflow).not.toBe(read(WORKFLOW));
    expect(auditAnonymousWorkflowJob(workflow).findings.join(' ')).toMatch(/services/i);
  });

  it('parses a CRLF workflow without crying wolf on a correct one', () => {
    // The entry regex carried no `m` flag, so `$` would not match before `\r`
    // and EVERY `with:` entry dropped — reporting `persist-credentials` absent
    // on a workflow that sets it. Cry-wolf is the same end state as never
    // firing: the guard gets deleted either way.
    const crlf = synthetic(GOOD_STEPS).replace(/\n/g, '\r\n');
    expect(auditAnonymousWorkflowJob(crlf).findings).toEqual([]);
  });

  it('still flags a bad CRLF workflow — normalisation must not swallow findings', () => {
    const crlf = synthetic(`${GOOD_STEPS}\n      - uses: actions/checkout@abc`).replace(
      /\n/g,
      '\r\n',
    );
    expect(auditAnonymousWorkflowJob(crlf).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it('recognises a quoted `"steps":` key', () => {
    const workflow = [
      'name: x',
      'on:',
      '  workflow_dispatch: {}',
      'permissions: {}',
      'jobs:',
      '  anonymous-install:',
      '    runs-on: ubuntu-latest',
      '    permissions: {}',
      '    "steps":',
      '      - uses: actions/checkout@abc',
      '      - run: node scripts/verify-anonymous-install.mjs',
      '',
    ].join('\n');
    // The checkout sets no `with:`, so a parser that found the steps reports it.
    expect(auditAnonymousWorkflowJob(workflow).findings.join(' ')).toMatch(/persist-credentials/i);
  });

  it('flags a `gh auth login` in a run step', () => {
    const mutated = read(WORKFLOW).replace(
      'run: node scripts/verify-anonymous-install.mjs',
      'run: |\n          gh auth login --with-token < /dev/null\n          node scripts/verify-anonymous-install.mjs',
    );
    expect(auditAnonymousWorkflowJob(mutated).findings.length).toBeGreaterThan(0);
  });
});
