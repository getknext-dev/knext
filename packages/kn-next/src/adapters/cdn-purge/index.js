/**
 * CDN purge — the entry point `cache-handler.js` wires into (ADR-0068 D6, D7).
 *
 * TWO CALL SITES, both owned by the cache-handler team (#2254 -> #2083 -> here):
 *
 * 1. `revalidateTag` (the SINGULAR handler only — D6.2: Next also calls the
 *    plural `updateTags` for the same tags, so purging from both would double
 *    every purge). After the Redis/memory invalidation has finished:
 *
 *        import { enqueuePurge } from './cdn-purge/index.js';
 *        ...
 *        async #revalidateTag(tags) {
 *          ...existing invalidation, including its try/catch...
 *          enqueuePurge(tagList);   // NOT awaited: a 429 must not hold a Server Action
 *        }
 *
 * 2. First ready, once per process, with the build id the cache handler
 *    already resolves (ADR-0066 D2) and the connected client it already has:
 *
 *        import { firstReadyPurge } from './cdn-purge/index.js';
 *        ...
 *        firstReadyPurge(buildId, { redis: client });   // or an async getter; not awaited
 *
 * Both are total: they never throw and never block, they are inert unless
 * `KNEXT_CDN_PROVIDER` is set, and the purge they start is enrolled in the
 * SIGTERM drain (`trackWrite`) by this module — the caller does not have to.
 *
 * The scrape surface for `knext_cdn_purge_total` is `renderCdnPurgeMetrics()`.
 */

import { createCdnPurger } from './purger.js';

export { createMetricsRegistry, defaultMetricsRegistry, renderCdnPurgeMetrics } from './metrics.js';
export { createCdnPurger } from './purger.js';
export { PURGE_ROWS, validateEmulatorEndpoint } from './rows.js';
export { appTag, buildTag, nextTag } from './tags.js';

/** Namespaced anchor (ADR-0027 §3): one purger however many module copies load. */
const PURGER_KEY = Symbol.for('knext.core.cdn.purger');

/** The process-wide purger, configured from `process.env` on first use. */
export function getCdnPurger() {
  let purger = globalThis[PURGER_KEY];
  if (!purger) {
    purger = createCdnPurger();
    globalThis[PURGER_KEY] = purger;
  }
  return purger;
}

/**
 * Queue a purge of the tags `revalidateTag` received.
 *
 * @param {unknown} tags a tag or an array of tags, exactly as Next passes them
 * @param {{ purger?: ReturnType<typeof createCdnPurger> }} [ctx] explicit purger (tests); default: the process-wide one
 * @returns {{ queued: number, skipped?: string }}
 */
export function enqueuePurge(tags, ctx = {}) {
  try {
    return (ctx.purger ?? getCdnPurger()).enqueue(tags);
  } catch {
    return { queued: 0, skipped: 'error' };
  }
}

/**
 * Purge the app's edge presence once per build across the cluster.
 *
 * @param {string} buildId
 * @param {{ purger?: ReturnType<typeof createCdnPurger>, redis?: object | (() => Promise<object | null | undefined>) | null }} [ctx]
 * @returns {Promise<{ purged: boolean, reason?: string }>}
 */
export async function firstReadyPurge(buildId, ctx = {}) {
  try {
    return await (ctx.purger ?? getCdnPurger()).firstReady(buildId, ctx.redis);
  } catch {
    return { purged: false, reason: 'error' };
  }
}
