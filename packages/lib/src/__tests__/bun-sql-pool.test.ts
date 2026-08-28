/**
 * The Bun-native DB path.
 *
 * The load-bearing test here is `rowMode: 'array'`. drizzle calls
 * `client.query()` two ways — with a SQL string, and with a config object
 * asking for positional rows — and pg honours that flag while Bun expresses the
 * same thing as `.values()`. Ignore it and drizzle receives objects where it
 * expects arrays: every column reads `undefined`, silently, on the Bun path
 * only. No error, no crash, just wrong data.
 *
 * A fake SQL client is injected rather than dialling a database, so these run
 * under Node with no Bun present — which is also the environment the published
 * package has to keep working in.
 */

import { describe, expect, it, vi } from 'vitest';
import { type BunSqlPoolConfig, bunSqlAvailable, createBunSqlPool } from '../db/bun-sql-pool';

const CONFIG: BunSqlPoolConfig = {
  connectionString: 'postgres://localhost/test',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
};

const OBJECT_ROWS = [{ id: 1, name: 'a' }];
const ARRAY_ROWS = [[1, 'a']];

/**
 * Stands in for `Bun.SQL`. Mirrors the real shape: `unsafe()` returns a LAZY
 * thenable whose `.values()` switches to positional rows.
 */
function fakeSql() {
  const seen: Array<{ text: string; values?: unknown[]; mode: 'object' | 'array' }> = [];
  const released = { count: 0 };

  const makeQuery = (text: string, values?: unknown[]) => {
    let mode: 'object' | 'array' = 'object';
    const record = () => seen.push({ text, values, mode });
    return {
      values() {
        mode = 'array';
        record();
        return Promise.resolve(ARRAY_ROWS);
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        record();
        return Promise.resolve(OBJECT_ROWS).then(resolve, reject);
      },
    };
  };

  const client = {
    unsafe: vi.fn(makeQuery),
    reserve: vi.fn(async () => ({
      unsafe: vi.fn(makeQuery),
      release: () => {
        released.count++;
      },
    })),
    close: vi.fn(async () => {}),
  };
  return { client, seen, released };
}

describe('bun-sql pool facade — the pg shape callers depend on', () => {
  it("re-shapes Bun's bare array into pg's { rows, rowCount }", async () => {
    const { client } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);

    const result = await pool.query('select 1');

    // Both halves. Leaking the raw array would leave `result.rows` undefined,
    // and every consumer would read an EMPTY result instead of throwing — a
    // silent wrong answer, which is worse than a crash.
    expect(result.rows).toEqual(OBJECT_ROWS);
    expect(result.rowCount).toBe(1);
  });

  it('passes parameters through to the underlying client', async () => {
    const { client } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);

    await pool.query('select * from t where id = $1', [42]);

    expect(client.unsafe).toHaveBeenCalledWith('select * from t where id = $1', [42]);
  });

  it('never yields an undefined rows array, whatever the client returns', async () => {
    const { client } = fakeSql();
    client.unsafe = vi.fn(() => ({
      values: () => Promise.resolve(undefined),
      then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
    })) as never;
    const pool = createBunSqlPool(CONFIG, () => client as never);

    const result = await pool.query('select 1');
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it('connect() reserves a connection and release() returns it', async () => {
    const { client, released } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);

    const conn = await pool.connect();
    expect((await conn.query('select 1')).rows).toEqual(OBJECT_ROWS);

    expect(released.count).toBe(0);
    conn.release();
    expect(released.count).toBe(1);
  });

  it('end() closes the client', async () => {
    const { client } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);
    await pool.end();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

describe("bun-sql pool facade — drizzle's rowMode: 'array' (the silent-divergence case)", () => {
  it('returns POSITIONAL rows when the query config asks for rowMode array', async () => {
    const { client, seen } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);

    const result = await pool.query({ text: 'select id, name from t', rowMode: 'array' });

    expect(seen.at(-1)?.mode, 'must go through Bun .values() for array rows').toBe('array');
    expect(result.rows).toEqual(ARRAY_ROWS);
  });

  it('returns OBJECT rows for a config object without rowMode', async () => {
    // The other half: honouring rowMode must not mean always using .values().
    const { client, seen } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);

    const result = await pool.query({ text: 'select id, name from t' });

    expect(seen.at(-1)?.mode).toBe('object');
    expect(result.rows).toEqual(OBJECT_ROWS);
  });

  it('unwraps the config object into the SQL text Bun expects', async () => {
    // Passing the object straight through would send "[object Object]" as SQL.
    const { client } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);

    await pool.query({ text: 'select 1', name: 'prepared' }, [7]);

    expect(client.unsafe).toHaveBeenCalledWith('select 1', [7]);
  });

  it('honours rowMode on a reserved connection too, not just the pool', async () => {
    // drizzle runs transactions through connect(); a facade that only handled
    // rowMode on the pool would corrupt exactly the transactional reads.
    const { client, seen } = fakeSql();
    const pool = createBunSqlPool(CONFIG, () => client as never);

    const conn = await pool.connect();
    const result = await conn.query({ text: 'select 1', rowMode: 'array' });

    expect(seen.at(-1)?.mode).toBe('array');
    expect(result.rows).toEqual(ARRAY_ROWS);
  });
});

describe('bun-sql availability probe', () => {
  it('reports false when Bun is absent, true when Bun.SQL is present', () => {
    // Both halves: a probe that only ever returns one answer is not a probe.
    const g = globalThis as { Bun?: unknown };
    const saved = g.Bun;
    try {
      g.Bun = undefined;
      expect(bunSqlAvailable()).toBe(false);

      g.Bun = { SQL: function SQL() {} };
      expect(bunSqlAvailable()).toBe(true);

      // Present but not a constructor is NOT available.
      g.Bun = { SQL: 'nope' };
      expect(bunSqlAvailable()).toBe(false);
    } finally {
      g.Bun = saved;
    }
  });

  it('refuses to build a pool when Bun.SQL is missing rather than failing later', () => {
    const g = globalThis as { Bun?: unknown };
    const saved = g.Bun;
    try {
      g.Bun = undefined;
      // Default factory, no injection — must throw HERE, not at first query.
      expect(() => createBunSqlPool(CONFIG)).toThrow(/Bun\.SQL/);
    } finally {
      g.Bun = saved;
    }
  });

  it('converts pg millisecond timeouts into the seconds Bun expects', () => {
    // 15_000ms passed through unconverted becomes a 15,000-SECOND connect
    // budget — a hang that looks like a hung database.
    const g = globalThis as { Bun?: unknown };
    const saved = g.Bun;
    const opts: Array<Record<string, unknown>> = [];
    try {
      g.Bun = {
        SQL: function SQL(o: Record<string, unknown>) {
          opts.push(o);
          return { unsafe: () => ({}), reserve: async () => ({}), close: async () => {} };
        },
      };
      createBunSqlPool(CONFIG);
      expect(opts[0]?.connectionTimeout).toBe(15);
      expect(opts[0]?.idleTimeout).toBe(30);
    } finally {
      g.Bun = saved;
    }
  });
});
