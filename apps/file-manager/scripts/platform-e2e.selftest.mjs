#!/usr/bin/env node
/**
 * platform-e2e.selftest.mjs — proves the platform e2e can go RED (#1282).
 *
 * A guard that stays green when its subject is removed is decoration. This runs
 * the SAME check functions the nightly runs (`platform-e2e-checks.mjs`) against
 * a local fake server, first HEALTHY (every check must pass), then once per
 * deliberate defect (the matching check must fail). It needs no cluster.
 *
 * Run: node scripts/platform-e2e.selftest.mjs   (exit 0 only if every defect is caught)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  assertIsr,
  assertObservabilityAuth,
  assertRolloutClean,
  assertUploadStored,
  checkImageOptimization,
  checkInvalidationEndpoint,
  checkPublicFiles,
  checkStaticAssets,
  checkStreaming,
} from './platform-e2e-checks.mjs';
import { createClient } from './platform-e2e-http.mjs';

const TOKEN = 'selftest-token';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** @typedef {{ cssType?: string, immutable?: boolean, buffered?: boolean, openInvalidate?: boolean, deadOptimizer?: boolean, bigImage?: boolean, fontLeak?: 'broken' | 'fixed' | 'none', noCssFont?: boolean, notChunked?: boolean, jsCache?: string }} Defects */

/** @param {Defects} d */
function makeServer(d) {
  return http.createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (
      /** @type {number} */ status,
      /** @type {Record<string,string>} */ h,
      /** @type {string|Buffer} */ body,
    ) => {
      res.writeHead(status, h);
      res.end(body);
    };
    if (url === '/') {
      return send(
        200,
        { 'content-type': 'text/html' },
        `<html><head><link rel="stylesheet" href="/_next/static/a.css">${d.fontLeak !== 'none' ? '<link rel="preload" as="font" href="/home/x/app/.vinext/fonts/h/f.woff2">' : ''}<script src="/_next/static/a.js"></script></head><body>ok</body></html>`,
      );
    }
    if (url === '/_next/static/a.css') {
      return send(
        200,
        {
          'content-type': d.cssType ?? 'text/css',
          'cache-control': d.immutable === false ? 'public, max-age=0' : IMMUTABLE,
        },
        d.noCssFont ? 'body{}' : '@font-face{src:url(/_next/static/f.woff2)}',
      );
    }
    if (url === '/_next/static/a.js') {
      return send(
        200,
        { 'content-type': 'text/javascript', 'cache-control': d.jsCache ?? IMMUTABLE },
        'console.log(1)',
      );
    }
    if (url === '/home/x/app/.vinext/fonts/h/f.woff2') {
      if (d.fontLeak === 'fixed')
        return send(200, { 'content-type': 'font/woff2', 'cache-control': IMMUTABLE }, 'wOF2');
      return send(404, { 'content-type': 'text/plain' }, 'nf');
    }
    if (url === '/_next/static/f.woff2') {
      return send(200, { 'content-type': 'font/woff2', 'cache-control': IMMUTABLE }, 'wOF2xxxx');
    }
    if (/^\/(file|globe|next)\.svg$/.test(url)) {
      return send(
        200,
        { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=0' },
        '<svg/>',
      );
    }
    if (url === '/knext-smoke.png' || url === '/knext-optimize-fixture.png') {
      return send(
        200,
        { 'content-type': 'image/png', 'cache-control': 'public, max-age=0' },
        Buffer.alloc(4096, 1),
      );
    }
    if (url === '/favicon.ico') {
      return send(
        200,
        { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=0' },
        Buffer.alloc(64, 2),
      );
    }
    if (url === '/knext-smoke/stream') {
      if (d.notChunked) {
        // Same chunk order, but delimited by connection close - never `chunked`.
        res.useChunkedEncodingByDefault = false;
        res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
      }
      if (d.buffered) {
        setTimeout(
          () => res.end('knext-stream-shell knext-stream-fallback knext-stream-late'),
          500,
        );
        return;
      }
      res.write('<div>knext-stream-shell</div>');
      res.write('<div>knext-stream-fallback</div>');
      setTimeout(() => res.end('<div>knext-stream-late</div>'), 600);
      return;
    }
    if (url.startsWith('/_next/image')) {
      if (d.deadOptimizer) return send(500, { 'content-type': 'text/plain' }, 'sharp missing');
      return send(200, { 'content-type': 'image/webp' }, Buffer.alloc(d.bigImage ? 8192 : 500, 3));
    }
    if (url === '/api/cache/invalidate' && req.method === 'POST') {
      const ok = req.headers.authorization === `Bearer ${TOKEN}`;
      if (!ok && !d.openInvalidate)
        return send(401, { 'content-type': 'application/json' }, '{"error":"unauthorized"}');
      return send(200, { 'content-type': 'application/json' }, '{"success":true}');
    }
    return send(404, { 'content-type': 'text/plain' }, 'nf');
  });
}

/** @param {Defects} d @param {(request: import('./platform-e2e-checks.mjs').RequestFn) => Promise<unknown>} fn */
async function against(d, fn) {
  const server = makeServer({ fontLeak: 'broken', ...d });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const { request } = createClient({ baseUrl: `http://127.0.0.1:${port}`, host: 'app.selftest' });
  try {
    await fn(request);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
}

const suite = {
  static: (/** @type {any} */ r) => checkStaticAssets(r),
  public: (/** @type {any} */ r) => checkPublicFiles(r),
  stream: (/** @type {any} */ r) => checkStreaming(r),
  image: (/** @type {any} */ r) => checkImageOptimization(r),
  invalidate: (/** @type {any} */ r) => checkInvalidationEndpoint(r, TOKEN, 'products'),
};

let failures = 0;
/** @param {string} label @param {boolean} ok @param {string} [why] */
function report(label, ok, why = '') {
  console.log(`${ok ? 'ok  ' : 'BAD '} ${label}${why ? ` — ${why}` : ''}`);
  if (!ok) failures++;
}

// Healthy: every check must pass (otherwise "red" below proves nothing).
for (const [name, fn] of Object.entries(suite)) {
  try {
    await against({}, fn);
    report(`healthy server passes ${name}`, true);
  } catch (e) {
    report(`healthy server passes ${name}`, false, String(e instanceof Error ? e.message : e));
  }
}

// Defective: each must make its check throw.
/** @type {[string, Defects, keyof typeof suite][]} */
const defects = [
  ['CSS served as text/plain', { cssType: 'text/plain' }, 'static'],
  ['hashed asset without immutable', { immutable: false }, 'static'],
  ['hashed JS with a short max-age', { jsCache: 'public, max-age=60, immutable' }, 'static'],
  ['stream page buffered (no early chunks)', { buffered: true }, 'stream'],
  ['invalidate endpoint open without a token', { openInvalidate: true }, 'invalidate'],
  ['image optimizer dead (500)', { deadOptimizer: true }, 'image'],
  ['optimizer output not smaller than the source', { bigImage: true }, 'image'],
  ['stream delimited by connection close, not chunked', { notChunked: true }, 'stream'],
];
// The #1284 exemption is narrow and self-expiring: the leaked-path font may
// stay broken (green), but serving it (fixed) must go RED, and it must not
// shelter any OTHER broken asset.
try {
  await against({ fontLeak: 'broken' }, suite.static);
  report('known defect #1284 (font path still 404) is tolerated, not skipped', true);
} catch (e) {
  report('known defect #1284 tolerated', false, String(e instanceof Error ? e.message : e));
}
// The only woff2 files are quarantined ones: passes, but must say fonts are
// UNVERIFIED and must not count them as coverage.
try {
  const seen = [];
  await against({ noCssFont: true }, async (r) => seen.push(await checkStaticAssets(r)));
  const ok = /FONTS UNVERIFIED/.test(seen[0].summary) && !/woff2/.test(seen[0].summary);
  report(
    'only-quarantined fonts: reported UNVERIFIED, not counted as covered',
    ok,
    seen[0].summary,
  );
} catch (e) {
  report('only-quarantined fonts pass', false, String(e instanceof Error ? e.message : e));
}
defects.push(
  [
    'exemption dead: no leaked font reference left, fonts served normally',
    { fontLeak: 'none' },
    'static',
  ],
  [
    'no font at all (nothing quarantined, none served)',
    { fontLeak: 'none', noCssFont: true },
    'static',
  ],
  ['#1284 fixed but exemption not removed', { fontLeak: 'fixed' }, 'static'],
  [
    'broken CSS while #1284 exemption is active',
    { fontLeak: 'broken', cssType: 'text/plain' },
    'static',
  ],
);
for (const [label, defect, name] of defects) {
  let caught = false;
  try {
    await against(defect, suite[name]);
  } catch {
    caught = true;
  }
  report(`RED on: ${label}`, caught, caught ? '' : `${name} stayed green`);
}

/** @param {string} label @param {() => unknown} fn */
function mustThrow(label, fn) {
  let caught = false;
  try {
    fn();
  } catch {
    caught = true;
  }
  report(`RED on: ${label}`, caught, caught ? '' : 'stayed green');
}

const OVERVIEW = { status: 200, text: '<h1>Overview</h1>', body: Buffer.from('<h1>Overview</h1>') };
mustThrow('/observability always 401 (right token refused)', () =>
  assertObservabilityAuth({
    none: { status: 401 },
    wrong: { status: 401 },
    right: { ...OVERVIEW, status: 401 },
  }),
);
mustThrow('/observability open without a token', () =>
  assertObservabilityAuth({ none: OVERVIEW, wrong: { status: 401 }, right: OVERVIEW }),
);
mustThrow('/observability 200 but not the Overview page', () =>
  assertObservabilityAuth({
    none: { status: 401 },
    wrong: { status: 401 },
    right: { status: 200, text: 'ok', body: Buffer.from('ok') },
  }),
);
mustThrow('ISR read is always a MISS', () =>
  assertIsr({
    reads: [{ cacheState: 'MISS' }, { cacheState: 'MISS' }],
    first: 'a',
    later: 'b',
  }),
);
mustThrow('ISR value never revalidates', () =>
  assertIsr({ reads: [{ cacheState: 'HIT' }, { cacheState: 'HIT' }], first: 'a', later: 'a' }),
);
mustThrow('rollout drops a request', () =>
  assertRolloutClean({
    results: [...Array.from({ length: 30 }, () => ({ status: 200 })), { error: 'ECONNRESET' }],
    before: 'r1',
    after: 'r2',
    minRequests: 20,
  }),
);
mustThrow('rollout never changes the revision', () =>
  assertRolloutClean({
    results: Array.from({ length: 30 }, () => ({ status: 200 })),
    before: 'r1',
    after: 'r1',
    minRequests: 20,
  }),
);
mustThrow('upload fell back to metadata-only (no storage_path)', () =>
  assertUploadStored({
    dbRow: '',
    expectedPath: 'assets/x.txt',
    sent: Buffer.from('a'),
    stored: Buffer.from('a'),
  }),
);
mustThrow('downloaded bytes differ from uploaded bytes', () =>
  assertUploadStored({
    dbRow: 'assets/x.txt',
    expectedPath: 'assets/x.txt',
    sent: Buffer.from('a'),
    stored: Buffer.from('b'),
  }),
);

assert.equal(failures, 0, `${failures} self-test expectation(s) failed`);
console.log('platform-e2e selftest: every check passes when healthy and goes red on each defect');
