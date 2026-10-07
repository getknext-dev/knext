/**
 * vinext data-cache adapter FACTORY for the BUN runtime: Bun's built-in Redis
 * client, with no ioredis anywhere in the graph (the compiled executable cannot
 * run it).
 *
 * Same contract as `./vinext-cache-adapter.mjs` (vinext calls the default
 * export as `factory({ env, options })`); the only difference is that the
 * Redis client is fixed by the per-runtime handler it wraps, instead of being
 * detected at runtime. The scaffolded `vite.config.ts` picks the entry that
 * matches `runtime`.
 *
 * If the client cannot load while REDIS_URL is set, the handler logs one
 * "Redis client unavailable" error at startup and serves from memory.
 */
import KnextBunCacheHandler from './cache-handler-bun.js';

/**
 * @param {{ env?: unknown, options?: Record<string, unknown> }} [args]
 * @returns {import('./cache-handler.js').default}
 */
export default function createKnextVinextDataCacheAdapter(args) {
  return new KnextBunCacheHandler(args?.options);
}
