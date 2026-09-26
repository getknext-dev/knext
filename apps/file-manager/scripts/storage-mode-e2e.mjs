#!/usr/bin/env node
/**
 * storage-mode-e2e.mjs — the LIVE storage-mode leg (#1292).
 *
 * Runs AFTER `kn-next deploy` has shipped `file-manager-storage` (a second
 * NextApp, `storage` configured against the in-cluster MinIO) to the same
 * kind cluster the image-served leg (`platform-e2e.mjs`) already stood up.
 * Fetches the served HTML through the real ingress (same Kourier
 * port-forward + Host header as the image-served leg) and:
 *
 *   1. asserts the served HTML references `<bucket-url>/<name>/...` asset
 *      URLs (proves `ASSET_PREFIX` was baked into the build, #1283);
 *   2. asserts those URLs return 200 from MinIO with the right content-type
 *      (proves the upload actually landed the objects the HTML points at);
 *   3. asserts the built static prefix / build id equals the deploy tag
 *      (proves `NEXT_DEPLOYMENT_ID` was baked in, ADR-0011 skew-protection
 *      lock-step).
 *
 * FAIL-CLOSED: no skip path. A missing env var throws before any check runs.
 *
 * Env (all required):
 *   PLATFORM_E2E_BASE_URL   the Kourier port-forward, e.g. http://127.0.0.1:8080
 *   PLATFORM_E2E_NAMESPACE  the app namespace (e.g. fm-e2e)
 *   STORAGE_APP_NAME        the NextApp/ksvc name (file-manager-storage)
 *   STORAGE_BUCKET_URL      the publicUrl configured in the storage profile,
 *                           as embedded in the served HTML (cluster-internal
 *                           DNS, e.g. http://minio.fm-e2e.svc.cluster.local:9000/<bucket>)
 *   STORAGE_TAG             the --tag kn-next deploy used for this app
 *   MINIO_LOCAL_ENDPOINT    port-forwarded MinIO the runner can reach, e.g.
 *                           http://127.0.0.1:9000 — object URLs are re-based
 *                           onto this host (same path) since the runner
 *                           cannot resolve the in-cluster DNS name
 *   PLATFORM_E2E_SUMMARY    (optional) file to append a markdown summary to
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import {
  assertAssetPrefixReferenced,
  assertAssetUrlsServeOk,
  assertBuildMarkerMatchesTag,
} from './storage-mode-checks.mjs';

const KUBECTL_TIMEOUT_MS = 120000;

/** @param {string} name */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `storage-mode-e2e: ${name} is not set. This leg never skips a check whose ` +
        'prerequisite is missing: set it (the nightly workflow does), or do not run it.',
    );
  }
  return v.trim();
}

/** @param {string[]} args */
function kubectl(args) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: KUBECTL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }).trim();
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string,string>} headers
 * @returns {Promise<{ status: number, headers: Record<string, string | string[] | undefined>, text: string }>}
 */
function get(baseUrl, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(baseUrl);
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port || 80,
        path,
        method: 'GET',
        headers,
        agent: false,
      },
      (res) => {
        /** @type {Buffer[]} */
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(bufs).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`request timeout: GET ${path}`)));
    req.end();
  });
}

/** @type {{ name: string, status: 'PASS'|'FAIL', detail: string }[]} */
const results = [];

/** @param {string} name @param {() => Promise<string> | string} fn */
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail: `${detail} (${Date.now() - t0}ms)` });
    console.log(`PASS  ${name} — ${detail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', detail: msg });
    console.log(`FAIL  ${name} — ${msg}`);
  }
}

async function main() {
  const baseUrl = requireEnv('PLATFORM_E2E_BASE_URL');
  const ns = requireEnv('PLATFORM_E2E_NAMESPACE');
  const app = requireEnv('STORAGE_APP_NAME');
  const bucketUrl = requireEnv('STORAGE_BUCKET_URL');
  const tag = requireEnv('STORAGE_TAG');
  const minioLocal = requireEnv('MINIO_LOCAL_ENDPOINT');

  const ksvcUrl = kubectl(['get', 'ksvc', app, '-n', ns, '-o', 'jsonpath={.status.url}']);
  if (!ksvcUrl)
    throw new Error(
      `storage-mode-e2e: ksvc ${ns}/${app} has no status.url — never became routable`,
    );
  const host = new URL(ksvcUrl).host;
  console.log(`storage-mode-e2e: ${ksvcUrl} via ${baseUrl} (Host: ${host}), bucket ${bucketUrl}`);

  /** @type {ReturnType<typeof assertAssetPrefixReferenced> | undefined} */
  let refs;

  await check(
    'served HTML references the storage bucket prefix (ASSET_PREFIX baked in)',
    async () => {
      const res = await get(baseUrl, '/', { host });
      if (res.status !== 200) throw new Error(`GET / -> HTTP ${res.status}`);
      refs = assertAssetPrefixReferenced({ html: res.text, bucketUrl, name: app });
      return `${refs.refs.length} asset ref(s) under ${refs.prefix}`;
    },
  );

  await check('bucket build-id marker equals the deploy tag', () => {
    if (!refs) throw new Error('no refs captured from the previous check');
    const local = new URL(minioLocal);
    return assertBuildMarkerMatchesTag({
      prefix: refs.prefix,
      tag,
      fetchOne: async (url) => {
        const u = new URL(url);
        const res = await get(minioLocal, u.pathname + u.search, { host: local.host });
        return { status: res.status, text: res.text };
      },
    });
  });

  await check(
    'the referenced bucket URLs return 200 from MinIO with the right content-type',
    () => {
      if (!refs) throw new Error('no refs captured from the previous check');
      // The runner cannot resolve the in-cluster DNS name baked into the HTML
      // (e.g. minio.fm-e2e.svc.cluster.local) — re-base each URL's PATH onto
      // the port-forwarded endpoint it actually reached MinIO through. This
      // checks the same object, at the same key, through a different route in
      // — not a different assertion.
      const local = new URL(minioLocal);
      return assertAssetUrlsServeOk({
        urls: refs.refs,
        fetchOne: async (url) => {
          const u = new URL(url);
          const res = await get(minioLocal, u.pathname + u.search, { host: local.host });
          return { status: res.status, headers: res.headers };
        },
      });
    },
  );

  const failed = results.filter((r) => r.status === 'FAIL');
  const lines = [
    '## Storage-mode leg',
    '',
    '| | Check | Evidence |',
    '|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.status === 'PASS' ? 'PASS' : '**FAIL**'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 400)} |`,
    ),
  ];
  const md = `${lines.join('\n')}\n`;
  console.log(`\n${md}`);
  if (process.env.PLATFORM_E2E_SUMMARY) appendFileSync(process.env.PLATFORM_E2E_SUMMARY, md);
  if (failed.length > 0) {
    console.error(`storage-mode-e2e: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`storage-mode-e2e: all ${results.length} checks passed`);
}

main().catch((err) => {
  console.error(`storage-mode-e2e: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
