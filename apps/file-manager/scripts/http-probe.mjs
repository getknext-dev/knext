/**
 * POC-ADAPTER-P1-rework: HTTP probe for live cache-test evidence.
 * Run AFTER starting the standalone server on port 3999.
 * Usage: node scripts/http-probe.mjs
 */
import http from 'node:http';

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: 3999, path }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

function post(path, data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3999,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('=== (a) TIME-BASED ISR ===');
  const t1 = await get('/cache-tests/time-based');
  console.log(`GET /cache-tests/time-based [1st] → HTTP ${t1.status}`);
  console.log(`  cache-control : ${t1.headers['cache-control'] ?? 'none'}`);
  console.log(`  x-next-cache-tags : ${t1.headers['x-next-cache-tags'] ?? 'none'}`);

  await new Promise((r) => setTimeout(r, 150));

  const t2 = await get('/cache-tests/time-based');
  console.log(
    `GET /cache-tests/time-based [2nd] → HTTP ${t2.status} (should be served from cache)`,
  );
  console.log(`  cache-control : ${t2.headers['cache-control'] ?? 'none'}`);

  console.log('');
  console.log('=== (b) ON-DEMAND REVALIDATION ===');
  const od1 = await get('/cache-tests/on-demand');
  console.log(`GET /cache-tests/on-demand [before] → HTTP ${od1.status}`);

  const inval1 = await post('/api/cache/invalidate', { tag: 'products' });
  console.log(
    `POST /api/cache/invalidate {tag:"products"} → HTTP ${inval1.status}: ${inval1.body}`,
  );

  const inval2 = await get('/api/cache/invalidate?tag=files');
  console.log(`GET /api/cache/invalidate?tag=files → HTTP ${inval2.status}: ${inval2.body}`);

  const od2 = await get('/cache-tests/on-demand');
  console.log(`GET /cache-tests/on-demand [after invalidation] → HTTP ${od2.status}`);

  console.log('');
  console.log('=== (c) RSC/STREAMING RESPONSE (home page) ===');
  const home = await get('/');
  console.log(`GET / → HTTP ${home.status}`);
  console.log(`  content-type      : ${home.headers['content-type']}`);
  console.log(`  transfer-encoding : ${home.headers['transfer-encoding'] ?? 'none (buffered)'}`);
  console.log(`  x-nextjs-prerender: ${home.headers['x-nextjs-prerender'] ?? 'none'}`);
  console.log(`  cache-control     : ${home.headers['cache-control'] ?? 'none'}`);
  console.log(`  x-next-cache-tags : ${home.headers['x-next-cache-tags'] ?? 'none'}`);
  const hasRSCMarker =
    home.body.includes('__NEXT_FLIGHT_CHUNK__') || home.body.includes('self.__next_f');
  console.log(`  RSC flight marker in body: ${hasRSCMarker}`);

  console.log('');
  console.log('=== (d) NESTED ISR ROUTES ===');
  for (const r of [
    '/cache-tests/nested',
    '/cache-tests/nested/child-a',
    '/cache-tests/nested/child-b',
  ]) {
    const res = await get(r);
    console.log(
      `GET ${r} → HTTP ${res.status} | cache-control: ${res.headers['cache-control'] ?? 'none'}`,
    );
  }

  console.log('');
  console.log('=== (e) PARALLEL CACHE REQUESTS ===');
  const [p1, p2, p3] = await Promise.all([
    get('/cache-tests/parallel'),
    get('/cache-tests/parallel'),
    get('/cache-tests/parallel'),
  ]);
  console.log(`3x concurrent GET /cache-tests/parallel → ${p1.status} ${p2.status} ${p3.status}`);

  console.log('');
  console.log('=== (f) DYNAMIC-STATIC MIX ===');
  const ds = await get('/cache-tests/dynamic-static/static');
  const dd = await get('/cache-tests/dynamic-static/dynamic');
  console.log(`GET /cache-tests/dynamic-static/static  → HTTP ${ds.status} (prerendered)`);
  console.log(`GET /cache-tests/dynamic-static/dynamic → HTTP ${dd.status} (server-rendered)`);

  console.log('');
  console.log('=== (g) API HEALTH CHECK ===');
  const health = await get('/api/health');
  console.log(`GET /api/health → HTTP ${health.status}: ${health.body.substring(0, 200)}`);
}

main().catch(console.error);
