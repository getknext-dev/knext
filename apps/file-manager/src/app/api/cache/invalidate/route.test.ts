import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// revalidateTag touches Next.js internals that aren't available outside a
// running server; stub it so we can exercise the authorized POST path.
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

import * as route from './route';
import { POST } from './route';

/**
 * Issue #78: a GET must be side-effect-free. The mutating
 * `GET /api/cache/invalidate?tag=…` handler is removed — only the
 * authenticated, fail-closed POST remains as the invalidation entrypoint.
 * (App Router automatically returns 405 for an unexported method.)
 */
function postReq(body: unknown, authorization?: string): Request {
  return new Request('http://localhost/api/cache/invalidate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/cache/invalidate (issue #78)', () => {
  const TOKEN = 'test-cache-token';

  beforeEach(() => {
    process.env.CACHE_INVALIDATE_TOKEN = TOKEN;
  });
  afterEach(() => {
    process.env.CACHE_INVALIDATE_TOKEN = undefined;
  });

  it('exports NO GET handler (a mutating GET is removed)', () => {
    expect((route as Record<string, unknown>).GET).toBeUndefined();
    expect(typeof (route as Record<string, unknown>).GET).toBe('undefined');
  });

  it('still exports POST as the invalidation entrypoint', () => {
    expect(typeof POST).toBe('function');
  });

  it('returns 401 with no Authorization header', async () => {
    const res = await POST(postReq({ tag: 'files' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong token', async () => {
    const res = await POST(postReq({ tag: 'files' }, 'Bearer wrong-token'));
    expect(res.status).toBe(401);
  });

  it('fails closed when the token is not configured', async () => {
    process.env.CACHE_INVALIDATE_TOKEN = undefined;
    const res = await POST(postReq({ tag: 'files' }, 'Bearer anything'));
    expect(res.status).toBe(401);
  });

  it('returns 200 and invalidates with the correct token', async () => {
    const res = await POST(postReq({ tag: 'files' }, `Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 400 on a missing tag (authorized)', async () => {
    const res = await POST(postReq({}, `Bearer ${TOKEN}`));
    expect(res.status).toBe(400);
  });
});
