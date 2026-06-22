import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { isAuthorized } from './auth';

/**
 * Cache Invalidation API
 * POST /api/cache/invalidate
 *
 * Mutating endpoint — requires a Bearer token (B1, security.md). Token from the
 * CACHE_INVALIDATE_TOKEN env var (K8s Secret); fail-closed when unconfigured.
 */
export async function POST(request: Request) {
  if (!isAuthorized(request.headers.get('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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

// NOTE (#78): there is intentionally NO GET handler. Cache invalidation mutates
// state, and a mutating GET is a security/operational hazard — prefetchable,
// link-triggerable, and it leaks the Bearer token into URLs/logs. App Router
// returns 405 automatically for the unexported GET method. POST is the only
// invalidation entrypoint.
