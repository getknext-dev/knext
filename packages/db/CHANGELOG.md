# @knext/db

## 0.2.1

### Patch Changes

- 2c156a7: Settle the drizzle dependency/peer shape before the first npmjs publish (ADR-0021
  amendment, supersedes Open decision 6). `drizzle-orm` is now a hard `dependency`
  only — the contradictory optional-peer duplicate is dropped (a dep cannot be both).
  `drizzle-kit` remains the sole **optional** peer, consulted lazily only inside
  `defineDrizzleConfig()`, which now throws an actionable named-peer error ("install
  it as a devDependency") instead of a bare `ERR_MODULE_NOT_FOUND` when it is absent.
  The `@knext/db` main entry and the `kn-next db migrate` runner import cleanly
  without drizzle-kit installed. The re-exported drizzle-orm range is documented as
  part of `@knext/db`'s semver contract. Runtime-neutral.

## 0.2.0

### Minor Changes

- 9810a00: feat(db): core `@knext/db` data SDK — `getDb` + `getDbRO` (ADR-0021)

  Introduces `@knext/db`, a thin drizzle-orm wrapper over the existing scale-to-zero
  Postgres pools. The core ships two explicit, never-auto-routed client accessors —
  `getDb()` (writer, `DATABASE_URL`, read-your-writes) and `getDbRO()` (reader,
  `DATABASE_URL_RO`, bounded-staleness ~9s, falls back to the writer with a one-time
  warning when unset) — plus the re-exported drizzle query surface (`eq`/`and`/`sql`/…).

  `@knext/lib` gains a symmetric read-only pool (`getDbPoolRO` / `closeDbPoolRO`) over
  `DATABASE_URL_RO`, mirroring the writer pool's ADR-0019 contract and tunable via
  `DB_POOL_RO_*`. Schema primitives, extension helpers, and the migrate runner land in
  follow-up work (#239–#242).

- dd20ad2: feat(db): TimescaleDB + pgvector helpers on the schema seam (ADR-0021 §2; closes #240, #241)

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

- e6288df: feat(db): `kn-next db migrate` one-shot migration runner + Job recipe (ADR-0021 §3)

  Completes the `@knext/db/migrate` surface with the writer-only migration runner.

  - **`@knext/db/migrate` → `runMigrations(options?, deps?)`** applies
    drizzle-kit-generated migrations against the **writer** (`DATABASE_URL`) via
    drizzle-orm's node-postgres migrator, then exits. It resolves + guards the DSN
    (`resolveWriterDsn`): it **refuses** a read-replica DSN — an exact
    `DATABASE_URL_RO`, or any DSN on the RO gateway port `55434` — because
    single-writer forbids writes on the replica. Idempotent (drizzle tracks applied
    migrations) and **fail loud** (rejects on error; the connection is always
    closed). `pg` is now a runtime dependency of `@knext/db`.
  - **`kn-next db migrate`** wraps it as a CLI subcommand — run it once per deploy
    (a CI step or a pre-deploy k8s Job), out of the request path, never on pod boot
    and never operator-run. A failure exits non-zero so a Job fails loudly.
  - **Docs:** the `@knext/db` README gains a migrations section, the "running
    migrations for a NextApp" flow, and a one-shot **Job recipe** (writer-only,
    `restartPolicy: Never`, sequenced after the `AppDatabase` is `Ready`).

- 49a48e4: feat(db): schema surface + drizzle-kit config helper (ADR-0021 §2/§5)

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

### Patch Changes

- 82ddbef: docs(db): drizzle-sdk user guide + runnable `apps/db-demo` example; finalize PUBLIC_API (ADR-0021 §Consequences, #235)

  The capstone of the Drizzle data SDK. No runtime change to `@knext/db` — this
  completes the documentation + example surface promised by ADR-0021.

  - **`docs/guides/drizzle-sdk.md`** — the end-to-end user guide: install, define
    schema (`@knext/db/schema`), generate + apply migrations with `kn-next db migrate`
    (writer-only, one-shot Job recipe sequenced after the database is `Ready`), typed
    App Router queries + mutations, the `getDb` vs `getDbRO` staleness contract
    (read-your-writes on the writer; bounded-stale ~9s on the RO gateway; falls back to
    the writer + warns when `DATABASE_URL_RO` is unset — never auto-splits), TimescaleDB
    - pgvector (self-enable over the app's own `DATABASE_URL`, the Apache-2 bound and the
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

- Re-release the full three-package set: `@knext/db` joins the published packages
  (`@knext/core` depends on it for `kn-next db migrate`), so all three bump
  together and ship as a set — publishing core without db breaks every consumer
  install with a 404 on the missing member.
- Updated dependencies [9810a00]
- Updated dependencies
  - @knext/lib@0.2.0
