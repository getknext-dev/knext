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
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  });

  afterEach(() => {
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT_MS;
    delete process.env.DB_POOL_CONNECT_TIMEOUT_MS;
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

  it('stays a lazy singleton (constructs the pool only once)', async () => {
    const { getDbPool } = await import('../clients');
    const a = getDbPool();
    const b = getDbPool();
    expect(a).toBe(b);
    expect(poolCtor).toHaveBeenCalledTimes(1);
  });
});
