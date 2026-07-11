import type { Config } from 'drizzle-kit';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * `@knext/db/migrate` — the migration entrypoint.
 *
 * Two things live here:
 * - `defineDrizzleConfig()` — the helper an app uses in its `drizzle.config.ts`
 *   (#239). `drizzle-kit` is a **type-only** import for it: it returns a plain
 *   object typed as drizzle-kit's `Config`, so the import erases at build and
 *   pulls no runtime code from drizzle-kit (the app's own dev tool, which runs
 *   `generate`/`migrate` against this config).
 * - `runMigrations()` / `resolveWriterDsn()` — the engine behind the one-shot
 *   `kn-next db migrate` runner + Job recipe (#242). Applies drizzle-kit-generated
 *   migrations against the **writer only**, once per deploy, out of the request
 *   path (ADR-0021 §3). This half is runtime code (drizzle-orm's migrator + `pg`).
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

// --- The one-shot migration runner (`kn-next db migrate`) --------------------

/**
 * The scale-zero-pg **RO gateway** port (bounded-staleness reads, ~9s ceiling,
 * no read-your-writes). Migrations must NEVER target it: single-writer forbids
 * writes on the replica and the runner is writer-only (ADR-0021 §3). The writer
 * gateway is port `55432`.
 */
export const RO_GATEWAY_PORT = '55434';

/** Options for {@link runMigrations} and {@link resolveWriterDsn}. */
export interface RunMigrationsOptions {
  /**
   * Writer DSN. Defaults to `process.env.DATABASE_URL` (the operator injects it).
   * **Writer-only** — never `DATABASE_URL_RO`; the runner refuses a RO DSN.
   */
  url?: string;
  /** Directory of drizzle-kit-generated SQL migrations. Defaults to {@link DEFAULT_MIGRATIONS_DIR}. */
  migrationsFolder?: string;
  /**
   * The read-replica DSN to guard against. Defaults to `process.env.DATABASE_URL_RO`.
   * If the resolved writer DSN equals this, the runner refuses (writer-only).
   */
  roUrl?: string;
}

/** Result of a successful {@link runMigrations}. */
export interface RunMigrationsResult {
  /** The migrations directory that was applied. */
  migrationsFolder: string;
}

/** An open writer connection: a drizzle db to migrate through + a close hook. */
export interface MigrationConnection {
  db: unknown;
  close(): Promise<void>;
}

/**
 * The effectful boundary of {@link runMigrations}, injectable so unit tests run
 * with no database. Production uses {@link defaultMigrateDeps}.
 */
export interface RunMigrationsDeps {
  /** Open a writer connection for `url` (wakes a scale-to-zero compute once). */
  connect(url: string): Promise<MigrationConnection>;
  /** Apply pending migrations from `migrationsFolder` (drizzle-orm's migrator). */
  migrate(db: unknown, migrationsFolder: string): Promise<void>;
}

/** Does this DSN point at the RO gateway port? (URL first, regex fallback for kv DSNs.) */
function dsnTargetsRoPort(dsn: string): boolean {
  try {
    if (new URL(dsn).port === RO_GATEWAY_PORT) return true;
  } catch {
    // Not URL-parseable (e.g. a libpq key=value DSN) — fall through to the regex.
  }
  return new RegExp(`:${RO_GATEWAY_PORT}(?:[/?]|$)`).test(dsn);
}

/**
 * Resolve — and guard — the **writer** DSN for a migration run.
 *
 * Migrations are writer-only (ADR-0021 §3): single-writer forbids writes on the
 * read replica, and the RO gateway is bounded-staleness. This resolves
 * `opts.url ?? DATABASE_URL` and **refuses** anything that looks like the RO
 * replica — an exact match of `DATABASE_URL_RO`, or a DSN on the RO gateway port
 * `55434`. Throws (fail loud) when no writer DSN is available.
 */
export function resolveWriterDsn(opts: Pick<RunMigrationsOptions, 'url' | 'roUrl'> = {}): string {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error(
      'kn-next db migrate: DATABASE_URL (the writer DSN) is required. Migrations run ' +
        'against the primary/writer only (ADR-0021 §3) — set DATABASE_URL (the operator ' +
        'injects it) or pass --url. Never the read replica.',
    );
  }
  const roUrl = opts.roUrl ?? process.env.DATABASE_URL_RO;
  if (roUrl && url === roUrl) {
    throw new Error(
      'kn-next db migrate: refusing to migrate — the resolved DSN equals DATABASE_URL_RO ' +
        '(the read-only replica). Migrations are writer-only (ADR-0021 §3): the RO gateway is ' +
        'bounded-staleness and single-writer forbids writes there. Use the writer DATABASE_URL.',
    );
  }
  if (dsnTargetsRoPort(url)) {
    throw new Error(
      `kn-next db migrate: refusing to migrate — the DSN targets the RO gateway port ` +
        `${RO_GATEWAY_PORT} (bounded-staleness reads). Migrations are writer-only (ADR-0021 §3); ` +
        `point at the writer gateway (port 55432).`,
    );
  }
  return url;
}

/**
 * Default production dependencies: a one-shot `pg.Pool` (max 1 — a single
 * migrator, no per-pod race) drizzle-wrapped, plus drizzle-orm's node-postgres
 * migrator. The connect timeout matches `@knext/lib`'s ADR-0019 default (15s) so
 * a cold scale-to-zero writer — which wakes in ~2.5s — is tolerated with margin.
 * The pool is closed after the run (see {@link runMigrations}'s `finally`).
 */
export function defaultMigrateDeps(): RunMigrationsDeps {
  return {
    async connect(url: string): Promise<MigrationConnection> {
      const pool = new Pool({
        connectionString: url,
        max: 1,
        connectionTimeoutMillis: 15_000,
      });
      const db = drizzle(pool);
      return { db, close: () => pool.end() };
    },
    migrate(db: unknown, migrationsFolder: string): Promise<void> {
      return drizzleMigrate(db as NodePgDatabase<Record<string, never>>, { migrationsFolder });
    },
  };
}

/**
 * Apply pending migrations against the **writer**, once. This is the engine
 * behind `kn-next db migrate` (ADR-0021 §3):
 *
 * - **Writer-only** — resolves + guards the DSN via {@link resolveWriterDsn};
 *   refuses the RO replica before opening any connection.
 * - **Idempotent** — drizzle tracks applied migrations in `__drizzle_migrations`,
 *   so re-running skips what is already applied. Safe to run every deploy.
 * - **Fail loud** — a migration error rejects (the caller/Job exits non-zero);
 *   the connection is always closed (`finally`), never leaked.
 *
 * Runs out of the request path (a CI step or a one-shot k8s Job), never on pod
 * boot — one migrator, no N-pod race. Composes with `AppDatabase` provisioning:
 * provision → `Ready` → migrate → app serves.
 */
export async function runMigrations(
  opts: RunMigrationsOptions = {},
  deps: RunMigrationsDeps = defaultMigrateDeps(),
): Promise<RunMigrationsResult> {
  const url = resolveWriterDsn(opts);
  const migrationsFolder = opts.migrationsFolder ?? DEFAULT_MIGRATIONS_DIR;

  const { db, close } = await deps.connect(url);
  try {
    await deps.migrate(db, migrationsFolder);
  } finally {
    await close();
  }
  return { migrationsFolder };
}
