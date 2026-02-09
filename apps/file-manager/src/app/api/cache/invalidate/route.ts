import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

/**
 * Cache Invalidation API
 * POST /api/cache/invalidate
 *
 * Triggers Next.js tag-based cache invalidation with SWR semantics
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { tag } = body;

    if (!tag || typeof tag !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid "tag" parameter' }, { status: 400 });
    }

    // Trigger Next.js cache invalidation with stale-while-revalidate
    revalidateTag(tag, 'max');

    return NextResponse.json({
      success: true,
      message: `Cache invalidated for tag: ${tag}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cache Invalidation] Error:', error);
    return NextResponse.json({ error: 'Failed to invalidate cache' }, { status: 500 });
  }
}

/**
 * GET /api/cache/invalidate?tag=files
 * Alternative GET-based invalidation for testing
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tag = searchParams.get('tag');

  if (!tag) {
    return NextResponse.json(
      { error: 'Missing "tag" query parameter', example: '/api/cache/invalidate?tag=files' },
      { status: 400 },
    );
  }

  // Trigger Next.js cache invalidation with stale-while-revalidate
  revalidateTag(tag, 'max');

  return NextResponse.json({
    success: true,
    message: `Cache invalidated for tag: ${tag}`,
    timestamp: new Date().toISOString(),
  });
}
