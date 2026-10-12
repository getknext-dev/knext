/**
 * The `'use cache'` backend for the NODE runtime, kind `default` (Next >= 16.4
 * `cacheHandlers.default`).
 *
 * The knext adapter points `cacheHandlers.default` here when the app uses knext's
 * `cacheHandler` and the configured runtime is `node`. Next imports this module by
 * path and uses its DEFAULT EXPORT as the handler object. It shares the Redis
 * connection, circuit breaker, key prefix and build id with the ISR handler
 * (`./cache-handler.js` is one module, so one client and one breaker per
 * process); all behaviour lives in `./use-cache-handler.js`.
 *
 * Like `./cache-handler-node.js`, it carries its own LITERAL `import('ioredis')`.
 * Next's standalone file tracing follows it, so the node image has the client
 * whichever of the two handlers is traced first. It is repeated here, rather than
 * imported from the ISR entry, because importing that entry would hoist its class
 * (and the literal) into a shared chunk and take the literal out of the entry
 * file, which `cache-handler-redis-client-unavailable.test.ts` reads.
 */
import { CacheHandler, ioredisClient } from './cache-handler.js';

const ioredis = {
  name: 'ioredis',
  async load(url) {
    const mod = await import('ioredis');
    return ioredisClient(mod.default || mod, url);
  },
};

class KnextNodeUseCacheHandler extends CacheHandler {
  static redisClient = ioredis;
}

export default KnextNodeUseCacheHandler.forUseCache('default');
