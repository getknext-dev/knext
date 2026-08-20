import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PG half of the ledger row-3 discrimination instrument.
 *
 * Reading (1) of the three compatible readings is "PG pool first-connect delay
 * on the fresh pod" — and `/dashboard`, the measured page, does three raw
 * `db.query` calls through this pool with `unstable_noStore()`. So the timing
 * belongs at the SHARED seam (`getDbPool`), not on the page: every consumer of
 * the writer pool is instrumented at once, and the wrapper sits OUTSIDE the
 * single-flight/retry layers so it measures the wall time a request actually
 * waited, retries included.
 *
 * Both halves asserted: a slow query emits exactly one line, a fast one emits
 * none. And the line must carry `cold` — that is what separates "the pool's
 * FIRST connect was slow" (the row-3 reading) from "a warm query was slow".
 */

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

type WarnSpy = ReturnType<typeof vi.fn>;

const slowLines = (warn: WarnSpy): string[] =>
  warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l) => l.startsWith('[slow-dep] '));

const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line.slice('[slow-dep] '.length));

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('@getknext/lib/clients — slow PG operations are named on the request path', () => {
  let warn: WarnSpy;

  beforeEach(async () => {
    vi.resetModules();
    vi.useRealTimers();
    query.mockClear();
    query.mockImplementation((..._args: unknown[]) => Promise.resolve({ rows: [] }));
    connect.mockClear();
    connect.mockImplementation(() => Promise.resolve({ release() {} }));
    process.env.DATABASE_URL = 'postgres://app:s3cr3t@pggw-apps.scale-zero-pg.svc:5432/fm';
    process.env.SLOW_DEP_LOG_MS = '20';
    warn = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(warn as unknown as typeof console.warn);
    const mod = await import('../clients');
    mod.resetDbWakeSingleflight();
    mod.resetDbActivity();
  });

  afterEach(async () => {
    const mod = await import('../clients');
    mod.resetDbWakeSingleflight();
    mod.resetDbActivity();
    vi.restoreAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.SLOW_DEP_LOG_MS;
  });

  it('emits exactly one `pg` line for a query that exceeds the threshold', async () => {
    query.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), 60)),
    );
    const mod = await import('../clients');

    await mod.getDbPool().query('SELECT 1');
    await settle();

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    const fields = parse(found[0]);
    expect(fields).toMatchObject({ dep: 'pg', op: 'pool.query', role: 'writer', outcome: 'ok' });
    expect(fields.durationMs as number).toBeGreaterThanOrEqual(20);
    // The FIRST acquisition on a fresh pool is the row-3 reading — mark it.
    expect(fields.cold).toBe(true);
  });

  it('emits NOTHING for a fast query (the other half)', async () => {
    const mod = await import('../clients');

    await mod.getDbPool().query('SELECT 1');
    await mod.getDbPool().query('SELECT 2');
    await settle();

    expect(slowLines(warn)).toHaveLength(0);
  });

  it('marks a slow query on an already-woken pool as NOT cold', async () => {
    const mod = await import('../clients');
    const pool = mod.getDbPool();
    await pool.query('SELECT 1'); // fast — wakes the pool
    query.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), 60)),
    );

    await pool.query('SELECT 2');
    await settle();

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(parse(found[0]).cold).toBe(false);
  });

  it('times a slow first `connect()` too — the pool-first-connect reading', async () => {
    connect.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ release() {} }), 60)),
    );
    const mod = await import('../clients');

    const client = (await mod.getDbPool().connect()) as { release(): void };
    client.release();
    await settle();

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(parse(found[0])).toMatchObject({ dep: 'pg', op: 'pool.connect', cold: true });
  });

  it('reports a slow FAILING query as outcome=error, and re-throws unchanged', async () => {
    // Persistent failure: keep the #310 retry budget tiny so this stays fast.
    process.env.DB_WAKE_RETRY_BUDGET_MS = '25';
    process.env.DB_WAKE_RETRY_BASE_MS = '5';
    vi.resetModules();
    const boom = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    query.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(boom), 30)));
    const mod = await import('../clients');

    await expect(mod.getDbPool().query('SELECT 1')).rejects.toBe(boom);
    await settle();

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(parse(found[0])).toMatchObject({ dep: 'pg', op: 'pool.query', outcome: 'error' });

    delete process.env.DB_WAKE_RETRY_BUDGET_MS;
    delete process.env.DB_WAKE_RETRY_BASE_MS;
  });

  it('never leaks the DSN or its credentials into the line', async () => {
    query.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), 60)),
    );
    const mod = await import('../clients');

    await mod.getDbPool().query('SELECT 1');
    await settle();

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('s3cr3t');
    expect(found[0]).not.toContain('postgres://');
  });

  it('does not log the SQL text — a query can carry user data', async () => {
    query.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), 60)),
    );
    const mod = await import('../clients');

    await mod.getDbPool().query("SELECT * FROM users WHERE email = 'victim@example.com'");
    await settle();

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('victim@example.com');
    expect(found[0]).not.toContain('SELECT');
  });
});
