/**
 * The `'use cache'` backend for the NODE runtime, kind `default` (Next >= 16.4
 * `cacheHandlers.default`).
 *
 * The knext adapter points `cacheHandlers.default` here when the app uses knext's
 * `cacheHandler` and the configured runtime is `node`. Next imports this module by
 * path and uses its DEFAULT EXPORT as the handler object. It shares the Redis
 * client, connection, circuit breaker, key prefix and build id with the ISR
 * handler of the same runtime (`./cache-handler-node.js`, whose literal
 * `import('ioredis')` is what Next's standalone tracing follows into the image);
 * all behaviour lives in `./use-cache-handler.js`.
 */
import KnextNodeCacheHandler from './cache-handler-node.js';

export default KnextNodeCacheHandler.useCacheHandler('default');
