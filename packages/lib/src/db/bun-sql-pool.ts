/**
 * A `pg.Pool`-shaped facade over Bun's native SQL client.
 *
 * ## Why a facade and not a rewrite
 *
 * `getDbPool()` does not hand back a bare pool. It hands back a pool wrapped in
 * five layers, applied inner-to-outer: the tracing instrumentor, wake retry
 * (#310), the 0→1 wake single-flight (#339), activity tracking (#348/#361), and
 * slow-dep timing. Every one of those works by replacing `.query` and
 * `.connect` on the object it is given.
 *
 * That is the whole reason this is a facade. Anything exposing `query`,
 * `connect` and `end` with pg's signatures inherits all five layers unchanged,
 * so the Bun path gets the scale-to-zero wake machinery for free rather than a
 * second copy of it that drifts.
 *
 * The surface really is that small. Measured across `packages/{lib,db,kn-next}`,
 * the only Pool members touched are `query` (95), `connect` (53) and `end` (10).
 * No `.on()`, no `.totalCount`. If that ever grows, this facade is where the
 * gap will show up as a Bun-only runtime failure, so re-measure rather than
 * assume.
 *
 * ## drizzle needs nothing special — that was measured, not assumed
 *
 * The first version of this file carried a proxy so `drizzle-orm/bun-sql` would
 * route back through the wrapped pool. It is gone, because drizzle's
 * **node-postgres** driver turns out to touch only `client.query()`,
 * `client.connect()` and `client.release()` — exactly this surface. So drizzle
 * runs unchanged on top of the facade and inherits the five layers by
 * construction, `@getknext/db` needs no runtime branch, and the Bun driver is
 * not imported at all.
 *
 * That last point is not a nicety. `drizzle-orm/bun-sql` imports `'bun'`, which
 * plain Node cannot resolve — a static import of it would have broken the
 * published package outright.
 *
 * ## The one place the two drivers genuinely differ
 *
 * drizzle calls `client.query()` two ways: with a SQL string, and with a config
 * object carrying `rowMode: "array"` when it wants positional rows. pg honours
 * that flag; Bun expresses the same thing as `.values()` on the query object.
 * Ignoring it would hand drizzle objects where it expects arrays — every column
 * would read `undefined`, silently, on the Bun path only. Hence `rowMode` is
 * handled explicitly below and pinned by a test.
 *
 * ## Node is unaffected
 *
 * `@getknext/lib` is published and must keep running under plain Node with no
 * Bun present — `install-smoke.yml` proves exactly that, asserting no bun on
 * PATH. Nothing here reaches for Bun unless `globalThis.Bun` exists, and no
 * Bun-only module is ever imported.
 */

/** The pg-Pool subset this codebase actually uses. */
export interface PgLikeQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

/** pg accepts a string or a config object; drizzle uses both. */
export type PgLikeQuery = string | { text: string; rowMode?: string; name?: string };

export interface PgLikeClient {
  query<R = Record<string, unknown>>(
    query: PgLikeQuery,
    values?: unknown[],
  ): Promise<PgLikeQueryResult<R>>;
  release(): void;
}

export interface PgLikePool {
  query<R = Record<string, unknown>>(
    query: PgLikeQuery,
    values?: unknown[],
  ): Promise<PgLikeQueryResult<R>>;
  connect(): Promise<PgLikeClient>;
  end(): Promise<void>;
}

/**
 * Bun's lazy query object. It is thenable, and `.values()` switches it from
 * object rows to positional rows — Bun's spelling of pg's `rowMode: 'array'`.
 */
interface BunQuery extends PromiseLike<unknown> {
  values(): PromiseLike<unknown>;
}

/** The bits of `Bun.SQL` this facade drives. */
interface BunSqlClient {
  unsafe(text: string, values?: unknown[]): BunQuery;
  reserve(): Promise<BunReservedConnection>;
  close(options?: { timeout?: number }): Promise<void>;
}

/**
 * A reserved connection is NOT a full client — it can issue queries and hand
 * itself back, and that is all. Modelling it as `extends BunSqlClient` demanded
 * a `reserve()` that no reservation has (you cannot reserve from a
 * reservation), which made every honest test double fail to typecheck.
 */
interface BunReservedConnection {
  unsafe(text: string, values?: unknown[]): BunQuery;
  release(): void;
}

export interface BunSqlPoolConfig {
  connectionString: string | undefined;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/**
 * Bun returns rows as a plain array; pg returns `{ rows, rowCount }`. Callers
 * here read `.rows`, so the array is re-shaped rather than leaked — a raw array
 * would make `result.rows` `undefined` and every consumer would read an empty
 * result instead of failing, which is the worst way for this to go wrong.
 */
function toPgResult<R>(raw: unknown): PgLikeQueryResult<R> {
  const rows = (Array.isArray(raw) ? raw : []) as R[];
  return { rows, rowCount: rows.length };
}

/** Run one query, honouring pg's `rowMode: 'array'` via Bun's `.values()`. */
async function runQuery(
  client: Pick<BunSqlClient, 'unsafe'>,
  query: PgLikeQuery,
  values?: unknown[],
): Promise<unknown> {
  const text = typeof query === 'string' ? query : query.text;
  const wantsArrayRows = typeof query !== 'string' && query.rowMode === 'array';
  const pending = client.unsafe(text, values);
  return wantsArrayRows ? await pending.values() : await pending;
}

/**
 * Build the facade. `sqlFactory` is injected so construction can be tested
 * without a live database and without Bun present.
 */
export function createBunSqlPool(
  config: BunSqlPoolConfig,
  sqlFactory: (config: BunSqlPoolConfig) => BunSqlClient = defaultSqlFactory,
): PgLikePool {
  const sql = sqlFactory(config);

  return {
    async query<R = Record<string, unknown>>(query: PgLikeQuery, values?: unknown[]) {
      return toPgResult<R>(await runQuery(sql, query, values));
    },

    async connect(): Promise<PgLikeClient> {
      const reserved = await sql.reserve();
      return {
        async query<R = Record<string, unknown>>(query: PgLikeQuery, values?: unknown[]) {
          return toPgResult<R>(await runQuery(reserved, query, values));
        },
        release() {
          reserved.release();
        },
      };
    },

    async end(): Promise<void> {
      await sql.close();
    },
  };
}

/**
 * Resolve `Bun.SQL` off `globalThis` rather than importing anything. There is
 * no module to import — it is a runtime global — and reaching it this way keeps
 * the Node bundle free of any Bun reference.
 */
export function defaultSqlFactory(
  config: BunSqlPoolConfig,
  scope: BunScope = globalThis as BunScope,
): BunSqlClient {
  const bun = scope.Bun as { SQL?: new (opts: unknown) => BunSqlClient } | undefined;
  if (typeof bun?.SQL !== 'function') {
    throw new Error(
      'createBunSqlPool called without Bun.SQL available — this path must ' +
        'only be taken when globalThis.Bun is present',
    );
  }
  return new bun.SQL({
    url: config.connectionString,
    max: config.max,
    // Bun takes seconds where pg takes milliseconds. Passing the millisecond
    // value straight through would turn a 15s connect budget into 15,000s.
    idleTimeout: Math.round(config.idleTimeoutMillis / 1000),
    connectionTimeout: Math.round(config.connectionTimeoutMillis / 1000),
  });
}

/**
 * The ambient scope `Bun.SQL` is looked up on. Injectable ONLY so this can be
 * tested in both directions.
 *
 * Under `bun test`, `globalThis.Bun` is both readonly AND non-configurable:
 * assignment throws, and so does `Object.defineProperty`. There is no way to
 * stand it up or take it away, so a function that reads the global directly can
 * only ever be observed returning one answer — on Bun, always `true`; on Node,
 * always `false`. Taking the scope as a parameter is what makes the other
 * branch reachable.
 */
export interface BunScope {
  Bun?: { SQL?: unknown };
}

/** Is the Bun-native path available in this process? */
export function bunSqlAvailable(scope: BunScope = globalThis as BunScope): boolean {
  return typeof scope.Bun?.SQL === 'function';
}
