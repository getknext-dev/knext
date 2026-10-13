/**
 * A tiny stand-in for the Next standalone server, for the CDN preload tests. It
 * runs under BOTH Node and Bun (the tests spawn it with each), loads the header
 * preload exactly the way `--require` would, and answers according to a JSON
 * "spec" the request carries in the `x-spec` header:
 *
 *   { cc, ct, tags: [{kind, tags}], setCookie, mode, status, rewriteUrl, hop, extra }
 *
 *   x-case: nostate  drop the preload's request snapshot before answering
 *   x-case: poison   corrupt the snapshot so the edge decision throws
 *   mode: "write"     res.setHeader(...) then res.write() — the IMPLICIT header flush
 *         "end"       res.setHeader(...) then res.end(body) — implicit flush on end
 *         "writehead" res.writeHead(status, { 'Cache-Control': cc, ... }) — object form
 *         "append"    like "write", but the `extra` headers go through
 *                     res.appendHeader() (bypasses the patched setHeader)
 *         "stream"    res.setHeader(...), then chunks written across timers: the
 *                     headers flush late, on the first write
 *         "flush"     res.setHeader(...), res.flushHeaders(), then chunks later
 *   hop: await a timer before recording the tags (proves AsyncLocalStorage
 *        carries the store across an async boundary, as Next's render does)
 *   rewriteUrl: Next rewrites `req.url` while routing; the decision must not read it
 *
 * Special routes: `x-case: raw` echoes the url the preload captured vs `req.url`;
 * `x-case: metrics` returns the decision counters in Prometheus text.
 *
 * argv: none. env: CDN_FIXTURE_PRELOAD (absolute path of the preload to load).
 * Prints `PORT <n>` once listening.
 */
'use strict';

const preload = process.env.CDN_FIXTURE_PRELOAD;
if (!preload) throw new Error('CDN_FIXTURE_PRELOAD is required');
require(preload);

const http = require('node:http');
const STATE = Symbol.for('knext.core.cdn.requestState');
const SEAM = Symbol.for('knext.core.cdn.requestTags');

const server = http.createServer(async (req, res) => {
  const kase = req.headers['x-case'];
  const state = req[STATE];
  if (kase === 'raw') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, raw: state ? state.rawTarget : null }));
    return;
  }
  if (kase === 'metrics') {
    const edge = require(require('node:path').join(require('node:path').dirname(preload), 'cdn-edge.cjs'));
    res.setHeader('content-type', 'text/plain');
    res.end(edge.renderEdgeDecisionMetrics());
    return;
  }
  const spec = JSON.parse(req.headers['x-spec'] || '{}');
  // A request the preload never saw (no snapshot): the response must stay uncached.
  if (kase === 'nostate') delete req[STATE];
  // A snapshot the decision cannot read: the preload must serve the response anyway.
  if (kase === 'poison') req[STATE].own = null;
  if (spec.rewriteUrl) req.url = spec.rewriteUrl;
  if (spec.hop) await new Promise((r) => setTimeout(r, 5));
  const seam = globalThis[SEAM];
  for (const rec of spec.tags || []) {
    if (seam) seam.record(rec);
  }
  const status = spec.status || 200;
  const headers = {};
  if (spec.cc !== undefined) headers['Cache-Control'] = spec.cc;
  if (spec.ct !== undefined) headers['Content-Type'] = spec.ct;
  if (spec.setCookie) headers['Set-Cookie'] = 'sid=1; Path=/';
  Object.assign(headers, spec.extra || {});
  const mode = spec.mode || 'write';
  if (mode === 'writehead') {
    res.writeHead(status, headers);
    res.end('body');
    return;
  }
  if (mode === 'writehead-pairs') {
    res.writeHead(status, Object.entries(headers));
    res.end('body');
    return;
  }
  if (mode === 'writehead-flat') {
    res.writeHead(status, Object.entries(headers).flat());
    res.end('body');
    return;
  }
  res.statusCode = status;
  const extra = spec.extra || {};
  for (const [k, v] of Object.entries(headers)) {
    if (mode === 'append' && Object.hasOwn(extra, k)) res.appendHeader(k, v);
    else res.setHeader(k, v);
  }
  if (mode === 'stream' || mode === 'flush') {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    if (mode === 'flush') res.flushHeaders();
    await tick();
    res.write('bo');
    await tick();
    res.end('dy');
    return;
  }
  if (mode === 'write' || mode === 'append') {
    res.write('bo');
    res.end('dy');
  } else {
    res.end('body');
  }
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
