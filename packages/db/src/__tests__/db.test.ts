import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sentinel pools returned by the mocked @knext/lib clients — we assert which
// pool each drizzle client is wrapped over WITHOUT a real database.
const WRITER_POOL = { id: 'writer-pool' };
const RO_POOL = { id: 'ro-pool' };

const getDbPool = vi.fn(() => WRITER_POOL);
const getDbPoolRO = vi.fn<() => unknown>(() => null);
const warn = vi.fn();

vi.mock('@knext/lib/clients', () => ({
  getDbPool: () => getDbPool(),
  getDbPoolRO: () => getDbPoolRO(),
}));
vi.mock('@knext/lib/logger', () => ({ logger: { warn: (m: string) => warn(m), info: vi.fn() } }));

// Mock drizzle so no driver is touched; the returned client records its pool +
// schema so tests can assert the wiring.
const drizzle = vi.fn((pool: unknown, opts?: { schema?: unknown }) => ({
  __client: true,
  pool,
  schema: opts?.schema,
}));
vi.mock('drizzle-orm/node-postgres', () => ({
  // The param type matches the spy above (type-only, #261) — the wrapper
  // still forwards whatever it receives, unchanged.
  drizzle: (p: unknown, o?: { schema?: unknown }) => drizzle(p, o),
}));

describe('@knext/db — client accessors over the @knext/lib pools', () => {
  beforeEach(() => {
    vi.resetModules(); // resets the module-level writer/reader singletons
    getDbPool.mockClear();
    getDbPoolRO.mockReset();
    getDbPoolRO.mockReturnValue(null);
    drizzle.mockClear();
    warn.mockClear();
  });

  describe('getDb() — writer', () => {
    it('wraps the @knext/lib writer pool (DATABASE_URL)', async () => {
      const { getDb } = await import('../index');
      const db = getDb() as unknown as { pool: unknown };
      expect(getDbPool).toHaveBeenCalledTimes(1);
      expect(db.pool).toBe(WRITER_POOL);
    });

    it('passes the schema through to drizzle', async () => {
      const { getDb } = await import('../index');
      const schema = { orders: { name: 'orders' } };
      const db = getDb(schema) as unknown as { schema: unknown };
      expect(db.schema).toBe(schema);
    });

    it('is a lazy singleton — one client, one pool wrap per pod', async () => {
      const { getDb } = await import('../index');
      const a = getDb();
      const b = getDb();
      expect(a).toBe(b);
      expect(drizzle).toHaveBeenCalledTimes(1);
      expect(getDbPool).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDbRO() — reader', () => {
    it('wraps the RO pool (DATABASE_URL_RO) when one is configured', async () => {
      getDbPoolRO.mockReturnValue(RO_POOL);
      const { getDb, getDbRO } = await import('../index');
      const dbRO = getDbRO() as unknown as { pool: unknown };
      expect(dbRO.pool).toBe(RO_POOL);
      // Distinct client from the writer.
      expect(dbRO).not.toBe(getDb());
      expect(warn).not.toHaveBeenCalled();
    });

    it('is a lazy singleton for the reader', async () => {
      getDbPoolRO.mockReturnValue(RO_POOL);
      const { getDbRO } = await import('../index');
      const a = getDbRO();
      const b = getDbRO();
      expect(a).toBe(b);
      // one writer wrap is never made here; only the RO client is constructed
      expect(drizzle).toHaveBeenCalledTimes(1);
    });

    it('falls back to the writer with a one-time warning when DATABASE_URL_RO is unset', async () => {
      getDbPoolRO.mockReturnValue(null);
      const { getDb, getDbRO } = await import('../index');
      const dbRO = getDbRO();
      // Same object as the writer client — reads hit the primary.
      expect(dbRO).toBe(getDb());
      expect(dbRO).toStrictEqual(expect.objectContaining({ pool: WRITER_POOL }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/DATABASE_URL_RO/);
      // Does NOT create a second writer pool.
      expect(getDbPool).toHaveBeenCalledTimes(1);
    });

    it('warns only once across repeated fallback calls', async () => {
      getDbPoolRO.mockReturnValue(null);
      const { getDbRO } = await import('../index');
      getDbRO();
      getDbRO();
      getDbRO();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('re-exported drizzle surface', () => {
    it('re-exports drizzle query operators (eq/and/sql) from the package root', async () => {
      const mod = await import('../index');
      expect(typeof mod.eq).toBe('function');
      expect(typeof mod.and).toBe('function');
      expect(typeof mod.sql).toBe('function');
    });
  });
});
