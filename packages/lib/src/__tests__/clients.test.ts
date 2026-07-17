import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the config object passed to `new Pool(...)` without a real DB.
const poolCtor = vi.fn();
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) {
      poolCtor(config);
    }
    // getDbPool() never calls these in the unit under test.
    end() {
      return Promise.resolve();
    }
  },
}));

describe('getDbPool — bounded pool for scale-to-zero', () => {
  beforeEach(() => {
    poolCtor.mockClear();
    vi.resetModules();
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT_MS;
    delete process.env.DB_POOL_CONNECT_TIMEOUT_MS;
    delete process.env.KNEXT_DB_POOL_MAX;
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  });

  afterEach(() => {
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT_MS;
    delete process.env.DB_POOL_CONNECT_TIMEOUT_MS;
    delete process.env.KNEXT_DB_POOL_MAX;
  });

  it('sets a small bounded default max (5) and a finite idle timeout', async () => {
    const { getDbPool } = await import('../clients');
    getDbPool();
    expect(poolCtor).toHaveBeenCalledTimes(1);
    const cfg = poolCtor.mock.calls[0][0] as {
      max: number;
      idleTimeoutMillis: number;
      connectionString?: string;
    };
    expect(cfg.max).toBe(5);
    expect(cfg.idleTimeoutMillis).toBeGreaterThan(0);
    expect(Number.isFinite(cfg.idleTimeoutMillis)).toBe(true);
    expect(cfg.connectionString).toBe('postgres://u:p@localhost:5432/db');
  });

  it('lets an env override win for max and idle timeout', async () => {
    process.env.DB_POOL_MAX = '12';
    process.env.DB_POOL_IDLE_TIMEOUT_MS = '1000';
    const { getDbPool } = await import('../clients');
    getDbPool();
    const cfg = poolCtor.mock.calls[0][0] as {
      max: number;
      idleTimeoutMillis: number;
    };
    expect(cfg.max).toBe(12);
    expect(cfg.idleTimeoutMillis).toBe(1000);
  });

  it('bounds the connect wait: default connectionTimeoutMillis 15s, >= 10s to survive a cold DB wake', async () => {
    // pg's default (0) waits indefinitely — that survives wakes but hangs
    // forever on a truly-dead DB. 15s fails fast with a clear error while
    // leaving ~6x margin over the ~2.5s scale-zero-pg cold wake (the
    // postgres-binding guide's contract: connect timeout >= 10s).
    const { getDbPool } = await import('../clients');
    getDbPool();
    const cfg = poolCtor.mock.calls[0][0] as { connectionTimeoutMillis: number };
    expect(cfg.connectionTimeoutMillis).toBe(15_000);
    expect(cfg.connectionTimeoutMillis).toBeGreaterThanOrEqual(10_000);
  });

  it('lets an env override win for the connect timeout', async () => {
    process.env.DB_POOL_CONNECT_TIMEOUT_MS = '30000';
    const { getDbPool } = await import('../clients');
    getDbPool();
    const cfg = poolCtor.mock.calls[0][0] as { connectionTimeoutMillis: number };
    expect(cfg.connectionTimeoutMillis).toBe(30_000);
  });

  // #378 (W3, ADR-0029): the operator-declared per-pod cap (spec.scaling.poolMax)
  // is injected as KNEXT_DB_POOL_MAX so the app enforces at RUNTIME the same cap
  // the operator gated at admission (maxScale × poolMax ≤ 80). This closes the
  // declared-vs-runtime drift the W2 system-designer flagged: without it, a pool
  // could open more than poolMax connections/pod and blow the budget.
  describe('KNEXT_DB_POOL_MAX runtime cap (#378)', () => {
    it('caps pool.max at KNEXT_DB_POOL_MAX (below the default 5)', async () => {
      process.env.KNEXT_DB_POOL_MAX = '3';
      const { getDbPool } = await import('../clients');
      getDbPool();
      const cfg = poolCtor.mock.calls[0][0] as { max: number };
      expect(cfg.max).toBe(3);
    });

    it('caps an app-set DB_POOL_MAX down to KNEXT_DB_POOL_MAX when the app asks for MORE', async () => {
      // The operator cap is authoritative — an app cannot opt OUT of the budget.
      process.env.KNEXT_DB_POOL_MAX = '4';
      process.env.DB_POOL_MAX = '12';
      const { getDbPool } = await import('../clients');
      getDbPool();
      const cfg = poolCtor.mock.calls[0][0] as { max: number };
      expect(cfg.max).toBe(4);
    });

    it('respects an app-set DB_POOL_MAX that is LOWER than the cap (precedence: min wins)', async () => {
      process.env.KNEXT_DB_POOL_MAX = '8';
      process.env.DB_POOL_MAX = '2';
      const { getDbPool } = await import('../clients');
      getDbPool();
      const cfg = poolCtor.mock.calls[0][0] as { max: number };
      expect(cfg.max).toBe(2);
    });

    it('is a no-op when KNEXT_DB_POOL_MAX is unset (default 5 preserved)', async () => {
      const { getDbPool } = await import('../clients');
      getDbPool();
      const cfg = poolCtor.mock.calls[0][0] as { max: number };
      expect(cfg.max).toBe(5);
    });
  });

  it('stays a lazy singleton (constructs the pool only once)', async () => {
    const { getDbPool } = await import('../clients');
    const a = getDbPool();
    const b = getDbPool();
    expect(a).toBe(b);
    expect(poolCtor).toHaveBeenCalledTimes(1);
  });
});
