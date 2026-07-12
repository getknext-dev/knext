import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// The CLI of record for `kn-next db migrate` (thin wrapper over this package's
// engine) — imported relatively because the live lane exercises the real
// dispatch path, not a mock runner.
import { runDbMigrate } from '../../../../kn-next/src/cli/db-migrate';
import { createVectorExtension, hnsw } from '../../extensions/pgvector';
import { createTimescaleExtension, hypertable } from '../../extensions/timescaledb';
import { runMigrations } from '../../migrate';
import { pgTable, serial, vector } from '../../schema';
import { checkLiveDbDsn } from './live-dsn-guard';

// Table used only by the (skipped) pgvector spec — kept real so flipping the
// scale-zero-pg#178 gate later needs no rewrite.
const vectorDocs = pgTable('docs', {
  id: serial('id').primaryKey(),
  embedding: vector('embedding', { dimensions: 3 }),
});

/**
 * LIVE-POSTGRES integration lane for `@knext/db` (plan P2, ADR-0021).
 *
 * Everything below runs against a REAL Postgres — the first time the SDK's
 * product claims (migrations apply + are idempotent, writer read-your-writes,
 * RO fallback/routing, the one-shot CLI runner) are verified beyond mocks.
 *
 * Gating (the default `vitest run` stays hermetic):
 *   - `KNEXT_DB_LIVE=1` AND `DATABASE_URL` must both be set, else the suite
 *     SKIPS cleanly (see the suite title for the reason).
 *   - SAFETY: before any connection, the DSN host must be loopback
 *     (localhost / 127.0.0.0/8 / ::1) or the CI service hostname `postgres`
 *     — anything else is REFUSED unless `KNEXT_DB_LIVE_UNSAFE_HOST=1`
 *     (live-dsn-guard.ts). A typo'd real DSN must never receive test writes:
 *     this suite CREATEs, writes to, and DROPs databases.
 *
 * Local run (see packages/db/README.md):
 *   docker run --rm -d --name knext-db-live -e POSTGRES_USER=knext \
 *     -e POSTGRES_PASSWORD=knext -e POSTGRES_DB=knext -p 55432:5432 postgres:16
 *   KNEXT_DB_LIVE=1 DATABASE_URL=postgres://knext:knext@127.0.0.1:55432/knext \
 *     pnpm exec vitest run packages/db/src/__tests__/integration/live-postgres.test.ts
 *   docker rm -f knext-db-live
 *
 * What this lane deliberately does NOT prove:
 *   - scale-zero-pg's **bounded-staleness** RO semantics. `DATABASE_URL_RO`
 *     here points at the SAME vanilla-Postgres container via a second DSN, so
 *     the reader tests prove pool **routing** (distinct pool, distinct
 *     connections), not replica lag behavior — vanilla PG cannot reproduce
 *     the RO gateway's ~9s staleness ceiling.
 *   - the on-cluster "app + database both wake on one request" AC (OKE-only,
 *     out of scope per the plan).
 */

const LIVE = process.env.KNEXT_DB_LIVE === '1' && Boolean(process.env.DATABASE_URL);
const BASE_DSN = process.env.DATABASE_URL ?? '';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
/** The db-demo app's committed drizzle-kit migrations — the SDK's own example. */
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'apps/db-demo/drizzle');

// One-time warning capture for the RO-fallback spec. Mocked file-wide; only
// packages/db/src/index.ts consumes this module here.
const warned: string[] = [];
vi.mock('@knext/lib/logger', () => ({
  logger: {
    warn: (msg: string) => warned.push(msg),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

/** DSN for `dbName` on the same server as `base` (optionally tagged for routing proofs). */
function dsnFor(base: string, dbName: string, applicationName?: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  if (applicationName) {
    url.searchParams.set('application_name', applicationName);
  }
  return url.toString();
}

/** Per-run database-name prefix — lowercase [a-z0-9_] only (interpolated into DDL). */
const RUN = `knext_live_${Date.now().toString(36)}`;

describe.skipIf(!LIVE)(
  '@knext/db live Postgres lane (SKIPPED unless KNEXT_DB_LIVE=1 and DATABASE_URL are set)',
  () => {
    let admin: Pool;
    const createdDbs: string[] = [];
    const savedEnv = {
      url: process.env.DATABASE_URL,
      ro: process.env.DATABASE_URL_RO,
    };

    async function freshDb(suffix: string): Promise<string> {
      const name = `${RUN}_${suffix}`;
      if (!/^[a-z0-9_]+$/.test(name)) {
        throw new Error(`unsafe test database name: ${name}`);
      }
      await admin.query(`CREATE DATABASE ${name}`);
      createdDbs.push(name);
      return name;
    }

    beforeAll(async () => {
      // SAFETY GATE — before ANY connection. Refuse every host that is not
      // loopback or the CI service container, absent the explicit override.
      const verdict = checkLiveDbDsn(BASE_DSN, {
        allowUnsafeHost: process.env.KNEXT_DB_LIVE_UNSAFE_HOST === '1',
      });
      if (!verdict.ok) {
        throw new Error(verdict.reason);
      }
      admin = new Pool({ connectionString: BASE_DSN, max: 1 });
      // Fail fast (and loud) if the container is not actually up.
      await admin.query('SELECT 1');
    }, 60_000);

    afterAll(async () => {
      for (const name of createdDbs.splice(0)) {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      await admin.end();
      process.env.DATABASE_URL = savedEnv.url;
      if (savedEnv.ro === undefined) {
        delete process.env.DATABASE_URL_RO;
      } else {
        process.env.DATABASE_URL_RO = savedEnv.ro;
      }
    }, 60_000);

    describe('runMigrations() — the db-demo drizzle/ migrations against a fresh database', () => {
      let migDsn: string;
      // Journal rows after the first run — the idempotency spec compares
      // against these exact rows (id + hash + created_at).
      let firstJournal: unknown[];

      beforeAll(async () => {
        migDsn = dsnFor(BASE_DSN, await freshDb('mig'));
      }, 30_000);

      it('applies the migrations: the messages table exists and the journal has one entry', async () => {
        await runMigrations({ url: migDsn, migrationsFolder: MIGRATIONS_DIR });

        const pool = new Pool({ connectionString: migDsn, max: 1 });
        try {
          const table = await pool.query("SELECT to_regclass('public.messages') AS tbl");
          expect(table.rows[0].tbl).toBe('messages');

          const journal = await pool.query(
            'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
          );
          expect(journal.rows).toHaveLength(1);
          firstJournal = journal.rows;

          // Seed a marker row: idempotency below must also prove no data loss
          // (a re-APPLY of 0000 would either fail on CREATE TABLE or, worse,
          // recreate the table — either way this row is the tripwire).
          await pool.query("INSERT INTO messages (author, body) VALUES ('live-lane', 'marker')");
        } finally {
          await pool.end();
        }
      }, 30_000);

      it('is idempotent on re-run — the journal is respected and nothing re-applies', async () => {
        // Second run: must resolve without error…
        await runMigrations({ url: migDsn, migrationsFolder: MIGRATIONS_DIR });

        const pool = new Pool({ connectionString: migDsn, max: 1 });
        try {
          // …append nothing to the journal (same rows, same created_at)…
          const journal = await pool.query(
            'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
          );
          expect(journal.rows).toEqual(firstJournal);

          // …and leave existing data untouched.
          const marker = await pool.query("SELECT body FROM messages WHERE author = 'live-lane'");
          expect(marker.rows).toEqual([{ body: 'marker' }]);
        } finally {
          await pool.end();
        }
      }, 30_000);
    });

    describe('getDb() / getDbRO() — real pools over the live server', () => {
      let appDb: string;
      // Track every SDK "generation" (vi.resetModules world) so its real pg
      // pools are drained after each spec — no leaked sockets, no hung vitest.
      const generations: Array<typeof import('@knext/lib/clients')> = [];

      /**
       * Import a FRESH copy of the SDK (+ its `@knext/lib` pools) with the
       * given env. `@knext/db`'s writer/reader clients and `@knext/lib`'s
       * pools are module-level singletons keyed off env at first call, so
       * each routing spec needs its own module generation.
       */
      async function freshSdk(env: { url: string; ro?: string }) {
        vi.resetModules();
        process.env.DATABASE_URL = env.url;
        if (env.ro === undefined) {
          delete process.env.DATABASE_URL_RO;
        } else {
          process.env.DATABASE_URL_RO = env.ro;
        }
        const sdk = await import('../../index');
        const clients = await import('@knext/lib/clients');
        generations.push(clients);
        return sdk;
      }

      /** drizzle's `sql` tag, typed loosely — it comes from a dynamic module generation. */
      type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

      /** The routing proof: which server-side application_name served this client? */
      async function appNameSeenBy(
        db: { execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> },
        sql: SqlTag,
      ): Promise<unknown> {
        const res = await db.execute(sql`SELECT current_setting('application_name') AS app`);
        return res.rows[0].app;
      }

      beforeAll(async () => {
        appDb = await freshDb('app');
        // Schema for the SDK specs — the same committed db-demo migrations.
        await runMigrations({ url: dsnFor(BASE_DSN, appDb), migrationsFolder: MIGRATIONS_DIR });
      }, 30_000);

      afterEach(async () => {
        warned.length = 0;
        for (const clients of generations.splice(0)) {
          await clients.closeDbPool();
          await clients.closeDbPoolRO();
        }
      });

      it('getDb(schema): insert → select is read-your-writes on the writer', async () => {
        const sdk = await freshSdk({ url: dsnFor(BASE_DSN, appDb, 'knext-live-writer') });
        // Import the db-demo schema in the SAME module generation so its
        // drizzle table objects match the freshly imported drizzle-orm.
        const { messages } = await import('../../../../../apps/db-demo/src/db/schema');

        const db = sdk.getDb({ messages });
        const [inserted] = await db
          .insert(messages)
          .values({ author: 'live-lane', body: 'read-your-writes' })
          .returning();
        expect(inserted.id).toBeGreaterThan(0);

        const seen = await db.select().from(messages).where(sdk.eq(messages.id, inserted.id));
        expect(seen).toHaveLength(1);
        expect(seen[0].body).toBe('read-your-writes');
      }, 30_000);

      it('getDbRO() without DATABASE_URL_RO: falls back to the writer pool with a one-time warning', async () => {
        const sdk = await freshSdk({ url: dsnFor(BASE_DSN, appDb, 'knext-live-writer') });

        const db = sdk.getDb();
        const dbRO = sdk.getDbRO();

        // Same client object — reads hit the primary…
        expect(dbRO).toBe(db);
        // …over the WRITER's connections (application_name proves the pool).
        expect(await appNameSeenBy(dbRO, sdk.sql)).toBe('knext-live-writer');

        // One-time warning, however often the fallback is taken.
        sdk.getDbRO();
        sdk.getDbRO();
        expect(warned).toHaveLength(1);
        expect(warned[0]).toMatch(/DATABASE_URL_RO/);
      }, 30_000);

      it('getDbRO() with DATABASE_URL_RO: uses a DISTINCT pool routed at the RO DSN', async () => {
        // ROUTING, not staleness: both DSNs hit the SAME vanilla-Postgres
        // container — this proves the reader client rides its own pool on the
        // RO DSN, NOT scale-zero-pg's bounded-staleness (~9s, no
        // read-your-writes) semantics, which vanilla PG cannot reproduce.
        const sdk = await freshSdk({
          url: dsnFor(BASE_DSN, appDb, 'knext-live-writer'),
          ro: dsnFor(BASE_DSN, appDb, 'knext-live-ro'),
        });

        const db = sdk.getDb();
        const dbRO = sdk.getDbRO();

        expect(dbRO).not.toBe(db);
        expect(await appNameSeenBy(db, sdk.sql)).toBe('knext-live-writer');
        expect(await appNameSeenBy(dbRO, sdk.sql)).toBe('knext-live-ro');
        expect(warned).toHaveLength(0);
      }, 30_000);
    });

    describe('kn-next db migrate — the one-shot CLI runner, live happy path', () => {
      let cliDsn: string;

      beforeAll(async () => {
        cliDsn = dsnFor(BASE_DSN, await freshDb('cli'));
        // The runner refuses a DSN equal to DATABASE_URL_RO; earlier routing
        // specs set that env, so clear it for a clean CLI environment.
        delete process.env.DATABASE_URL_RO;
      }, 30_000);

      it('applies the db-demo migrations via the real engine and reports success', async () => {
        const out: string[] = [];
        await runDbMigrate(
          ['--url', cliDsn, '--dir', MIGRATIONS_DIR],
          undefined, // default runner — the REAL @knext/db/migrate engine
          (text) => out.push(text),
        );
        expect(out.join('')).toMatch(/Migrations applied from/);

        const pool = new Pool({ connectionString: cliDsn, max: 1 });
        try {
          const table = await pool.query("SELECT to_regclass('public.messages') AS tbl");
          expect(table.rows[0].tbl).toBe('messages');
        } finally {
          await pool.end();
        }
      }, 30_000);
    });

    // ------------------------------------------------------------------
    // Extension helpers — SKIP-gated in this lane (plain postgres:16 ships
    // neither extension). The specs are real: swap in an extension-enabled
    // image and flip the env to run them.
    //
    // KNOWN FINDING (2026-07-12, this lane's first opportunistic run against
    // timescale/timescaledb latest-pg15-oss = TimescaleDB 2.24.0): the
    // `hypertable()` emitter targets the LEGACY
    // `create_hypertable(regclass, name, ...)` interface, which TimescaleDB
    // 2.24 removed in favor of the dimension-based
    // `create_hypertable(regclass, by_range(...))` form — the spec below
    // fails there with "function create_hypertable(unknown, unknown, ...)
    // does not exist". Flipping this gate on in CI requires either pinning a
    // pre-2.24 image or updating the emitter (an SDK output change — its own
    // follow-up, not this lane's).
    // ------------------------------------------------------------------

    describe.skipIf(process.env.KNEXT_DB_LIVE_TIMESCALE !== '1')(
      'timescaledb hypertable() (SKIPPED: plain postgres:16 lacks the extension — run a timescale/timescaledb image and set KNEXT_DB_LIVE_TIMESCALE=1)',
      () => {
        it('enables the extension and converts a table into a hypertable', async () => {
          const tsDsn = dsnFor(BASE_DSN, await freshDb('ts'));
          const pool = new Pool({ connectionString: tsDsn, max: 1 });
          try {
            await pool.query(createTimescaleExtension());
            await pool.query(
              'CREATE TABLE metrics (ts timestamptz NOT NULL, device text NOT NULL, value double precision NOT NULL)',
            );
            await pool.query(hypertable('metrics', { by: 'ts', chunkInterval: '7 days' }));
            // Idempotent by default (if_not_exists => TRUE):
            await pool.query(hypertable('metrics', { by: 'ts', chunkInterval: '7 days' }));

            const hyper = await pool.query(
              "SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'metrics'",
            );
            expect(hyper.rows).toHaveLength(1);

            await pool.query("INSERT INTO metrics VALUES (now(), 'dev-1', 42.0)");
            const rows = await pool.query("SELECT value FROM metrics WHERE device = 'dev-1'");
            expect(rows.rows).toEqual([{ value: 42 }]);
          } finally {
            await pool.end();
          }
        }, 60_000);
      },
    );

    // pgvector live enablement is GATED on scale-zero-pg#178 (ADR-0021 open
    // decision 4) — it stays skipped in this lane even with an image override.
    // The spec body is real so flipping the gate later needs no rewrite.
    describe.skip('pgvector hnsw() (SKIPPED: gated on scale-zero-pg#178 per ADR-0021 decision 4; plain postgres:16 lacks the vector extension)', () => {
      it('enables the extension and builds an hnsw index over a vector column', async () => {
        const vecDsn = dsnFor(BASE_DSN, await freshDb('vec'));
        const pool = new Pool({ connectionString: vecDsn, max: 1 });
        try {
          await pool.query(createVectorExtension());
          await pool.query('CREATE TABLE docs (id serial PRIMARY KEY, embedding vector(3))');
          await pool.query("INSERT INTO docs (embedding) VALUES ('[1,2,3]')");
          await pool.query(hnsw('docs_embedding_idx', vectorDocs.embedding, { m: 16 }));
          const idx = await pool.query(
            "SELECT indexname FROM pg_indexes WHERE indexname = 'docs_embedding_idx'",
          );
          expect(idx.rows).toHaveLength(1);
        } finally {
          await pool.end();
        }
      }, 60_000);
    });
  },
);

describe('kn-next db migrate — missing-DSN failure mode (hermetic, always runs)', () => {
  it('fails loud with the writer-only guidance when neither DATABASE_URL nor --url is set', async () => {
    const saved = { url: process.env.DATABASE_URL, ro: process.env.DATABASE_URL_RO };
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_RO;
    try {
      // Default runner (the real engine): resolveWriterDsn throws BEFORE any
      // connection is attempted, so this is hermetic.
      await expect(runDbMigrate([], undefined, () => {})).rejects.toThrow(
        /DATABASE_URL \(the writer DSN\) is required/,
      );
    } finally {
      if (saved.url === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = saved.url;
      }
      if (saved.ro === undefined) {
        delete process.env.DATABASE_URL_RO;
      } else {
        process.env.DATABASE_URL_RO = saved.ro;
      }
    }
  });
});
