/**
 * vinext data-cache adapter FACTORY over knext's Redis cache handler (#953).
 *
 * ## Why this file exists when `./cache-handler.js` already does
 *
 * The two consumers want the same handler through incompatible calling
 * conventions:
 *
 *  - Next.js (`next.config.ts` → `cacheHandler: <path>`) wants a module whose
 *    default export is a CLASS it constructs itself. That is what
 *    `@getknext/core/adapters/cache-handler` ships.
 *  - vinext's declarative cache config (`vinext({ cache: { data: { adapter } } })`)
 *    generates a registration module that calls the default export as a
 *    FACTORY: `setDataCacheHandler(factory({ env, options }))` — see
 *    `generateCacheAdaptersModule` in vinext@1.0.0-beta.8. Handing it the bare
 *    class throws "Class constructor … cannot be invoked without 'new'", which
 *    vinext CATCHES, warns about once, and silently replaces with its per-pod
 *    `MemoryCacheHandler` — i.e. exactly the row-E state #953 observed on both
 *    clusters (every request MISS, Redis DBSIZE 0).
 *
 * So the class stays where Next expects it, and this thin factory is what the
 * scaffolded `vite.config.ts` hands to vinext. One handler, two entrances —
 * NOT a second runtime (the ADR-0036 "don't rewrite the runtime twice" rule):
 * every byte of cache behaviour lives in `./cache-handler.js`.
 *
 * ## Interface fit, measured against vinext@1.0.0-beta.8 (the scaffold's pin)
 *
 * vinext's `CacheHandler` contract (`vinext/shims/cache-handler`) is
 * `get(key, ctx) → { lastModified, value, cacheState?, cacheControl? } | null`,
 * `set(key, data, ctx)`, `revalidateTag(tags)` — the shape knext's handler
 * already speaks: its ISR writes receive `ctx.cacheControl.revalidate/expire`
 * + `ctx.tags` (what `isrSet` passes), its reads label `cacheState`
 * "stale"/"expired" (what `isrGet` consumes, #940), and its Redis TTL outlives
 * the revalidate window so stale-while-revalidate is reachable (#886).
 * Page-level ISR needs no separate `cache.cdn` adapter: vinext's
 * `DefaultCdnCacheAdapter` is the origin-managed strategy — it stores page
 * artifacts through THIS data cache handler, serves HIT/STALE from it, and
 * runs in-process background regeneration, which is precisely the Knative
 * origin topology.
 *
 * Compiled-binary note: this module (and the handler it wraps) is inlined into
 * the vinext server bundle by the app's vite build, then baked into the single
 * executable. The handler was engineered for that — Bun's native RedisClient
 * at runtime, the ioredis specifier non-literal so `bun build --compile`
 * cannot drag it into the graph.
 *
 * `env` is the Workers binding object on Cloudflare; on the knext target it is
 * meaningless and deliberately ignored — configuration arrives as process env
 * (REDIS_URL / REDIS_KEY_PREFIX, operator-injected).
 */
import CacheHandler from './cache-handler.js';

/**
 * @param {{ env?: unknown, options?: Record<string, unknown> }} [args]
 *   The shape vinext's generated registration module calls with.
 * @returns {import('./cache-handler.js').default} one handler per isolate —
 *   vinext guards registration so this runs once per process.
 */
export default function createKnextVinextDataCacheAdapter(args) {
  return new CacheHandler(args?.options);
}
