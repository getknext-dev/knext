import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DELETE } from './route';

/**
 * E4-2: DELETE /api/cache/events is a mutating endpoint (clears all cache
 * events). It must require the same Bearer token as POST /api/cache/invalidate
 * and fail closed. Without REDIS_URL the handler clears the in-memory store, so
 * these run without a live Redis.
 */
function deleteReq(authorization?: string): Request {
  return new Request('http://localhost/api/cache/events', {
    method: 'DELETE',
    headers: authorization ? { authorization } : {},
  });
}

describe('DELETE /api/cache/events authorization', () => {
  const TOKEN = 'test-cache-token';

  beforeEach(() => {
    process.env.CACHE_INVALIDATE_TOKEN = TOKEN;
  });
  afterEach(() => {
    process.env.CACHE_INVALIDATE_TOKEN = undefined;
  });

  it('returns 401 with no Authorization header', async () => {
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong token', async () => {
    const res = await DELETE(deleteReq('Bearer wrong-token'));
    expect(res.status).toBe(401);
  });

  it('returns 200 with the correct token', async () => {
    const res = await DELETE(deleteReq(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
  });

  it('fails closed when the token is not configured', async () => {
    process.env.CACHE_INVALIDATE_TOKEN = undefined;
    const res = await DELETE(deleteReq('Bearer anything'));
    expect(res.status).toBe(401);
  });
});
