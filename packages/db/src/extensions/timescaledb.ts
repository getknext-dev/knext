/**
 * `@knext/db` TimescaleDB helpers (#240) — migration SQL emitters on the
 * `@knext/db/schema` extension seam (ADR-0021 §2).
 *
 * drizzle does not model TimescaleDB hypertables, so these helpers do the one thing
 * drizzle-kit cannot: emit the exact `create_hypertable(...)` / `drop_chunks(...)`
 * SQL an app pastes into (or appends to) its generated migration. They are pure
 * string builders — no live database — so they unit-test deterministically.
 *
 * ## Self-enable + scale-to-zero (the platform contract)
 *
 * TimescaleDB ships in the scale-zero-pg compute image, marked `trusted`. Your app
 * **enables it itself**, once, over its own `DATABASE_URL` (no operator, no
 * superuser) — see scale-zero-pg `docs/connecting.md`. Put {@link createTimescaleExtension}
 * at the top of the migration that creates a hypertable. Hypertables, their chunks,
 * and their data live on the pageserver, so they **survive scale-to-zero**: the
 * compute sleeps at 0 and your data is intact on the next connection.
 *
 * ## Honest bound (Apache-2 tier only)
 *
 * You get the Apache-2 tier: hypertables, `time_bucket()`, chunk pruning, and
 * **one-shot `drop_chunks()` retention** ({@link dropChunks}). Columnar **compression**
 * and **continuous aggregates** are **not** available here — they are TSL features
 * driven by *background policy jobs*, which cannot run on a compute that scales to
 * zero (scale-zero-pg `adr-0001-timescale-and-sharding.md`). For the same reason,
 * retention is a one-shot `drop_chunks()` run by your migration/CI — **not**
 * `add_retention_policy()`, whose background job would never fire on a sleeping
 * compute.
 */

import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { quoteLiteral } from '../sql';

/** A table this helper targets: a drizzle `pgTable`, or a bare table name. */
export type TableRef = PgTable | string;

function tableName(table: TableRef): string {
  return typeof table === 'string' ? table : getTableName(table);
}

/** The idempotent, self-service statement that enables TimescaleDB for an app DB. */
export const CREATE_TIMESCALEDB_EXTENSION = 'CREATE EXTENSION IF NOT EXISTS timescaledb;';

/**
 * Return the `CREATE EXTENSION IF NOT EXISTS timescaledb;` your app runs **once**,
 * over its own `DATABASE_URL`, before creating any hypertable. Place it at the top
 * of the migration (scale-zero-pg `docs/connecting.md`).
 */
export function createTimescaleExtension(): string {
  return CREATE_TIMESCALEDB_EXTENSION;
}

/** Options for {@link hypertable}. */
export interface HypertableOptions {
  /** The time / partitioning column — the hypertable's range dimension. */
  by: string;
  /**
   * Chunk (partition) time interval, e.g. `'7 days'`. Emitted inside the
   * dimension builder as `by_range('<col>', INTERVAL '<value>')`. Omit to
   * accept TimescaleDB's default.
   */
  chunkInterval?: string;
  /**
   * Emit `if_not_exists => TRUE` so re-running the migration is a no-op. Defaults to
   * `true` (idempotent). Set `false` for a strict first migration that must fail if
   * the hypertable already exists.
   */
  ifNotExists?: boolean;
  /**
   * Emit `migrate_data => TRUE` to convert an already-populated table in place. Off
   * by default — a fresh table needs no migration and the flag makes the call slow.
   */
  migrateData?: boolean;
}

/**
 * Emit the `SELECT create_hypertable(...)` that turns a regular table into a
 * TimescaleDB hypertable. Run it in the migration **after** the `CREATE TABLE` and
 * after {@link createTimescaleExtension}.
 *
 * Emits the **modern dimension-builder form** — `by_range('<col>'[, INTERVAL])`
 * — introduced in TimescaleDB 2.13 and the ONLY interface on 2.24+ (the legacy
 * `create_hypertable(regclass, name, ...)` signature was removed there and
 * hard-errors: #259). **Minimum supported TimescaleDB: 2.13.** There is
 * deliberately no legacy escape hatch — a new SDK has no pre-2.13 installed base.
 *
 * ```ts
 * import { hypertable } from '@knext/db/schema';
 * export const metrics = pgTable('metrics', {
 *   ts: timestamp('ts', { withTimezone: true }).notNull(),
 *   value: doublePrecision('value').notNull(),
 * });
 * // → SELECT create_hypertable('metrics', by_range('ts', INTERVAL '7 days'),
 * //     if_not_exists => TRUE);
 * export const metricsHyper = hypertable(metrics, { by: 'ts', chunkInterval: '7 days' });
 * ```
 */
export function hypertable(table: TableRef, options: HypertableOptions): string {
  const { by, chunkInterval, ifNotExists = true, migrateData = false } = options;

  // create_hypertable / by_range take the table + column as TEXT arguments (not
  // bare identifiers), so they are quoted as string literals (#278).
  const dimension = chunkInterval
    ? `by_range(${quoteLiteral(by)}, INTERVAL ${quoteLiteral(chunkInterval)})`
    : `by_range(${quoteLiteral(by)})`;
  const args = [quoteLiteral(tableName(table)), dimension];
  if (migrateData) {
    args.push('migrate_data => TRUE');
  }
  if (ifNotExists) {
    args.push('if_not_exists => TRUE');
  }
  return `SELECT create_hypertable(${args.join(', ')});`;
}

/** Options for {@link dropChunks}. */
export interface DropChunksOptions {
  /**
   * Drop chunks whose data is entirely older than this interval, e.g. `'30 days'`.
   * Emitted as `INTERVAL '<value>'`.
   */
  olderThan: string;
}

/**
 * Emit a **one-shot** `SELECT drop_chunks(...)` for retention — the migration/CI
 * runs it while the compute is awake. This is deliberately not
 * `add_retention_policy()`: that schedules a *background policy job*, which cannot
 * run on a compute that scales to zero (scale-zero-pg `adr-0001`). Run this on a
 * schedule you control (a CI cron / a `kn-next` job) instead.
 *
 * ```ts
 * // → SELECT drop_chunks('metrics', INTERVAL '30 days');
 * dropChunks(metrics, { olderThan: '30 days' });
 * ```
 */
export function dropChunks(table: TableRef, options: DropChunksOptions): string {
  // drop_chunks takes the table + interval as TEXT arguments — quote as literals (#278).
  return `SELECT drop_chunks(${quoteLiteral(tableName(table))}, INTERVAL ${quoteLiteral(
    options.olderThan,
  )});`;
}
