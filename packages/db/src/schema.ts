/**
 * `@knext/db/schema` — the knext **schema surface**.
 *
 * An app defines its tables in one place (`src/db/schema.ts` by convention) and
 * imports the builders from here, so it has a single pinned-compatible drizzle
 * dependency (ADR-0021 §2). This is a **thin re-export** — no bespoke DSL: every
 * `pgTable`, column type, index, and constraint helper is drizzle-orm's own, and
 * drizzle's documentation applies directly.
 *
 * ```ts
 * // src/db/schema.ts
 * import { pgTable, serial, text, timestamp } from '@knext/db/schema';
 *
 * export const orders = pgTable('orders', {
 *   id: serial('id').primaryKey(),
 *   userId: text('user_id').notNull(),
 *   createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
 * });
 * // typed rows for free: type Order = typeof orders.$inferSelect;
 * ```
 *
 * Everything drizzle's `pg-core` exports is available here: `pgTable`, the column
 * builders (`serial`/`text`/`integer`/`timestamp`/`jsonb`/`uuid`/`vector`/…),
 * `index`/`uniqueIndex`, `primaryKey`/`foreignKey`, `pgEnum`/`pgSchema`, etc. We
 * also re-export `relations` and `sql` from the drizzle-orm root because a schema
 * file routinely needs them (relation graphs, `sql` default values).
 */

// Relation graphs and the `sql` tag live on the drizzle-orm root, not `pg-core`,
// but belong with a schema definition — re-export them from the same place so an
// app imports its whole schema vocabulary from `@knext/db/schema`.
export { relations, sql } from 'drizzle-orm';
// Table + column + index + constraint builders (the bulk of the surface).
export * from 'drizzle-orm/pg-core';

/*
 * ── Extension helper seam (reserved) ────────────────────────────────────────
 *
 * The platform's Postgres extensions add knext-specific schema ergonomics ON TOP
 * of the drizzle surface above, without changing it:
 *
 *   • TimescaleDB (#240) — `hypertable(table, { by, chunkInterval })` +
 *     retention (`dropChunksPolicy`) migration helpers. Bound: no columnar
 *     compression / continuous aggregates on a scale-to-zero compute
 *     (scale-zero-pg ADR-0001).
 *   • pgvector (#241, gated on scale-zero-pg #178) — similarity operators
 *     (`cosineDistance`/`l2Distance`) + `hnsw`/`ivfflat` index helpers over the
 *     `vector` column already re-exported above.
 *
 * Those land as additional `export … from './extensions/…'` lines here, so
 * apps keep importing everything from `@knext/db/schema` and the surface only
 * grows. Nothing to configure today.
 */
