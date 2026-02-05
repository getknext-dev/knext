import { getDbPool } from '@knative-next/lib';
import { unstable_cache } from 'next/cache';
import { type NextRequest, NextResponse } from 'next/server';

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
      total: Number.parseInt(countResult.rows[0].count),
      page,
      pageSize: PAGE_SIZE,
      hasMore: offset + logsResult.rows.length < Number.parseInt(countResult.rows[0].count),
    };
  },
  ['audit-logs'],
  {
    revalidate: 60, // Cache for 60 seconds
    tags: ['audit', 'audit-logs'], // <- Use these tags for invalidation testing!
  },
);

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const page = Number.parseInt(searchParams.get('page') || '0');

  try {
    const data = await getAuditLogsCached(page);

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
      },
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch audit logs', logs: [], total: 0, page: 0, hasMore: false },
      { status: 500 },
    );
  }
}
