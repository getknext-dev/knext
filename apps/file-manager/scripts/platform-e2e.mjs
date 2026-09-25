#!/usr/bin/env node
/**
 * platform-e2e.mjs — the nightly file-manager PLATFORM e2e (#1282).
 *
 * Runs against file-manager AFTER `kn-next deploy` has shipped it to a live
 * kind + Knative + knext-operator cluster
 * (.github/workflows/file-manager-platform-e2e-nightly.yml). Every HTTP request
 * goes through the real ingress (Kourier, then activator/queue-proxy) with the
 * ksvc's Host header. Cluster state is read with kubectl.
 *
 * Three areas, per the issue:
 *   A. app functionality — the file-manager's own user flows;
 *   B. platform features — scale-to-zero + wake, ISR + authenticated
 *      invalidation, image optimization, health, metrics, NetworkPolicy, and a
 *      graceful rollout under load;
 *   C. deployment basics — static assets (content-type + cache policy) and RSC
 *      streaming.
 *
 * FAIL-CLOSED. There is no skip status. A missing prerequisite (env var,
 * kubectl, aws CLI) throws before any check runs. Every check either passes
 * with evidence or fails with a reason, and any failure exits 1. The
 * assertions live in `platform-e2e-checks.mjs`, where
 * `platform-e2e.selftest.mjs` proves each one can go red.
 *
 * Env (all required unless marked):
 *   PLATFORM_E2E_BASE_URL   the Kourier port-forward, e.g. http://127.0.0.1:8080
 *   PLATFORM_E2E_NAMESPACE  the app namespace (e.g. fm-e2e)
 *   CACHE_INVALIDATE_TOKEN  the token put in the app's Secret
 *   OBSERVABILITY_TOKEN     the token put in the app's Secret
 *   KN_NEXT_CLI             path to the built CLI (dist/cli/kn-next.js), for the rollout redeploy
 *   APP_DIR                 apps/file-manager (the redeploy's cwd)
 *   MINIO_LOCAL_ENDPOINT    port-forwarded MinIO, e.g. http://127.0.0.1:9000
 *   MINIO_ACCESS_KEY / MINIO_SECRET_KEY
 *   PLATFORM_E2E_SCRAPE_NAMESPACE  a namespace labelled knext.dev/metrics-scrape=true
 *   CURL_IMAGE              digest-pinned curl image for the in-cluster scrape pod
 *   PLATFORM_E2E_SUMMARY    (optional) file to append a markdown summary to
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  assertDeepHealthOk,
  assertImageOptimized,
  assertIsr,
  assertIsrKeysInRedis,
  assertObservabilityAuth,
  assertPrometheusText,
  assertRolloutClean,
  assertRscFlight,
  assertTagInvalidation,
  assertUploadAccepted,
  assertUploadStored,
  assertWoken,
  checkInvalidationEndpoint,
  checkMalformedUrls,
  checkPublicFiles,
  checkStaticAssets,
  checkStreaming,
  extensionOf,
  extractAssetRefs,
  findServerActionId,
  generatedAt,
  HOME_MARKER,
  isScaledToZero,
  ORDERS_CLASS,
  PRODUCTS_CLASS,
  SEEDED_USER_EMAIL,
} from './platform-e2e-checks.mjs';
import { createClient, encodeMultipart } from './platform-e2e-http.mjs';

const APP = 'file-manager';
const WAKE_CEILING_MS = 60000;
const SCALE_TO_ZERO_DEADLINE_MS = 240000;
const ROLLOUT_DEADLINE_MS = 300000;
// Every child process has a bound, so a hang fails fast with a NAMED command
// instead of surfacing as the job's 45-minute cancellation.
const KUBECTL_TIMEOUT_MS = 120000;
const AWS_TIMEOUT_MS = 60000;
const DEPLOY_TIMEOUT_MS = 600000;

// ---------------------------------------------------------------------------
// Preconditions: refuse, never skip.
// ---------------------------------------------------------------------------

/** @param {string} name */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `platform-e2e: ${name} is not set. This suite never skips a check whose ` +
        'prerequisite is missing: set it (the nightly workflow does), or do not run the suite.',
    );
  }
  return v.trim();
}

/** @param {string} bin @param {string[]} args */
function requireBinary(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 30000 });
  } catch {
    throw new Error(
      `platform-e2e: required binary "${bin}" is not runnable (${bin} ${args.join(' ')})`,
    );
  }
}

// ---------------------------------------------------------------------------
// kubectl
// ---------------------------------------------------------------------------

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

/** @param {string} ns @param {string} sql */
function psql(ns, sql) {
  return kubectl([
    'exec',
    '-n',
    ns,
    'deploy/postgres',
    '--',
    'psql',
    '-U',
    'postgres',
    '-d',
    'filemanager',
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    sql,
  ]);
}

/** @param {string} ns @param {string[]} argv */
function redisCli(ns, argv) {
  return kubectl(['exec', '-n', ns, 'deploy/redis', '--', 'redis-cli', ...argv]);
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

/** @type {{ area: string, name: string, status: 'PASS'|'FAIL', detail: string }[]} */
const results = [];

/**
 * @param {'A. app' | 'B. platform' | 'C. basics'} area
 * @param {string} name
 * @param {() => Promise<string> | string} fn
 */
async function check(area, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ area, name, status: 'PASS', detail: `${detail} (${Date.now() - t0}ms)` });
    console.log(`PASS  [${area}] ${name} — ${detail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ area, name, status: 'FAIL', detail: msg });
    console.log(`FAIL  [${area}] ${name} — ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const baseUrl = requireEnv('PLATFORM_E2E_BASE_URL');
  const ns = requireEnv('PLATFORM_E2E_NAMESPACE');
  const token = requireEnv('CACHE_INVALIDATE_TOKEN');
  const obsToken = requireEnv('OBSERVABILITY_TOKEN');
  const cli = requireEnv('KN_NEXT_CLI');
  const appDir = requireEnv('APP_DIR');
  const minioEndpoint = requireEnv('MINIO_LOCAL_ENDPOINT');
  const minioKey = requireEnv('MINIO_ACCESS_KEY');
  const minioSecret = requireEnv('MINIO_SECRET_KEY');
  const scrapeNs = requireEnv('PLATFORM_E2E_SCRAPE_NAMESPACE');
  const curlImage = requireEnv('CURL_IMAGE');
  if (!/@sha256:[0-9a-f]{64}$/.test(curlImage)) {
    throw new Error(`platform-e2e: CURL_IMAGE must be digest-pinned, got ${curlImage}`);
  }
  requireBinary('kubectl', ['version', '--client']);
  requireBinary('aws', ['--version']);
  requireBinary('node', ['--version']);

  // The ksvc URL is read, not assumed: its Host is what Kourier routes on.
  const ksvcUrl = kubectl(['get', 'ksvc', APP, '-n', ns, '-o', 'jsonpath={.status.url}']);
  if (!ksvcUrl)
    throw new Error(`platform-e2e: ksvc ${ns}/${APP} has no status.url — it never became routable`);
  const host = new URL(ksvcUrl).host;
  const http = createClient({ baseUrl, host });
  console.log(`platform-e2e: ${ksvcUrl} via ${baseUrl} (Host: ${host})`);

  const get = (/** @type {string} */ p, /** @type {Record<string,string>} */ headers = {}) =>
    http.request(p, { headers });

  // ── B. platform: the control plane did its job ───────────────────────────
  await check(
    'B. platform',
    'NextApp Ready=True, ksvc runs the digest kn-next deploy pushed',
    () => {
      const ready = kubectl([
        'get',
        'nextapp',
        APP,
        '-n',
        ns,
        '-o',
        'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
      ]);
      if (ready !== 'True') throw new Error(`NextApp Ready=${ready || '(absent)'}`);
      const specImage = kubectl(['get', 'nextapp', APP, '-n', ns, '-o', 'jsonpath={.spec.image}']);
      if (!/^localhost:5001\/file-manager(:[\w.-]+)?@sha256:[0-9a-f]{64}$/.test(specImage)) {
        throw new Error(
          `NextApp spec.image "${specImage}" is not the digest-pinned in-cluster push`,
        );
      }
      const ksvcImage = kubectl([
        'get',
        'ksvc',
        APP,
        '-n',
        ns,
        '-o',
        'jsonpath={.spec.template.spec.containers[0].image}',
      ]);
      if (ksvcImage !== specImage)
        throw new Error(`ksvc image "${ksvcImage}" != NextApp spec.image "${specImage}"`);
      return specImage;
    },
  );

  await check(
    'B. platform',
    'NetworkPolicy reconciled by the operator, selecting the app pods',
    () => {
      const np = JSON.parse(
        kubectl(['get', 'networkpolicy', `${APP}-allow-ingress`, '-n', ns, '-o', 'json']),
      );
      if (np.metadata?.labels?.['generated-by'] !== 'kn-next-operator') {
        throw new Error(
          `NetworkPolicy not operator-generated: labels ${JSON.stringify(np.metadata?.labels)}`,
        );
      }
      const sel = np.spec?.podSelector?.matchLabels?.['serving.knative.dev/service'];
      if (sel !== APP)
        throw new Error(
          `NetworkPolicy podSelector ${JSON.stringify(np.spec?.podSelector)} does not select ${APP}`,
        );
      if (!np.spec?.ingress?.length) throw new Error('NetworkPolicy has no ingress rules');
      return `${np.metadata.name}: ${np.spec.ingress.length} ingress rules`;
    },
  );

  // ── A. app functionality ─────────────────────────────────────────────────
  await check('A. app', 'GET / renders the home page (middleware header present)', async () => {
    const res = await get('/');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    if (!res.text.includes(HOME_MARKER)) throw new Error('home marker missing');
    if (res.headers['x-knext-smoke'] !== '1')
      throw new Error(`middleware header x-knext-smoke=${res.headers['x-knext-smoke']}`);
    return `200 ${res.body.length}B, x-knext-smoke=1`;
  });

  await check('A. app', 'GET /setup initialises the database (tables + seed)', async () => {
    const res = await get('/setup');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    if (!res.text.includes('Database initialized successfully')) {
      throw new Error(`setup did not succeed: ${res.text.replace(/<[^>]+>/g, ' ').slice(0, 300)}`);
    }
    const users = psql(ns, 'SELECT count(*) FROM users');
    if (Number(users) < 3) throw new Error(`users table has ${users} rows after setup`);
    return `tables created, ${users} users seeded`;
  });

  await check('A. app', 'GET /users lists the seeded users from Postgres', async () => {
    const res = await get('/users');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    if (!res.text.includes(SEEDED_USER_EMAIL)) throw new Error(`${SEEDED_USER_EMAIL} not listed`);
    return `lists ${SEEDED_USER_EMAIL}`;
  });

  await check('A. app', 'Add user: no-JS server action POST, then listed', async () => {
    const page = await get('/users');
    const id = /name="(\$ACTION_ID_[^"]+)"/.exec(page.text)?.[1];
    if (!id)
      throw new Error(
        'no $ACTION_ID_ field on /users — the addUser form is not wired to a server action',
      );
    const email = `e2e-${Date.now().toString(36)}@example.com`;
    const { boundary, body } = encodeMultipart([
      [id, ''],
      ['name', 'Platform E2E'],
      ['email', email],
    ]);
    const res = await http.request('/users', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, accept: 'text/html' },
      body,
    });
    if (res.status < 200 || res.status >= 400) throw new Error(`action POST HTTP ${res.status}`);
    const row = psql(ns, `SELECT email FROM users WHERE email='${email}'`);
    if (row !== email) throw new Error(`user ${email} not inserted (psql: "${row}")`);
    const after = await get('/users');
    if (!after.text.includes(email)) throw new Error(`${email} inserted but not listed on /users`);
    return `inserted + listed ${email}`;
  });

  await check('A. app', 'GET /api/audit returns the seeded audit log page (JSON)', async () => {
    const res = await get('/api/audit?page=0');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    const json = JSON.parse(res.text);
    if (!(Array.isArray(json.logs) && json.logs.length > 0 && json.total >= 1000)) {
      throw new Error(`unexpected audit payload: ${res.text.slice(0, 200)}`);
    }
    return `${json.logs.length} logs, total ${json.total}`;
  });

  await check('A. app', 'GET /audit (client page) and /dashboard render', async () => {
    const audit = await get('/audit');
    if (audit.status !== 200 || !audit.text.includes('Audit Logs'))
      throw new Error(`/audit HTTP ${audit.status}`);
    const dash = await get('/dashboard');
    if (dash.status !== 200 || !dash.text.includes('Total Users'))
      throw new Error(`/dashboard HTTP ${dash.status}`);
    return '/audit 200, /dashboard 200';
  });

  await check(
    'A. app',
    'Upload a file (the client server action) → listed on / and /dashboard → bytes in object storage',
    async () => {
      // The upload form is a CLIENT component, so there is no no-JS path. Call the
      // action the way the browser does: find its id in the client JS the page
      // loads, then POST the React reply encoding with x-rsc-action.
      const home = await get('/');
      const scripts = extractAssetRefs(home.text).filter((p) =>
        ['.js', '.mjs'].includes(extensionOf(p)),
      );
      /** @type {string[]} */
      const texts = [];
      const seen = new Set();
      const queue = [...scripts];
      while (queue.length && seen.size < 200) {
        const p = /** @type {string} */ (queue.shift());
        if (seen.has(p)) continue;
        seen.add(p);
        const r = await get(p);
        if (r.status !== 200) continue;
        texts.push(r.text);
        for (const m of r.text.matchAll(
          /(?:from|import)\s*\(?\s*["'`](\.{1,2}\/[^"'`]+\.m?js)["'`]/g,
        )) {
          queue.push(new URL(m[1], `http://x${p}`).pathname);
        }
      }
      const actionId = findServerActionId(texts, 'uploadFile');
      const name = `platform-e2e-${Date.now().toString(36)}.txt`;
      const data = Buffer.from(`knext platform e2e ${name} ${Math.random().toString(36)}\n`);
      const { boundary, body } = encodeMultipart([
        ['0', '["$K1"]'],
        ['_1_file', { filename: name, contentType: 'text/plain', data }],
      ]);
      const res = await http.request('/', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'x-rsc-action': actionId,
          accept: 'text/x-component',
          origin: `http://${host}`,
        },
        body,
      });
      const accepted = assertUploadAccepted(res);
      const listed = await get('/');
      if (!listed.text.includes(name)) throw new Error(`uploaded ${name} is not listed on /`);
      const dash = await get('/dashboard');
      if (!dash.text.includes(name))
        throw new Error(`uploaded ${name} is not in /dashboard recent files`);
      const dbRow = psql(ns, `SELECT storage_path FROM files WHERE name='${name}'`);
      const stored = execFileSync(
        'aws',
        ['s3', 'cp', `s3://assets/${name}`, '-', '--endpoint-url', minioEndpoint],
        {
          env: {
            ...process.env,
            AWS_ACCESS_KEY_ID: minioKey,
            AWS_SECRET_ACCESS_KEY: minioSecret,
            AWS_DEFAULT_REGION: 'us-east-1',
            AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
            AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
          },
          maxBuffer: 16 * 1024 * 1024,
          timeout: AWS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      const storedEv = assertUploadStored({
        dbRow,
        expectedPath: `assets/${name}`,
        sent: data,
        stored,
      });
      return `action ${actionId}; ${accepted}; listed on / and /dashboard; ${storedEv}`;
    },
  );

  await check(
    'A. app',
    'Server action round-trip (no-JS form on /knext-smoke/stream)',
    async () => {
      const page = await get('/knext-smoke/stream');
      const id = /name="(\$ACTION_ID_[^"]+)"/.exec(page.text)?.[1];
      if (!id) throw new Error('no $ACTION_ID_ field in the fixture form');
      const nonce = `act-${Math.random().toString(36).slice(2, 12)}`;
      const { boundary, body } = encodeMultipart([
        [id, ''],
        ['knextEcho', nonce],
      ]);
      const res = await http.request('/knext-smoke/stream', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          accept: 'text/html',
        },
        body,
      });
      if (res.status < 200 || res.status >= 400) throw new Error(`action POST HTTP ${res.status}`);
      const setCookie = [].concat(res.headers['set-cookie'] || []).join('; ');
      if (!setCookie.includes(nonce))
        throw new Error(`action did not run: set-cookie "${setCookie || 'none'}"`);
      const back = await get('/knext-smoke/stream', { cookie: `knext-smoke-echo=${nonce}` });
      if (!back.text.includes(`data-knext-action-echo="${nonce}"`))
        throw new Error('action effect not rendered back');
      return `echoed ${nonce}`;
    },
  );

  await check('A. app', 'API routes: /api/health, /api/cache-stats return JSON', async () => {
    const h = await get('/api/health');
    if (h.status !== 200 || typeof JSON.parse(h.text) !== 'object')
      throw new Error(`/api/health HTTP ${h.status}`);
    const c = await get('/api/cache-stats');
    const cj = JSON.parse(c.text);
    if (c.status !== 200 || typeof cj.cache !== 'object')
      throw new Error(`/api/cache-stats HTTP ${c.status}: ${c.text.slice(0, 120)}`);
    return `/api/health ${h.status}, /api/cache-stats ${c.status}`;
  });

  await check('A. app', 'RUM ingest: malformed beacon 400, valid beacon 204', async () => {
    const post = (/** @type {string} */ s) =>
      http.request('/api/rum', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: s,
      });
    const bad = await post('{"metric":"NOPE","value":-1}');
    if (bad.status !== 400) throw new Error(`malformed beacon got ${bad.status}, expected 400`);
    const good = await post(
      JSON.stringify({ metric: 'LCP', value: 1234, rating: 'good', pathname: '/' }),
    );
    if (good.status !== 204) throw new Error(`valid beacon got ${good.status}, expected 204`);
    return '400 / 204';
  });

  await check(
    'A. app',
    'Auth: /observability is 401 without/with a wrong token and 200 with the right one',
    async () => {
      const none = await get('/observability');
      const wrong = await get('/observability', { authorization: `Bearer ${obsToken}-wrong` });
      const right = await get('/observability', { authorization: `Bearer ${obsToken}` });
      return assertObservabilityAuth({ none, wrong, right });
    },
  );

  await check('A. app', 'Unknown route is a real 404', async () => {
    const res = await get(`/definitely-not-a-route-${Date.now()}`);
    if (res.status !== 404) throw new Error(`HTTP ${res.status}, expected 404`);
    return '404';
  });

  await check(
    'A. app',
    'Malformed request paths are refused with a 4xx, the app keeps serving, no container restarts',
    async () => {
      /** Restarts of the app pods' non-sidecar containers, summed. */
      const appRestarts = () =>
        JSON.parse(
          kubectl([
            'get',
            'pods',
            '-n',
            ns,
            '-l',
            `serving.knative.dev/service=${APP}`,
            '-o',
            'json',
          ]),
        )
          .items.flatMap((/** @type {any} */ p) => p.status?.containerStatuses ?? [])
          .filter((/** @type {any} */ c) => c.name !== 'queue-proxy')
          .reduce((/** @type {number} */ n, /** @type {any} */ c) => n + (c.restartCount ?? 0), 0);
      await get('/'); // make sure a pod is up before the baseline
      const before = appRestarts();
      const evidence = await checkMalformedUrls(http.request);
      const after = appRestarts();
      if (after !== before) {
        throw new Error(`app container restarts went ${before} -> ${after} during the probes`);
      }
      return `${evidence}; restarts ${before} -> ${after}`;
    },
  );

  // ── C. deployment basics ─────────────────────────────────────────────────
  await check(
    'C. basics',
    'Static assets referenced by the served HTML + fonts from its CSS',
    async () => {
      const { summary, evidence } = await checkStaticAssets(http.request);
      console.log(evidence.map((e) => `      ${e}`).join('\n'));
      return summary;
    },
  );

  await check(
    'C. basics',
    'public/ files: SVG, PNG, favicon served with correct types, not immutable',
    () => checkPublicFiles(http.request),
  );

  await check('C. basics', 'RSC streaming: chunked, fallback first, resolved content later', () =>
    checkStreaming(http.request),
  );

  await check('C. basics', 'RSC flight payload (RSC: 1) is text/x-component', async () => {
    let res = await get('/', { RSC: '1' });
    if (res.status === 307 || res.status === 308) {
      const loc = String(res.headers.location ?? '');
      if (!loc.startsWith('/')) throw new Error(`RSC redirect left the origin: ${loc}`);
      res = await get(loc, { RSC: '1' });
    }
    return assertRscFlight(res);
  });

  // ── B. platform features ─────────────────────────────────────────────────
  await check(
    'B. platform',
    'Health: /api/health 200; /api/health/deep ok with live Postgres + Redis',
    async () => {
      const h = await get('/api/health');
      if (h.status !== 200) throw new Error(`/api/health HTTP ${h.status}`);
      return assertDeepHealthOk(await get('/api/health/deep'));
    },
  );

  await check('B. platform', 'ISR served from the in-cluster Redis and revalidated', async () => {
    const read = async () => {
      const res = await get('/knext-smoke/isr');
      if (res.status !== 200) throw new Error(`/knext-smoke/isr HTTP ${res.status}`);
      const v = /data-knext-isr-value="([\w-]+)"/.exec(res.text)?.[1];
      if (!v) throw new Error('ISR value marker missing');
      return {
        value: v,
        cacheState: /** @type {string|undefined} */ (res.headers['x-nextjs-cache']),
      };
    };
    await read();
    const r1 = await read();
    const r2 = await read();
    let later = r1.value;
    const deadline = Date.now() + 30000;
    await sleep(1500);
    while (Date.now() < deadline && later === r1.value) {
      later = (await read()).value;
      if (later === r1.value) await sleep(500);
    }
    const isr = assertIsr({ reads: [r1, r2], first: r1.value, later });
    const all = redisCli(ns, ['--scan', '--pattern', '*knext-smoke/isr*'])
      .split('\n')
      .filter(Boolean);
    // `<prefix>:tag:<tag>` is the tag -> paths INDEX (a persistent set), not the
    // page entry. The entry is every other matching key, and it carries the TTL.
    const keys = all.filter((k) => !k.includes(':tag:'));
    const ttls = keys.map((k) => Number(redisCli(ns, ['TTL', k])));
    try {
      return `${isr}; ${assertIsrKeysInRedis({ keys, ttls })}`;
    } catch (err) {
      const seen = all.map((k) => `${k} (TTL ${redisCli(ns, ['TTL', k])})`).join(', ');
      throw new Error(
        `${err instanceof Error ? err.message : err} [redis keys: ${seen || 'none'}]`,
      );
    }
  });

  await check(
    'B. platform',
    'Invalidation: 401 without/with wrong token; right token busts ONLY its tag',
    async () => {
      const page = '/cache-tests/on-demand';
      const read = async () => {
        const res = await get(page);
        if (res.status !== 200) throw new Error(`${page} HTTP ${res.status}`);
        return {
          products: generatedAt(res.text, PRODUCTS_CLASS),
          orders: generatedAt(res.text, ORDERS_CLASS),
        };
      };
      await read();
      const before = await read();
      const auth = await checkInvalidationEndpoint(http.request, token, 'products', async () => {
        // The refused attempts must not have busted anything.
        const between = await read();
        if (between.products !== before.products) {
          throw new Error(
            'products changed after only UNAUTHENTICATED invalidate calls — the 401 did not stop the mutation',
          );
        }
      });
      let after = await read();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && after.products === before.products) {
        await sleep(500);
        after = await read();
      }
      return `${auth}; ${assertTagInvalidation({ before, after })}`;
    },
  );

  await check(
    'B. platform',
    'Image optimization: /_next/image negotiates webp and re-encodes smaller',
    async () => {
      const src = '/knext-optimize-fixture.png';
      const source = await get(src);
      const optimized = await get(`/_next/image?url=${encodeURIComponent(src)}&w=128&q=75`, {
        accept: 'image/webp,image/*,*/*',
      });
      return assertImageOptimized({ source, optimized });
    },
  );

  await check(
    'B. platform',
    'Metrics: /api/metrics through the route is Prometheus text',
    async () => {
      const res = await get('/api/metrics');
      if (res.status !== 200) throw new Error(`/api/metrics HTTP ${res.status}`);
      return assertPrometheusText(res.text, /^kn_next_http_requests_total\b/m);
    },
  );

  await check(
    'B. platform',
    'Metrics: the annotated metrics port answers a scrape from a knext.dev/metrics-scrape namespace',
    async () => {
      await get('/'); // make sure a pod is up
      const pods = JSON.parse(
        kubectl([
          'get',
          'pods',
          '-n',
          ns,
          '-l',
          `serving.knative.dev/service=${APP}`,
          '--field-selector=status.phase=Running',
          '-o',
          'json',
        ]),
      ).items;
      if (!pods.length) throw new Error('no running app pod to scrape');
      const pod = pods[0];
      const port = pod.metadata?.annotations?.['prometheus.io/port'];
      const path = pod.metadata?.annotations?.['prometheus.io/path'] ?? '/metrics';
      if (!port)
        throw new Error(`pod ${pod.metadata.name} carries no prometheus.io/port annotation`);
      const ip = pod.status?.podIP;
      const podName = `scrape-${Date.now().toString(36)}`;
      kubectl([
        'run',
        podName,
        '-n',
        scrapeNs,
        `--image=${curlImage}`,
        '--restart=Never',
        '--command',
        '--',
        'curl',
        '-sS',
        '-f',
        '--max-time',
        '20',
        `http://${ip}:${port}${path}`,
      ]);
      try {
        kubectl([
          'wait',
          '-n',
          scrapeNs,
          `pod/${podName}`,
          '--for=jsonpath={.status.phase}=Succeeded',
          '--timeout=120s',
        ]);
      } catch (err) {
        const logs = (() => {
          try {
            return kubectl(['logs', '-n', scrapeNs, podName]);
          } catch {
            return '(no logs)';
          }
        })();
        throw new Error(
          `scrape pod did not succeed: ${err instanceof Error ? err.message : err}; logs: ${logs.slice(0, 400)}`,
        );
      }
      const text = kubectl(['logs', '-n', scrapeNs, podName]);
      kubectl(['delete', 'pod', '-n', scrapeNs, podName, '--wait=false']);
      return `${ip}:${port}${path} — ${assertPrometheusText(text, /^\w+_http_requests_total\b/m)}`;
    },
  );

  // ── B. platform: scale-to-zero, then wake ────────────────────────────────
  await check(
    'B. platform',
    'Scale-to-zero: revision reaches 0 replicas and 0 pods, ksvc stays Ready',
    async () => {
      const rev = kubectl([
        'get',
        'ksvc',
        APP,
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
        if (isScaledToZero({ specReplicas: replicas === '' ? null : Number(replicas), pods }))
          break;
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
        APP,
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
    'B. platform',
    'Wake from zero: one request through the activator returns the home page',
    async () => {
      const t0 = Date.now();
      const res = await http.request('/', { headers: {} });
      return assertWoken({
        status: res.status,
        text: res.text,
        ms: Date.now() - t0,
        ceilingMs: WAKE_CEILING_MS,
      });
    },
  );

  // ── B. platform: graceful rollout under load ─────────────────────────────
  await check(
    'B. platform',
    'Graceful rollout: second `kn-next deploy --image` under load drops nothing',
    async () => {
      const before = kubectl([
        'get',
        'ksvc',
        APP,
        '-n',
        ns,
        '-o',
        'jsonpath={.status.latestReadyRevisionName}',
      ]);
      const image = kubectl(['get', 'nextapp', APP, '-n', ns, '-o', 'jsonpath={.spec.image}']);
      /** @type {{ status?: number, error?: string }[]} */
      const loadResults = [];
      let stop = false;
      const worker = async () => {
        while (!stop) {
          try {
            const r = await http.request('/knext-smoke/stream');
            loadResults.push({ status: r.status });
          } catch (err) {
            loadResults.push({ error: err instanceof Error ? err.message : String(err) });
          }
        }
      };
      const workers = Array.from({ length: 4 }, worker);
      try {
        await sleep(2000);
        const tag = `${process.env.GITHUB_RUN_ID ?? Date.now()}-rollout`;
        await new Promise((resolve, reject) => {
          const child = spawn(
            'node',
            [cli, 'deploy', '--image', image, '--tag', tag, '--namespace', ns],
            {
              cwd: appDir,
              stdio: 'inherit',
            },
          );
          const killer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(
              new Error(`kn-next deploy --image did not finish within ${DEPLOY_TIMEOUT_MS}ms`),
            );
          }, DEPLOY_TIMEOUT_MS);
          child.on('error', reject);
          child.on('exit', (code) => {
            clearTimeout(killer);
            return code === 0
              ? resolve(undefined)
              : reject(new Error(`kn-next deploy --image exited ${code}`));
          });
        });
        const t0 = Date.now();
        let after = before;
        let oldPods = -1;
        while (Date.now() - t0 < ROLLOUT_DEADLINE_MS) {
          after = kubectl([
            'get',
            'ksvc',
            APP,
            '-n',
            ns,
            '-o',
            'jsonpath={.status.latestReadyRevisionName}',
          ]);
          const traffic = kubectl([
            'get',
            'ksvc',
            APP,
            '-n',
            ns,
            '-o',
            'jsonpath={.status.traffic[0].revisionName}',
          ]);
          oldPods = kubectl([
            'get',
            'pods',
            '-n',
            ns,
            '-l',
            `serving.knative.dev/revision=${before}`,
            '-o',
            'name',
          ])
            .split('\n')
            .filter(Boolean).length;
          if (after !== before && traffic === after && oldPods === 0) break;
          await sleep(2000);
        }
        await sleep(3000); // keep load on the new revision briefly
        stop = true;
        await Promise.all(workers);
        if (oldPods !== 0)
          throw new Error(
            `old revision ${before} still has ${oldPods} pod(s) after ${ROLLOUT_DEADLINE_MS}ms`,
          );
        return assertRolloutClean({ results: loadResults, before, after, minRequests: 20 });
      } finally {
        // Whatever happens (deploy failed, kubectl hung), the load loop must end.
        stop = true;
      }
    },
  );

  // ── report ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === 'FAIL');
  const areas = ['A. app', 'B. platform', 'C. basics'];
  const lines = ['## File-manager platform e2e', '', '| Area | Pass | Fail |', '|---|---|---|'];
  for (const a of areas) {
    const rs = results.filter((r) => r.area === a);
    lines.push(
      `| ${a} | ${rs.filter((r) => r.status === 'PASS').length} | ${rs.filter((r) => r.status === 'FAIL').length} |`,
    );
  }
  lines.push('', '| | Area | Check | Evidence |', '|---|---|---|---|');
  for (const r of results) {
    lines.push(
      `| ${r.status === 'PASS' ? 'PASS' : '**FAIL**'} | ${r.area} | ${r.name} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 400)} |`,
    );
  }
  const md = `${lines.join('\n')}\n`;
  console.log(`\n${md}`);
  if (process.env.PLATFORM_E2E_SUMMARY) appendFileSync(process.env.PLATFORM_E2E_SUMMARY, md);
  writeFileSync('platform-e2e-results.json', JSON.stringify(results, null, 2));
  if (failed.length > 0) {
    console.error(`platform-e2e: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`platform-e2e: all ${results.length} checks passed`);
}

main().catch((err) => {
  console.error(`platform-e2e: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
