import type { Config } from 'drizzle-kit';

/**
 * `@knext/db/migrate` — the migration entrypoint.
 *
 * This module currently ships `defineDrizzleConfig()`, the helper an app uses in
 * its `drizzle.config.ts` (#239). The one-shot `kn-next db migrate` runner + Job
 * recipe land on this same subpath in follow-up work (#242).
 *
 * `drizzle-kit` is a **type-only** dependency here: `defineDrizzleConfig()` returns
 * a plain object typed as drizzle-kit's `Config`; the import erases at build, so
 * `@knext/db/migrate` pulls no runtime code from drizzle-kit. drizzle-kit is the
 * app's own dev tool (it runs `generate`/`migrate` against this config).
 */

/** Conventional schema location for a knext app (ADR-0021 §2). */
export const DEFAULT_SCHEMA_PATH = './src/db/schema.ts';

/** Conventional output directory for generated SQL migrations. */
export const DEFAULT_MIGRATIONS_DIR = './drizzle';

/** Options for {@link defineDrizzleConfig}. */
export interface DefineDrizzleConfigOptions {
  /** Path (or paths) to the schema module(s). Defaults to {@link DEFAULT_SCHEMA_PATH}. */
  schema?: string | string[];
  /** Directory for generated migrations. Defaults to {@link DEFAULT_MIGRATIONS_DIR}. */
  out?: string;
  /**
   * Explicit writer DSN. Defaults to `process.env.DATABASE_URL`. Provide this to
   * compose with an `AppDatabase`-provisioned credential resolved at config time.
   * **Migrations are writer-only** (ADR-0021 §3) — never pass `DATABASE_URL_RO`.
   */
  url?: string;
}

/**
 * Produce a valid `drizzle.config.ts` for a NextApp.
 *
 * ```ts
 * // drizzle.config.ts
 * import { defineDrizzleConfig } from '@knext/db/migrate';
 * export default defineDrizzleConfig({ schema: './src/db/schema.ts', out: './drizzle' });
 * ```
 *
 * Wiring:
 * - **dialect** `postgresql`.
 * - **DSN** the **writer** `DATABASE_URL` (or an explicit `url` override) — never
 *   the read replica. `drizzle-kit generate` needs no live database, so an unset
 *   `DATABASE_URL` yields an empty DSN and still generates SQL; `migrate`/`push`
 *   require the writer DSN to be present (the operator injects it at runtime).
 * - **paths** the knext conventions unless overridden.
 * - `strict` + `verbose` for safe, legible migration runs.
 *
 * The result is a plain `Config` object, so an app can spread it to add fields
 * drizzle-kit supports (`tablesFilter`, `casing`, `migrations`, …).
 */
export function defineDrizzleConfig(options: DefineDrizzleConfigOptions = {}): Config {
  const {
    schema = DEFAULT_SCHEMA_PATH,
    out = DEFAULT_MIGRATIONS_DIR,
    url = process.env.DATABASE_URL,
  } = options;

  return {
    dialect: 'postgresql',
    schema,
    out,
    strict: true,
    verbose: true,
    dbCredentials: { url: url ?? '' },
  } satisfies Config;
}
