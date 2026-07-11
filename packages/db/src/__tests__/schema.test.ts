import { describe, expect, it } from 'vitest';
import * as schema from '../schema';

// `@knext/db/schema` is the one place an app imports its table/column builders
// from — a thin re-export of drizzle-orm's `pg-core` (plus `relations`/`sql`),
// pinned at a compatible version. These tests prove the surface is present and
// that the re-exported builders actually build a real drizzle table (not just a
// name that type-checks) — the platform value-add helpers (#240 TimescaleDB,
// #241 pgvector) slot in on top of this surface later.

describe('@knext/db/schema — re-exported drizzle surface', () => {
  it('re-exports pgTable + the common column builders', () => {
    for (const name of [
      'pgTable',
      'serial',
      'text',
      'integer',
      'boolean',
      'timestamp',
      'jsonb',
      'uuid',
      'doublePrecision',
    ]) {
      expect(typeof (schema as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('re-exports index + constraint helpers', () => {
    for (const name of ['index', 'uniqueIndex', 'primaryKey', 'foreignKey', 'pgEnum']) {
      expect(typeof (schema as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('re-exports `relations` and `sql` from drizzle-orm', () => {
    expect(typeof schema.relations).toBe('function');
    expect(typeof schema.sql).toBe('function');
  });

  it('re-exports the pgvector `vector` column (the #241 extension seam builds on it)', () => {
    expect(typeof schema.vector).toBe('function');
  });

  it('builds a real drizzle table from the re-exported builders', async () => {
    const { pgTable, serial, text, timestamp } = schema;
    const { getTableConfig } = await import('drizzle-orm/pg-core');

    const users = pgTable('users', {
      id: serial('id').primaryKey(),
      email: text('email').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    });

    const cfg = getTableConfig(users);
    expect(cfg.name).toBe('users');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(['created_at', 'email', 'id']);

    // Row-type inference flows through the re-export: `$inferSelect` types the
    // row shape, so this object is checked against the table's columns.
    const row: typeof users.$inferSelect = {
      id: 1,
      email: 'a@example.com',
      createdAt: new Date(),
    };
    expect(row.email).toBe('a@example.com');
  });
});
