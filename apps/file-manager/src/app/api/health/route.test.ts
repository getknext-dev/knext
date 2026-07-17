import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #338 — the /api/health route backs the Knative readiness + liveness probes.
 * It MUST be SHALLOW: return 200 while a scale-to-zero DB is asleep/waking,
 * so readiness never flaps on legitimate DB cold-wake. Deep DB/Redis reachability
 * moves to /api/health/deep for observability only.
 */

// If the route ever imports the deep check it would pull these; make them throw
// so a regression to a deep probe is caught.
const pgQuery = vi.fn(() => Promise.reject(new Error('readiness must not dial pg')));
const redisPing = vi.fn(() => Promise.reject(new Error('readiness must not dial redis')));
vi.mock('@knext/lib/clients', () => ({
  getDbPool: () => ({ query: pgQuery }),
}));
vi.mock('ioredis', () => ({
  default: class {
    ping() {
      return redisPing();
    }
  },
}));

describe('GET /api/health (shallow readiness/liveness) — #338', () => {
  beforeEach(() => {
    pgQuery.mockClear();
    redisPing.mockClear();
    // DB configured but ASLEEP: the probe must still be Ready.
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
  });
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns 200 with the DB asleep and never dials Postgres/Redis', async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(pgQuery).not.toHaveBeenCalled();
    expect(redisPing).not.toHaveBeenCalled();
  });
});
