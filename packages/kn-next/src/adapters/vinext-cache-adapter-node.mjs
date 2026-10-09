/**
 * vinext data-cache adapter for knext's Node cache handler (ioredis, imported literally so the build traces it).
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
import { CacheHandler, ioredisClient } from './cache-handler.js';

// Defined here, with a LITERAL `import('ioredis')`, rather than imported from
// cache-handler-node.js: the bundler splits shared code into chunks, and nitro's
// tracer must see the literal specifier in this adapter's own file to ship ioredis.
const ioredis = {
  name: 'ioredis',
  async load(url) {
    const mod = await import('ioredis');
    return ioredisClient(mod.default || mod, url);
  },
};

class KnextNodeCacheHandler extends CacheHandler {
  static redisClient = ioredis;
}

export { KnextNodeCacheHandler as KnextCacheHandler };

/**
 * @param {{ env?: unknown, options?: Record<string, unknown> }} [args]
 * @returns one handler per isolate: vinext guards registration so this runs once.
 */
export default function createKnextVinextDataCacheAdapter(args) {
  return new KnextNodeCacheHandler(args);
}
