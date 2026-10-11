import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closedPort, startFakePostgres } from './fixtures/fake-postgres';

/**
 * The deep check's verdict over a database's life, against a REAL pool with its
 * real retry layer and DEFAULT timings (no env tuning): nothing here is mocked
 * except the far end of the socket, which is a real listener speaking the
 * Postgres wire protocol (`fixtures/fake-postgres.ts`).
 *
 * `health-refused-defaults.test.ts` proves a refused bring-your-own database
 * reads `down`. This file proves the other half of the claim: that the verdict
 * is not sticky and not over-eager.
 */

const ENV = [
  'DB_WAKE_RETRY_BUDGET_MS',
  'DB_WAKE_RETRY_BASE_MS',
  'DB_WAKE_RETRY_MAX_MS',
  'DB_POOL_CONNECT_TIMEOUT_MS',
  'HEALTH_DEEP_TIMEOUT_MS',
  'KNEXT_DB_SCALE_TO_ZERO',
  'KNEXT_DB_DRIVER',
  'DATABASE_URL',
  'REDIS_URL',
] as const;
const saved: Record<string, string | undefined> = {};
const closers: Array<() => Promise<void>> = [];

describe('checkDeepHealth over a database lifecycle — real pool, default timings', () => {
  beforeEach(async () => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    (await import('../clients')).resetClients();
  });

  afterEach(async () => {
    // End the pool BEFORE its far end disappears, so the idle client is released
    // cleanly rather than erroring on a pool nobody is listening to.
    const clients = await import('../clients');
    await clients.closeDbPool();
    clients.resetClients();
    for (const close of closers.splice(0)) await close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const driver of ['pg', 'bun'] as const) {
    it(`${driver} driver: a refused scale-to-zero database reads waking, not down`, async () => {
      // Declared scale-to-zero: the host here is a loopback address, which the
      // heuristic cannot know (the same situation as a pooler or an IP).
      const port = await closedPort();
      process.env.DATABASE_URL = `postgres://u:p@127.0.0.1:${port}/app`;
      process.env.KNEXT_DB_SCALE_TO_ZERO = 'true';
      process.env.KNEXT_DB_DRIVER = driver;

      const { checkDeepHealth } = await import('../health');
      const res = await checkDeepHealth();

      // The refusal is the wake itself: the check must wait it out and report
      // `waking`, and must not have been short-circuited to `down`.
      expect(res.checks.postgres).toBe('waking');
      expect(res.status).toBe('waking');
    }, 30_000);
  }

  it('a database that was refused and then starts listening reads up on the next check', async () => {
    const port = await closedPort();
    process.env.DATABASE_URL = `postgres://u:p@127.0.0.1:${port}/app`;
    process.env.KNEXT_DB_DRIVER = 'pg';

    const { checkDeepHealth } = await import('../health');
    const { acquireFailureObserverCount } = await import('../db/reachability');
    const baseline = acquireFailureObserverCount();

    const outage = await checkDeepHealth();
    expect(outage.checks.postgres).toBe('down');

    // The first check abandoned its probe, which is still inside the pool's
    // retry loop and still reporting refusals. The database now comes back.
    const db = await startFakePostgres(port);
    closers.push(db.close);

    const started = Date.now();
    const recovered = await checkDeepHealth();

    expect(recovered.checks.postgres).toBe('up');
    expect(recovered.status).toBe('ok');
    // Recovery is the pool's next retry (<= 1 s backoff), not another full window.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(acquireFailureObserverCount()).toBe(baseline);

    // And it stays up: no stale refusal from the abandoned probe leaks in.
    const again = await checkDeepHealth();
    expect(again.checks.postgres).toBe('up');
  }, 30_000);

  it('a server-side error that reads "connection refused" (SQLSTATE 08001) does not turn a reachable database down', async () => {
    // dblink / postgres_fdw: the database ANSWERED, with an error about a
    // different server it tried to reach. It is not down.
    const db = await startFakePostgres(0, {
      kind: 'error',
      sqlstate: '08001',
      message: 'could not connect to server: Connection refused (ECONNREFUSED)',
    });
    closers.push(db.close);
    process.env.DATABASE_URL = `postgres://u:p@127.0.0.1:${db.port}/app`;
    process.env.KNEXT_DB_DRIVER = 'pg';
    // Shorten only the deep window (the pool keeps its default retry budget): the
    // point is that the observer does not decide, not how long the window is.
    process.env.HEALTH_DEEP_TIMEOUT_MS = '1500';

    const { checkDeepHealth } = await import('../health');
    const started = Date.now();
    const res = await checkDeepHealth();

    expect(res.checks.postgres).not.toBe('down');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  }, 30_000);
});
