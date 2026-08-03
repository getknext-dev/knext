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
 * NO CHECK IN HERE MAY SKIP ON FAILURE (Sprint 1, T4). A capability whose check downgrades a
 * failure to SKIP is indistinguishable from a broken one — that is exactly how four rows of
 * docs/compat-matrix.md ended up implemented-but-unbacked. The only SKIP this script emits is
 * the runtime-LANE filter, which declares "this check does not apply to this runtime".
 *
 * What it does:
 *   1. Boots the prebuilt standalone server on a free port with HOSTNAME=0.0.0.0 and the
 *      REDIS_URL it inherits (check (k) requires a real one; CI supplies a service container).
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
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQuarantineLedger, smokeQuarantineCount } from './compat-smoke-quarantines.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '../..');

const RUNTIME = (process.env.RUNTIME || 'node').toLowerCase();
const PORT = Number(process.env.PORT || 3987);
const HOST = '127.0.0.1';
const SERVER_PATH =
  process.env.SERVER_PATH || path.resolve(APP_DIR, '.next/standalone/apps/file-manager/server.js');
// Runtime binary: node | bun. RUNTIME=bun boots the same standalone server.js under Bun.
const SERVER_CMD = process.env.SERVER_CMD || (RUNTIME === 'bun' ? 'bun' : process.execPath);

// #188 — Bun ≤1.3.x keep-alive mitigation preload (bun runtime only; the Node
// boot args stay byte-identical). Resolved from the built workspace package,
// falling back to the in-repo source (both are dependency-free CJS).
const BUN_GUARD_CANDIDATES = [
  path.resolve(APP_DIR, '../../packages/kn-next/dist/adapters/bun-keepalive-guard.cjs'),
  path.resolve(APP_DIR, '../../packages/kn-next/src/adapters/bun-keepalive-guard.cjs'),
];
const BUN_GUARD_PRELOAD = BUN_GUARD_CANDIDATES.find((p) => existsSync(p));

// A public asset shipped specifically for the image-optimization check. It is deliberately a
// LARGE png (~180 KB): check (g) asserts the optimized output is materially SMALLER than the
// source, which an 82-byte placeholder cannot demonstrate.
const IMAGE_ASSET = '/knext-optimize-fixture.png';

// compat-smoke fixture routes (apps/file-manager/src/app/knext-smoke/**). They exist only to
// give checks (i), (j) and (k) their own named evidence.
const FIXTURE_STREAM = '/knext-smoke/stream';
const FIXTURE_ISR = '/knext-smoke/isr';

// A REAL Redis. Unlike every other knob here this one is NOT defaulted to "" any more: check
// (k) asserts ISR against a real cache backend, and CI (.github/workflows/ci.yml, the
// compat-smoke job) provides one as a service container. Absence is a FAILURE, never a skip.
const REDIS_URL = process.env.REDIS_URL || '';

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

/**
 * Like `request()`, but records the ARRIVAL TIME of every response chunk.
 *
 * Check (j) needs this: a buffered (non-streamed) response reproduces the final body
 * byte-for-byte, so the only observable difference between "streamed" and "buffered" is
 * WHEN each byte arrives. Returns `{ status, headers, chunks: [{ at, text }], body }`
 * where `at` is ms since the request was issued.
 */
function requestChunks(reqPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get({ hostname: HOST, port: PORT, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push({ at: Date.now() - t0, text: d.toString('utf8') }));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          chunks,
          body: chunks.map((c) => c.text).join(''),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
  });
}

/** POST a body with explicit headers (used for the Server Action form submit). */
function post(reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: reqPath,
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
    req.write(body);
    req.end();
  });
}

/**
 * Build a `multipart/form-data` body — the encoding React uses for a `<form action={fn}>`
 * server-action submit in the no-JavaScript progressive-enhancement path.
 */
function multipart(fields) {
  const boundary = `----knextsmoke${Math.random().toString(36).slice(2)}`;
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return { boundary, body: `${parts.join('')}--${boundary}--\r\n` };
}

/**
 * `DBSIZE` against a real Redis, spoken as raw RESP over a socket (no dependency).
 * Check (k) uses it as the NAMED evidence that the ISR cache landed in the configured
 * Redis rather than the in-memory fallback.
 */
function redisDbSize(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`REDIS_URL is not a URL: ${url}`));
      return;
    }
    const sock = net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
    });
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('redis DBSIZE timeout')));
    let buf = '';
    sock.on('connect', () => sock.write('*1\r\n$6\r\nDBSIZE\r\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (!buf.includes('\r\n')) return;
      sock.end();
      const line = buf.slice(0, buf.indexOf('\r\n'));
      if (!line.startsWith(':')) {
        reject(new Error(`unexpected DBSIZE reply: ${JSON.stringify(line)}`));
        return;
      }
      resolve(Number(line.slice(1)));
    });
    sock.on('error', reject);
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
// The lane this run exercises (#281): the runtime axis the compat-matrix already
// splits on. Each check declares the lane(s) it applies to; a check NOT in the
// active lane is SKIPPED, so a node-only check can never red the bun lane (and
// vice-versa). Default = both lanes.
const LANE = RUNTIME === 'bun' ? 'bun' : 'node';

const results = [];
async function check(name, fn, lanes = ['node', 'bun']) {
  // Lane filter (#281): if this check does not apply to the active lane, record a
  // lane-scoped SKIP and do NOT run it — its verdict never crosses into this lane.
  if (!lanes.includes(LANE)) {
    results.push({ name, status: 'SKIP', lane: LANE, note: `not in "${LANE}" lane` });
    return;
  }
  try {
    const note = await fn();
    results.push({ name, status: 'PASS', lane: LANE, note: note || '' });
  } catch (err) {
    // NO skip-on-fail path (Sprint 1, T4). A capability check that downgrades its own
    // failure to SKIP is indistinguishable from a broken capability, which is exactly why
    // four matrix rows were unbacked. The ONLY SKIP this runner can emit is the lane
    // filter above — a deliberate, declared "this check does not apply to this runtime".
    results.push({
      name,
      status: 'FAIL',
      lane: LANE,
      note: err && err.message ? err.message : String(err),
    });
  }
}

// ── server lifecycle ─────────────────────────────────────────────────────────
let serverProc = null;
function startServer() {
  if (!existsSync(SERVER_PATH)) {
    throw new Error(
      `standalone server not found at ${SERVER_PATH}. Build first:\n` +
        `  pnpm --filter @getknext/lib build && pnpm --filter file-manager build`,
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

  // #188: on Bun, preload the keep-alive guard (self-disables on fixed Bun
  // versions ≥1.4.0). Never added on Node.
  const serverArgs =
    RUNTIME === 'bun' && BUN_GUARD_PRELOAD ? ['-r', BUN_GUARD_PRELOAD, SERVER_PATH] : [SERVER_PATH];
  console.log(`[compat-smoke] runtime=${RUNTIME} cmd=${SERVER_CMD} args=${serverArgs.join(' ')}`);
  console.log(`[compat-smoke] booting ${SERVER_PATH} on ${HOST}:${PORT}`);
  serverProc = spawn(SERVER_CMD, serverArgs, {
    cwd: path.dirname(SERVER_PATH),
    env: {
      ...process.env,
      // A REAL Redis when one is provided (CI supplies a service container). The old
      // hard-coded "" forced the in-memory fallback, which is why ISR was unverifiable.
      REDIS_URL,
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

  // (g) next/image optimization — HARD (Sprint 1, T4). Previously this check downgraded
  // a missing asset AND any non-200 to SKIP, so a dead optimizer was reported as SKIP and the
  // matrix row could never be ✅. It now reds, and it asserts the optimizer's OWN named
  // evidence rather than "some bytes came back":
  //   - the format was NEGOTIATED (Accept: image/webp → content-type image/webp), which a
  //     static-file passthrough cannot produce (it would return image/png);
  //   - the output is materially SMALLER than the source asset, i.e. it was re-encoded.
  await check('g. next/image optimization (transcode + resize)', async () => {
    const assetFile = path.join(APP_DIR, 'public', IMAGE_ASSET.replace(/^\//, ''));
    assert.ok(existsSync(assetFile), `optimizer fixture ${IMAGE_ASSET} missing from public/`);

    const source = await request(IMAGE_ASSET, { raw: true });
    assert.strictEqual(source.status, 200, `source asset ${IMAGE_ASSET}: ${source.status}`);

    const url = `/_next/image?url=${encodeURIComponent(IMAGE_ASSET)}&w=128&q=75`;
    const res = await request(url, { raw: true, headers: { accept: 'image/webp,image/*,*/*' } });
    assert.strictEqual(res.status, 200, `image optimizer returned ${res.status}, expected 200`);
    const ct = res.headers['content-type'] || '';
    assert.strictEqual(
      ct,
      'image/webp',
      `optimizer did not honour the negotiated format (Accept: image/webp), got: ${ct}`,
    );
    assert.ok(
      res.bytes > 0 && res.bytes < source.bytes,
      `optimized output (${res.bytes}B) is not smaller than the source (${source.bytes}B) — not re-encoded`,
    );
    return `200 ${ct} ${res.bytes}B (source ${source.bytes}B)`;
  });

  // (h) #188 — Bun keep-alive guard contract. Bun ≤1.3.14 resets a reused
  // keep-alive socket when the next request arrives immediately after the
  // previous response ("socket hang up" — 30/39 bun-lane compat failures; the
  // exact race only fires under node-fetch@2's reuse timing, so asserting the
  // MITIGATION's observable contract is the honest per-PR gate):
  //   bun (affected version) → every response advertises `Connection: close`
  //                            (the guard preload is active);
  //   bun (fixed ≥1.4.0)     → guard self-disables, no requirement;
  //   node                   → serving stays byte-identical: keep-alive intact,
  //                            NEVER `Connection: close`.
  await check('h. bun keep-alive guard contract (#188)', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: HOST, port: PORT, path: '/api/health', agent }, (r) => {
          r.resume();
          r.on('end', () => resolve({ status: r.statusCode, connection: r.headers.connection }));
          r.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
      });
      if (RUNTIME === 'bun') {
        if (!BUN_GUARD_PRELOAD) {
          throw new Error('bun-keepalive-guard preload not found in the workspace');
        }
        const { createRequire } = await import('node:module');
        const { shouldInstall } = createRequire(import.meta.url)(BUN_GUARD_PRELOAD);
        // argv array, shell:false default — no string interpolation into a
        // shell (CLI-58 injection rule; SERVER_CMD is env-overridable).
        const bunVersion = execFileSync(SERVER_CMD, ['--version']).toString().trim();
        if (shouldInstall({}, { bun: bunVersion })) {
          assert.strictEqual(
            res.connection,
            'close',
            `guard active on bun ${bunVersion} but Connection header is ${JSON.stringify(res.connection)}`,
          );
          return `bun ${bunVersion}: guard active, Connection: close`;
        }
        return `bun ${bunVersion}: fixed version, guard self-disabled`;
      }
      assert.notStrictEqual(
        res.connection,
        'close',
        'Node serving must stay keep-alive — the guard must never load under Node',
      );
      return `node: keep-alive intact (connection=${res.connection})`;
    } finally {
      agent.destroy();
    }
  });

  // (i) Server Actions — a REAL round-trip over the no-JS progressive-enhancement path.
  // The action id is read out of the rendered form (React emits a `$ACTION_ID_*` hidden
  // field for the JS-less submit), the form is POSTed as multipart, and the action's effect
  // is then observed on a SUBSEQUENT render. A per-run random nonce means only genuine
  // execution of the action can produce the asserted output.
  await check('i. Server Action round-trip (no-JS form POST)', async () => {
    const page = await request(FIXTURE_STREAM);
    assert.strictEqual(page.status, 200, `${FIXTURE_STREAM}: ${page.status}`);
    const idMatch = page.body.match(/name="(\$ACTION_ID_[0-9a-fA-F]+)"/);
    assert.ok(
      idMatch,
      'no $ACTION_ID_* field in the rendered form — the Server Action was not wired into the HTML',
    );
    const actionId = idMatch[1];

    const nonce = `act-${Math.random().toString(36).slice(2, 12)}`;
    const { boundary, body } = multipart({ [actionId]: '', knextEcho: nonce });
    const res = await post(FIXTURE_STREAM, body, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      accept: 'text/html,application/xhtml+xml',
    });
    assert.ok(
      res.status >= 200 && res.status < 400,
      `Server Action POST returned ${res.status} (a 404/405 means the action endpoint is gone)`,
    );

    // The action's ONLY effect is a cookie on the caller's own response (security.md: it
    // mutates no server state). Its presence proves the action body executed.
    const setCookie = [].concat(res.headers['set-cookie'] || []).join('; ');
    assert.ok(
      setCookie.includes(nonce),
      `the Server Action did not run: no cookie carrying the submitted nonce (set-cookie: ${setCookie || 'none'})`,
    );

    // …and the effect must be observable on a real render, not just in a header.
    const back = await request(FIXTURE_STREAM, {
      headers: { cookie: `knext-smoke-echo=${nonce}` },
    });
    assert.ok(
      back.body.includes(`data-knext-action-echo="${nonce}"`),
      'the action-applied value is not rendered back — the round-trip is not observable',
    );
    return `action ${actionId.slice(0, 22)}… echoed ${nonce}`;
  });

  // (j) Streaming / Suspense — asserted on CHUNK ARRIVAL ORDERING. Asserting the final body
  // would prove nothing: a fully buffered response reproduces it byte-for-byte. The shell
  // must land in an EARLIER chunk than the Suspense payload, with a real time gap.
  await check('j. Streaming / Suspense incremental flush', async () => {
    const res = await requestChunks(FIXTURE_STREAM);
    assert.strictEqual(res.status, 200, `${FIXTURE_STREAM}: ${res.status}`);

    const firstChunkWith = (needle) => {
      let seen = '';
      for (let i = 0; i < res.chunks.length; i++) {
        seen += res.chunks[i].text;
        if (seen.includes(needle)) return i;
      }
      return -1;
    };
    const shellIdx = firstChunkWith('knext-stream-shell');
    const lateIdx = firstChunkWith('knext-stream-late');
    assert.ok(shellIdx >= 0, 'shell marker never arrived');
    assert.ok(lateIdx >= 0, 'suspended content never arrived');
    assert.ok(
      lateIdx > shellIdx,
      `shell and suspended content arrived in the same chunk (#${shellIdx}) — the response was buffered, not streamed`,
    );
    const gap = res.chunks[lateIdx].at - res.chunks[shellIdx].at;
    assert.ok(
      gap >= 300,
      `suspended content arrived only ${gap}ms after the shell — the boundary did not flush early`,
    );
    return `shell chunk #${shellIdx} @${res.chunks[shellIdx].at}ms, suspended chunk #${lateIdx} @${res.chunks[lateIdx].at}ms (+${gap}ms)`;
  });

  // (k) ISR / Data Cache against a REAL Redis. Two 200s would prove nothing, so this asserts
  // the CONTENT: identical across back-to-back requests (it is cached, not re-rendered), then
  // CHANGED after the revalidate window (it is revalidated, not frozen) — and finally that the
  // configured Redis actually holds keys (the cache was not the in-memory fallback).
  await check('k. ISR revalidation with a real REDIS_URL', async () => {
    assert.ok(
      REDIS_URL,
      'REDIS_URL is not set — ISR cannot be verified against the real cache backend. ' +
        'This check never skips: start a Redis and set REDIS_URL (CI provides a service container).',
    );
    const readValue = async () => {
      const res = await request(FIXTURE_ISR);
      assert.strictEqual(res.status, 200, `${FIXTURE_ISR}: ${res.status}`);
      const m = res.body.match(/data-knext-isr-value="([\w-]+)"/);
      assert.ok(m, 'ISR fixture did not render its value marker');
      return m[1];
    };

    const first = await readValue();
    const immediate = await readValue();
    assert.strictEqual(
      immediate,
      first,
      'back-to-back requests rendered DIFFERENT values — the route is not being cached at all',
    );

    // Past the 1s window each request serves stale and kicks off a background regeneration,
    // so the change shows up on a later poll.
    const deadline = Date.now() + 20000;
    let current = first;
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() < deadline && current === first) {
      current = await readValue();
      if (current === first) await new Promise((r) => setTimeout(r, 500));
    }
    assert.notStrictEqual(
      current,
      first,
      'the cached value never changed within 20s — ISR did not revalidate',
    );

    const keys = await redisDbSize(REDIS_URL);
    assert.ok(
      keys > 0,
      `Redis at ${REDIS_URL} holds ${keys} keys — the ISR cache did not reach the configured Redis`,
    );
    return `cached ${first} → revalidated ${current}; redis keys=${keys}`;
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
  // Per-lane summary (#281): this run's verdict is attributed to a single lane, so
  // a red here reds ONLY this lane — the other lane's gate stays independent.
  // The quarantine count is DERIVED from the real `$knextQuarantines` ledger (#512) — it
  // was a hardcoded 0, which would silently under-report the day this lane gains one. A
  // ledger this runner cannot read, or an entry it cannot attribute, THROWS out of
  // smokeQuarantineCount rather than degrading to 0.
  const quarantined = smokeQuarantineCount({
    ledger: loadQuarantineLedger(REPO_ROOT),
    lane: LANE,
    checkNames: results.map((r) => r.name),
  });
  console.log(
    `LANE=${LANE}  passing=${pass}  quarantined=${quarantined}  failing=${fail}  (per-lane; the other lane runs separately)`,
  );
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
