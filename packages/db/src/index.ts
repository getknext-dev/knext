import { getDbPool, getDbPoolRO } from '@getknext/lib/clients';
import { logger } from '@getknext/lib/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * `@getknext/db` — the knext data SDK. A **thin** drizzle-orm wrapper over the
 * existing `@getknext/lib` scale-to-zero pools (ADR-0021). We re-export drizzle's
 * query surface (`eq`/`and`/`or`/`sql`/… and the query builder) and add only the
 * knext-specific ergonomics the platform needs — starting with the writer/reader
 * client accessors below. Apps keep drizzle's own docs and lose no power.
 *
 * Schema primitives (`./schema`), extension helpers, and the migrate runner
 * (`./migrate`) land in follow-up work (#239–#242); this module is the core.
 */
export * from 'drizzle-orm';

// A drizzle schema is an opaque record of table/relation objects; the concrete
// shape is the app's own, supplied at the call site.
type AnySchema = Record<string, unknown>;

// One drizzle client per pod, per pool — mirroring @getknext/lib's pool singletons.
// The client only wraps the pool; the pool's lifecycle + SIGTERM drain stay in
// @getknext/lib (getDbPool/closeDbPool, getDbPoolRO/closeDbPoolRO).
let writer: NodePgDatabase<AnySchema> | null = null;
let reader: NodePgDatabase<AnySchema> | null = null;
let warnedNoReadReplica = false;

/**
 * The **writer** client over `DATABASE_URL` (`@getknext/lib`'s `getDbPool()`).
 * Read-your-writes, single-writer — all writes and any read that must see its
 * own write go here. One client per pod, shared with any raw-`pg` use of the
 * same pool and drained by the existing `closeDbPool()` SIGTERM hook.
 *
 * Pass the app's schema for typed queries: `getDb(schema).select().from(...)`.
 */
export function getDb<TSchema extends AnySchema = Record<string, never>>(
  schema?: TSchema,
): NodePgDatabase<TSchema> {
  if (!writer) {
    writer = drizzle(getDbPool(), { schema }) as unknown as NodePgDatabase<AnySchema>;
  }
  return writer as unknown as NodePgDatabase<TSchema>;
}

/**
 * The **reader** client over `DATABASE_URL_RO` (`@getknext/lib`'s `getDbPoolRO()`)
 * — the scale-zero-pg RO gateway: **bounded-staleness (~9s), NO read-your-writes**.
 * Use it for dashboard/analytics/fan-out reads that tolerate a few seconds of
 * lag. Reads are never auto-routed — you pick `getDb()` vs `getDbRO()` per query,
 * matching scale-zero-pg's "nothing is automatic" contract.
 *
 * When `DATABASE_URL_RO` is unset there is no read replica, so this **falls back
 * to the writer** (`getDb()`) with a one-time warning — an app without a RO pool
 * still works, it just reads from the primary.
 */
export function getDbRO<TSchema extends AnySchema = Record<string, never>>(
  schema?: TSchema,
): NodePgDatabase<TSchema> {
  if (reader) {
    return reader as unknown as NodePgDatabase<TSchema>;
  }
  const roPool = getDbPoolRO();
  if (!roPool) {
    if (!warnedNoReadReplica) {
      warnedNoReadReplica = true;
      logger.warn(
        'DATABASE_URL_RO is unset — getDbRO() falls back to the writer pool. ' +
          'Reads will hit the primary (no bounded-staleness read replica). Set ' +
          'DATABASE_URL_RO to route staleness-tolerant reads to the RO gateway.',
      );
    }
    return getDb(schema);
  }
  reader = drizzle(roPool, { schema }) as unknown as NodePgDatabase<AnySchema>;
  return reader as unknown as NodePgDatabase<TSchema>;
}

/**
 * Drop the cached drizzle clients so the next `getDb()`/`getDbRO()` rebuilds them.
 *
 * Exported for tests, and public for the same reason `@getknext/lib`'s
 * `closeDbPool` / `resetDbActivity` / `resetPoolInstrumentor` are: the state is
 * module-level, so nothing outside this module can clear it. A test runner with
 * a module-registry reset could paper over that — vitest's `vi.resetModules()`
 * did — but `bun:test` deliberately has none, and relying on one hid which
 * state a module actually owns. It worked until some of that state moved onto
 * `globalThis` (ADR-0027), at which point the registry reset silently stopped
 * resetting it and nothing said so.
 *
 * This does NOT close the underlying pools: their lifecycle belongs to
 * `@getknext/lib` (`closeDbPool`/`closeDbPoolRO`, wired into the SIGTERM drain),
 * and closing them from here would sever connections the app still owns.
 * `warnedNoReadReplica` resets too, so the one-time RO warning is observable
 * again in the next test rather than swallowed by a previous one.
 */
export function resetDbClients(): void {
  writer = null;
  reader = null;
  warnedNoReadReplica = false;
}
