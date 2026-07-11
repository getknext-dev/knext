---
"@knext/db": minor
---

feat(db): schema surface + drizzle-kit config helper (ADR-0021 §2/§5)

Adds two public subpaths to `@knext/db`:

- **`@knext/db/schema`** — the knext schema surface: a thin re-export of drizzle's
  `pg-core` (`pgTable`, the column builders incl. `vector`, `index`/`uniqueIndex`,
  `primaryKey`/`foreignKey`, `pgEnum`/`pgSchema`, …) plus `relations`/`sql`, so an
  app imports its whole table vocabulary from one pinned-compatible place. No
  bespoke DSL; the TimescaleDB (#240) and pgvector (#241) helpers slot in on top of
  this surface without changing it.
- **`@knext/db/migrate`** — `defineDrizzleConfig({ schema?, out?, url? })`, which
  produces a valid `drizzle.config.ts`: dialect `postgresql`, the **writer**
  `DATABASE_URL` DSN (never the RO replica — migrations are writer-only), and the
  knext path conventions (`./src/db/schema.ts`, `./drizzle`). `drizzle-kit` is a
  type-only, optional-peer dependency — no runtime code is pulled from it.
