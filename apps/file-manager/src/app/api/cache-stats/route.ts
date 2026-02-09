import { NextResponse } from 'next/server';

// Simple in-memory cache stats tracker
// In production, use Redis or external metrics service
declare global {
  var cacheStats: {
    hits: number;
    misses: number;
    lastFetch: string | null;
    fetchDuration: number | null;
  };
}

// Initialize global stats
if (!global.cacheStats) {
  global.cacheStats = {
    hits: 0,
    misses: 0,
    lastFetch: null,
    fetchDuration: null,
  };
}

export function GET() {
  return NextResponse.json({
    cache: global.cacheStats,
    hitRate:
      global.cacheStats.hits + global.cacheStats.misses > 0
        ? `${(
            (global.cacheStats.hits / (global.cacheStats.hits + global.cacheStats.misses)) * 100
          ).toFixed(2)}%`
        : 'N/A',
    timestamp: new Date().toISOString(),
  });
}

// Export helper to track stats from other modules
export function trackCacheHit() {
  global.cacheStats.hits++;
}

export function trackCacheMiss(duration: number) {
  global.cacheStats.misses++;
  global.cacheStats.lastFetch = new Date().toISOString();
  global.cacheStats.fetchDuration = duration;
}
