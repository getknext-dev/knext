/**
 * vinext data-cache adapter FACTORY for the NODE runtime: ioredis through a
 * LITERAL import, which nitro/vite tracing follows into the image.
 *
 * Same contract as `./vinext-cache-adapter.mjs` (vinext calls the default
 * export as `factory({ env, options })`); the only difference is that the
 * Redis client is fixed statically instead of being detected at runtime
 * through a specifier no bundler can follow. The scaffolded `vite.config.ts`
 * picks the entry that matches `runtime`.
 *
 * The client definition mirrors `./cache-handler-node.js` rather than
 * importing it: importing it would make the package build hoist that entry's
 * literal `import('ioredis')` into a shared chunk, and the entry-level
 * guarantee ("the built node entry itself carries the literal import") would
 * stop holding. Both are covered by tests.
 *
 * It stays a lazy import (inside `load`, which runs only when REDIS_URL is
 * set). If the client cannot load while REDIS_URL is set, the core logs one
 * "Redis client unavailable" error at startup and serves from memory.
 */
import { CacheHandler, ioredisClient } from './cache-handler.js';

const ioredis = {
  name: 'ioredis',
  async load(url) {
    const mod = await import('ioredis');
    return ioredisClient(mod.default || mod, url);
  },
};

class KnextVinextNodeCacheHandler extends CacheHandler {
  static redisClient = ioredis;
}

/**
 * @param {{ env?: unknown, options?: Record<string, unknown> }} [args]
 * @returns {import('./cache-handler.js').default}
 */
export default function createKnextVinextDataCacheAdapter(args) {
  return new KnextVinextNodeCacheHandler(args?.options);
}
