/**
 * A Cloudflare-shaped CDN cache emulator for the CDN cache-tier kind e2e
 * (ADR-0068 D13). TEST-ONLY: it lives under `__tests__/fixtures`, is never part
 * of a published package, and runs in the e2e cluster from a ConfigMap on a
 * stock `node` image. Dependency-free (node: built-ins only).
 *
 * Why not a default Varnish: Varnish honours `Vary`, and Cloudflare does not.
 * The bugs this emulator exists to expose (a flight payload stored under the
 * HTML key, one host's redirect served to another) are invisible to a cache
 * that honours `Vary`.
 *
 * ## The cache (port EMU_PORT, default 8080)
 *
 * - The cache KEY is the request's Host plus its raw request-target (path and
 *   query, byte for byte). Nothing else: not the method, not `Vary`, not a
 *   cookie, not an `Authorization` header, not the `RSC` header. That is the
 *   Cloudflare default key, and it is what makes the e2e adversarial.
 * - LOOKUP: GET and HEAD only (a CDN never answers a POST from cache).
 * - STORE, mode `honour` (the default): the origin's own directive decides,
 *   with Cloudflare's precedence `Cloudflare-CDN-Cache-Control` >
 *   `CDN-Cache-Control` > `Cache-Control`. The first of those present is the
 *   only one read: `private` / `no-store` / `no-cache` there means "do not
 *   store", otherwise `s-maxage`, else `max-age`, gives the TTL. NOTHING ELSE
 *   is checked on purpose: not the method, not the status, not `Set-Cookie`,
 *   not the request's `Authorization`. Real CDNs carry some of those safety
 *   nets; this one does not, so every "never cached" result an e2e observes is
 *   the decision knext made at the origin, never a net the emulator supplied.
 * - STORE, mode `store-all` (a NEGATIVE CONTROL, not a CDN model): every
 *   response is stored for EMU_STORE_ALL_TTL seconds whatever it says. A check
 *   that still passes against this mode cannot see the failure it claims to
 *   catch.
 * - A request carrying `x-emu-bypass: 1` is forwarded with no lookup and no
 *   store (used to read the origin's own headers through the same path).
 * - Responses carry `x-emu-cache: HIT | MISS | BYPASS`, and a stored MISS also
 *   carries `x-emu-stored: <ttl seconds>`. `Cache-Tag` is passed through to the
 *   client unchanged (the e2e reads it; a real Cloudflare zone strips it).
 *
 * The upstream: EMU_UPSTREAM (default the Knative internal ingress), with the
 * client's Host header kept, so one emulator fronts several apps. Only Hosts
 * ending in EMU_HOST_SUFFIX (default `.svc.cluster.local`) are proxied, so the
 * emulator cannot be pointed at an arbitrary host. EMU_UPSTREAM_MAP
 * (`host=http://127.0.0.1:3001,…`) overrides the upstream per Host for a run
 * outside a cluster.
 *
 * ## The admin API (port EMU_ADMIN_PORT, default 8081)
 *
 *   GET  /healthz          200 "ok"
 *   GET  /__emu/entries    the stored entries: key, host, url, method, status,
 *                          contentType, tags, ttl
 *   POST /__emu/reset      drop every entry and the purge log
 *   GET  /__emu/purges     every purge request received: zone, tags, status,
 *                          authorized, evicted, at (ms)
 *   POST /__emu/fail-next?status=429&retryAfter=1
 *                          answer the NEXT purge with that status (once)
 *
 * ## Tag purge (the API the knext `emulator` provider row calls)
 *
 *   POST /client/v4/zones/<zone>/purge_cache   {"tags": ["kn-…", …]}
 *
 * Cloudflare-shaped: `Authorization: Bearer <token>` must be EMU_PURGE_TOKEN,
 * which the e2e sets to the emulator row's fixed dummy token, read from
 * cdn-purge/rows.js (the row never sends the user's Secret); anything else,
 * or no EMU_PURGE_TOKEN at all, is a 403 `{success:false}`. A tag purge evicts every stored entry, of ANY
 * host, carrying any of the tags: a zone-wide purge, which is exactly why knext
 * prefixes every tag per app. `files`, `prefixes` and `purge_everything` are
 * not modelled and answer 400, as an empty tag list does.
 */

import { realpathSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Directive tokens of one header value, lowercased and trimmed. */
function tokensOf(value) {
  if (value === undefined || value === null) return [];
  const text = Array.isArray(value) ? value.join(',') : String(value);
  return text
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function secondsOf(tokens, name) {
  for (const t of tokens) {
    const [k, v] = t.split('=');
    if (k.trim() === name && v !== undefined) {
      const n = Number(v.trim().replace(/^"|"$/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/**
 * The TTL (seconds) a Cloudflare-precedence cache gives a response, or 0 for
 * "do not store". `headers` is a Node-style lowercased header object.
 */
export function honouredTtl(headers) {
  for (const name of ['cloudflare-cdn-cache-control', 'cdn-cache-control', 'cache-control']) {
    if (headers[name] === undefined) continue;
    const tokens = tokensOf(headers[name]);
    if (tokens.some((t) => t === 'private' || t === 'no-store' || t === 'no-cache')) return 0;
    const ttl = secondsOf(tokens, 's-maxage') ?? secondsOf(tokens, 'max-age') ?? 0;
    return ttl > 0 ? ttl : 0;
  }
  return 0;
}

/** Split a `Cache-Tag` header into its tags. */
export function tagsOf(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value.join(',') : String(value))
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseUpstreamMap(raw) {
  const map = new Map();
  for (const pair of String(raw || '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    map.set(pair.slice(0, at).trim().toLowerCase(), pair.slice(at + 1).trim());
  }
  return map;
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function json(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

/**
 * Build the emulator. Returns `{ cache, admin, store }` (two unstarted
 * `http.Server`s and the entry map); `startEmulator` listens on them.
 *
 * @param {{ mode?: 'honour' | 'store-all', upstream?: string, upstreamMap?: string,
 *           hostSuffix?: string, storeAllTtl?: number, purgeToken?: string, now?: () => number }} [opts]
 */
export function createEmulator(opts = {}) {
  const mode = opts.mode ?? 'honour';
  if (mode !== 'honour' && mode !== 'store-all') throw new Error(`unknown EMU_MODE ${mode}`);
  const upstream = opts.upstream ?? 'http://kourier-internal.kourier-system.svc.cluster.local';
  const upstreamMap = parseUpstreamMap(opts.upstreamMap);
  const hostSuffix = (opts.hostSuffix ?? '.svc.cluster.local').toLowerCase();
  const storeAllTtl = opts.storeAllTtl ?? 300;
  const now = opts.now ?? Date.now;
  /** @type {Map<string, any>} */
  const store = new Map();
  /** Every purge request received, in order. */
  const purges = [];
  /** A status to answer the next purge with, once (`fail-next`). */
  let failNext = null;
  // The bearer token a purge must carry: the knext emulator row's fixed dummy
  // token, handed in (EMU_PURGE_TOKEN) rather than written here. Unset means
  // every purge is refused (fail closed).
  const purgeToken = opts.purgeToken || null;

  /** POST /client/v4/zones/<zone>/purge_cache — see the header. */
  async function purge(req, res, zone) {
    const body = await readBody(req);
    const record = { zone, tags: [], status: 0, authorized: false, evicted: 0, at: now() };
    purges.push(record);
    const answer = (status, value, headers = {}) => {
      record.status = status;
      const out = Buffer.from(`${JSON.stringify(value)}\n`);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': out.length, ...headers });
      res.end(out);
    };
    const cfError = (code, message) => ({ success: false, errors: [{ code, message }], messages: [], result: null });
    record.authorized = purgeToken !== null && req.headers.authorization === `Bearer ${purgeToken}`;
    if (!record.authorized) return answer(403, cfError(10000, 'Authentication error'));
    if (failNext) {
      const { status, retryAfter } = failNext;
      failNext = null;
      return answer(status, cfError(971, 'Please wait and consider throttling your request speed'), {
        ...(retryAfter !== null ? { 'retry-after': String(retryAfter) } : {}),
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return answer(400, cfError(1012, 'Request must contain one of "purge_everything", "files", "tags", "hosts" or "prefixes"'));
    }
    const tags = parsed && Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === 'string') : [];
    const extra = parsed && typeof parsed === 'object' ? Object.keys(parsed).filter((k) => k !== 'tags') : [];
    if (tags.length === 0 || extra.length > 0) {
      return answer(400, cfError(1012, 'the emulator models tag purge only: {"tags": [...]}'));
    }
    record.tags = tags;
    const wanted = new Set(tags);
    for (const [key, entry] of store) {
      if (entry.tags.some((t) => wanted.has(t))) {
        store.delete(key);
        record.evicted += 1;
      }
    }
    return answer(200, { success: true, errors: [], messages: [], result: { id: zone } });
  }

  function forward(req, host, body) {
    const base = new URL(upstreamMap.get(host) ?? upstream);
    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k) && k !== 'x-emu-bypass') headers[k] = v;
    }
    headers.host = req.headers.host;
    if (body.length > 0) headers['content-length'] = String(body.length);
    return new Promise((resolve, reject) => {
      const out = send(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port || undefined,
          method: req.method,
          path: req.url,
          headers,
        },
        async (up) => {
          try {
            resolve({ status: up.statusCode, headers: up.headers, rawHeaders: up.rawHeaders, body: await readBody(up) });
          } catch (err) {
            reject(err);
          }
        },
      );
      out.on('error', reject);
      out.setTimeout(60_000, () => out.destroy(new Error('upstream timeout')));
      out.end(body);
    });
  }

  function reply(res, req, entry, cacheState, extra = {}) {
    const headers = [];
    for (let i = 0; i < entry.rawHeaders.length; i += 2) {
      const name = entry.rawHeaders[i];
      if (HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === 'content-length') continue;
      headers.push(name, entry.rawHeaders[i + 1]);
    }
    headers.push('content-length', String(entry.body.length), 'x-emu-cache', cacheState);
    for (const [k, v] of Object.entries(extra)) headers.push(k, String(v));
    res.writeHead(entry.status, headers);
    res.end(req.method === 'HEAD' ? undefined : entry.body);
  }

  const cache = createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '')
        .toLowerCase()
        .replace(/:\d+$/, '');
      if (!host.endsWith(hostSuffix) && !upstreamMap.has(host)) {
        return json(res, 400, { error: `refusing to proxy host ${JSON.stringify(host)}` });
      }
      const key = `${host}${req.url}`;
      const body = await readBody(req);
      const bypass = req.headers['x-emu-bypass'] === '1';
      const lookup = !bypass && (req.method === 'GET' || req.method === 'HEAD');
      if (lookup) {
        const hit = store.get(key);
        if (hit && hit.expiresAt > now()) {
          return reply(res, req, hit, 'HIT', { age: Math.floor((now() - hit.storedAt) / 1000) });
        }
        if (hit) store.delete(key);
      }
      const up = await forward(req, host, body);
      if (bypass) return reply(res, req, up, 'BYPASS');
      const ttl = mode === 'store-all' ? storeAllTtl : honouredTtl(up.headers);
      if (ttl > 0) {
        store.set(key, {
          ...up,
          key,
          host,
          url: req.url,
          method: req.method,
          tags: tagsOf(up.headers['cache-tag']),
          storedAt: now(),
          expiresAt: now() + ttl * 1000,
          ttl,
        });
        return reply(res, req, up, 'MISS', { 'x-emu-stored': ttl });
      }
      return reply(res, req, up, 'MISS');
    } catch (err) {
      if (!res.headersSent) json(res, 502, { error: `upstream failed: ${err && err.message}` });
      else res.destroy();
    }
  });

  const admin = createServer(async (req, res) => {
    try {
      const path = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (req.method === 'GET' && path === '/__emu/entries') {
        const t = now();
        const entries = [];
        for (const e of store.values()) {
          if (e.expiresAt <= t) continue;
          entries.push({
            key: e.key,
            host: e.host,
            url: e.url,
            method: e.method,
            status: e.status,
            contentType: String(e.headers['content-type'] || ''),
            tags: e.tags,
            ttl: e.ttl,
          });
        }
        return json(res, 200, { mode, entries });
      }
      if (req.method === 'POST' && path === '/__emu/reset') {
        await readBody(req);
        const dropped = store.size;
        store.clear();
        purges.length = 0;
        return json(res, 200, { dropped });
      }
      if (req.method === 'GET' && path === '/__emu/purges') {
        return json(res, 200, { purges });
      }
      if (req.method === 'POST' && path === '/__emu/fail-next') {
        await readBody(req);
        const q = new URL(String(req.url), 'http://emu').searchParams;
        const status = Number(q.get('status') || 429);
        const retryAfter = q.has('retryAfter') ? Number(q.get('retryAfter')) : null;
        if (!Number.isInteger(status) || status < 400 || status > 599) return json(res, 400, { error: 'status' });
        failNext = { status, retryAfter };
        return json(res, 200, { failNext });
      }
      const zone = /^\/client\/v4\/zones\/([A-Za-z0-9_-]{1,64})\/purge_cache$/.exec(path);
      if (req.method === 'POST' && zone) return purge(req, res, zone[1]);
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: String(err && err.message) });
    }
  });

  return { cache, admin, store, purges, mode };
}

/** Start both listeners from the environment. */
export async function startEmulator(env = process.env) {
  const emu = createEmulator({
    mode: env.EMU_MODE || 'honour',
    upstream: env.EMU_UPSTREAM || undefined,
    upstreamMap: env.EMU_UPSTREAM_MAP || '',
    hostSuffix: env.EMU_HOST_SUFFIX || undefined,
    storeAllTtl: env.EMU_STORE_ALL_TTL ? Number(env.EMU_STORE_ALL_TTL) : undefined,
    purgeToken: env.EMU_PURGE_TOKEN || undefined,
  });
  const port = Number(env.EMU_PORT || 8080);
  const adminPort = Number(env.EMU_ADMIN_PORT || 8081);
  await new Promise((r) => emu.cache.listen(port, '0.0.0.0', r));
  await new Promise((r) => emu.admin.listen(adminPort, '0.0.0.0', r));
  console.log(`cdn-emulator: mode=${emu.mode} cache=:${port} admin=:${adminPort}`);
  return emu;
}

// Run as a program. Compared through realpath: in the cluster the file is a
// ConfigMap mount, i.e. a symlink, and import.meta.url is the resolved path.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  startEmulator().catch((err) => {
    console.error(`cdn-emulator: failed to start: ${err && err.message}`);
    process.exit(1);
  });
}
