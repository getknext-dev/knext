import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #338 — /api/health/deep is the DEEP dependency-reachability endpoint used for
 * observability/alerting only (never wired to a Knative probe). It classifies a
 * scale-to-zero DB that refuses the connection as `waking` (200, transient), and
 * a reachable-but-erroring DB as `down` (503).
 */

const pgQuery = vi.fn<() => Promise<unknown>>();
vi.mock('@knext/lib/clients', () => ({
  getDbPool: () => ({ query: pgQuery }),
}));
vi.mock('ioredis', () => ({
  default: class {
    ping() {
      return Promise.resolve('PONG');
    }
  },
}));

describe('GET /api/health/deep (observability) — #338', () => {
  beforeEach(() => {
    vi.resetModules();
    pgQuery.mockReset();
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
  });
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('scale-to-zero DB refusing the connection ⇒ 200 waking (transient, not a fault)', async () => {
    pgQuery.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.status).toBe('waking');
  });

  it('reachable-but-erroring DB ⇒ 503 down (genuine fault)', async () => {
    pgQuery.mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = JSON.parse(await res.text());
    expect(body.status).toBe('down');
  });
});
