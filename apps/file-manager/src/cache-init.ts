// NOTE (POC-ADAPTER-P0): setCacheHandler is not exported from next/cache in
// Next.js 16.0.3.  The ISR cache handler is registered via `cacheHandler` in
// next.config.ts (the correct API).  This runtime call is a no-op guard that
// prevents a build-time TypeError when next/cache is evaluated during static
// analysis.  If setCacheHandler is eventually exported by Next, the guard
// will let it through; until then it skips silently.
import * as nextCache from 'next/cache';
import CacheHandler from '../cache-handler.js';

let initialized = false;
if (!initialized) {
  initialized = true;
  // @ts-expect-error — setCacheHandler not yet in next/cache public types
  if (typeof nextCache.setCacheHandler === 'function') {
    // @ts-expect-error — same as above
    nextCache.setCacheHandler(new CacheHandler());
    console.log('[Cache Init] Registered Custom CacheHandler via setCacheHandler');
  } else {
    console.log(
      '[Cache Init] setCacheHandler not available; ISR handler registered via next.config cacheHandler',
    );
  }
}
