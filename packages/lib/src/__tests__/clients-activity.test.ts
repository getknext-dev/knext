import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #348 (gate fix) — per-pool DB ACTIVITY tracking, so the deep-health scrape
 * only dials Postgres when the app has actually used the DB recently.
 *
 * Without this, the :9091 scrape (every ~30s) ran `checkDeepHealth()` →
 * `SELECT 1` through the scale-zero-pg gateway on EVERY scrape, re-arming the
 * gateway's 60s DB idle timer → the DB never sleeps while the pod is up. This
 * BREAKS scale-to-zero (the platform's core value prop).
 *
 * The tracker records `lastQueryAt` whenever the writer pool is queried
 * (independent of OTel — the pool is used whether or not tracing is on), and
 * exposes `getLastDbActivityAt()` + `isDbRecentlyActive(budgetMs)` so the scrape
 * hook can SKIP the DB dial when the pool has been idle past the budget.
 */

// A fake pg Pool whose query() resolves, so the activity wrapper can hook it.
// `query` is a swappable spy so a test can make it REJECT (#361).
const query = vi.fn((..._args: unknown[]) => Promise.resolve({ rows: [] }));
const connect = vi.fn(() => Promise.resolve({ release() {} }));
vi.mock('pg', () => ({
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

describe('@knext/lib/clients — DB activity tracking (#348 gate fix)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useRealTimers();
    query.mockClear();
    query.mockImplementation((..._args: unknown[]) => Promise.resolve({ rows: [] }));
    connect.mockClear();
    connect.mockImplementation(() => Promise.resolve({ release() {} }));
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    // The activity timestamp lives on globalThis (cross-bundle, #352), which
    // survives vi.resetModules() — clear it so each test starts from "never used".
    const mod = await import('../clients');
    mod.resetDbActivity();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DATABASE_URL;
  });

  it('records lastQueryAt when the writer pool is queried', async () => {
    const mod = await import('../clients');
    expect(mod.getLastDbActivityAt()).toBeUndefined();

    const t0 = Date.now();
    await mod.getDbPool().query('SELECT 1');

    const last = mod.getLastDbActivityAt();
    expect(last).toBeDefined();
    expect(last as number).toBeGreaterThanOrEqual(t0);
    // The wrapper must still delegate to the real query.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('isDbRecentlyActive is true right after a query, false once idle past the budget', async () => {
    vi.useFakeTimers();
    const mod = await import('../clients');

    await mod.getDbPool().query('SELECT 1');
    // Within the budget → recently active.
    expect(mod.isDbRecentlyActive(50_000)).toBe(true);

    // Advance past the budget (below the 60s gateway idle) → NOT recently active.
    vi.advanceTimersByTime(50_001);
    expect(mod.isDbRecentlyActive(50_000)).toBe(false);
  });

  it('isDbRecentlyActive is false when the pool has NEVER been used (never woken)', async () => {
    const mod = await import('../clients');
    // No query issued → no activity → the scrape must NOT dial the DB.
    expect(mod.isDbRecentlyActive(50_000)).toBe(false);
  });

  it('exposes a default recency budget below the 60s gateway idle window', async () => {
    const mod = await import('../clients');
    expect(mod.DB_ACTIVITY_BUDGET_MS).toBeGreaterThan(0);
    expect(mod.DB_ACTIVITY_BUDGET_MS).toBeLessThan(60_000);
  });

  // ── #361: a REJECTED query/connect STILL stamps lastDbActivityAt ─────────────
  // The #348 activity-gate keeps the deep-health probe dialing the DB as long as
  // the app keeps TRYING to use it — even if the queries FAIL. This protects the
  // stuck-`waking` alert: a hung DB the app hammers must stay probed (→ it pages),
  // never go silent. So `markDbActivity()` MUST fire BEFORE delegating, not in a
  // success `.then()`. These tests pin that so a future refactor of the wrappers
  // (e.g. the #339 single-flight, same file) can't silently move the stamp into
  // the success path.
  it('stamps lastDbActivityAt even when the writer-pool QUERY rejects', async () => {
    const mod = await import('../clients');
    expect(mod.getLastDbActivityAt()).toBeUndefined();
    query.mockImplementationOnce(() => Promise.reject(new Error('DB down')));

    const t0 = Date.now();
    await expect(mod.getDbPool().query('SELECT 1')).rejects.toThrow('DB down');

    const last = mod.getLastDbActivityAt();
    expect(last).toBeDefined();
    expect(last as number).toBeGreaterThanOrEqual(t0);
    // A failed attempt still counts as activity → the alert keeps probing.
    expect(mod.isDbRecentlyActive(50_000)).toBe(true);
  });

  it('stamps lastDbActivityAt even when the writer-pool CONNECT rejects', async () => {
    const mod = await import('../clients');
    expect(mod.getLastDbActivityAt()).toBeUndefined();
    connect.mockImplementationOnce(() => Promise.reject(new Error('connect refused')));

    const t0 = Date.now();
    await expect(mod.getDbPool().connect()).rejects.toThrow('connect refused');

    const last = mod.getLastDbActivityAt();
    expect(last).toBeDefined();
    expect(last as number).toBeGreaterThanOrEqual(t0);
    expect(mod.isDbRecentlyActive(50_000)).toBe(true);
  });
});
