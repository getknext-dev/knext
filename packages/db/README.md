# @knext/db

The typed **data SDK** for [knext](https://knext.dev) apps — a thin
[drizzle-orm](https://orm.drizzle.team) wrapper over the scale-to-zero Postgres
pools that the operator binds into your app (`DATABASE_URL` / `DATABASE_URL_RO`).

`@knext/db` re-exports drizzle's query surface and adds only the knext-specific
ergonomics the platform needs. It provisions nothing and mutates no cluster
resource — it is an **app-side client library** (ADR-0021). Apps keep drizzle's
own docs and lose no power.

> **Shipped:** the client accessors below (`getDb` / `getDbRO`) + the re-exported
> drizzle query operators (`.`), the schema surface (`@knext/db/schema`), the
> TimescaleDB + pgvector extension helpers on that surface (#240/#241), and the
> `drizzle.config.ts` helper (`@knext/db/migrate` → `defineDrizzleConfig`). The
> `kn-next db migrate` runner (#242) lands in follow-up work.

## Install

```bash
npm i @knext/db
```

## Clients — writer / reader are explicit, never auto-routed

```ts
import { getDb, getDbRO, eq } from '@knext/db';
import { orders } from '@/db/schema';

const db = getDb(); // writer  — DATABASE_URL     (read-your-writes, single-writer)
const dbRO = getDbRO(); // reader — DATABASE_URL_RO  (bounded-stale ~9s, NO read-your-writes)

// write → writer, visible to your next getDb() read
await getDb({ orders }).insert(orders).values({ userId, total }).returning();

// staleness-tolerant read → reader
const rows = await getDbRO({ orders }).select().from(orders).where(eq(orders.userId, uid));
```

- **`getDb(schema?)`** wraps `@knext/lib`'s writer pool (`getDbPool()`,
  `DATABASE_URL`). Use it for every write and any read that must see its own
  write. One client per pod; the pool drains on SIGTERM via `closeDbPool()`.
- **`getDbRO(schema?)`** wraps the read-only pool (`getDbPoolRO()`,
  `DATABASE_URL_RO` — the scale-zero-pg RO gateway). Use it for
  dashboard/analytics/fan-out reads that tolerate ≤ ~9s of staleness.

**Nothing is auto-routed.** You pick `getDb()` vs `getDbRO()` per query — mirroring
scale-zero-pg's "you decide which queries are reads" contract. When
`DATABASE_URL_RO` is unset there is no read replica, so **`getDbRO()` falls back to
the writer with a one-time warning** — an app without a RO pool still works, it
just reads from the primary.

Rule of thumb:

- write, or read-your-own-write → **`getDb()`**
- read that tolerates ≤ ~9s staleness → **`getDbRO()`**

## Query surface

`@knext/db` re-exports drizzle-orm's operators and query builder (`eq`, `and`,
`or`, `sql`, …) — there is **no bespoke DSL**, so drizzle's documentation applies
directly. The knext value-add is client selection (above), plus the schema and
migration-config helpers below.

## Schema — define your tables in one place

Import the table + column builders from `@knext/db/schema` and define your schema
in `src/db/schema.ts` (the knext convention). It is a thin re-export of drizzle's
`pg-core` (plus `relations`/`sql`) — no bespoke DSL, so [drizzle's schema
docs](https://orm.drizzle.team/docs/sql-schema-declaration) apply directly.

```ts
// src/db/schema.ts
import { pgTable, serial, text, timestamp, doublePrecision } from '@knext/db/schema';

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  total: doublePrecision('total').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Typed rows for free:
export type Order = typeof orders.$inferSelect; // row shape
export type NewOrder = typeof orders.$inferInsert; // insert shape
```

`@knext/db/schema` re-exports `pgTable`, the column builders (`serial`/`text`/
`integer`/`timestamp`/`jsonb`/`uuid`/`vector`/…), `index`/`uniqueIndex`,
`primaryKey`/`foreignKey`, `pgEnum`/`pgSchema`, and `relations`/`sql`. The
platform's TimescaleDB and pgvector helpers (below) slot in **on top of** this
surface without changing it.

## Extensions — TimescaleDB & pgvector

The scale-to-zero Postgres ships two extensions in its compute image, both **opt-in
and self-service**: your app enables the one it needs **itself**, once, over its own
`DATABASE_URL` — no operator, no superuser. Both are `trusted`, so a single
`CREATE EXTENSION IF NOT EXISTS …` is all it takes, and their data + indexes live on
the pageserver, so **they survive scale-to-zero** (see scale-zero-pg
[`docs/connecting.md`](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/connecting.md)).

`@knext/db/schema` adds the ergonomics drizzle-kit can't model — the helpers below
are **migration SQL emitters**: put their output in the migration that creates the
table. `createTimescaleExtension()` / `createVectorExtension()` return the enable
statement; run it at the top of that migration.

### TimescaleDB (time-series) — #240

```ts
import {
  pgTable, timestamp, text, doublePrecision,
  hypertable, dropChunks, createTimescaleExtension,
} from '@knext/db/schema';

export const metrics = pgTable('metrics', {
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  device: text('device').notNull(),
  value: doublePrecision('value').notNull(),
});

// Emit these into your migration (drizzle-kit won't generate them):
createTimescaleExtension();
// → CREATE EXTENSION IF NOT EXISTS timescaledb;
hypertable(metrics, { by: 'ts', chunkInterval: '7 days' });
// → SELECT create_hypertable('metrics', 'ts',
//     chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);

// Retention — a ONE-SHOT drop, run by your migration/CI on a schedule you own:
dropChunks(metrics, { olderThan: '30 days' });
// → SELECT drop_chunks('metrics', INTERVAL '30 days');
```

> **Honest bound (Apache-2 tier only).** You get hypertables, `time_bucket()`, chunk
> pruning, and one-shot `drop_chunks()` retention. Columnar **compression** and
> **continuous aggregates** are **not** available here, and retention is
> `dropChunks()` rather than `add_retention_policy()` — both of those rely on
> *background policy jobs*, which cannot run on a compute that scales to zero
> (scale-zero-pg `adr-0001`). Run `dropChunks()` from a CI cron / a `kn-next` job.

### pgvector (embeddings / semantic search) — #241

```ts
import {
  pgTable, serial, text, vector,
  hnsw, ivfflat, createVectorExtension,
} from '@knext/db/schema';

export const docs = pgTable('docs', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
});

// Emit into your migration:
createVectorExtension();
// → CREATE EXTENSION IF NOT EXISTS vector;
hnsw('docs_embedding_idx', docs.embedding, { m: 16, efConstruction: 64 });
// → CREATE INDEX IF NOT EXISTS "docs_embedding_idx" ON "docs"
//     USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

// IVFFlat is the alternative access method (faster build, tune `lists` to row count):
ivfflat('docs_embedding_ivf', docs.embedding, { ops: 'vector_l2_ops', lists: 100 });
```

Query with the distance operators (re-exported from drizzle). **Match the operator
to the index's ops class**: `cosineDistance` (`<=>`) ⇄ `vector_cosine_ops`,
`l2Distance` (`<->`) ⇄ `vector_l2_ops`, `innerProduct` (`<#>`) ⇄ `vector_ip_ops`.

```ts
import { getDbRO, cosineDistance } from '@knext/db';
import { docs } from '@/db/schema';

const nearest = await getDbRO({ docs })
  .select()
  .from(docs)
  .orderBy(cosineDistance(docs.embedding, queryEmbedding))
  .limit(5);
```

Build the index while the compute is awake (index builds run on your own per-app
compute); it persists across scale-to-zero like any other table. pgvector 0.8.0 —
requires scale-zero-pg ≥ v1.4.0.

## Migrations — the `drizzle.config.ts` helper

`@knext/db/migrate` ships `defineDrizzleConfig()` — it produces a valid
[drizzle-kit](https://orm.drizzle.team/docs/drizzle-config-file) config wired to
the **writer** `DATABASE_URL` (migrations are writer-only). Install `drizzle-kit`
as a dev dependency, then:

```ts
// drizzle.config.ts (app root)
import { defineDrizzleConfig } from '@knext/db/migrate';

// dialect: 'postgresql', schema: './src/db/schema.ts', out: './drizzle',
// dbCredentials.url: process.env.DATABASE_URL (the writer, injected by the operator).
export default defineDrizzleConfig();
```

Override the defaults, or pass an explicit writer DSN, when you need to:

```ts
export default defineDrizzleConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  url: process.env.DATABASE_URL, // explicit; composes with a provisioned credential
});
```

Then generate and commit SQL at dev time, and apply per deploy:

```bash
npx drizzle-kit generate   # diff schema → ./drizzle/*.sql (commit these)
npx drizzle-kit migrate    # apply against the writer DATABASE_URL
```

`defineDrizzleConfig()` never uses `DATABASE_URL_RO` — migrations always run once,
against the single writer (ADR-0021 §3). `drizzle-kit generate` needs no live
database (an unset `DATABASE_URL` yields an empty DSN and still generates SQL);
`migrate`/`push` require the writer DSN. The forthcoming `kn-next db migrate`
runner (#242) wraps `migrate` as a one-shot per-deploy step.

## Pooling

Both pools live in `@knext/lib` and inherit the scale-to-zero contract (ADR-0019):
small `max`, idle timeout **< the gateway's 60s idle** (no dead sockets), connect
timeout **≥ 10s** (tolerates the ~2.5s cold wake). Tune the writer with
`DB_POOL_*` and the reader with `DB_POOL_RO_*`.

## Documentation

Full guides and configuration reference: <https://knext.dev>

## License

[Apache-2.0](./LICENSE)
