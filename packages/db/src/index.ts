import { getDbPool, getDbPoolRO } from '@knext/lib/clients';
import { logger } from '@knext/lib/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * `@knext/db` — the knext data SDK. A **thin** drizzle-orm wrapper over the
 * existing `@knext/lib` scale-to-zero pools (ADR-0021). We re-export drizzle's
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

// One drizzle client per pod, per pool — mirroring @knext/lib's pool singletons.
// The client only wraps the pool; the pool's lifecycle + SIGTERM drain stay in
// @knext/lib (getDbPool/closeDbPool, getDbPoolRO/closeDbPoolRO).
let writer: NodePgDatabase<AnySchema> | null = null;
let reader: NodePgDatabase<AnySchema> | null = null;
let warnedNoReadReplica = false;

/**
 * The **writer** client over `DATABASE_URL` (`@knext/lib`'s `getDbPool()`).
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
 * The **reader** client over `DATABASE_URL_RO` (`@knext/lib`'s `getDbPoolRO()`)
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
