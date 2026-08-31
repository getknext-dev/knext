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

/**
 * Reset the counters (tests only).
 *
 * The explicit replacement for `vi.resetModules()`, which bun has no equivalent
 * of. Worth noting that `resetModules` never reset this either: the state lives
 * on `globalThis` behind an `if (!globalThis.cacheStats)` init guard, so
 * re-evaluating the module found the object already there and left it alone.
 * The test's comment claimed otherwise, so any case that appeared to depend on
 * a reset was actually reading accumulated counts.
 */
export function resetCacheStats(): void {
  globalThis.cacheStats = {
    hits: 0,
    misses: 0,
    lastFetch: null,
    fetchDuration: null,
  };
}

export function getCacheStats() {
  return globalThis.cacheStats;
}
