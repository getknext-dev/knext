/**
 * The `'use cache: remote'` backend for the NODE runtime (Next >= 16.4
 * `cacheHandlers.remote`). Same module as `./use-cache-handler-node.js` for the
 * kind `remote`: its own key namespace, the same Redis connection and breaker,
 * and its own literal `import('ioredis')` for Next's file tracing (see there).
 *
 * Both kinds are wired. Next keeps its no-op built-in for any kind left unset, so
 * wiring only `default` would leave `'use cache: remote'` silently uncached.
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

export default KnextNodeUseCacheHandler.forUseCache('remote');
