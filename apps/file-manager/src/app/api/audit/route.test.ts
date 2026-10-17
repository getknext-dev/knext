import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * GET /api/audit returns audit_logs rows. Reading them requires the same Bearer
 * token as the mutating routes, fails closed when unconfigured, and the answer
 * is never publicly cacheable (a shared cache must not replay it to someone
 * who has no token).
 */
mock.module('next/cache', () => ({
  // Run the wrapped function directly; no cache in a unit test.
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
}));

const query = mock(async (sql: string) =>
  sql.includes('COUNT') ? { rows: [{ count: '1' }] } : { rows: [{ id: 1, action: 'x' }] },
);
const getDbPool = mock(() => ({ query }));
mock.module('@getknext/lib/clients', () => ({ getDbPool }));

const { GET } = await import('./route');

const TOKEN = 'audit-test-token';
const original = process.env.CACHE_INVALIDATE_TOKEN;

function req(authorization?: string): Request {
  return new Request('http://localhost/api/audit?page=0', {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  process.env.CACHE_INVALIDATE_TOKEN = TOKEN;
  query.mockClear();
  getDbPool.mockClear();
});
afterEach(() => {
  if (original === undefined) delete process.env.CACHE_INVALIDATE_TOKEN;
  else process.env.CACHE_INVALIDATE_TOKEN = original;
});

describe('GET /api/audit authorization', () => {
  it('returns 401 with no Authorization header and reads nothing', async () => {
    const res = await GET(req(), {});
    expect(res.status).toBe(401);
    expect(getDbPool).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong token', async () => {
    const res = await GET(req('Bearer wrong'), {});
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when the token is not configured', async () => {
    delete process.env.CACHE_INVALIDATE_TOKEN;
    const res = await GET(req('Bearer anything'), {});
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the rows with the correct token, marked not publicly cacheable', async () => {
    const res = await GET(req(`Bearer ${TOKEN}`), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('no-store');
    expect(cc).not.toContain('public');
    expect(cc).not.toContain('s-maxage');
  });
});
