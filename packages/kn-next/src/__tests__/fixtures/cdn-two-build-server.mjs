/**
 * One build's server for cdn-foreign-build-body.test.ts: the CDN header preload
 * (loaded with `--require`, as the standalone server loads it) in front of the
 * REAL cache handler, sharing nothing with another build but Redis. It stands in
 * for Next's ISR read path: `GET /read?key=K` asks the handler for K, the way
 * Next's incremental cache does, and on a hit answers with the body the entry
 * holds and the shared-cache directive Next emits for an ISR page.
 *
 *   GET /write?key=K   the handler `set`s K as this build (an APP_PAGE entry whose
 *                      body names this build, tagged `_N_T_<K>`), 204
 *   GET /read?key=K    hit -> 200 + `Cache-Control: s-maxage=3600, ...` + the
 *                      stored body; miss -> 404
 *   GET /metrics       knext_cdn_edge_decision_total in Prometheus text
 *
 * env: POD_HANDLER (absolute path of adapters/cache-handler.js), REDIS_URL,
 * REDIS_KEY_PREFIX, KNEXT_BUILD_ID, the KNEXT_CDN_* env. Prints `PORT <n>`.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const handlerPath = process.env.POD_HANDLER;
if (!handlerPath) throw new Error('POD_HANDLER is required');
const mod = await import(pathToFileURL(handlerPath).href);
const edge = createRequire(import.meta.url)(join(dirname(handlerPath), 'cdn-edge.cjs'));
const handler = new mod.default({});
const BUILD = process.env.KNEXT_BUILD_ID;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = url.searchParams.get('key') || '/page';
  if (url.pathname === '/metrics') {
    res.setHeader('content-type', 'text/plain');
    res.end(edge.renderEdgeDecisionMetrics());
    return;
  }
  if (url.pathname === '/write') {
    await handler.set(
      key,
      {
        kind: 'APP_PAGE',
        html: `<p id="build">${BUILD}</p>`,
        headers: { 'x-next-cache-tags': `_N_T_${key}` },
        status: 200,
      },
      { cacheControl: { revalidate: 3600 }, isRoutePPREnabled: false, isFallback: false },
    );
    res.statusCode = 204;
    res.end();
    return;
  }
  const hit = await handler.get(key, { kind: 'APP_PAGE' });
  if (!hit) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('cache-control', 's-maxage=3600, stale-while-revalidate=31532400');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('x-nextjs-cache', 'HIT');
  res.end(String(hit.value?.html ?? ''));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
