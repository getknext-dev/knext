import { getDbPool } from '@getknext/lib/clients';
import { unstable_cache } from 'next/cache';
import { NextResponse } from 'next/server';
import { withRedMetrics } from '../_metrics/registry';
import { isAuthorized } from '../cache/invalidate/auth';

const PAGE_SIZE = 20;

// Cached query with revalidation tag for testing
const getAuditLogsCached = unstable_cache(
  async (page: number) => {
    const db = getDbPool();
    const offset = page * PAGE_SIZE;

    const [logsResult, countResult] = await Promise.all([
      db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2', [
        PAGE_SIZE,
        offset,
      ]),
      db.query('SELECT COUNT(*) FROM audit_logs'),
    ]);

    return {
      logs: logsResult.rows,
      total: Number.parseInt(countResult.rows[0].count, 10),
      page,
      pageSize: PAGE_SIZE,
      hasMore: offset + logsResult.rows.length < Number.parseInt(countResult.rows[0].count, 10),
    };
  },
  ['audit-logs'],
  {
    revalidate: 60, // Cache for 60 seconds
    tags: ['audit', 'audit-logs'], // <- Use these tags for invalidation testing!
  },
);

// Wrapped in withRedMetrics (observability P0) under route="/api/audit".
// Behavior-preserving: returns this handler's own Response (incl. its 500-on-DB
// -error path) so the error-rate SLI sees DB outages on this route.
//
// Reading audit rows needs the same Bearer token as the mutating routes
// (CACHE_INVALIDATE_TOKEN, fail-closed when unset). The answer is therefore
// `private, no-store`: a shared cache must never replay it to a caller who has no
// token. (The server-side `unstable_cache` below is inside the process, after the
// check, and is not reachable without it.)
export const GET = withRedMetrics('/api/audit', async (request: any, _context: any) => {
  if (!isAuthorized(request?.headers?.get?.('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Vinext passes route params in context.params.
  // It turns out Vinext's Request shim sometimes drops the internal Next.js `nextUrl`
  // property entirely or strips standard properties off when creating the dummy request.
  // The most bulletproof way to parse the URL in all edge runtimes is to check
  // both the standard url property and use string splitting as a fallback

  let page = 0;
  try {
    // Safe fallback parsing. Some runtimes pass URL string directly or inside strange proxy objects
    const urlString = request?.url || request?.nextUrl?.href || 'http://localhost';
    const parsedUrl = new URL(urlString);
    const pageParam = parsedUrl.searchParams?.get('page');
    page = Number.parseInt(pageParam || '0', 10);
  } catch (e) {
    console.warn('Failed to parse URL in audit route:', e);
  }

  try {
    const data = await getAuditLogsCached(page);

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch audit logs', logs: [], total: 0, page: 0, hasMore: false },
      { status: 500 },
    );
  }
});
