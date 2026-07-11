import { doublePrecision, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  CREATE_TIMESCALEDB_EXTENSION,
  createTimescaleExtension,
  dropChunks,
  hypertable,
} from '../extensions/timescaledb';
import * as schema from '../schema';

// TimescaleDB helpers (#240) are **migration SQL emitters** on the `@knext/db/schema`
// extension seam. drizzle does not model hypertables, so — mirroring how the app
// self-enables the extension over its own DATABASE_URL (scale-zero-pg connecting.md)
// — these produce the exact `create_hypertable` / `drop_chunks` SQL an app pastes
// into its generated migration. The scale-to-zero bound is honest: hypertables +
// `drop_chunks()` retention only (Apache-2 tier); NO columnar compression / continuous
// aggregates (background policy jobs can't run on a compute that scales to zero —
// scale-zero-pg adr-0001).

const metrics = pgTable('metrics', {
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  device: text('device').notNull(),
  value: doublePrecision('value').notNull(),
});

describe('@knext/db timescaledb — CREATE EXTENSION guidance', () => {
  it('emits the self-service, idempotent enable statement', () => {
    expect(createTimescaleExtension()).toBe('CREATE EXTENSION IF NOT EXISTS timescaledb;');
    expect(CREATE_TIMESCALEDB_EXTENSION).toBe('CREATE EXTENSION IF NOT EXISTS timescaledb;');
  });
});

describe('@knext/db timescaledb — hypertable()', () => {
  it('emits create_hypertable with the time column + chunk interval', () => {
    expect(hypertable(metrics, { by: 'ts', chunkInterval: '7 days' })).toBe(
      "SELECT create_hypertable('metrics', 'ts', " +
        "chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);",
    );
  });

  it('accepts a bare table name string', () => {
    expect(hypertable('readings', { by: 'ts' })).toBe(
      "SELECT create_hypertable('readings', 'ts', if_not_exists => TRUE);",
    );
  });

  it('omits chunk_time_interval when no interval is given', () => {
    expect(hypertable(metrics, { by: 'ts' })).not.toContain('chunk_time_interval');
  });

  it('can opt out of if_not_exists for a strict first migration', () => {
    expect(hypertable(metrics, { by: 'ts', ifNotExists: false })).toBe(
      "SELECT create_hypertable('metrics', 'ts');",
    );
  });

  it('emits migrate_data => TRUE only when converting a populated table', () => {
    expect(hypertable(metrics, { by: 'ts', migrateData: true })).toContain('migrate_data => TRUE');
    expect(hypertable(metrics, { by: 'ts' })).not.toContain('migrate_data');
  });
});

describe('@knext/db timescaledb — dropChunks() retention', () => {
  // Retention is a ONE-SHOT drop_chunks() the migration/CI runs — deliberately NOT
  // add_retention_policy(), whose background policy job cannot run on a scale-to-zero
  // compute (scale-zero-pg adr-0001). That is the honest bound.
  it('emits drop_chunks with an INTERVAL cutoff', () => {
    expect(dropChunks(metrics, { olderThan: '30 days' })).toBe(
      "SELECT drop_chunks('metrics', INTERVAL '30 days');",
    );
  });

  it('accepts a bare table name string', () => {
    expect(dropChunks('readings', { olderThan: '90 days' })).toBe(
      "SELECT drop_chunks('readings', INTERVAL '90 days');",
    );
  });
});

describe('@knext/db/schema — re-exports the timescaledb helpers on the seam', () => {
  it('exposes hypertable / dropChunks / createTimescaleExtension', () => {
    expect(typeof schema.hypertable).toBe('function');
    expect(typeof schema.dropChunks).toBe('function');
    expect(typeof schema.createTimescaleExtension).toBe('function');
  });
});
