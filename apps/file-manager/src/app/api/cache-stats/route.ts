import { NextResponse } from 'next/server';
import { withRedMetrics } from '../_metrics/registry';
import { getCacheStats } from './cache-stats';

// Tracker helpers (trackCacheHit, trackCacheMiss) live in cache-stats.ts.
// Exporting non-HTTP-method names from a route file is a Next.js type error.

// Wrapped in withRedMetrics (observability P0) so real traffic populates the
// server-side RED series. `route` is the bounded path template, never a raw URL.
// Behavior is preserved: the wrapper returns this handler's own Response.
export const GET = withRedMetrics('/api/cache-stats', () => {
  const stats = getCacheStats();
  return NextResponse.json({
    cache: stats,
    hitRate:
      stats.hits + stats.misses > 0
        ? `${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2)}%`
        : 'N/A',
    timestamp: new Date().toISOString(),
  });
});
