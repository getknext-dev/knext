---
"@knext/db": minor
---

feat(db): TimescaleDB + pgvector helpers on the schema seam (ADR-0021 §2; closes #240, #241)

Adds the platform's Postgres-extension ergonomics to `@knext/db/schema`, purely as
new exports on the existing extension seam — the base schema surface is unchanged.
All helpers are **migration SQL emitters** (drizzle-kit cannot model these), so they
are deterministic and unit-tested without a live database.

- **TimescaleDB (#240)** — `hypertable(table, { by, chunkInterval?, ifNotExists?,
  migrateData? })` emits `create_hypertable(...)`; `dropChunks(table, { olderThan })`
  emits a **one-shot** `drop_chunks(...)` for retention (deliberately **not**
  `add_retention_policy()`, whose background job cannot run on a scale-to-zero
  compute); `createTimescaleExtension()` emits the enable statement. Honest bound:
  Apache-2 tier only — **no columnar compression / continuous aggregates** on
  scale-to-zero (scale-zero-pg `adr-0001`).
- **pgvector (#241)** — `hnsw(name, column, { ops?, m?, efConstruction?, … })` and
  `ivfflat(name, column, { ops?, lists?, … })` emit the `CREATE INDEX … USING …` DDL
  with the correct ops class (default `vector_cosine_ops`) + `WITH` build params;
  `createVectorExtension()` emits the enable statement; the distance-operator query
  builders `cosineDistance` (`<=>`), `l2Distance` (`<->`), `innerProduct` (`<#>`) are
  re-exported from drizzle. Requires scale-zero-pg ≥ v1.4.0 (pgvector 0.8.0).

Both extensions are **opt-in and self-service**: the app runs `CREATE EXTENSION` over
its own `DATABASE_URL` (no operator, no superuser), and both survive scale-to-zero.
