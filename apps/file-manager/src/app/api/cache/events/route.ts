import {
  clearCacheEvents,
  getCacheEvents,
  getCacheStats,
} from '@kn-next/config/adapters/cache-events';
import { NextResponse } from 'next/server';

/**
 * GET /api/cache/events
 * Returns all logged cache events
 */
export async function GET() {
  const events = getCacheEvents();
  const stats = getCacheStats();

  return NextResponse.json({
    stats,
    events: events.slice(0, 50), // Return last 50 events
    timestamp: new Date().toISOString(),
  });
}

/**
 * DELETE /api/cache/events
 * Clears all cache events
 */
export async function DELETE() {
  clearCacheEvents();

  return NextResponse.json({
    success: true,
    message: 'Cache events cleared',
    timestamp: new Date().toISOString(),
  });
}
