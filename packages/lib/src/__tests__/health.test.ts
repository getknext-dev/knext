import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Postgres pool mock -----------------------------------------------------
// `checkDeepHealth` calls `getDbPool().query('SELECT 1 ...')`. We drive that
// query's behaviour per-test (resolve = alive, reject = blip, slow = timeout).
const pgQuery = vi.fn<() => Promise<unknown>>();
vi.mock('../clients', () => ({
  getDbPool: () => ({ query: pgQuery }),
}));

// --- Redis mock -------------------------------------------------------------
// The health module lazily `new RedisClient(url, opts)` then `.ping()`s it.
const redisPing = vi.fn<() => Promise<unknown>>();
vi.mock('ioredis', () => ({
  default: class {
    ping() {
      return redisPing();
    }
  },
}));

// Silence the logger.
vi.mock('../logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('checkDeepHealth — hard vs soft dependency taxonomy (readiness contract)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    pgQuery.mockReset();
    redisPing.mockReset();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  it('all dependencies healthy ⇒ ok / up / up', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.REDIS_URL = 'redis://h:6379';
    pgQuery.mockResolvedValue({ rows: [{ healthy: 1 }] });
    redisPing.mockResolvedValue('PONG');

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.status).toBe('ok');
    expect(res.checks.postgres).toBe('up');
    expect(res.checks.redis).toBe('up');
  });

  it('HARD dep (Postgres) transient blip with Redis healthy ⇒ down (fails CLOSED)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.REDIS_URL = 'redis://h:6379';
    pgQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    redisPing.mockResolvedValue('PONG');

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    // Never route traffic to a pod whose hard dependency is unreachable.
    expect(res.status).toBe('down');
    expect(res.checks.postgres).toBe('down');
    expect(res.checks.redis).toBe('up');
  });

  it('SOFT dep (Redis-cache) blip with Postgres healthy ⇒ degraded, NOT down (fails OPEN, stays Ready)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.REDIS_URL = 'redis://h:6379';
    pgQuery.mockResolvedValue({ rows: [{ healthy: 1 }] });
    redisPing.mockRejectedValue(new Error('cache node down'));

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    // A cache blip must NOT evict a pod that can still serve cache-miss traffic.
    expect(res.status).toBe('degraded');
    expect(res.checks.postgres).toBe('up');
    expect(res.checks.redis).toBe('down');
  });

  it('both dependencies down ⇒ down (hard-dep failure dominates)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.REDIS_URL = 'redis://h:6379';
    pgQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    redisPing.mockRejectedValue(new Error('cache node down'));

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.status).toBe('down');
    expect(res.checks.postgres).toBe('down');
    expect(res.checks.redis).toBe('down');
  });

  it('slow-but-alive Postgres exceeding the 3s cluster timeout ⇒ down, with NO false "up" sub-check', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    // PG query never settles within the window (slow, not dead).
    pgQuery.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // Advance past the 3s cluster-timeout guard.
    await vi.advanceTimersByTimeAsync(3100);
    const res = await promise;

    expect(res.status).toBe('down');
    // The timeout must not leave the never-resolved sub-check falsely 'up'.
    expect(res.checks.postgres).not.toBe('up');
  });

  it('Redis unconfigured + Postgres healthy ⇒ ok (only configured deps count)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    pgQuery.mockResolvedValue({ rows: [{ healthy: 1 }] });

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.status).toBe('ok');
    expect(res.checks.postgres).toBe('up');
    expect(res.checks.redis).toBe('unconfigured');
  });

  it('no dependencies configured ⇒ ok / unconfigured / unconfigured', async () => {
    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.status).toBe('ok');
    expect(res.checks.postgres).toBe('unconfigured');
    expect(res.checks.redis).toBe('unconfigured');
  });
});
