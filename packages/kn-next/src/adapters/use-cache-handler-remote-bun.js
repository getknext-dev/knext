/**
 * The `'use cache: remote'` backend for the BUN runtime (Next >= 16.4
 * `cacheHandlers.remote`). Same module as `./use-cache-handler-bun.js` for the
 * kind `remote`: its own key namespace, the same Redis connection and breaker.
 *
 * Both kinds are wired. Next keeps its no-op built-in for any kind left unset, so
 * wiring only `default` would leave `'use cache: remote'` silently uncached.
 */
import KnextBunCacheHandler from './cache-handler-bun.js';

export default KnextBunCacheHandler.forUseCache('remote');
