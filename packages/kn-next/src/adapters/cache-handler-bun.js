/**
 * The knext cache handler for the BUN runtime (#1843).
 *
 * `knext build`/`deploy`/`preview` point `cacheHandler` here when the app's
 * configured runtime is `bun`. All cache behaviour lives in
 * `./cache-handler.js`; this entry only fixes the Redis client: Bun's
 * built-in one (`Bun.RedisClient`, 1.2.9+).
 *
 * This entry never imports or selects ioredis (the generic module it extends
 * keeps a runtime-detecting path for its own callers, which this subclass
 * replaces). The compiled Bun executable loads this handler from disk, and a
 * client that reaches a transitive dynamic `require` (as ioredis does) cannot
 * run inside it. The native client also costs no JavaScript at startup.
 *
 * Outside Bun, or on a Bun without the built-in client, the core logs one
 * "Redis client unavailable" error at startup and serves from memory.
 */
import { CacheHandler, nativeRedisClient } from './cache-handler.js';

const bunNative = {
  name: 'Bun native',
  load(url) {
    const B = globalThis.Bun;
    if (!B || typeof B.RedisClient !== 'function') {
      throw new Error(
        'Bun.RedisClient is not available: this is the Bun runtime cache handler ' +
          'and needs Bun 1.2.9 or later',
      );
    }
    return nativeRedisClient(B, url);
  },
};

export default class KnextBunCacheHandler extends CacheHandler {
  static redisClient = bunNative;
}
