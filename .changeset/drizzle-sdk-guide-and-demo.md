---
"@knext/db": patch
---

docs(db): drizzle-sdk user guide + runnable `apps/db-demo` example; finalize PUBLIC_API (ADR-0021 §Consequences, #235)

The capstone of the Drizzle data SDK. No runtime change to `@knext/db` — this
completes the documentation + example surface promised by ADR-0021.

- **`docs/guides/drizzle-sdk.md`** — the end-to-end user guide: install, define
  schema (`@knext/db/schema`), generate + apply migrations with `kn-next db migrate`
  (writer-only, one-shot Job recipe sequenced after the database is `Ready`), typed
  App Router queries + mutations, the `getDb` vs `getDbRO` staleness contract
  (read-your-writes on the writer; bounded-stale ~9s on the RO gateway; falls back to
  the writer + warns when `DATABASE_URL_RO` is unset — never auto-splits), TimescaleDB
  + pgvector (self-enable over the app's own `DATABASE_URL`, the Apache-2 bound and the
  scale-zero-pg ≥ v1.4.0 gate), and the pooling/wake contract (pool idle < 60s
  `GW_IDLE_MS`, connect ≥ 10s for cold wake).
- **`apps/db-demo`** — a new minimal runnable example proving the SDK end-to-end:
  one `messages` table, a generated migration, a bounded-stale RO read and a
  single-writer server action, wired to `@knext/db`. Additive (no existing app was
  changed); typechecks and `next build`s clean; a unit test asserts the drizzle config,
  the schema table, and the data-access + client modules.
- **`packages/db/docs/PUBLIC_API.md`** — finalized to match the shipped exports across
  `.`, `./schema` (incl. the TimescaleDB/pgvector helpers + option types), and
  `./migrate` (incl. the injectable `RunMigrationsDeps` test seam).
