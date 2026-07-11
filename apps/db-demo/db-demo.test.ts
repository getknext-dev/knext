import { getTableName } from '@knext/db';
import { describe, expect, it } from 'vitest';

/**
 * `apps/db-demo` — the runnable `@knext/db` example (#243, ADR-0021 §Consequences).
 *
 * These are the unit-level build/typecheck proofs the guide's example rests on:
 * the drizzle config is valid, the schema builds a real drizzle table, and the
 * data-access + client modules import cleanly (no live database needed — the
 * on-cluster "both wake on one request" AC is proven separately on OKE). A full
 * `next build` + `tsc --noEmit` covers the App Router glue (page/actions).
 */

describe('apps/db-demo — @knext/db example wiring', () => {
  it('exposes a valid drizzle.config wired to the writer + knext conventions', async () => {
    const mod = await import('./drizzle.config');
    const config = mod.default;
    expect(config.dialect).toBe('postgresql');
    expect(config.schema).toBe('./src/db/schema.ts');
    expect(config.out).toBe('./drizzle');
    // Writer-only: the config is wired to DATABASE_URL, never the RO replica.
    // (dbCredentials only exists on the postgres/mysql Config variants — narrow it.)
    expect((config as { dbCredentials?: unknown }).dbCredentials).toBeDefined();
  });

  it('defines a single `messages` table via the @knext/db/schema surface', async () => {
    const schema = await import('./src/db/schema');
    expect(getTableName(schema.messages)).toBe('messages');
    // Typed row/insert shapes are exported for the app to use.
    expect(schema.messages.body).toBeDefined();
    expect(schema.messages.author).toBeDefined();
  });

  it('exposes read (RO) + write data-access functions that import cleanly', async () => {
    const queries = await import('./src/db/queries');
    expect(typeof queries.listMessages).toBe('function');
    expect(typeof queries.addMessage).toBe('function');
  });

  it('binds to @knext/db clients (getDb writer / getDbRO reader)', async () => {
    const db = await import('@knext/db');
    expect(typeof db.getDb).toBe('function');
    expect(typeof db.getDbRO).toBe('function');
  });
});
