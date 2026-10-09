/**
 * vinext data-cache adapter for knext's Bun cache handler (Bun's built-in Redis client, nothing for `bun build --compile` to trace).
 *
 * The default export is a plain FUNCTION on purpose: vinext 1.0.x calls the
 * adapter module's default export as a factory
 * (`factory({ env, options })`) and a bare class throws "cannot be invoked
 * without 'new'", which vinext swallows by falling back to a per-pod memory
 * cache. vinext 1.1.0+ also accepts a class, but still calls a non-class
 * export as a factory, so one factory serves every vinext knext supports.
 * The `{ env, options }` unwrap lives in the CacheHandler constructor; `env`
 * is the Workers binding object and is meaningless on the knext target.
 *
 * The handler class itself is the named export.
 */
import KnextBunCacheHandler from './cache-handler-bun.js';

export { KnextBunCacheHandler as KnextCacheHandler };

/**
 * @param {{ env?: unknown, options?: Record<string, unknown> }} [args]
 * @returns one handler per isolate: vinext guards registration so this runs once.
 */
export default function createKnextVinextDataCacheAdapter(args) {
  return new KnextBunCacheHandler(args);
}
