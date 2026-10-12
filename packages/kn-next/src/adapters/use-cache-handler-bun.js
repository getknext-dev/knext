/**
 * The `'use cache'` backend for the BUN runtime, kind `default` (Next >= 16.4
 * `cacheHandlers.default`).
 *
 * The knext adapter points `cacheHandlers.default` here when the app uses knext's
 * `cacheHandler` and the configured runtime is `bun`. Next imports this module by
 * path and uses its DEFAULT EXPORT as the handler object. It shares Bun's native
 * Redis client, connection, circuit breaker, key prefix and build id with the ISR
 * handler of the same runtime (`./cache-handler-bun.js`, which imports no
 * ioredis); all behaviour lives in `./use-cache-handler.js`.
 */
import KnextBunCacheHandler from './cache-handler-bun.js';

export default KnextBunCacheHandler.forUseCache('default');
