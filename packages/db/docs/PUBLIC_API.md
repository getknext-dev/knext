# @knext/db — Public API

`@knext/db` follows semver. Only the subpaths listed below are public; anything
not listed is internal and may change without a major bump.

## Stable subpaths

| Subpath | Status | Exports |
|---|---|---|
| `@knext/db` (`.`) | **public** | `getDb`, `getDbRO`, and the re-exported drizzle-orm query surface (`eq`, `and`, `or`, `sql`, the query builder, …). |
| `@knext/db/schema` | **public** | drizzle `pg-core` primitives (`pgTable`, column + index + constraint builders) plus `relations`/`sql`, re-exported from one place. |
| `@knext/db/migrate` | **public** | `defineDrizzleConfig()` + `DEFAULT_SCHEMA_PATH` / `DEFAULT_MIGRATIONS_DIR`. |

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
- The TimescaleDB (#240) and pgvector (#241) extension helpers slot in **on top of**
  this surface without changing it; that seam is documented in `src/schema.ts`.

### `@knext/db/migrate`

- **`defineDrizzleConfig(options?): Config`** — builds a valid `drizzle.config.ts`
  for a NextApp: dialect `postgresql`, the **writer** DSN (`process.env.DATABASE_URL`
  or an explicit `url`; never the RO replica), and the knext path conventions.
  `options`: `{ schema?, out?, url? }`.
- **`DEFAULT_SCHEMA_PATH`** (`./src/db/schema.ts`) and **`DEFAULT_MIGRATIONS_DIR`**
  (`./drizzle`) — the conventional defaults.
- The `kn-next db migrate` one-shot runner lands on this same subpath in #242.
- `drizzle-kit` is a **type-only** dependency (an optional peer) — `defineDrizzleConfig()`
  returns a plain object typed as its `Config`; no drizzle-kit code is imported at
  runtime.

## Stability policy

- The `.`, `./schema`, and `./migrate` subpaths are covered by semver; breaking
  changes to `getDb`/`getDbRO`/`defineDrizzleConfig` signatures, the fallback
  behaviour, or the path defaults require a major bump.
- The re-exported drizzle surface (root query operators + `./schema` builders)
  tracks the pinned `drizzle-orm` range; a drizzle major bump that changes those
  exports is a `@knext/db` major bump.
