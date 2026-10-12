import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

/**
 * The deep-health probe must not keep the database awake by probing it.
 *
 * THE LOOP THIS CLOSES. The scrape hook runs `checkDeepHealth()` only while
 * `isDbRecentlyActive()` (45 s budget). `checkDeepHealth()` queries the TRACKED
 * writer pool, and the tracked pool stamps `lastDbActivityAt` on every query. So
 * the probe stamped its own activity: with a 30 s scrape interval (under the
 * 45 s budget) every scrape re-armed the gate, the probe ran forever, and the
 * scale-to-zero database NEVER slept while the pod was up. That contradicts the
 * gate's whole purpose (clients.ts: "the scrape must not re-wake it").
 *
 * It was latent while the child `/metrics` port was not scraped; serving the
 * gauge on the scraped port makes it live, so the loop itself is the test:
 * real tracked pool, real `checkDeepHealth`, a scrape every 30 s, and the only
 * REAL application query happening once at the start.
 *
 * Nothing here mocks `../clients` or `../health` — a stubbed pool cannot stamp
 * activity, which is precisely why the unit tests for each half stayed green.
 */

const query = mock((..._args: unknown[]) => Promise.resolve({ rows: [] }));
const connect = mock(() => Promise.resolve({ release() {} }));
mock.module('pg', () => ({
  Pool: class {
    query(...args: unknown[]) {
      return query(...(args as []));
    }
    connect(...args: unknown[]) {
      return connect(...(args as []));
    }
    end() {
      return Promise.resolve();
    }
  },
}));
mock.module('../logger', () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const SCRAPE_INTERVAL_MS = 30_000;
const BUDGET_MS = 45_000;

describe('deep-health probe vs the DB activity gate', () => {
  beforeEach(async () => {
    const clients = await import('../clients');
    clients.resetClients();
    clients.resetDbActivity();
    jest.useRealTimers();
    query.mockClear();
    query.mockImplementation((..._args: unknown[]) => Promise.resolve({ rows: [] }));
    connect.mockClear();
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.DATABASE_URL;
  });

  it('the probe does not stamp activity: lastDbActivityAt is unchanged by checkDeepHealth()', async () => {
    jest.useFakeTimers();
    const clients = await import('../clients');
    const { checkDeepHealth } = await import('../health');

    await clients.getDbPool().query('SELECT 1'); // the one REAL application query
    const stamped = clients.getLastDbActivityAt();
    expect(stamped).toBeDefined();

    jest.advanceTimersByTime(10_000);
    query.mockClear();
    await checkDeepHealth();

    expect(query).toHaveBeenCalledTimes(1); // the probe did reach the database
    expect(clients.getLastDbActivityAt()).toBe(stamped);
  });

  it('probes spaced at the scrape interval stop once real activity ages past the budget', async () => {
    jest.useFakeTimers();
    const clients = await import('../clients');
    const { checkDeepHealth } = await import('../health');

    await clients.getDbPool().query('SELECT 1'); // real traffic at t=0, then none
    query.mockClear();

    // The scrape hook, as makeDeepHealthScrapeHook wires it: probe only while the
    // app has used the DB recently.
    let probes = 0;
    const scrape = async () => {
      if (!clients.isDbRecentlyActive(BUDGET_MS)) return;
      probes += 1;
      await checkDeepHealth();
    };

    // 10 scrape intervals = 5 minutes of idle app, pod still up.
    for (let i = 1; i <= 10; i++) {
      jest.advanceTimersByTime(SCRAPE_INTERVAL_MS);
      await scrape();
    }

    // Only the scrape at t=30s is inside the 45 s budget. Before the fix every
    // probe re-stamped, so this was 10 and the database never slept.
    expect(probes).toBe(1);
    expect(clients.isDbRecentlyActive(BUDGET_MS)).toBe(false);
  });

  it('real application traffic DURING a probe still stamps activity (the scope is per call, not global)', async () => {
    const clients = await import('../clients');
    const { checkDeepHealth } = await import('../health');

    // Wake the pool first (the cold first acquisition is single-flighted, so a
    // hanging first query would block every later one), then forget the stamp.
    await clients.getDbPool().query('SELECT 1');
    clients.resetDbActivity();
    expect(clients.getLastDbActivityAt()).toBeUndefined();

    // The probe's query hangs until released; meanwhile the app serves a request.
    let release!: () => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ rows: [] });
        }),
    );
    const probe = checkDeepHealth();
    await Promise.resolve();
    expect(clients.getLastDbActivityAt()).toBeUndefined(); // the probe alone stamped nothing

    await clients.getDbPool().query('SELECT 1'); // real traffic, outside the probe's scope
    expect(clients.getLastDbActivityAt()).toBeDefined();

    release();
    await probe;
  });
});
