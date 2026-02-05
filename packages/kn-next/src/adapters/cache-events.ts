/**
 * Cache Events Logger
 * Tracks all cache operations (hits, misses, sets, deletes, invalidations)
 * for observability in the file-manager demo app.
 */

export type CacheEventType = 'HIT' | 'MISS' | 'SET' | 'DELETE' | 'INVALIDATE' | 'REVALIDATE';

export interface CacheEvent {
  id: string;
  timestamp: string;
  type: CacheEventType;
  source: 'gcs' | 'redis' | 'fetch';
  key: string;
  tag?: string;
  durationMs?: number;
  details?: string;
}

// Global event store (in production, use external storage)
declare global {
  var cacheEvents: CacheEvent[];
  var cacheEventCounter: number;
}

// Initialize globals
if (!global.cacheEvents) {
  global.cacheEvents = [];
}
if (!global.cacheEventCounter) {
  global.cacheEventCounter = 0;
}

const MAX_EVENTS = 100;

/**
 * Log a cache event
 */
export function logCacheEvent(
  type: CacheEventType,
  source: CacheEvent['source'],
  key: string,
  options?: {
    tag?: string;
    durationMs?: number;
    details?: string;
  },
): void {
  const event: CacheEvent = {
    id: `evt-${++global.cacheEventCounter}`,
    timestamp: new Date().toISOString(),
    type,
    source,
    key,
    ...options,
  };

  global.cacheEvents.unshift(event);

  // Keep only last N events
  if (global.cacheEvents.length > MAX_EVENTS) {
    global.cacheEvents = global.cacheEvents.slice(0, MAX_EVENTS);
  }

  // Also log to console for pod logs
  const emoji = {
    HIT: '✅',
    MISS: '❌',
    SET: '💾',
    DELETE: '🗑️',
    INVALIDATE: '🔄',
    REVALIDATE: '♻️',
  }[type];

  console.log(
    `[Cache ${emoji}] ${type} | ${source} | ${key}${options?.tag ? ` | tag:${options.tag}` : ''}${options?.durationMs ? ` | ${options.durationMs}ms` : ''}`,
  );
}

/**
 * Get all logged cache events
 */
export function getCacheEvents(): CacheEvent[] {
  return global.cacheEvents;
}

/**
 * Get cache statistics summary
 */
export function getCacheStats() {
  const events = global.cacheEvents;

  const hits = events.filter((e) => e.type === 'HIT').length;
  const misses = events.filter((e) => e.type === 'MISS').length;
  const sets = events.filter((e) => e.type === 'SET').length;
  const deletes = events.filter((e) => e.type === 'DELETE').length;
  const invalidations = events.filter((e) => e.type === 'INVALIDATE').length;
  const revalidations = events.filter((e) => e.type === 'REVALIDATE').length;

  const total = hits + misses;
  const hitRate = total > 0 ? `${((hits / total) * 100).toFixed(2)}%` : 'N/A';

  return {
    hits,
    misses,
    sets,
    deletes,
    invalidations,
    revalidations,
    hitRate,
    totalEvents: events.length,
  };
}

/**
 * Clear all cache events
 */
export function clearCacheEvents(): void {
  global.cacheEvents = [];
}
