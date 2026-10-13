/**
 * One "pod" for cdn-wire-in-integration.test.ts: the REAL cache handler in its
 * own process, so two pods share nothing but Redis and the CDN -- exactly what
 * two replicas share.
 *
 * Inputs (env):
 *   POD_HANDLER    absolute path of adapters/cache-handler.js
 *   POD_CDN_PORT   the fake CDN's port on 127.0.0.1; any `*.svc.cluster.local`
 *                  URL the purger fetches is routed there (the emulator row only
 *                  accepts a cluster-local endpoint)
 *   POD_SEAM       "1" installs a stub request-tag seam that records every call
 *   POD_ACTIONS    JSON array of { op: "set" | "get" | "revalidate", key?, tags? }
 *   plus REDIS_URL, REDIS_KEY_PREFIX, KNEXT_BUILD_ID and the KNEXT_CDN_* env.
 *
 * Output: one JSON line on stdout, `{ recorded, results }`, after every cache
 * write -- the first-ready claim and every queued purge included -- has drained.
 */

import { pathToFileURL } from 'node:url';

const port = Number(process.env.POD_CDN_PORT);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(String(input));
  if (u.hostname.endsWith('.svc.cluster.local')) {
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  }
  return realFetch(input, init);
};

const recorded = [];
if (process.env.POD_SEAM === '1') {
  globalThis[Symbol.for('knext.core.cdn.requestTags')] = {
    record(r) {
      recorded.push({ kind: r.kind, tags: [...r.tags], ...(r.foreignBuild === true && { foreignBuild: true }) });
      return true;
    },
  };
}

const handlerPath = process.env.POD_HANDLER;
const handlerUrl = pathToFileURL(handlerPath);
const mod = await import(handlerUrl.href);
const registry = await import(new URL('./cache-write-registry.js', handlerUrl).href);

const handler = new mod.default({});
const results = [];
for (const action of JSON.parse(process.env.POD_ACTIONS || '[]')) {
  if (action.op === 'set') {
    await handler.set(
      action.key,
      { kind: 'APP_PAGE', html: `<html>${action.key}</html>`, headers: { 'x-next-cache-tags': action.tags.join(',') } },
      { cacheControl: { revalidate: 60 }, isRoutePPREnabled: false, isFallback: false },
    );
    results.push({ op: 'set', key: action.key });
  } else if (action.op === 'get') {
    const hit = await handler.get(action.key, { kind: 'APP_PAGE' });
    results.push({ op: 'get', key: action.key, hit: hit !== null });
  } else if (action.op === 'revalidate') {
    await handler.revalidateTag(action.tags);
    results.push({ op: 'revalidate', tags: action.tags });
  }
}

// Drain until nothing is in flight: the first-ready claim, then the purge it
// may queue (which enrols itself only once queued), then any revalidate purge.
const deadline = Date.now() + 15_000;
while (registry.inFlightCacheWriteCount() > 0 && Date.now() < deadline) {
  await registry.drainCacheWrites(1000);
}

process.stdout.write(`${JSON.stringify({ recorded, results, inFlight: registry.inFlightCacheWriteCount() })}\n`);
process.exit(0);
