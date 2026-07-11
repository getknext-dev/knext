# @knext/db

The typed **data SDK** for [knext](https://knext.dev) apps — a thin
[drizzle-orm](https://orm.drizzle.team) wrapper over the scale-to-zero Postgres
pools that the operator binds into your app (`DATABASE_URL` / `DATABASE_URL_RO`).

`@knext/db` re-exports drizzle's query surface and adds only the knext-specific
ergonomics the platform needs. It provisions nothing and mutates no cluster
resource — it is an **app-side client library** (ADR-0021). Apps keep drizzle's
own docs and lose no power.

> **This package is the core** — the two client accessors below (`getDb` /
> `getDbRO`) and the re-exported drizzle query operators. Schema primitives +
> extension helpers (`@knext/db/schema`), the TimescaleDB/pgvector helpers, and
> the `kn-next db migrate` runner (`@knext/db/migrate`) land in follow-up work.

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
directly. The knext value-add is client selection (above), plus the schema,
extension, and migration helpers arriving in follow-up releases.

## Pooling

Both pools live in `@knext/lib` and inherit the scale-to-zero contract (ADR-0019):
small `max`, idle timeout **< the gateway's 60s idle** (no dead sockets), connect
timeout **≥ 10s** (tolerates the ~2.5s cold wake). Tune the writer with
`DB_POOL_*` and the reader with `DB_POOL_RO_*`.

## Documentation

Full guides and configuration reference: <https://knext.dev>

## License

[Apache-2.0](./LICENSE)
