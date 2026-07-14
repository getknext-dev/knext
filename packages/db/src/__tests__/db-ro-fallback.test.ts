import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1 — prove the previously-UNTESTED-at-the-DSN-level `getDbRO()` writer
 * fallback (packages/db/src/index.ts ~L56-76). db.test.ts already proves the
 * OBJECT-identity fallback with a fully mocked `@knext/lib`; this file proves
 * the OBSERVABLE routing: which DSN the real `pg` pool is actually told to
 * connect to, plus the one-time warning gated by the module-level
 * `warnedNoReadReplica` flag.
 *
 * Seam: we do NOT add any export for testability. The observable behavior is
 * (a) the `connectionString` handed to `new Pool(...)` — the same seam the
 * lib pool tests assert on (clients-ro.test.ts) — and (b) the `logger.warn`
 * call. drizzle is stubbed to a no-op (it only wraps the pool; no driver work),
 * so no live Postgres is needed.
 *
 * `warnedNoReadReplica` is a MODULE-LEVEL singleton, so "warns exactly once"
 * and "RO uses the RO DSN" would cross-contaminate without a fresh module
 * registry. Each case therefore calls `vi.resetModules()` and re-imports.
 *
 * Data-sovereignty (scs-zones.md): the DSNs are inert test strings for THIS
 * zone's own DATABASE_URL / DATABASE_URL_RO — no real or cross-zone connection
 * is ever opened (the pool ctor is captured, never used to query).
 */

// Capture the connectionString every `new Pool(...)` is constructed with —
// the observable DSN routing decision, without touching a real database.
const poolConnectionStrings: Array<string | undefined> = [];
vi.mock('pg', () => ({
  Pool: class {
    constructor(config: { connectionString?: string }) {
      poolConnectionStrings.push(config?.connectionString);
    }
    end() {
      return Promise.resolve();
    }
  },
}));

// drizzle only wraps the pool; stub it so no driver runs. Record the wrapped
// pool so the singleton/identity assertions still hold.
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: (pool: unknown, opts?: { schema?: unknown }) => ({
    __client: true,
    pool,
    schema: opts?.schema,
  }),
}));

// Capture the one-time warning.
const warn = vi.fn();
vi.mock('@knext/lib/logger', () => ({
  logger: { warn: (m: string) => warn(m), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WRITER_DSN = 'postgres://u:p@writer.local:5432/app';
const RO_DSN = 'postgres://u:p@reader.local:55434/app';
const savedEnv = { ...process.env };

describe('getDbRO() writer-fallback — observable DSN routing + one-time warning', () => {
  beforeEach(() => {
    vi.resetModules(); // reset warnedNoReadReplica + writer/reader + lib pool singletons
    poolConnectionStrings.length = 0;
    warn.mockClear();
    process.env = { ...savedEnv };
    delete process.env.DATABASE_URL_RO;
    delete process.env.DB_POOL_RO_MAX;
    process.env.DATABASE_URL = WRITER_DSN;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('no DATABASE_URL_RO: falls back to the WRITER DSN and warns exactly once', async () => {
    delete process.env.DATABASE_URL_RO;

    const { getDb, getDbRO } = await import('../index');
    const dbRO = getDbRO();

    // Falls back to the writer client (reads hit the primary)…
    expect(dbRO).toBe(getDb());
    // …and the ONLY pool constructed is over the WRITER DSN — no RO pool exists.
    expect(poolConnectionStrings).toEqual([WRITER_DSN]);

    // One-time warning, emitted, and mentioning the missing RO env.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DATABASE_URL_RO/);
  });

  it('no DATABASE_URL_RO: warns only ONCE across repeated getDbRO() calls (module-level gate)', async () => {
    delete process.env.DATABASE_URL_RO;

    const { getDbRO } = await import('../index');
    getDbRO();
    getDbRO();
    getDbRO();

    expect(warn).toHaveBeenCalledTimes(1);
    // Still only the single writer pool — the fallback reuses getDb().
    expect(poolConnectionStrings).toEqual([WRITER_DSN]);
  });

  it('DATABASE_URL_RO set: getDbRO() routes over the RO DSN on a DISTINCT pool, no warning', async () => {
    process.env.DATABASE_URL_RO = RO_DSN;

    const { getDb, getDbRO } = await import('../index');
    const db = getDb();
    const dbRO = getDbRO();

    // Distinct clients: the reader is NOT the writer.
    expect(dbRO).not.toBe(db);
    // Two pools were constructed — the writer on its DSN, the reader on the RO
    // DSN. The RO client rides the RO DSN (the routing proof).
    expect(poolConnectionStrings).toContain(WRITER_DSN);
    expect(poolConnectionStrings).toContain(RO_DSN);
    // No fallback taken → no warning.
    expect(warn).not.toHaveBeenCalled();
  });

  it('DATABASE_URL_RO set: reader is a lazy singleton over the single RO pool', async () => {
    process.env.DATABASE_URL_RO = RO_DSN;

    const { getDbRO } = await import('../index');
    const a = getDbRO();
    const b = getDbRO();

    expect(a).toBe(b);
    // Exactly one RO pool constructed (the RO DSN appears once).
    expect(poolConnectionStrings.filter((c) => c === RO_DSN)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
