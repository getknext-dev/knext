/**
 * The `'use cache: remote'` backend for the NODE runtime (Next >= 16.4
 * `cacheHandlers.remote`). Same module as `./use-cache-handler-node.js` for the
 * kind `remote`: its own key namespace, the same Redis connection and breaker.
 *
 * Both kinds are wired. Next keeps its no-op built-in for any kind left unset, so
 * wiring only `default` would leave `'use cache: remote'` silently uncached.
 */
import KnextNodeCacheHandler from './cache-handler-node.js';

export default KnextNodeCacheHandler.forUseCache('remote');
