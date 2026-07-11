# @knext/db — Public API

`@knext/db` follows semver. Only the subpaths listed below are public; anything
not listed is internal and may change without a major bump.

## Stable subpaths

| Subpath | Status | Exports |
|---|---|---|
| `@knext/db` (`.`) | **public** | `getDb`, `getDbRO`, and the re-exported drizzle-orm query surface (`eq`, `and`, `or`, `sql`, the query builder, …). |

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

## Reserved (not yet public)

The following subpaths are declared in ADR-0021 and reserved for follow-up work.
They are **not exported yet** — importing them will fail until the corresponding
PR lands:

| Subpath | Tracking | Will export |
|---|---|---|
| `@knext/db/schema` | #239 (+ #240 TimescaleDB, #241 pgvector) | drizzle `pg-core` primitives re-exported from one place, plus `hypertable`/retention + `vector`/`hnsw` extension helpers. |
| `@knext/db/migrate` | #242 | `defineDrizzleConfig()` + the `kn-next db migrate` one-shot runner (writer-only). |

## Stability policy

- The `.` subpath is covered by semver; breaking changes to `getDb`/`getDbRO`
  signatures or the fallback behaviour require a major bump.
- The re-exported drizzle surface tracks the pinned `drizzle-orm` range; a
  drizzle major bump that changes those exports is a `@knext/db` major bump.
