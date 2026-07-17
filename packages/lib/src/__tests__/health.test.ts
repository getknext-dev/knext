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

  it('HARD dep (Postgres) reachable but query-erroring with Redis healthy ⇒ down (fails CLOSED)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.REDIS_URL = 'redis://h:6379';
    // A reachable DB that errors the probe query (e.g. auth / relation missing)
    // is a genuine fault — NOT a scale-to-zero wake — so it stays fatal 'down'.
    pgQuery.mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }));
    redisPing.mockResolvedValue('PONG');

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

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

  it('both dependencies down ⇒ down (hard-dep query fault dominates)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.REDIS_URL = 'redis://h:6379';
    // Reachable-but-erroring PG (genuine fault, not a wake) dominates.
    pgQuery.mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }));
    redisPing.mockRejectedValue(new Error('cache node down'));

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.status).toBe('down');
    expect(res.checks.postgres).toBe('down');
    expect(res.checks.redis).toBe('down');
  });

  it('slow-but-alive Postgres exceeding the cluster timeout leaves NO false "up" sub-check (#338: classified waking)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    // PG query never settles within the window (slow, not dead).
    pgQuery.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // Advance past the deep cluster-timeout guard (default wake budget).
    await vi.advanceTimersByTimeAsync(9000);
    const res = await promise;

    // #338: a slow/waking hard-dep is 'waking', not fatal 'down' — but the
    // timeout must still never leave the never-resolved sub-check falsely 'up'.
    expect(res.status).toBe('waking');
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

  // --- #338: wake-aware deep check + configurable timeout ------------------

  it('#338 HARD dep (Postgres) connection-refused during a wake window ⇒ waking (NOT down)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    // A scale-to-zero DB that is legitimately WAKING refuses the connection.
    pgQuery.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    // An asleep/waking scale-to-zero DB is NORMAL, not a fatal 'down'.
    expect(res.status).toBe('waking');
    expect(res.checks.postgres).toBe('waking');
  });

  it('#338 slow-but-alive Postgres exceeding the timeout ⇒ waking (wake-in-progress, NOT down)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // Advance past the (default) deep timeout window.
    await vi.advanceTimersByTimeAsync(9000);
    const res = await promise;

    expect(res.status).toBe('waking');
    expect(res.checks.postgres).not.toBe('up');
  });

  it('#338 deep cluster timeout is configurable via HEALTH_DEEP_TIMEOUT_MS', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.HEALTH_DEEP_TIMEOUT_MS = '500';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // A 500ms budget must fire before the default: advancing 600ms settles it.
    await vi.advanceTimersByTimeAsync(600);
    const res = await promise;

    // Timed out at the configured budget ⇒ waking (wake still in progress).
    expect(res.status).toBe('waking');
    delete process.env.HEALTH_DEEP_TIMEOUT_MS;
  });

  it('#338 deep timeout defaults to the DB wake budget (> the old 3s)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // At 3.1s (the OLD hard-coded window) the check must NOT yet have timed out —
    // a waking DB gets the full wake budget.
    await vi.advanceTimersByTimeAsync(3100);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    // Drain the remaining budget so the test doesn't leak a pending timer.
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
  });
});

describe('checkShallowHealth — process-only readiness/liveness (#338)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    pgQuery.mockReset();
    redisPing.mockReset();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  it('returns ok when the process is up, WITHOUT touching Postgres or Redis', async () => {
    // Both deps configured but the query/ping mocks would REJECT if called.
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.REDIS_URL = 'redis://h:6379';
    pgQuery.mockRejectedValue(new Error('deep check must not run for shallow'));
    redisPing.mockRejectedValue(new Error('deep check must not run for shallow'));

    const { checkShallowHealth } = await import('../health');
    const res = await checkShallowHealth();

    expect(res.status).toBe('ok');
    // The shallow check must never dial the datastores.
    expect(pgQuery).not.toHaveBeenCalled();
    expect(redisPing).not.toHaveBeenCalled();
  });

  it('returns ok even with DATABASE_URL / REDIS_URL unset (no dependency dial)', async () => {
    const { checkShallowHealth } = await import('../health');
    const res = await checkShallowHealth();

    expect(res.status).toBe('ok');
    expect(pgQuery).not.toHaveBeenCalled();
    expect(redisPing).not.toHaveBeenCalled();
  });
});
