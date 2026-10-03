/**
 * The knext cache handler for the NODE runtime (#1843).
 *
 * `knext build`/`deploy`/`preview` point `cacheHandler` here when the app's
 * configured runtime is `node`. All cache behaviour lives in
 * `./cache-handler.js`; this entry only fixes the Redis client: ioredis.
 *
 * The `import('ioredis')` below is LITERAL on purpose. Next's standalone file
 * tracing follows it, so `.next/standalone` — and with it the node runtime
 * image — carries ioredis and its dependencies. The generic entry hides the
 * same import behind a computed specifier, which tracing cannot follow; that
 * is how the node image ended up with no Redis client and a cache that ran
 * from memory in silence.
 *
 * It stays a lazy import (inside `load`, which runs only when REDIS_URL is
 * set) so an app without Redis never pays for loading the client. If it
 * cannot load, the core logs one "Redis client unavailable" error at startup
 * and serves from memory.
 */
import { CacheHandler, ioredisClient } from './cache-handler.js';

const ioredis = {
  name: 'ioredis',
  async load(url) {
    const mod = await import('ioredis');
    return ioredisClient(mod.default || mod, url);
  },
};

export default class KnextNodeCacheHandler extends CacheHandler {
  static redisClient = ioredis;
}
