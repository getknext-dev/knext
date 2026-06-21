import Redis from 'ioredis';
import { NextResponse } from 'next/server';
import '../../../../cache-init';
// Reuse the single auth helper from the invalidate route — DELETE here is a
// mutating endpoint (clears cache events) and must not be open (E4-2, security.md).
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
let redisClient: Redis | null = null;

if (REDIS_URL) {
  redisClient = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
}

async function getEvents(): Promise<CacheEvent[]> {
  if (redisClient) {
    try {
      const items = await redisClient.lrange(`${KEY_PREFIX}:cache-events`, 0, 50);
      return items.map((i) => JSON.parse(i));
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

export async function GET() {
  const events = await getEvents();
  const stats = await getCacheStats(events);

  return NextResponse.json({
    stats,
    events: events.slice(0, 50), // Return last 50 events
    timestamp: new Date().toISOString(),
  });
}

export async function DELETE(request: Request) {
  // Mutating: clears all cache events. Requires the same Bearer token as
  // POST /api/cache/invalidate; fail-closed when CACHE_INVALIDATE_TOKEN is unset.
  if (!isAuthorized(request.headers.get('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (redisClient) {
    try {
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
}
