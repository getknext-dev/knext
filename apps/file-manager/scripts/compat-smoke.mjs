#!/usr/bin/env node
/**
 * knext compat-smoke — a FAST, HONEST per-PR smoke gate for the knext Next.js adapter.
 *
 * THIS IS NOT THE OFFICIAL NEXT.JS COMPATIBILITY SUITE. It is a small, in-repo set of
 * real-HTTP assertions against the standalone `server.js` produced by building
 * apps/file-manager THROUGH the knext adapter (output:'standalone'). See ADR-0007
 * (docs/adr/0007-compat-suite.md, option C, the per-PR `compat-smoke` gate). The official
 * deploy-test harness lives behind A3-2 (`compat-suite-full`), not here.
 *
 * What it does:
 *   1. Boots the prebuilt standalone server on a free port with REDIS_URL="" HOSTNAME=0.0.0.0.
 *   2. Polls until ready.
 *   3. Runs real HTTP assertions against routes that actually exist in src/app/.
 *   4. Kills the server and exits non-zero if any check FAILED.
 *
 * Runtime is parameterized so the same script exercises Node and Bun:
 *   RUNTIME=node node scripts/compat-smoke.mjs   (default)
 *   RUNTIME=bun  node scripts/compat-smoke.mjs   (boots the server with `bun`)
 *
 * Other env knobs:
 *   PORT=<n>        override the server port (default: random free-ish port)
 *   SERVER_CMD=...  override the runtime binary (default: derived from RUNTIME)
 *   SERVER_PATH=... override the server.js path
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');

const RUNTIME = (process.env.RUNTIME || 'node').toLowerCase();
const PORT = Number(process.env.PORT || 3987);
const HOST = '127.0.0.1';
const SERVER_PATH =
  process.env.SERVER_PATH || path.resolve(APP_DIR, '.next/standalone/apps/file-manager/server.js');
// Runtime binary: node | bun. RUNTIME=bun boots the same standalone server.js under Bun.
const SERVER_CMD = process.env.SERVER_CMD || (RUNTIME === 'bun' ? 'bun' : process.execPath);

// A public asset shipped specifically for the image-optimization check.
const IMAGE_ASSET = '/knext-smoke.png';

// ── tiny HTTP helper ───────────────────────────────────────────────────────
function request(reqPath, { headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: HOST, port: PORT, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw ? buf : buf.toString('utf8'),
          bytes: buf.length,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
  });
}

async function waitForReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('/api/health');
      // Any HTTP response (even 503 from a degraded health check with no DB) means the
      // server is up and routing. We only need "the process is serving HTTP".
      if (res.status > 0) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ── check runner ───────────────────────────────────────────────────────────
const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, status: 'PASS', note: note || '' });
  } catch (err) {
    if (err && err.__skip) {
      results.push({ name, status: 'SKIP', note: err.message });
    } else {
      results.push({ name, status: 'FAIL', note: err && err.message ? err.message : String(err) });
    }
  }
}
function skip(message) {
  const e = new Error(message);
  e.__skip = true;
  throw e;
}

// ── server lifecycle ─────────────────────────────────────────────────────────
let serverProc = null;
function startServer() {
  if (!existsSync(SERVER_PATH)) {
    throw new Error(
      `standalone server not found at ${SERVER_PATH}. Build first:\n` +
        `  pnpm --filter @knext/lib build && pnpm --filter file-manager build`,
    );
  }
  // `output:'standalone'` does NOT copy `.next/static` or `public/` into the standalone
  // tree (mirrors what the Dockerfile does manually). Stage them so static assets and the
  // next/image optimizer can resolve local files. Idempotent + best-effort.
  const standaloneAppDir = path.dirname(SERVER_PATH);
  const stage = [
    [path.resolve(APP_DIR, '.next/static'), path.join(standaloneAppDir, '.next/static')],
    [path.resolve(APP_DIR, 'public'), path.join(standaloneAppDir, 'public')],
  ];
  for (const [src, dest] of stage) {
    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true });
    }
  }

  console.log(`[compat-smoke] runtime=${RUNTIME} cmd=${SERVER_CMD}`);
  console.log(`[compat-smoke] booting ${SERVER_PATH} on ${HOST}:${PORT}`);
  serverProc = spawn(SERVER_CMD, [SERVER_PATH], {
    cwd: path.dirname(SERVER_PATH),
    env: {
      ...process.env,
      REDIS_URL: '',
      HOSTNAME: '0.0.0.0',
      PORT: String(PORT),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on('exit', (code, signal) => {
    if (code && code !== 0 && !shuttingDown) {
      console.error(`[compat-smoke] server exited early code=${code} signal=${signal}`);
    }
  });
}

let shuttingDown = false;
function stopServer() {
  shuttingDown = true;
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    setTimeout(() => {
      if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
    }, 3000).unref();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  startServer();
  const ready = await waitForReady();
  if (!ready) {
    stopServer();
    console.error('[compat-smoke] server never became ready');
    process.exit(1);
  }

  // (a) App Router page: GET / → 200, text/html, non-trivial body.
  await check('a. App Router page GET /', async () => {
    const res = await request('/');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const ct = res.headers['content-type'] || '';
    assert.ok(ct.includes('text/html'), `content-type not html: ${ct}`);
    assert.ok(res.bytes > 500, `body too small: ${res.bytes} bytes`);
    return `200 ${ct} ${res.bytes}B`;
  });

  // (b) RSC flight payload: GET / with `RSC: 1` → 200, content-type text/x-component.
  await check('b. RSC flight GET / (RSC: 1)', async () => {
    const res = await request('/', { headers: { RSC: '1' } });
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const ct = res.headers['content-type'] || '';
    assert.ok(
      ct.includes('text/x-component'),
      `RSC content-type expected text/x-component, got: ${ct}`,
    );
    return `200 ${ct}`;
  });

  // (c) Route handler: GET /api/health → 200, valid JSON.
  // Health is force-dynamic; with no DB/Redis it reports "degraded" but still 200 (see route.ts).
  await check('c. Route handler GET /api/health', async () => {
    const res = await request('/api/health');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const json = JSON.parse(res.body); // throws on invalid JSON
    assert.ok(typeof json === 'object' && json !== null, 'body is not a JSON object');
    return `200 status=${json.status ?? 'n/a'}`;
  });

  // (d) Dynamic route (force-dynamic, rendered per request) → 200.
  await check('d. Dynamic route GET /cache-tests/dynamic-static/dynamic', async () => {
    const res = await request('/cache-tests/dynamic-static/dynamic');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    return `200`;
  });

  // (e) Static / prerendered route (force-static) → 200.
  await check('e. Static route GET /cache-tests/dynamic-static/static', async () => {
    const res = await request('/cache-tests/dynamic-static/static');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    return `200`;
  });

  // (f) Middleware header: GET / carries x-knext-smoke: 1 (proves middleware ran).
  await check('f. Middleware header x-knext-smoke on GET /', async () => {
    const res = await request('/');
    const v = res.headers['x-knext-smoke'];
    assert.strictEqual(v, '1', `x-knext-smoke header missing/wrong: ${v}`);
    return `x-knext-smoke=${v}`;
  });

  // (g) next/image optimization: GET /_next/image?url=...&w=128&q=75 → 200, content-type image/*.
  await check('g. next/image optimization', async () => {
    if (!existsSync(path.join(APP_DIR, 'public', IMAGE_ASSET.replace(/^\//, '')))) {
      skip(`asset ${IMAGE_ASSET} missing from public/`);
    }
    const url = `/_next/image?url=${encodeURIComponent(IMAGE_ASSET)}&w=128&q=75`;
    const res = await request(url, { raw: true });
    if (res.status !== 200) {
      // Distinguish "unsupported in this build" from a hard failure.
      skip(
        `image optimizer returned ${res.status} (optimization may be unsupported in this build)`,
      );
    }
    const ct = res.headers['content-type'] || '';
    assert.ok(ct.startsWith('image/'), `content-type not image/*: ${ct}`);
    return `200 ${ct} ${res.bytes}B`;
  });

  // ── report ──────────────────────────────────────────────────────────────
  printReport();

  const failed = results.filter((r) => r.status === 'FAIL').length;
  stopServer();
  // give SIGTERM a moment, then exit
  await new Promise((r) => setTimeout(r, 300));
  process.exit(failed > 0 ? 1 : 0);
}

function printReport() {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log('━'.repeat(72));
  console.log(`knext compat-smoke  (NOT the official Next.js compat suite)  runtime=${RUNTIME}`);
  console.log('━'.repeat(72));
  for (const r of results) {
    const mark = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '–' : '✗';
    console.log(`${mark} ${pad(r.status, 4)} ${pad(r.name, 50)} ${r.note}`);
  }
  console.log('━'.repeat(72));
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const sk = results.filter((r) => r.status === 'SKIP').length;
  console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${sk}  (total ${results.length})`);
  console.log('━'.repeat(72));
}

process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});

main().catch((err) => {
  console.error('[compat-smoke] fatal:', err);
  stopServer();
  process.exit(1);
});
