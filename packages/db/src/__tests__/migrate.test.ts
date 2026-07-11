import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_SCHEMA_PATH,
  defineDrizzleConfig,
  RO_GATEWAY_PORT,
  type RunMigrationsDeps,
  resolveWriterDsn,
  runMigrations,
} from '../migrate';

// `defineDrizzleConfig()` produces the `drizzle.config.ts` a NextApp uses to
// generate + apply migrations. Per ADR-0021 §3/§5, migrations are WRITER-ONLY:
// the config's DSN is always `DATABASE_URL` (never `DATABASE_URL_RO`). These
// tests pin the dialect, the writer DSN wiring, and the path defaults.

describe('@knext/db/migrate — defineDrizzleConfig()', () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalRoUrl = process.env.DATABASE_URL_RO;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://writer.example:55432/app';
    process.env.DATABASE_URL_RO = 'postgres://reader.example:55434/app';
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalRoUrl === undefined) delete process.env.DATABASE_URL_RO;
    else process.env.DATABASE_URL_RO = originalRoUrl;
  });

  it('produces a postgresql config', () => {
    const cfg = defineDrizzleConfig();
    expect(cfg.dialect).toBe('postgresql');
  });

  it('uses the WRITER DSN (DATABASE_URL), never the RO DSN', () => {
    const cfg = defineDrizzleConfig() as { dbCredentials: { url: string } };
    expect(cfg.dbCredentials.url).toBe('postgres://writer.example:55432/app');
    expect(cfg.dbCredentials.url).not.toContain('55434');
    expect(cfg.dbCredentials.url).not.toBe(process.env.DATABASE_URL_RO);
  });

  it('defaults the schema path and out dir to the knext conventions', () => {
    const cfg = defineDrizzleConfig();
    expect(cfg.schema).toBe(DEFAULT_SCHEMA_PATH);
    expect(cfg.out).toBe(DEFAULT_MIGRATIONS_DIR);
    expect(DEFAULT_SCHEMA_PATH).toBe('./src/db/schema.ts');
    expect(DEFAULT_MIGRATIONS_DIR).toBe('./drizzle');
  });

  it('overrides schema + out when provided', () => {
    const cfg = defineDrizzleConfig({ schema: './db/tables.ts', out: './migrations' });
    expect(cfg.schema).toBe('./db/tables.ts');
    expect(cfg.out).toBe('./migrations');
  });

  it('accepts an explicit url override (composes with a provisioned DATABASE_URL)', () => {
    const cfg = defineDrizzleConfig({
      url: 'postgres://provisioned.example:55432/app',
    }) as { dbCredentials: { url: string } };
    expect(cfg.dbCredentials.url).toBe('postgres://provisioned.example:55432/app');
  });

  it('falls back to an empty DSN when DATABASE_URL is unset (generate still works, migrate/push need it)', () => {
    delete process.env.DATABASE_URL;
    const cfg = defineDrizzleConfig() as { dbCredentials: { url: string } };
    expect(cfg.dbCredentials.url).toBe('');
  });
});

// The one-shot migration runner (`kn-next db migrate`'s engine, ADR-0021 §3).
// It applies drizzle-kit-generated migrations against the WRITER only, out of
// the request path. These tests pin the writer-only guarantee (never the RO
// replica) and the fail-loud + connection-close behaviour — all without a real
// database (the pg/drizzle boundary is injected).

const WRITER_DSN = 'postgres://writer.example:55432/app';
const RO_DSN = 'postgres://reader.example:55434/app';

describe('@knext/db/migrate — resolveWriterDsn()', () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalRoUrl = process.env.DATABASE_URL_RO;

  beforeEach(() => {
    process.env.DATABASE_URL = WRITER_DSN;
    process.env.DATABASE_URL_RO = RO_DSN;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalRoUrl === undefined) delete process.env.DATABASE_URL_RO;
    else process.env.DATABASE_URL_RO = originalRoUrl;
  });

  it('resolves the writer DSN from DATABASE_URL', () => {
    expect(resolveWriterDsn()).toBe(WRITER_DSN);
  });

  it('honours an explicit url override (composes with a provisioned credential)', () => {
    expect(resolveWriterDsn({ url: 'postgres://provisioned:55432/app' })).toBe(
      'postgres://provisioned:55432/app',
    );
  });

  it('throws (fail loud) when no writer DSN is available', () => {
    delete process.env.DATABASE_URL;
    expect(() => resolveWriterDsn()).toThrow(/DATABASE_URL/);
  });

  it('refuses a DSN equal to DATABASE_URL_RO (writer-only)', () => {
    expect(() => resolveWriterDsn({ url: RO_DSN })).toThrow(/writer-only|read-only/i);
  });

  it('refuses a DSN targeting the RO gateway port even if DATABASE_URL_RO is unset', () => {
    delete process.env.DATABASE_URL_RO;
    expect(() => resolveWriterDsn({ url: `postgres://pggw:${RO_GATEWAY_PORT}/app` })).toThrow(
      new RegExp(RO_GATEWAY_PORT),
    );
  });

  it('exposes the RO gateway port as the documented 55434', () => {
    expect(RO_GATEWAY_PORT).toBe('55434');
  });
});

describe('@knext/db/migrate — runMigrations()', () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalRoUrl = process.env.DATABASE_URL_RO;

  beforeEach(() => {
    process.env.DATABASE_URL = WRITER_DSN;
    delete process.env.DATABASE_URL_RO;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalRoUrl === undefined) delete process.env.DATABASE_URL_RO;
    else process.env.DATABASE_URL_RO = originalRoUrl;
  });

  function spyDeps(migrateImpl?: (db: unknown, folder: string) => Promise<void>) {
    const close = vi.fn(async () => {});
    const db = { __db: true };
    const connect = vi.fn(async (_url: string) => ({ db, close }));
    const migrate = vi.fn(migrateImpl ?? (async () => {}));
    const deps: RunMigrationsDeps = { connect, migrate };
    return { deps, connect, migrate, close, db };
  }

  it('connects with the writer DSN and applies migrations from ./drizzle by default', async () => {
    const { deps, connect, migrate, close, db } = spyDeps();
    const result = await runMigrations({}, deps);
    expect(connect).toHaveBeenCalledWith(WRITER_DSN);
    expect(migrate).toHaveBeenCalledWith(db, './drizzle');
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.migrationsFolder).toBe('./drizzle');
  });

  it('applies from a custom migrations folder', async () => {
    const { deps, migrate } = spyDeps();
    const result = await runMigrations({ migrationsFolder: './migrations' }, deps);
    expect(migrate).toHaveBeenCalledWith(expect.anything(), './migrations');
    expect(result.migrationsFolder).toBe('./migrations');
  });

  it('refuses the RO replica — never connects', async () => {
    const { deps, connect } = spyDeps();
    await expect(runMigrations({ url: RO_DSN }, deps)).rejects.toThrow(/writer-only|read-only/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('fails loud and still closes the pool when a migration errors', async () => {
    const boom = new Error('relation already exists');
    const { deps, close } = spyDeps(async () => {
      throw boom;
    });
    await expect(runMigrations({}, deps)).rejects.toThrow(boom);
    expect(close).toHaveBeenCalledTimes(1); // finally-closed, no leaked connection
  });
});
