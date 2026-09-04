/**
 * TDD (POC-ADAPTER-P1): cache-stats tracker utility
 * RED: fails until trackCacheHit/trackCacheMiss are moved to cache-stats.ts utility.
 */
import { beforeEach, describe, expect, it } from 'bun:test';

describe('cache-stats utility (POC-ADAPTER-P1)', () => {
  beforeEach(async () => {
    // An EXPLICIT reset. The old `vi.resetModules()` did not do what its comment
    // said: the counters live on `globalThis` behind an init guard, so
    // re-evaluating the module left them exactly as they were.
    (await import('./cache-stats')).resetCacheStats();
  });

  it('exports trackCacheHit and trackCacheMiss as named functions', async () => {
    const mod = await import('./cache-stats');
    expect(typeof mod.trackCacheHit).toBe('function');
    expect(typeof mod.trackCacheMiss).toBe('function');
  });

  it('trackCacheHit increments hits in the global stats', async () => {
    // Reset global state
    (globalThis as any).cacheStats = { hits: 0, misses: 0, lastFetch: null, fetchDuration: null };
    const { trackCacheHit } = await import('./cache-stats');
    trackCacheHit();
    trackCacheHit();
    expect((globalThis as any).cacheStats.hits).toBe(2);
  });

  it('trackCacheMiss increments misses and records duration', async () => {
    (globalThis as any).cacheStats = { hits: 0, misses: 0, lastFetch: null, fetchDuration: null };
    const { trackCacheMiss } = await import('./cache-stats');
    trackCacheMiss(42);
    expect((globalThis as any).cacheStats.misses).toBe(1);
    expect((globalThis as any).cacheStats.fetchDuration).toBe(42);
    expect((globalThis as any).cacheStats.lastFetch).not.toBeNull();
  });
});
