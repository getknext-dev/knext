import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { advanceTimersByTimeAsync } from '../../../../tests/helpers/bun-test-helpers';

// --- Postgres pool mock -----------------------------------------------------
// `checkDeepHealth` calls `getDbPool().query('SELECT 1 ...')`. We drive that
// query's behaviour per-test (resolve = alive, reject = blip, slow = timeout).
const pgQuery = mock<() => Promise<unknown>>();
mock.module('../clients', () => ({
  getDbPool: () => ({ query: pgQuery }),
}));

// --- Redis mock -------------------------------------------------------------
// The health module lazily `new RedisClient(url, opts)` then `.ping()`s it.
const redisPing = mock<() => Promise<unknown>>();
class FakeRedis {
  ping() {
    return redisPing();
  }
}
// Mock the SEAM, not the package — and under bun the seam moved UP.
//
// The ioredis-ctor mock below is still right for Node: ioredis is resolved
// through a computed specifier so it stays out of the bundle graph, and
// `mock.module('ioredis')` resolves by module id, which cannot intercept that.
//
// But `createRedisClient` prefers `Bun.RedisClient` when it exists, and under
// `bun test` it ALWAYS exists. So on bun the ioredis branch is never taken and
// both mocks below are dead — the health check dialled a real Redis and failed
// with "Connection timeout reached after 2000ms", which names a network problem
// rather than a mocking one. The two mocks are kept because they document the
// Node path, and `createRedisClient` is mocked above them because it is the one
// seam BOTH runtimes go through.
mock.module('../redis/client', () => ({
  createRedisClient: () => new FakeRedis(),
}));
mock.module('../redis/ioredis-ctor', () => ({ loadRedisCtor: () => FakeRedis }));
mock.module('ioredis', () => ({ default: FakeRedis }));

// Silence the logger.
mock.module('../logger', () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

describe('checkDeepHealth — hard vs soft dependency taxonomy (readiness contract)', () => {
  beforeEach(() => {
    jest.useRealTimers();
    // No `resetClients()`: `../clients` is replaced wholesale above, so there
    // is no real module state to clear. Calling the mock's no-op would only
    // look like it was doing something.
    pgQuery.mockReset();
    redisPing.mockReset();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.KNEXT_DB_SCALE_TO_ZERO;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.KNEXT_DB_SCALE_TO_ZERO;
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

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // Advance past the deep cluster-timeout guard (default wake budget).
    await advanceTimersByTimeAsync(9000);
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

  it('#338 HARD dep (Postgres) connection-refused against the scale-to-zero gateway ⇒ waking (NOT down)', async () => {
    // The scale-zero-pg gateway is the scale-to-zero database this app is bound to.
    process.env.DATABASE_URL =
      'postgres://u:p@pggw.scale-zero-pg.svc.cluster.local.:55432/postgres?sslmode=disable';
    // A scale-to-zero DB that is legitimately WAKING refuses the connection.
    pgQuery.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    // An asleep/waking scale-to-zero DB is NORMAL, not a fatal 'down'.
    expect(res.status).toBe('waking');
    expect(res.checks.postgres).toBe('waking');
  });

  it('bring-your-own Postgres connection-refused ⇒ down (NOT waking: nothing is waking)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
    pgQuery.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    // A refused connection to a BYO database is an outage, not a wake.
    expect(res.status).toBe('down');
    expect(res.checks.postgres).toBe('down');
  });

  it('bring-your-own Postgres whose DSN merely mentions scale-zero-pg ⇒ down (host, not substring)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/scale-zero-pg';
    pgQuery.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.checks.postgres).toBe('down');
    expect(res.status).toBe('down');
  });

  // --- a refusal is known on the first attempt, not after the retry budget ----
  //
  // The real pool retries a failed connect for DB_WAKE_RETRY_BUDGET_MS (8 s by
  // default) and the deep check gives up at HEALTH_DEEP_TIMEOUT_MS (8 s), so a
  // rejection never reaches the classifier before the timeout. The retry layer
  // therefore REPORTS each failed attempt, and the deep check acts on a refusal
  // without waiting for the final rejection. (The un-mocked default-settings
  // proof is `health-refused-defaults.test.ts`.)

  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

  it('bring-your-own Postgres: a refusal reported while the probe is still retrying ⇒ down at once', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
    // The probe never settles on its own: it is inside the pool's retry loop.
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const { reportAcquireFailure } = await import('../db/reachability');
    const promise = checkDeepHealth();
    await advanceTimersByTimeAsync(10);
    reportAcquireFailure(refused());
    // Far inside the 8 s deep window: the verdict does not wait for it.
    await advanceTimersByTimeAsync(10);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
    const res = await promise;

    expect(res.checks.postgres).toBe('down');
    expect(res.status).toBe('down');
  });

  it('scale-to-zero gateway: a reported refusal is a wake, so it stays waking (never short-circuits to down)', async () => {
    process.env.DATABASE_URL =
      'postgres://u:p@pggw.scale-zero-pg.svc.cluster.local.:55432/postgres?sslmode=disable';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const { reportAcquireFailure } = await import('../db/reachability');
    const promise = checkDeepHealth();
    await advanceTimersByTimeAsync(10);
    reportAcquireFailure(refused());
    await advanceTimersByTimeAsync(10);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    // Still waiting for the wake: nothing decided yet.
    expect(settled).toBe(false);
    await advanceTimersByTimeAsync(9000);
    const res = await promise;

    expect(res.checks.postgres).toBe('waking');
    expect(res.status).toBe('waking');
  });

  it('bring-your-own Postgres: a non-refusal failure reported mid-probe does not decide the verdict', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const { reportAcquireFailure } = await import('../db/reachability');
    const promise = checkDeepHealth();
    await advanceTimersByTimeAsync(10);
    // A reset / timeout is not a definitive refusal: a timed-out probe stays
    // `waking` (the documented behaviour), so it must not flip to down early.
    reportAcquireFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    reportAcquireFailure(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    await advanceTimersByTimeAsync(10);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await advanceTimersByTimeAsync(9000);
    const res = await promise;

    expect(res.checks.postgres).toBe('waking');
  });

  it('bring-your-own Postgres: the probe rejecting AFTER the refusal decided is not an unhandled rejection', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
    let rejectProbe: (e: unknown) => void = () => {};
    pgQuery.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectProbe = reject;
        }),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { checkDeepHealth } = await import('../health');
      const { reportAcquireFailure } = await import('../db/reachability');
      const promise = checkDeepHealth();
      await new Promise((r) => setTimeout(r, 5));
      reportAcquireFailure(refused());
      expect((await promise).checks.postgres).toBe('down');
      // The pool finally gives up, long after the verdict was returned.
      rejectProbe(refused());
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // --- only a REFUSAL turns a non-scale-to-zero database `down` --------------
  //
  // Everything else that looks like a connection-level failure is ambiguous (a
  // reset, a DNS blip, a timeout) and keeps its wake classification on EVERY host,
  // including one the host heuristic cannot recognise.

  for (const [label, err] of [
    ['a connect timeout (ETIMEDOUT)', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })],
    ['a reset (ECONNRESET)', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['a DNS blip (EAI_AGAIN)', Object.assign(new Error('getaddrinfo'), { code: 'EAI_AGAIN' })],
    ['a dropped connect', new Error('Connection terminated unexpectedly')],
  ] as const) {
    it(`bring-your-own Postgres: ${label} rejecting the probe ⇒ waking, not down`, async () => {
      process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
      pgQuery.mockRejectedValue(err);

      const { checkDeepHealth } = await import('../health');
      const res = await checkDeepHealth();

      expect(res.checks.postgres).toBe('waking');
      expect(res.status).toBe('waking');
    });
  }

  it('KNEXT_DB_SCALE_TO_ZERO=true: a refused connection to an unrecognised host reads waking', async () => {
    // A pooler / IP / ExternalName alias in front of the scale-to-zero database.
    process.env.DATABASE_URL = 'postgres://u:p@10.0.0.7:5432/app';
    process.env.KNEXT_DB_SCALE_TO_ZERO = 'true';
    pgQuery.mockRejectedValue(refused());

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.checks.postgres).toBe('waking');
  });

  it('KNEXT_DB_SCALE_TO_ZERO=true: a refusal reported mid-probe never short-circuits to down', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@10.0.0.7:5432/app';
    process.env.KNEXT_DB_SCALE_TO_ZERO = 'true';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const { reportAcquireFailure } = await import('../db/reachability');
    const promise = checkDeepHealth();
    await advanceTimersByTimeAsync(10);
    reportAcquireFailure(refused());
    await advanceTimersByTimeAsync(10);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await advanceTimersByTimeAsync(9000);
    expect((await promise).checks.postgres).toBe('waking');
  });

  it('KNEXT_DB_SCALE_TO_ZERO=false: a refused connection to the gateway host reads down', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@pggw-apps.scale-zero-pg.svc:55432/app';
    process.env.KNEXT_DB_SCALE_TO_ZERO = 'false';
    pgQuery.mockRejectedValue(refused());

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.checks.postgres).toBe('down');
  });

  it('a short-form gateway host (no .svc) is still scale-to-zero ⇒ a refusal reads waking', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@pggw-apps.scale-zero-pg:55432/app';
    pgQuery.mockRejectedValue(refused());

    const { checkDeepHealth } = await import('../health');
    expect((await checkDeepHealth()).checks.postgres).toBe('waking');
  });

  it('a server-side error that says "connection refused" (SQLSTATE 08001) never short-circuits', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const { reportAcquireFailure } = await import('../db/reachability');
    const promise = checkDeepHealth();
    await advanceTimersByTimeAsync(10);
    // An application query on the same pool, run through dblink / postgres_fdw.
    reportAcquireFailure(
      Object.assign(new Error('could not connect to server: Connection refused'), {
        code: '08001',
        severity: 'ERROR',
      }),
    );
    await advanceTimersByTimeAsync(10);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await advanceTimersByTimeAsync(9000);
    expect((await promise).checks.postgres).toBe('waking');
  });

  it('a refusal reported BEFORE the check began does not decide it (no stale verdict)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
    const { reportAcquireFailure } = await import('../db/reachability');
    // The previous check's abandoned probe, still retrying, gives up late.
    reportAcquireFailure(refused());
    pgQuery.mockResolvedValue({ rows: [{ healthy: 1 }] });

    const { checkDeepHealth } = await import('../health');
    const res = await checkDeepHealth();

    expect(res.checks.postgres).toBe('up');
  });

  it('the failure observer is released when the check finishes (no listener leak per scrape)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/app';
    pgQuery.mockResolvedValue({ rows: [{ healthy: 1 }] });

    const { checkDeepHealth } = await import('../health');
    const { acquireFailureObserverCount } = await import('../db/reachability');
    const before = acquireFailureObserverCount();
    await checkDeepHealth();
    await checkDeepHealth();
    expect(acquireFailureObserverCount()).toBe(before);
  });

  it('#338 slow-but-alive Postgres exceeding the timeout ⇒ waking (wake-in-progress, NOT down)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // Advance past the (default) deep timeout window.
    await advanceTimersByTimeAsync(9000);
    const res = await promise;

    expect(res.status).toBe('waking');
    expect(res.checks.postgres).not.toBe('up');
  });

  it('#338 deep cluster timeout is configurable via HEALTH_DEEP_TIMEOUT_MS', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    process.env.HEALTH_DEEP_TIMEOUT_MS = '500';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // A 500ms budget must fire before the default: advancing 600ms settles it.
    await advanceTimersByTimeAsync(600);
    const res = await promise;

    // Timed out at the configured budget ⇒ waking (wake still in progress).
    expect(res.status).toBe('waking');
    delete process.env.HEALTH_DEEP_TIMEOUT_MS;
  });

  it('#338 deep timeout defaults to the DB wake budget (> the old 3s)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    pgQuery.mockImplementation(() => new Promise(() => {}));

    jest.useFakeTimers();
    const { checkDeepHealth } = await import('../health');
    const promise = checkDeepHealth();
    // At 3.1s (the OLD hard-coded window) the check must NOT yet have timed out —
    // a waking DB gets the full wake budget.
    await advanceTimersByTimeAsync(3100);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    // Drain the remaining budget so the test doesn't leak a pending timer.
    await advanceTimersByTimeAsync(6000);
    await promise;
  });
});

describe('checkShallowHealth — process-only readiness/liveness (#338)', () => {
  beforeEach(() => {
    jest.useRealTimers();
    // No `resetClients()`: `../clients` is replaced wholesale above, so there
    // is no real module state to clear. Calling the mock's no-op would only
    // look like it was doing something.
    pgQuery.mockReset();
    redisPing.mockReset();
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.KNEXT_DB_SCALE_TO_ZERO;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.KNEXT_DB_SCALE_TO_ZERO;
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
