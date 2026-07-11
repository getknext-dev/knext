# @knext/db — Public API

`@knext/db` follows semver. Only the subpaths listed below are public; anything
not listed is internal and may change without a major bump.

## Stable subpaths

| Subpath | Status | Exports |
|---|---|---|
| `@knext/db` (`.`) | **public** | `getDb`, `getDbRO`, and the re-exported drizzle-orm query surface (`eq`, `and`, `or`, `sql`, the query builder, …). |
| `@knext/db/schema` | **public** | drizzle `pg-core` primitives (`pgTable`, column + index + constraint builders) plus `relations`/`sql`, re-exported from one place, **and** the TimescaleDB + pgvector extension helpers (`hypertable`/`dropChunks`/`createTimescaleExtension`, `hnsw`/`ivfflat`/`createVectorExtension`, `cosineDistance`/`l2Distance`/`innerProduct`). |
| `@knext/db/migrate` | **public** | `defineDrizzleConfig()`, the one-shot writer-only runner `runMigrations()` / `resolveWriterDsn()`, `RO_GATEWAY_PORT`, and `DEFAULT_SCHEMA_PATH` / `DEFAULT_MIGRATIONS_DIR`. |

### `@knext/db` (`.`)

- **`getDb<TSchema>(schema?): NodePgDatabase<TSchema>`** — drizzle client over the
  `@knext/lib` **writer** pool (`DATABASE_URL`). Read-your-writes, single-writer.
  Lazy singleton per pod; the pool drains on SIGTERM via `@knext/lib`'s
  `closeDbPool()`.
- **`getDbRO<TSchema>(schema?): NodePgDatabase<TSchema>`** — drizzle client over the
  **read-only** pool (`DATABASE_URL_RO`, bounded-staleness ~9s, no read-your-writes).
  Lazy singleton per pod. When `DATABASE_URL_RO` is unset it **falls back to the
  writer** and emits a one-time warning.
- **drizzle-orm re-exports** — the package root re-exports drizzle-orm's operators
  and query builder (`export * from 'drizzle-orm'`). drizzle-orm's own semver +
  docs govern these; `@knext/db` pins a compatible range and also declares it an
  (optional) peer so an app may supply its own compatible drizzle.

### `@knext/db/schema`

- The one place an app imports its table/column vocabulary from — a thin re-export
  of drizzle-orm's `pg-core` (`pgTable`, the column builders incl. `vector`,
  `index`/`uniqueIndex`, `primaryKey`/`foreignKey`, `pgEnum`/`pgSchema`, …) plus
  `relations` and `sql` from the drizzle-orm root. No bespoke DSL — drizzle's docs
  apply directly.
- **Extension helpers** slot in **on top of** this surface without changing it —
  they are migration **SQL emitters** (strings), since drizzle-kit does not model
  these. All are exported from `@knext/db/schema` (and the distance operators from
  the package root too):
  - **TimescaleDB (#240)** — `hypertable(table, { by, chunkInterval?, ifNotExists?,
    migrateData? }): string` (emits `create_hypertable`), `dropChunks(table, {
    olderThan }): string` (emits a **one-shot** `drop_chunks()` — not a background
    policy), and `createTimescaleExtension(): string` / `CREATE_TIMESCALEDB_EXTENSION`.
    Apache-2 tier only: no columnar compression / continuous aggregates on
    scale-to-zero (scale-zero-pg `adr-0001`).
  - **pgvector (#241)** — `hnsw(name, column, { ops?, m?, efConstruction?,
    ifNotExists?, concurrently? }): string` and `ivfflat(name, column, { ops?, lists?,
    … }): string` (emit `CREATE INDEX … USING …`), `createVectorExtension(): string` /
    `CREATE_VECTOR_EXTENSION`, the `VectorOpClass` type, and the distance-operator
    query builders re-exported from drizzle: `cosineDistance` (`<=>`), `l2Distance`
    (`<->`), `innerProduct` (`<#>`). Requires scale-zero-pg ≥ v1.4.0.

### `@knext/db/migrate`

- **`defineDrizzleConfig(options?): Config`** — builds a valid `drizzle.config.ts`
  for a NextApp: dialect `postgresql`, the **writer** DSN (`process.env.DATABASE_URL`
  or an explicit `url`; never the RO replica), and the knext path conventions.
  `options`: `{ schema?, out?, url? }`.
- **`DEFAULT_SCHEMA_PATH`** (`./src/db/schema.ts`) and **`DEFAULT_MIGRATIONS_DIR`**
  (`./drizzle`) — the conventional defaults.
- **`runMigrations(options?, deps?): Promise<{ migrationsFolder }>`** — the one-shot,
  **writer-only** migration runner behind `kn-next db migrate` (ADR-0021 §3). Resolves
  + guards the writer DSN (see below), applies drizzle-kit-generated migrations via
  drizzle-orm's migrator, always closes the connection, and **rejects on failure**
  (fail loud). Idempotent (drizzle tracks applied migrations). `deps` injects the
  pg/drizzle boundary for tests. `options`: `{ url?, migrationsFolder?, roUrl? }`.
- **`resolveWriterDsn(options?): string`** — resolves `url ?? DATABASE_URL` and
  **refuses** a read-replica DSN (an exact `DATABASE_URL_RO`, or one on the RO gateway
  port). Throws (fail loud) when no writer DSN is available.
- **`RO_GATEWAY_PORT`** (`'55434'`) — the scale-zero-pg RO gateway port migrations
  must never target.
- `drizzle-kit` is a **type-only** dependency (an optional peer) — `defineDrizzleConfig()`
  returns a plain object typed as its `Config`; no drizzle-kit code is imported at
  runtime. `runMigrations()` uses drizzle-**orm**'s migrator + `pg` (runtime).

## Stability policy

- The `.`, `./schema`, and `./migrate` subpaths are covered by semver; breaking
  changes to `getDb`/`getDbRO`/`defineDrizzleConfig` signatures, the fallback
  behaviour, or the path defaults require a major bump.
- The re-exported drizzle surface (root query operators + `./schema` builders)
  tracks the pinned `drizzle-orm` range; a drizzle major bump that changes those
  exports is a `@knext/db` major bump.
