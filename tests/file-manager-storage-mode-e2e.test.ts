import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  assertAssetPrefixReferenced,
  assertAssetUrlsServeOk,
  assertBuildIdMatchesTag,
  extractBucketAssetRefs,
} from '../apps/file-manager/scripts/storage-mode-checks.mjs';

/**
 * WIRING + BEHAVIOUR GUARD for the storage-mode leg of the nightly file-manager
 * platform e2e (#1292, follow-up to #1283/#1291). Mirrors
 * `file-manager-platform-e2e-workflow.test.ts`'s doctrine: assert on the
 * PARSED workflow and the committed profile, and prove the assertion
 * functions actually go red on the defect they exist to catch — a guard that
 * only ever passes is decoration.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(ROOT, '.github/workflows/file-manager-platform-e2e-nightly.yml');
const STORAGE_PROFILE = resolve(
  ROOT,
  'apps/file-manager/platform-e2e/kn-next.config.storage-e2e.ts',
);
const REAL_CONFIG = resolve(ROOT, 'apps/file-manager/kn-next.config.ts');

type Step = { name?: string; uses?: string; run?: string; if?: string; [k: string]: unknown };
type Job = { steps: Step[]; needs?: string[]; if?: string; [k: string]: unknown };
const text = readFileSync(WF, 'utf8');
const wf = parse(text) as { jobs: Record<string, Job> };
const check = wf.jobs['platform-e2e'];

describe('storage-mode leg - workflow wiring', () => {
  it('the storage-mode selftest runs BEFORE the cluster suite, same as the app-functionality selftest', () => {
    const idx = (needle: string) => check.steps.findIndex((s) => (s.run ?? '').includes(needle));
    const selftest = idx('storage-mode-e2e.selftest.mjs');
    expect(selftest).toBeGreaterThanOrEqual(0);
    expect(selftest).toBeLessThan(idx('kind create cluster'));
  });

  it('the storage-mode deploy AND live-check steps carry no `if:` (fail-closed, not skippable)', () => {
    const deploy = check.steps.find((s) => (s.run ?? '').includes('kn-next.config.storage-e2e.ts'));
    const liveCheck = check.steps.find((s) => (s.run ?? '').includes('storage-mode-e2e.mjs'));
    expect(deploy).toBeDefined();
    expect(liveCheck).toBeDefined();
    expect(deploy?.if).toBeUndefined();
    expect(liveCheck?.if).toBeUndefined();
  });

  it('the storage-mode deploy runs through the product CLI, not a hand-written Knative apply', () => {
    const deploy = check.steps.find((s) => (s.run ?? '').includes('kn-next.config.storage-e2e.ts'));
    expect(deploy?.run).toContain('kn-next.js deploy');
    expect(deploy?.run).not.toMatch(/kind:\s*Service\b|serving\.knative\.dev\/v1/);
  });

  it('the storage-mode NextApp is waited on with a timeout before the live checks run', () => {
    const deploy = check.steps.find((s) => (s.run ?? '').includes('kn-next.config.storage-e2e.ts'));
    expect(deploy?.run).toMatch(
      /wait --for=condition=Ready --timeout=\d+s nextapp\/file-manager-storage/,
    );
  });

  it('the leg deploys a DISTINCT NextApp name, never overwriting the app-functionality leg', () => {
    expect(text).toMatch(/nextapp\/file-manager-storage/);
    // The original app-functionality NextApp is still waited on by its own name.
    expect(text).toMatch(/nextapp\/file-manager\b/);
  });

  it('no continue-on-error anywhere in the workflow (still holds with the new leg added)', () => {
    expect(text).not.toMatch(/continue-on-error/);
  });
});

describe('storage-mode config profile', () => {
  const norm = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const keys = (src: string) =>
    [...norm(src).matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();

  it('differs from the real config only in name/storage/registry/cache/database', () => {
    const real = keys(readFileSync(REAL_CONFIG, 'utf8'));
    const prof = keys(readFileSync(STORAGE_PROFILE, 'utf8'));
    const allowed = new Set(['name', 'storage', 'registry', 'cache', 'database']);
    const onlyReal = real.filter((k) => !prof.includes(k));
    const onlyProf = prof.filter((k) => !real.includes(k));
    for (const k of [...onlyReal, ...onlyProf]) expect(allowed.has(k)).toBe(true);
    // Storage is PRESENT here (unlike the image-served e2e profile, where it's dropped).
    expect(prof).toContain('storage');
  });

  it('non-differing keys are byte-identical to the real config', () => {
    const block = (src: string, key: string) =>
      new RegExp(`^ {2}${key}:[\\s\\S]*?(?=^ {2}[a-zA-Z]+:|^\\};?$)`, 'm')
        .exec(norm(src))?.[0]
        .replace(/\s+/g, ' ')
        .trim();
    const real = readFileSync(REAL_CONFIG, 'utf8');
    const prof = readFileSync(STORAGE_PROFILE, 'utf8');
    for (const k of ['infrastructure', 'scaling', 'observability', 'secrets']) {
      expect(block(prof, k)).toBeDefined();
      expect(block(prof, k)).toBe(block(real, k));
    }
  });

  it('uses the s3 provider (mc is not installed on the runner), never the unproven minio provider', () => {
    const src = readFileSync(STORAGE_PROFILE, 'utf8');
    expect(src).toMatch(/provider:\s*'s3'/);
  });
});

describe('storage-mode leg harness self-test', () => {
  it('passes: every check is green when healthy and red on each defect', () => {
    const r = spawnSync('node', ['apps/file-manager/scripts/storage-mode-e2e.selftest.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.stdout + r.stderr).toContain('goes red on each defect');
    expect(r.status).toBe(0);
  });
});

describe('storage-mode checks - mutation proof (the assertions themselves, not just the harness)', () => {
  const BUCKET_URL = 'http://minio.fm-e2e.svc.cluster.local:9000/fm-e2e-storage-assets';
  const NAME = 'file-manager-storage';
  const TAG = 'ci-run-42-storage';
  const goodHtml = `<html><head><script src="${BUCKET_URL}/${NAME}/_next/static/${TAG}/chunk.js"></script></head></html>`;

  it('an image built WITHOUT ASSET_PREFIX (image-local relative paths) turns the leg RED', () => {
    const brokenHtml = `<html><head><script src="/_next/static/${TAG}/chunk.js"></script></head></html>`;
    expect(() =>
      assertAssetPrefixReferenced({ html: brokenHtml, bucketUrl: BUCKET_URL, name: NAME }),
    ).toThrow(/no asset .* references the storage bucket prefix/);
  });

  it('an image built WITHOUT NEXT_DEPLOYMENT_ID (build id != deploy tag) turns the leg RED', () => {
    const wrongIdHtml = `<html><head><script src="${BUCKET_URL}/${NAME}/_next/static/development/chunk.js"></script></head></html>`;
    const { refs } = assertAssetPrefixReferenced({
      html: wrongIdHtml,
      bucketUrl: BUCKET_URL,
      name: NAME,
    });
    expect(() => assertBuildIdMatchesTag({ refs, tag: TAG })).toThrow(/!= deploy tag/);
  });

  it('a healthy image passes both assertions', () => {
    const { refs } = assertAssetPrefixReferenced({
      html: goodHtml,
      bucketUrl: BUCKET_URL,
      name: NAME,
    });
    expect(refs.length).toBe(1);
    expect(assertBuildIdMatchesTag({ refs, tag: TAG })).toContain(TAG);
  });

  it('a bucket URL that does not serve 200 turns the leg RED', async () => {
    await expect(
      assertAssetUrlsServeOk({
        urls: [`${BUCKET_URL}/${NAME}/_next/static/${TAG}/chunk.js`],
        fetchOne: async () => ({ status: 404, headers: {} }),
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('a bucket URL served with the wrong content-type turns the leg RED', async () => {
    await expect(
      assertAssetUrlsServeOk({
        urls: [`${BUCKET_URL}/${NAME}/_next/static/${TAG}/chunk.js`],
        fetchOne: async () => ({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      }),
    ).rejects.toThrow(/content-type/);
  });

  it('extractBucketAssetRefs never matches a same-origin (non-bucket) path as a bucket ref', () => {
    const refs = extractBucketAssetRefs(
      '<html><head><script src="/_next/static/x/chunk.js"></script></head></html>',
      BUCKET_URL,
    );
    expect(refs).toEqual([]);
  });
});
