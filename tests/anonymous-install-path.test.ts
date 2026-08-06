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
  findAllInstallUrls,
  findEnvCredentialLeaks,
  findFileCredentialLeaks,
  findRequestCredentialLeaks,
  findUrlDriftFindings,
  parseImageRef,
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

  it('flags a `gh auth login` in a run step', () => {
    const mutated = read(WORKFLOW).replace(
      'run: node scripts/verify-anonymous-install.mjs',
      'run: |\n          gh auth login --with-token < /dev/null\n          node scripts/verify-anonymous-install.mjs',
    );
    expect(auditAnonymousWorkflowJob(mutated).findings.length).toBeGreaterThan(0);
  });
});
