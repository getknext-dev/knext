#!/usr/bin/env node
/**
 * rc-scaffold-platform-e2e.mjs — G1 (#1732).
 *
 * Runs against an app that was SCAFFOLDED by the PUBLISHED `@getknext/core@rc`
 * CLI (`npx @getknext/core@rc create`, no repo source) on the DEFAULT target
 * (turbopack build x bun compiled single-executable runtime —
 * DEFAULT_BUILDER_ID/DEFAULT_RUNTIME_ID in
 * packages/kn-next/src/adapters/artifact-contract.ts), then deployed through
 * `kn-next deploy` -> NextApp CR -> the operator BUILT FROM the resolved rc
 * ref -> Knative, on an ephemeral kind cluster
 * (.github/workflows/rc-default-scaffold-platform-e2e-weekly.yml).
 *
 * Every existing real-cluster lane deploys apps/file-manager, a `build:
 * 'vinext'` app — not a v1.0 cell. This is the one lane that exercises the
 * actual v1.0 default cell end to end, from the npm artifact a real user
 * would run.
 *
 * Four checks, every one fail-closed (no skip path, see `requireEnv` below):
 *   1. scale-to-zero, then wake on request;
 *   2. Redis-backed ISR: a page's cached value changes after an authenticated
 *      on-demand revalidation (never on its own within the check's deadline);
 *   3. authenticated invalidation: POST /api/cache/invalidate rejects without
 *      a Bearer token (401) and succeeds with the right one;
 *   4. object-storage upload of static assets (`kn-next deploy`'s asset
 *      upload, against the in-cluster MinIO).
 *
 * Reuses the platform-e2e HTTP client (`apps/file-manager/scripts/
 * platform-e2e-http.mjs`, #1282) rather than a second copy: a plain `fetch`
 * cannot set a `Host` header (undici treats it as forbidden), and that is how
 * a request reaches the app THROUGH Kourier rather than a pod IP directly.
 *
 * Env (all required unless marked):
 *   RC_E2E_BASE_URL        the Kourier port-forward, e.g. http://127.0.0.1:8080
 *   RC_E2E_NAMESPACE       the app namespace
 *   RC_E2E_APP_NAME        the NextApp/ksvc name
 *   CACHE_INVALIDATE_TOKEN the token put in the app's Secret
 *   MINIO_LOCAL_ENDPOINT   port-forwarded MinIO, e.g. http://127.0.0.1:9000
 *   MINIO_ACCESS_KEY / MINIO_SECRET_KEY
 *   RC_E2E_BUCKET          the bucket `kn-next deploy` uploaded assets into
 *   RC_E2E_SUMMARY         (optional) file to append a markdown summary to
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '../apps/file-manager/scripts/platform-e2e-http.mjs';

const WAKE_CEILING_MS = 60000;
const SCALE_TO_ZERO_DEADLINE_MS = 240000;
const ISR_REVALIDATE_DEADLINE_MS = 20000;
const KUBECTL_TIMEOUT_MS = 120000;
const AWS_TIMEOUT_MS = 60000;

/** @param {string} name */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `rc-scaffold-platform-e2e: ${name} is not set. This suite never skips a check whose ` +
        'prerequisite is missing: set it (the weekly workflow does), or do not run the suite.',
    );
  }
  return v.trim();
}

const baseUrl = requireEnv('RC_E2E_BASE_URL');
const ns = requireEnv('RC_E2E_NAMESPACE');
const app = requireEnv('RC_E2E_APP_NAME');
const token = requireEnv('CACHE_INVALIDATE_TOKEN');
const minioEndpoint = requireEnv('MINIO_LOCAL_ENDPOINT');
const minioAccessKey = requireEnv('MINIO_ACCESS_KEY');
const minioSecretKey = requireEnv('MINIO_SECRET_KEY');
const bucket = requireEnv('RC_E2E_BUCKET');
const summaryFile = process.env.RC_E2E_SUMMARY;

/** @param {string[]} args @param {{ input?: string }} [opts] */
function kubectl(args, opts = {}) {
  return execFileSync('kubectl', args, {
    encoding: 'utf8',
    input: opts.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: KUBECTL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }).trim();
}

/** @param {string[]} args */
function aws(args) {
  return execFileSync('aws', ['--endpoint-url', minioEndpoint, '--region', 'us-east-1', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: minioAccessKey,
      AWS_SECRET_ACCESS_KEY: minioSecretKey,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: AWS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }).trim();
}

const host = kubectl(['get', 'nextapp', app, '-n', ns, '-o', 'jsonpath={.status.url}']).replace(
  /^https?:\/\//,
  '',
);
if (!host) throw new Error('nextapp status.url is empty');
const http = createClient({ baseUrl, host });

/** @type {{ name: string, status: 'PASS'|'FAIL', detail: string }[]} */
const results = [];

/** @param {string} name @param {() => Promise<string> | string} fn */
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail: `${detail} (${Date.now() - t0}ms)` });
    console.log(`PASS  ${name} — ${detail} (${Date.now() - t0}ms)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', detail });
    console.error(`FAIL  ${name} — ${detail}`);
  }
}

async function main() {
  // ── 1. Redis ISR + authenticated invalidation ──────────────────────────
  // The value the authenticated invalidate produced; re-read after the
  // scale-to-zero → wake cycle to prove the entry lives in Redis, not in the
  // replaced pod's memory.
  let isrAfterInvalidate;
  const readIsr = async () => {
    const res = await http.request('/isr-smoke');
    if (res.status !== 200) throw new Error(`/isr-smoke HTTP ${res.status}`);
    const v = /data-isr-value="([\w.-]+)"/.exec(res.text)?.[1];
    if (!v) throw new Error('ISR value marker missing from /isr-smoke');
    return v;
  };

  await check('ISR served from Redis, stable across reads', async () => {
    const a = await readIsr();
    const b = await readIsr();
    if (a !== b) throw new Error(`ISR value changed with no invalidation: ${a} -> ${b}`);
    return `stable at ${a}`;
  });

  await check(
    'Authenticated invalidation: 401 without/with a wrong token; 200 with the right one',
    async () => {
      const before = await readIsr();

      const noAuth = await http.request('/api/cache/invalidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'isr-smoke' }),
      });
      if (noAuth.status !== 401) {
        throw new Error(`POST without a token returned ${noAuth.status}, want 401`);
      }

      const wrongAuth = await http.request('/api/cache/invalidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
        body: JSON.stringify({ tag: 'isr-smoke' }),
      });
      if (wrongAuth.status !== 401) {
        throw new Error(`POST with a wrong token returned ${wrongAuth.status}, want 401`);
      }

      const stillBefore = await readIsr();
      if (stillBefore !== before) {
        throw new Error(
          `ISR value changed after only UNAUTHENTICATED invalidate calls — the 401 did not stop the mutation`,
        );
      }

      const rightAuth = await http.request('/api/cache/invalidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ tag: 'isr-smoke' }),
      });
      if (rightAuth.status !== 200) {
        throw new Error(`POST with the right token returned ${rightAuth.status}, want 200`);
      }

      const deadline = Date.now() + ISR_REVALIDATE_DEADLINE_MS;
      let after = await readIsr();
      while (Date.now() < deadline && after === before) {
        await sleep(500);
        after = await readIsr();
      }
      if (after === before) {
        throw new Error(
          `ISR value did not change within ${ISR_REVALIDATE_DEADLINE_MS}ms of an authenticated invalidate`,
        );
      }
      isrAfterInvalidate = after;
      return `401/401/200; value changed ${before} -> ${after}`;
    },
  );

  // ── 1b. image optimization with storage configured (#1786 round 2) ─────
  // The operator's default readOnlyRootFilesystem config mounts a writable
  // `.next/cache` ONLY because this app has `spec.storage` configured (see
  // check 2 below) — the built-in image optimizer writes the variant there
  // BEFORE image-cache-sync.ts can push it to the bucket. Without that
  // mount this request would 500 on an EROFS write, not just miss a cache.
  await check(
    'Image optimization: /_next/image succeeds against a storage-configured app (no EROFS)',
    async () => {
      const res = await http.request('/_next/image?url=%2Frc-e2e-optimize-fixture.png&w=256&q=75');
      if (res.status !== 200) {
        throw new Error(`/_next/image returned ${res.status}, want 200 (EROFS surfaces as 500)`);
      }
      const contentType = res.headers?.['content-type'] ?? '';
      if (!/^image\//.test(contentType)) {
        throw new Error(`/_next/image content-type = "${contentType}", want an image/* type`);
      }
      return `200, content-type ${contentType}`;
    },
  );

  // ── 2. object-storage upload of static assets ──────────────────────────
  await check('Object storage: static assets uploaded to the in-cluster MinIO bucket', async () => {
    const listing = aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', `${app}/`]);
    /** @type {{ Contents?: { Key: string }[] }} */
    const parsed = JSON.parse(listing || '{}');
    const keys = (parsed.Contents ?? []).map((o) => o.Key);
    const staticKeys = keys.filter((k) => k.includes('/_next/static/'));
    if (staticKeys.length === 0) {
      throw new Error(
        `no "${app}/_next/static/*" objects found in bucket ${bucket} (${keys.length} total keys)`,
      );
    }
    return `${staticKeys.length} static asset(s) under ${app}/_next/static/`;
  });

  // ── 3. scale-to-zero, then wake ──────────────────────────────────────────
  await check(
    'Scale-to-zero: revision reaches 0 replicas and 0 pods, ksvc stays Ready',
    async () => {
      const rev = kubectl([
        'get',
        'ksvc',
        app,
        '-n',
        ns,
        '-o',
        'jsonpath={.status.latestReadyRevisionName}',
      ]);
      if (!rev) throw new Error('ksvc has no latestReadyRevisionName');
      const t0 = Date.now();
      for (;;) {
        const replicas = kubectl([
          'get',
          'deploy',
          `${rev}-deployment`,
          '-n',
          ns,
          '-o',
          'jsonpath={.spec.replicas}',
        ]);
        const pods = kubectl([
          'get',
          'pods',
          '-n',
          ns,
          '-l',
          `serving.knative.dev/revision=${rev}`,
          '-o',
          'name',
        ])
          .split('\n')
          .filter(Boolean).length;
        const specReplicas = replicas === '' ? null : Number(replicas);
        if ((specReplicas === null || specReplicas === 0) && pods === 0) break;
        if (Date.now() - t0 > SCALE_TO_ZERO_DEADLINE_MS) {
          throw new Error(
            `still replicas=${replicas} pods=${pods} after ${SCALE_TO_ZERO_DEADLINE_MS}ms idle`,
          );
        }
        await sleep(3000);
      }
      const ready = kubectl([
        'get',
        'ksvc',
        app,
        '-n',
        ns,
        '-o',
        'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
      ]);
      if (ready !== 'True') throw new Error(`ksvc Ready=${ready} while scaled to zero`);
      return `${rev} at zero after ${Date.now() - t0}ms idle; ksvc Ready=True`;
    },
  );

  await check(
    'Wake from zero: one request through the activator returns the home page',
    async () => {
      const t0 = Date.now();
      const res = await http.request('/');
      const ms = Date.now() - t0;
      if (res.status !== 200) throw new Error(`GET / returned ${res.status} after ${ms}ms`);
      if (ms > WAKE_CEILING_MS)
        throw new Error(`woke in ${ms}ms, over the ${WAKE_CEILING_MS}ms ceiling`);
      return `200 in ${ms}ms`;
    },
  );

  await check('ISR entry survives scale-to-zero (served from Redis by the new pod)', async () => {
    if (!isrAfterInvalidate)
      throw new Error('no post-invalidate ISR value recorded (the ISR check failed earlier)');
    // Stale-while-revalidate serves the cached entry on the first read even if it has
    // expired, so the new pod must return exactly the value the old pod cached.
    const v = await readIsr();
    if (v !== isrAfterInvalidate) {
      throw new Error(
        `new pod served ${v}, want the cached ${isrAfterInvalidate} — ISR cache did not survive the pod`,
      );
    }
    return `new pod served the cached ${v}`;
  });

  // ── report ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === 'FAIL');
  const table = [
    '| Check | Status | Detail |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`),
  ].join('\n');
  console.log(`\n${table}\n`);
  if (summaryFile) {
    appendFileSync(summaryFile, `## RC default-scaffold platform e2e\n\n${table}\n`);
  }
  if (failed.length > 0) {
    console.error(`${failed.length}/${results.length} check(s) failed`);
    process.exitCode = 1;
  }
}

await main();
