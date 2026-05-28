import { NextResponse } from 'next/server';
import { getCacheStats } from './cache-stats';

// Tracker helpers (trackCacheHit, trackCacheMiss) live in cache-stats.ts.
// Exporting non-HTTP-method names from a route file is a Next.js type error.

export function GET() {
  const stats = getCacheStats();
  return NextResponse.json({
    cache: stats,
    hitRate:
      stats.hits + stats.misses > 0
        ? `${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2)}%`
        : 'N/A',
    timestamp: new Date().toISOString(),
  });
}
