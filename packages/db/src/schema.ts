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
 * ── Extension helpers ───────────────────────────────────────────────────────
 *
 * The platform's Postgres extensions add knext-specific schema ergonomics ON TOP
 * of the drizzle surface above, without changing it. They are migration SQL
 * emitters (drizzle-kit can't model these) — the app self-enables the extension
 * over its own DATABASE_URL and both survive scale-to-zero (scale-zero-pg
 * docs/connecting.md). Adding these `export`s grows the surface; nothing above changes.
 *
 *   • TimescaleDB (#240) — `hypertable(table, { by, chunkInterval })` +
 *     one-shot `dropChunks()` retention. Bound: hypertables + `drop_chunks()`
 *     only (Apache-2 tier); NO columnar compression / continuous aggregates on a
 *     scale-to-zero compute (scale-zero-pg adr-0001).
 *   • pgvector (#241) — distance operators (`cosineDistance` `<=>` / `l2Distance`
 *     `<->` / `innerProduct` `<#>`) + `hnsw`/`ivfflat` index DDL helpers over the
 *     `vector` column already re-exported above.
 */
export * from './extensions/pgvector';
export * from './extensions/timescaledb';
