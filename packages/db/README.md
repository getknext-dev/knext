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
> TimescaleDB + pgvector extension helpers on that surface (#240/#241), the
> `drizzle.config.ts` helper (`@knext/db/migrate` → `defineDrizzleConfig`), and the
> one-shot `kn-next db migrate` runner (`@knext/db/migrate` → `runMigrations`).

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
// → SELECT create_hypertable('metrics', by_range('ts', INTERVAL '7 days'),
//     if_not_exists => TRUE);

// Retention — a ONE-SHOT drop, run by your migration/CI on a schedule you own:
dropChunks(metrics, { olderThan: '30 days' });
// → SELECT drop_chunks('metrics', INTERVAL '30 days');
```

> **Minimum TimescaleDB version: 2.13.** `hypertable()` emits the modern
> dimension-builder form (`create_hypertable(<table>, by_range('<col>'[, INTERVAL]))`),
> introduced in TimescaleDB 2.13 and the **only** interface on 2.24+ — the legacy
> `create_hypertable(regclass, name, ...)` signature was removed there. There is no
> legacy emitter for pre-2.13 servers.

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

Generate and commit SQL at dev time:

```bash
npx drizzle-kit generate   # diff schema → ./drizzle/*.sql (commit these)
```

`defineDrizzleConfig()` never uses `DATABASE_URL_RO` — migrations always run once,
against the single writer (ADR-0021 §3). `drizzle-kit generate` needs no live
database (an unset `DATABASE_URL` yields an empty DSN and still generates SQL).

## Migrations — `kn-next db migrate` (the one-shot runner)

Apply the committed migrations with **`kn-next db migrate`** — a one-shot runner
that connects on the **writer** `DATABASE_URL`, applies pending migrations, and
exits. It is the k8s-idiomatic answer to *"who migrates a single-writer,
scale-to-zero database?"*:

```bash
kn-next db migrate            # apply ./drizzle against the writer DATABASE_URL
kn-next db migrate --dir ./migrations   # custom migrations directory
kn-next db migrate --url "$WRITER_DSN"  # explicit writer DSN override
```

- **Writer-only.** It resolves `DATABASE_URL` (the operator injects it) and
  **refuses** a read-replica DSN — an exact `DATABASE_URL_RO`, or any DSN on the
  RO gateway port `55434`. Single-writer forbids writes on the replica (ADR-0021
  §3).
- **Once per deploy, out of the request path.** Run it as a CI step or a
  pre-deploy k8s Job — **not** on every pod boot (that races N migrators and
  penalises cold start) and **not** by the operator (migrating app *data* is not
  a cluster-resource mutation; the operator owns ksvc/Secrets, not your schema).
- **Idempotent + fail loud.** drizzle records applied migrations in
  `__drizzle_migrations`, so a re-run is a no-op. A migration error exits
  **non-zero** so a Job fails loudly instead of a half-applied schema going live.
- **Wakes the writer once.** Connecting wakes a scale-to-zero compute — a
  deliberate one-shot. The runner uses a cold-wake-tolerant connect timeout
  (15s ≥ the ~2.5s wake, per ADR-0019).

Programmatic use (e.g. a custom script) is available too:

```ts
import { runMigrations } from '@knext/db/migrate';
await runMigrations({ migrationsFolder: './drizzle' }); // writer DATABASE_URL; throws on failure
```

### Running migrations for a NextApp (the flow)

A NextApp's database is provisioned by an `AppDatabase` (managed mode) or bound
to a BYO Secret; either way the app gets a writer `DATABASE_URL`. Migrations then
run against it **after** the database is `Ready` and **before** app pods serve:

```
AppDatabase provisions branch (template schema, ~4s) ──▶ Ready
                                                            │
        kn-next db migrate (CI / Job, writer, once) ◀───────┘
                                                            │
        app pods boot; getDb()/getDbRO() serve traffic ◀────┘
```

### Job recipe — migrate once per deploy

Run the migration as a one-shot Kubernetes `Job` against the same image and
`DATABASE_URL` Secret your NextApp uses. `restartPolicy: Never` +
`backoffLimit: 2` mean a failed migration fails the Job loudly; the `Job`
connecting wakes the scale-to-zero writer a single time.

```yaml
# migrate-job.yaml — apply once per deploy (e.g. `kubectl apply -f` in CI,
# gated on the AppDatabase being Ready). Not a live-applied platform manifest.
apiVersion: batch/v1
kind: Job
metadata:
  name: shop-migrate
  namespace: my-apps
spec:
  backoffLimit: 2 # fail loud after a few retries — never ship a half-applied schema
  ttlSecondsAfterFinished: 300 # reap the finished Job automatically
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example/shop:<same-digest-as-the-deploy>
          command: ['kn-next', 'db', 'migrate']
          env:
            # The writer DSN — the SAME Secret the operator injects into the app.
            # Writer only: never wire DATABASE_URL_RO here (the runner refuses it).
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: shop-db # the AppDatabase-provisioned (or BYO) Secret
                  key: DATABASE_URL
```

Sequence it after the database is `Ready`:

```bash
kubectl wait --for=condition=Ready appdatabase/shop -n my-apps --timeout=120s
kubectl apply -f migrate-job.yaml -n my-apps
kubectl wait --for=condition=Complete job/shop-migrate -n my-apps --timeout=300s
```

`kubectl wait --for=condition=Complete` returns non-zero if the Job fails — wire
it into your deploy pipeline so a failed migration blocks the rollout.

## Pooling

Both pools live in `@knext/lib` and inherit the scale-to-zero contract (ADR-0019):
small `max`, idle timeout **< the gateway's 60s idle** (no dead sockets), connect
timeout **≥ 10s** (tolerates the ~2.5s cold wake). Tune the writer with
`DB_POOL_*` and the reader with `DB_POOL_RO_*`.

## Development — the live-Postgres integration lane

The SDK's product claims (migrations apply + are idempotent, writer
read-your-writes, RO fallback/routing, the `kn-next db migrate` runner) are
verified against a real Postgres by
`packages/db/src/__tests__/integration/live-postgres.test.ts`. The suite is
**env-gated** — the default `pnpm test` run stays hermetic and skips it — and
runs in CI against a `postgres:16` service container (`db-live-integration`).

Run it locally against a throwaway Docker Postgres:

```bash
# start a throwaway postgres:16 (auto-removed on stop)
docker run --rm -d --name knext-db-live \
  -e POSTGRES_USER=knext -e POSTGRES_PASSWORD=knext -e POSTGRES_DB=knext \
  -p 55432:5432 postgres:16

# run the live lane (both env vars are required; otherwise it skips cleanly)
KNEXT_DB_LIVE=1 DATABASE_URL=postgres://knext:knext@127.0.0.1:55432/knext \
  pnpm exec vitest run packages/db/src/__tests__/integration/live-postgres.test.ts

# teardown
docker rm -f knext-db-live
```

Safety: before opening any connection the suite **refuses** a `DATABASE_URL`
whose host is not loopback (`localhost` / `127.0.0.0/8` / `::1`) or the CI
service hostname `postgres` — it creates, writes to, and drops databases, so a
typo'd real DSN must never receive test traffic. To deliberately target another
throwaway host, set `KNEXT_DB_LIVE_UNSAFE_HOST=1`. **Caveat: loopback ≠
throwaway** — a real primary reached through a port-forward or SSH tunnel
(`kubectl port-forward` → `127.0.0.1:<port>`) passes the DSN guard, and the
suite will create, write to, and DROP databases on it. Never point the lane at
a forwarded production database.

Notes:

- The RO specs point `DATABASE_URL_RO` at the **same** container via a second
  DSN — they prove pool **routing**, not scale-zero-pg's bounded-staleness
  semantics (vanilla PG cannot reproduce those).
- The TimescaleDB `hypertable()` spec is skip-gated (plain `postgres:16` lacks
  the extension): run a `timescale/timescaledb:latest-pg16` container instead
  and set `KNEXT_DB_LIVE_TIMESCALE=1`. The pgvector spec stays skipped pending
  the scale-zero-pg image gate (ADR-0021, open decision 4).

## Documentation

Full guides and configuration reference: <https://knext.dev>

## License

[Apache-2.0](./LICENSE)
