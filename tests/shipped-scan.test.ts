import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  classifyRegistryError,
  failingNpmFindings,
  loadNpmAllowlist,
  NPM_GROUP,
  operatorImageRefs,
  parseNpmAudit,
  parseNpmView,
  publishedTemplateImages,
  TEMPLATE_IMAGES,
  versionsToScan,
} from '../scripts/lib/shipped-scan.mjs';
import { auditJobCanNotSkip } from './helpers/blocking-gate';

/**
 * GUARD: what we have already shipped is re-scanned every night, and the scan
 * cannot pass by not looking.
 *
 * `audit-published.mjs` gates the tarballs at PUBLISH time and Trivy gates images
 * at PUSH time. Both are a snapshot: an advisory published next week against a
 * dependency we shipped last month is invisible to them, and the artifact keeps
 * being installed. This nightly re-reads the REGISTRY, not the repo:
 *
 *   - the published `@getknext/*` versions on every dist-tag: `npm audit` over the
 *     production closure plus OSV over the resolved lockfile (malware included);
 *   - the operator image digests the release bundles pin, and the reference app
 *     image, with Trivy;
 *   - every tracked lockfile for malicious-package advisories.
 *
 * FAIL LOUD. The failure this file keeps closed is a nightly that goes green
 * because it could not see: `npm audit` against an unreachable registry prints
 * `{"error": …}` and no `vulnerabilities`, which a naive reader takes as clean.
 * Every parser here throws on that, and an image that cannot be fetched is a
 * failure unless the registry positively says it was never published.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
const TODAY = '2026-10-17';

describe('versionsToScan', () => {
  it('returns every distinct version on every dist-tag, with the tags that point at it', () => {
    expect(
      versionsToScan({ latest: '1.3.1', next: '1.3.0-rc.10', rc: '1.0.0-rc.6', beta: '1.3.1' }),
    ).toEqual([
      { version: '1.0.0-rc.6', tags: ['rc'] },
      { version: '1.3.0-rc.10', tags: ['next'] },
      { version: '1.3.1', tags: ['beta', 'latest'] },
    ]);
  });
  it('refuses an empty or malformed dist-tags answer instead of scanning nothing', () => {
    expect(() => versionsToScan({})).toThrow(/no dist-tags/);
    expect(() => versionsToScan(null as never)).toThrow();
    expect(() => versionsToScan({ latest: 'not-a-version' })).toThrow(/semver/);
    expect(() => versionsToScan({ latest: 3 } as never)).toThrow();
  });
  it('requires a latest tag (the version users get by default is never skipped)', () => {
    expect(() => versionsToScan({ next: '1.3.0-rc.10' })).toThrow(/latest/);
  });
});

describe('parseNpmView', () => {
  it('parses JSON and refuses empty or non-JSON output', () => {
    expect(parseNpmView('{"latest": "1.0.0"}')).toEqual({ latest: '1.0.0' });
    expect(() => parseNpmView('')).toThrow();
    expect(() => parseNpmView('npm ERR! code E404')).toThrow();
    expect(() => parseNpmView('{"error": {"code": "E404"}}')).toThrow(/error/);
  });
});

describe('parseNpmAudit', () => {
  const clean = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: {} },
  });
  it('reads a clean report', () => {
    expect(parseNpmAudit(clean).vulnerabilities).toEqual({});
  });
  it('THROWS on an error document: an unreachable registry is not a clean audit', () => {
    expect(() =>
      parseNpmAudit(JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'request failed' } })),
    ).toThrow(/ENOTFOUND/);
  });
  it('THROWS on a document with no vulnerabilities map, empty output, or non-JSON', () => {
    expect(() => parseNpmAudit('{}')).toThrow();
    expect(() => parseNpmAudit('')).toThrow();
    expect(() => parseNpmAudit('<html>')).toThrow();
  });
});

describe('failingNpmFindings', () => {
  const via = (id: string) => ({ url: `https://github.com/advisories/${id}`, source: 1 });
  const report = {
    vulnerabilities: {
      highpkg: { severity: 'high', via: [via('GHSA-aaaa-bbbb-cccc')] },
      critpkg: { severity: 'critical', via: [via('GHSA-dddd-eeee-ffff')] },
      midpkg: { severity: 'moderate', via: [via('GHSA-gggg-hhhh-iiii')] },
      transitive: { severity: 'high', via: ['highpkg'] },
    },
  };
  it('fails on high and critical (a dependent of a failing group fails too), ignores moderate', () => {
    const r = failingNpmFindings(report, new Set());
    expect(r.failing.map((f: { name: string }) => f.name).sort()).toEqual([
      'critpkg',
      'highpkg',
      'transitive',
    ]);
  });
  it('a dependent is suppressed exactly when the group it points to is', () => {
    const r = failingNpmFindings(report, new Set(['GHSA-aaaa-bbbb-cccc']));
    expect(r.failing.map((f: { name: string }) => f.name).sort()).toEqual(['critpkg']);
    expect(r.suppressed.map((f: { name: string }) => f.name).sort()).toEqual([
      'highpkg',
      'transitive',
    ]);
  });
  it('a high group with no advisory and no pointer cannot be judged, so it fails', () => {
    const r = failingNpmFindings(
      { vulnerabilities: { odd: { severity: 'high', via: [] } } },
      new Set(),
    );
    expect(r.failing).toHaveLength(1);
  });
  it('a pointer cycle terminates and fails', () => {
    const r = failingNpmFindings(
      {
        vulnerabilities: {
          a: { severity: 'high', via: ['b'] },
          b: { severity: 'high', via: ['a'] },
        },
      },
      new Set(),
    );
    expect(r.failing).toHaveLength(2);
  });
  it('suppresses only when EVERY contributing advisory is allowlisted', () => {
    const two = {
      vulnerabilities: {
        p: { severity: 'high', via: [via('GHSA-aaaa-bbbb-cccc'), via('GHSA-zzzz-yyyy-xxxx')] },
      },
    };
    expect(failingNpmFindings(two, new Set(['GHSA-aaaa-bbbb-cccc'])).failing).toHaveLength(1);
    expect(
      failingNpmFindings(two, new Set(['GHSA-aaaa-bbbb-cccc', 'GHSA-zzzz-yyyy-xxxx'])).failing,
    ).toHaveLength(0);
  });
});

describe('loadNpmAllowlist', () => {
  it('reads active entries and drops expired ones', () => {
    const ids = loadNpmAllowlist(
      {
        allow: [
          { id: 'GHSA-1', justification: 'accepted', added: '2026-10-01' },
          { id: 'GHSA-2', justification: 'accepted', added: '2026-09-01', expires: '2026-10-01' },
        ],
      },
      TODAY,
    );
    expect([...ids]).toEqual(['GHSA-1']);
  });
  it('rejects a malformed entry', () => {
    expect(() => loadNpmAllowlist({ allow: [{ id: 'X' }] }, TODAY)).toThrow();
    expect(() => loadNpmAllowlist(null, TODAY)).toThrow();
  });
  it('the committed allowlist parses', () => {
    const json = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'security/npm-audit-allowlist.json'), 'utf8'),
    );
    expect(() => loadNpmAllowlist(json, TODAY)).not.toThrow();
  });
});

describe('operatorImageRefs', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const yaml = `kind: Deployment\nspec:\n  containers:\n  - image: ghcr.io/getknext-dev/kn-next-operator:v0.1.0@${digest}\n  - image: ghcr.io/getknext-dev/kn-next-operator:v0.1.0@${digest}\n`;
  it('returns the digest-pinned operator image refs, de-duplicated', () => {
    expect(operatorImageRefs(yaml)).toEqual([`ghcr.io/getknext-dev/kn-next-operator@${digest}`]);
  });
  it('throws on a bundle that carries no digest-pinned operator image', () => {
    expect(() => operatorImageRefs('image: ghcr.io/getknext-dev/kn-next-operator:latest')).toThrow(
      /digest/,
    );
    expect(() => operatorImageRefs('')).toThrow();
  });
  it('ignores other images', () => {
    expect(() => operatorImageRefs(`image: ghcr.io/other/thing@${digest}`)).toThrow();
  });
});

describe('classifyRegistryError', () => {
  it('only a positive not-found is not-found; everything else is unreachable', () => {
    expect(
      classifyRegistryError('Error: GET https://ghcr.io/...: MANIFEST_UNKNOWN: manifest unknown'),
    ).toBe('not-found');
    expect(classifyRegistryError('NAME_UNKNOWN: repository name not known to registry')).toBe(
      'not-found',
    );
    expect(classifyRegistryError('Error: dial tcp: lookup ghcr.io: no such host')).toBe(
      'unreachable',
    );
    expect(classifyRegistryError('Error: GET https://ghcr.io/v2/: 503 Service Unavailable')).toBe(
      'unreachable',
    );
    expect(classifyRegistryError('UNAUTHORIZED: authentication required')).toBe('unreachable');
    expect(classifyRegistryError('')).toBe('unreachable');
  });
});

describe('template images', () => {
  it('names the function template images', () => {
    expect(TEMPLATE_IMAGES).toEqual(['knext-function-go', 'knext-function-rust']);
  });
  it('detects a workflow that starts publishing one', () => {
    const push = 'run: crane push oci "ghcr.io/o/knext-function-go:${GITHUB_SHA}"';
    expect(publishedTemplateImages({ 'x.yml': push })).toEqual({ 'x.yml': ['knext-function-go'] });
    expect(
      publishedTemplateImages({ 'x.yml': 'run: docker build -t knext-function-go .' }),
    ).toEqual({});
  });
  it('TODAY no workflow publishes a template image, so the nightly has nothing to miss', () => {
    const texts: Record<string, string> = {};
    for (const f of readdirSync(WORKFLOW_DIR).filter((n) => n.endsWith('.yml'))) {
      texts[f] = readFileSync(resolve(WORKFLOW_DIR, f), 'utf8');
    }
    expect(Object.keys(texts).length).toBeGreaterThan(40);
    expect(publishedTemplateImages(texts)).toEqual({});
  });
});

describe('the npm group', () => {
  it('is the published fixed group', () => {
    expect([...NPM_GROUP].sort()).toEqual([
      '@getknext/core',
      '@getknext/db',
      '@getknext/lib',
      'kn-next',
    ]);
  });
});

describe('.github/workflows/shipped-artifacts-nightly.yml', () => {
  const text = readFileSync(resolve(WORKFLOW_DIR, 'shipped-artifacts-nightly.yml'), 'utf8');
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const doc = parse(text) as {
    on: Record<string, unknown>;
    permissions: unknown;
    jobs: Record<string, Record<string, unknown>>;
  };
  const SCAN_JOBS = ['npm-published', 'resolve-images', 'images', 'lockfile-malware'];

  it('is scheduled nightly and manually runnable, and never on a pull request', () => {
    expect(Object.keys(doc.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });
  it('is read-only at workflow level', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
  });
  it('has every scan job and the alert job', () => {
    for (const id of [...SCAN_JOBS, 'nightly-red-alert']) expect(doc.jobs[id], id).toBeDefined();
  });
  it('no scan job can be skipped or softened (a skipped job does not fail the run)', () => {
    // The shared audit refuses `strategy` outright (a matrix that expands to zero
    // jobs runs nothing). The `images` job needs a matrix, one entry per published
    // image, so it is audited in two parts: its `strategy` is checked by hand below,
    // and everything else goes through the shared audit with `strategy` removed.
    const jobs = structuredClone(doc.jobs) as Record<string, Record<string, unknown>>;
    delete jobs.images.strategy;
    const problems: string[] = [];
    for (const id of SCAN_JOBS) {
      auditJobCanNotSkip(jobs as never, id, problems);
    }
    expect(problems).toEqual([]);
  });
  it('the images matrix is exactly the resolved list, never empty by construction, and fails fast off', () => {
    const strategy = doc.jobs.images.strategy as {
      'fail-fast'?: unknown;
      matrix?: { image?: unknown } & Record<string, unknown>;
    };
    expect(Object.keys(strategy).sort()).toEqual(['fail-fast', 'matrix']);
    expect(strategy['fail-fast']).toBe(false);
    expect(Object.keys(strategy.matrix ?? {})).toEqual(['image']);
    expect(String(strategy.matrix?.image)).toBe(
      '${{ fromJSON(needs.resolve-images.outputs.images) }}',
    );
    expect(doc.jobs.images.needs).toEqual(['resolve-images']);
    // The list can only be empty if resolution found no operator bundle, and the
    // resolver exits non-zero then: the images job is then skipped BECAUSE the
    // resolve job failed, which the alert reports.
    const resolver = readFileSync(resolve(REPO_ROOT, 'scripts/resolve-shipped-images.mjs'), 'utf8');
    expect(resolver).toMatch(/if \(operatorFound === 0\)\s*fail\(/);
  });
  it('osv-scanner is pinned identically in every workflow that installs it', () => {
    const pins = new Set<string>();
    for (const file of ['osv-scan.yml', 'shipped-artifacts-nightly.yml']) {
      const t = readFileSync(resolve(WORKFLOW_DIR, file), 'utf8');
      for (const m of t.matchAll(/OSV_SCANNER_VERSION:\s*(\S+)/g)) pins.add(`version ${m[1]}`);
      for (const m of t.matchAll(/OSV_SCANNER_SHA256:\s*([0-9a-f]{64})/g)) pins.add(`sha ${m[1]}`);
    }
    expect([...pins].sort()).toEqual([
      'sha ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108',
      'version v2.6.0',
    ]);
  });
  it('no step is soft-failed or masked with || true', () => {
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/\|\|\s*true/);
  });
  it('the alert job fires on failure OR cancelled of EVERY scan job, on schedule only', () => {
    const alert = doc.jobs['nightly-red-alert'];
    const cond = String(alert.if);
    expect(cond).toMatch(/always\(\)/);
    expect(cond).toMatch(/github\.event_name == 'schedule'/);
    for (const id of SCAN_JOBS) {
      expect(cond, `${id} failure`).toContain(`needs.${id}.result == 'failure'`);
      expect(cond, `${id} cancelled`).toContain(`needs.${id}.result == 'cancelled'`);
    }
    expect([...(alert.needs as string[])].sort()).toEqual([...SCAN_JOBS].sort());
    expect(alert.permissions).toEqual({ issues: 'write' });
  });
  it('the alert reuses the shared create-or-update helper and never pins', () => {
    expect(code).toContain('node scripts/nightly-alert-issue.mjs');
    expect(code).not.toMatch(/gh issue pin/);
  });
  it('the image scan is Trivy at HIGH,CRITICAL with exit-code 1, by digest', () => {
    expect(code).toMatch(/aquasecurity\/trivy-action@[0-9a-f]{40}/);
    expect(code).toMatch(/severity:\s*HIGH,CRITICAL/);
    expect(code).toMatch(/exit-code:\s*["']?1["']?/);
    expect(code).toMatch(/image-ref:\s*\$\{\{\s*matrix\.image\.ref\s*\}\}/);
  });
  it('the npm scan and the lockfile scan use the sha256-pinned osv-scanner', () => {
    expect(code).toMatch(/OSV_SCANNER_SHA256:\s*[0-9a-f]{64}/);
    expect((code.match(/sha256sum -c/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('the image job reads packages (the reference app image is private)', () => {
    expect((doc.jobs.images.permissions as Record<string, string>).packages).toBe('read');
  });
});
