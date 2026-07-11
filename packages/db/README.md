# @knext/db

The typed **data SDK** for [knext](https://knext.dev) apps — a thin
[drizzle-orm](https://orm.drizzle.team) wrapper over the scale-to-zero Postgres
pools that the operator binds into your app (`DATABASE_URL` / `DATABASE_URL_RO`).

`@knext/db` re-exports drizzle's query surface and adds only the knext-specific
ergonomics the platform needs. It provisions nothing and mutates no cluster
resource — it is an **app-side client library** (ADR-0021). Apps keep drizzle's
own docs and lose no power.

> **Shipped:** the client accessors below (`getDb` / `getDbRO`) + the re-exported
> drizzle query operators (`.`), the schema surface (`@knext/db/schema`), and the
> `drizzle.config.ts` helper (`@knext/db/migrate` → `defineDrizzleConfig`). The
> TimescaleDB/pgvector extension helpers (#240/#241) and the `kn-next db migrate`
> runner (#242) land in follow-up work.

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
platform's TimescaleDB (#240) and pgvector (#241) helpers will slot in **on top
of** this surface without changing it.

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
