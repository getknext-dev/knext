import { createRedisClient, ensureDialable } from '@getknext/lib';
import { NextResponse } from 'next/server';
// NOTE: this route used to import `cache-init`, an imperative
// `setCacheHandler(new CacheHandler())` probe written for Next (where the
// setter never existed, so it no-opped). Under vinext's next/cache shim the
// setter IS real, so that import silently became a SECOND registration racing
// the vinext() plugin's declarative `cache.data` wiring (vite.config.ts) —
// two handler instances, order-dependent winner. The plugin wiring is the one
// registration mechanism now; the `globalThis.cacheEvents` fallback this route
// reads is initialised by the handler module itself, which the registration
// module loads before any route runs.
// Reuse the single auth helper from the invalidate route — DELETE here is a
// mutating endpoint (clears cache events) and must not be open (E4-2, security.md).
import { withRedMetrics } from '../../_metrics/registry';
import { isAuthorized } from '../invalidate/auth';

/**
 * Cache Events API
 * Reads from Redis if available, fallback to globalThis.cacheEvents
 *
 * GET /api/cache/events — Returns cache events and stats
 * DELETE /api/cache/events — Clears all events
 */

interface CacheEvent {
  id: string;
  timestamp: string;
  type: string;
  source: string;
  key: string;
  tag?: string;
  durationMs?: number;
  details?: string;
}

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'kn-next';
let redisClient: ReturnType<typeof createRedisClient> | null = null;

if (REDIS_URL) {
  // #802: lazy (no dial at module evaluation), listened-to, and bounded (the
  // retry gives up instead of looping for the pod's life). Recovery is on
  // demand — see `ensureDialable` in getEvents/DELETE. The selector attaches
  // the error listener itself, so there is no second call here.
  //
  // Bun-native when running on Bun, ioredis under Node. This used to construct
  // ioredis directly against a LOCAL copy of the quiet helpers, which had
  // already drifted from the shared one: the copy only knew how to attach a
  // listener via `.on()`, and Bun's client has no `.on()` at all — so on the
  // runtime this app actually targets it attached nothing and the #802 log
  // noise came back silently.
  redisClient = createRedisClient(REDIS_URL, 'cache-events');
}

async function getEvents(): Promise<CacheEvent[]> {
  if (redisClient) {
    try {
      ensureDialable(redisClient);
      const items = await redisClient.lrange(`${KEY_PREFIX}:cache-events`, 0, 50);
      return items.map((i: string) => JSON.parse(i) as CacheEvent);
    } catch (e) {
      console.error('[Cache Events] Error reading from Redis:', e);
      return [];
    }
  }
  return ((globalThis as Record<string, unknown>).cacheEvents as CacheEvent[]) || [];
}

async function getCacheStats(events: CacheEvent[]) {
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

// Wrapped in withRedMetrics (observability P0) under the bounded
// route="/api/cache/events" label. Behavior-preserving — returns each handler's
// own Response; the DELETE auth check is untouched.
export const GET = withRedMetrics('/api/cache/events', async () => {
  const events = await getEvents();
  const stats = await getCacheStats(events);

  return NextResponse.json({
    stats,
    events: events.slice(0, 50), // Return last 50 events
    timestamp: new Date().toISOString(),
  });
});

export const DELETE = withRedMetrics('/api/cache/events', async (request: Request) => {
  // Mutating: clears all cache events. Requires the same Bearer token as
  // POST /api/cache/invalidate; fail-closed when CACHE_INVALIDATE_TOKEN is unset.
  if (!isAuthorized(request.headers.get('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (redisClient) {
    try {
      ensureDialable(redisClient);
      await redisClient.del(`${KEY_PREFIX}:cache-events`);
    } catch (e) {
      console.error('[Cache Events] Error deleting from Redis:', e);
    }
  } else {
    (globalThis as Record<string, unknown>).cacheEvents = [];
    (globalThis as Record<string, unknown>).cacheEventCounter = 0;
  }

  return NextResponse.json({
    success: true,
    message: 'Cache events cleared',
    timestamp: new Date().toISOString(),
  });
});
