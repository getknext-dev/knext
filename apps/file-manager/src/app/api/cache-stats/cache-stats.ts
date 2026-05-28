/**
 * Cache stats tracker utilities.
 * Separated from route.ts because Next.js only allows HTTP-method exports
 * (GET, POST, …) from route files — named utility exports cause a build error.
 */
declare global {
  // eslint-disable-next-line no-var
  var cacheStats: {
    hits: number;
    misses: number;
    lastFetch: string | null;
    fetchDuration: number | null;
  };
}

// Initialise global stats on first import.
if (!globalThis.cacheStats) {
  globalThis.cacheStats = {
    hits: 0,
    misses: 0,
    lastFetch: null,
    fetchDuration: null,
  };
}

export function trackCacheHit(): void {
  globalThis.cacheStats.hits++;
}

export function trackCacheMiss(duration: number): void {
  globalThis.cacheStats.misses++;
  globalThis.cacheStats.lastFetch = new Date().toISOString();
  globalThis.cacheStats.fetchDuration = duration;
}

export function getCacheStats() {
  return globalThis.cacheStats;
}
