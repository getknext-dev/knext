import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_SCHEMA_PATH,
  defineDrizzleConfig,
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
