import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the config object passed to `new Pool(...)` without a real DB.
const poolCtor = vi.fn();
const poolEnd = vi.fn(() => Promise.resolve());
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: unknown) {
      poolCtor(config);
    }
    end() {
      return poolEnd();
    }
  },
}));

describe('getDbPoolRO — bounded read-only pool for scale-to-zero', () => {
  beforeEach(() => {
    poolCtor.mockClear();
    poolEnd.mockClear();
    vi.resetModules();
    delete process.env.DB_POOL_RO_MAX;
    delete process.env.DB_POOL_RO_IDLE_TIMEOUT_MS;
    delete process.env.DB_POOL_RO_CONNECT_TIMEOUT_MS;
    delete process.env.DATABASE_URL_RO;
  });

  afterEach(() => {
    delete process.env.DB_POOL_RO_MAX;
    delete process.env.DB_POOL_RO_IDLE_TIMEOUT_MS;
    delete process.env.DB_POOL_RO_CONNECT_TIMEOUT_MS;
    delete process.env.DATABASE_URL_RO;
  });

  it('returns null when DATABASE_URL_RO is unset (no RO pool configured)', async () => {
    const { getDbPoolRO } = await import('../clients');
    expect(getDbPoolRO()).toBeNull();
    // Never constructs a pool when there is no RO DSN.
    expect(poolCtor).not.toHaveBeenCalled();
  });

  it('reads DATABASE_URL_RO and inherits the writer scale-to-zero defaults', async () => {
    process.env.DATABASE_URL_RO = 'postgres://u:p@pggw:55434/db';
    const { getDbPoolRO } = await import('../clients');
    const pool = getDbPoolRO();
    expect(pool).not.toBeNull();
    expect(poolCtor).toHaveBeenCalledTimes(1);
    const cfg = poolCtor.mock.calls[0][0] as {
      max: number;
      idleTimeoutMillis: number;
      connectionTimeoutMillis: number;
      connectionString?: string;
    };
    expect(cfg.connectionString).toBe('postgres://u:p@pggw:55434/db');
    expect(cfg.max).toBe(5);
    expect(cfg.idleTimeoutMillis).toBe(10_000);
    expect(cfg.idleTimeoutMillis).toBeLessThan(60_000); // < gateway idle (dead-socket bound)
    expect(cfg.connectionTimeoutMillis).toBe(15_000);
    expect(cfg.connectionTimeoutMillis).toBeGreaterThanOrEqual(10_000); // cold-wake tolerance
  });

  it('lets DB_POOL_RO_* env overrides win, independent of the writer pool', async () => {
    process.env.DATABASE_URL_RO = 'postgres://u:p@pggw:55434/db';
    process.env.DB_POOL_RO_MAX = '8';
    process.env.DB_POOL_RO_IDLE_TIMEOUT_MS = '2000';
    process.env.DB_POOL_RO_CONNECT_TIMEOUT_MS = '20000';
    const { getDbPoolRO } = await import('../clients');
    getDbPoolRO();
    const cfg = poolCtor.mock.calls[0][0] as {
      max: number;
      idleTimeoutMillis: number;
      connectionTimeoutMillis: number;
    };
    expect(cfg.max).toBe(8);
    expect(cfg.idleTimeoutMillis).toBe(2000);
    expect(cfg.connectionTimeoutMillis).toBe(20_000);
  });

  it('stays a lazy singleton (constructs the RO pool only once)', async () => {
    process.env.DATABASE_URL_RO = 'postgres://u:p@pggw:55434/db';
    const { getDbPoolRO } = await import('../clients');
    const a = getDbPoolRO();
    const b = getDbPoolRO();
    expect(a).toBe(b);
    expect(poolCtor).toHaveBeenCalledTimes(1);
  });

  it('closeDbPoolRO drains the pool and resets the singleton', async () => {
    process.env.DATABASE_URL_RO = 'postgres://u:p@pggw:55434/db';
    const { getDbPoolRO, closeDbPoolRO } = await import('../clients');
    getDbPoolRO();
    await closeDbPoolRO();
    expect(poolEnd).toHaveBeenCalledTimes(1);
    // A later call reconnects (constructs a second pool).
    getDbPoolRO();
    expect(poolCtor).toHaveBeenCalledTimes(2);
  });

  it('closeDbPoolRO is a no-op when no RO pool was ever created', async () => {
    const { closeDbPoolRO } = await import('../clients');
    await expect(closeDbPoolRO()).resolves.toBeUndefined();
    expect(poolEnd).not.toHaveBeenCalled();
  });
});
