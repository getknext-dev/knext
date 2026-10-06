# @getknext/db

## 1.3.0-rc.5

### Patch Changes

- @getknext/lib@1.3.0-rc.5

## 1.3.0-rc.4

### Patch Changes

- @getknext/lib@1.3.0-rc.4

## 1.3.0-rc.3

### Patch Changes

- @getknext/lib@1.3.0-rc.3

## 1.3.0-rc.2

### Patch Changes

- @getknext/lib@1.3.0-rc.2

## 1.3.0-rc.1

### Patch Changes

- 1aa6b8f: knext's public docs site moved from `knext.dev` to `knext-platform.dev` (`knext.dev` now resolves to an unrelated Cloudflare 403 page). Updates every user-facing `knext.dev` URL in the CLI — help text (`knext --help`), error-message hints (`knext doctor`, missing-config guidance), scaffolded `knext.config.ts` template comments, the asset-upload multi-cloud hint, and package READMEs (`@getknext/core`, `@getknext/lib`, `@getknext/db`, the `kn-next` alias package) — to `knext-platform.dev`. `@getknext/action`'s README is also updated but carries no changeset entry since that package is `private: true` and never publishes. Kubernetes label keys that happen to share the domain string (e.g. the CRD-adjacent `apps.knext.dev/build-id` label) are unaffected; they are not web links.
- Updated dependencies [1aa6b8f]
  - @getknext/lib@1.3.0-rc.1

## 1.0.0-rc.5

### Patch Changes

- Updated dependencies [65eef13]
  - @getknext/lib@1.0.0-rc.5

## 1.0.0-rc.4

### Patch Changes

- 0a32380: Security: new apps now scaffold with Next.js 16.3.6. The default template moves from 16.3.5, and the vinext builder template from 16.3.3. Next.js 16.2.0 through 16.3.5 have a critical remote code execution vulnerability in `next/og` `ImageResponse` (GHSA-vcvr-r3jv-pc5j), fixed in 16.3.6. If you scaffolded an app from an earlier release candidate, upgrade it with `npm install next@16.3.6` (or a later 16.3.x). The compatibility credential suite now runs against Next.js 16.3.6.
  
  `@getknext/lib` depends on `@grpc/grpc-js` through `@cerbos/grpc` with a range that already admits the patched 1.14.5 (GHSA-m9gg-hp2v-232j), so a fresh install resolves the fix. If your lockfile still holds `@grpc/grpc-js` 1.14.4 or older, update it.
- Updated dependencies [0a32380]
  - @getknext/lib@1.0.0-rc.4

## 1.0.0-rc.3

### Patch Changes

- Release-candidate re-cut with no changes to package code. The compatibility credential test harness now covers the sharp version that Next.js 16.3.5 ships, so the Bun credential runs can execute against this candidate.
- Updated dependencies
  - @getknext/lib@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- 7661878: Rewrite package READMEs for v1.0 release: concise one-paragraph introductions, quickstart commands that work, supported platforms table (Node/Bun × Turbopack/Webpack, with the Next.js versions on the compatibility page), and clear links to docs, compatibility, security, and contributing pages. Remove internal references (ADR numbers, issue/PR numbers) to prepare for npm publication.
- Updated dependencies [7661878]
  - @getknext/lib@1.0.0-rc.2

## 1.0.0-rc.1

### Patch Changes

- @getknext/lib@1.0.0-rc.1

## 0.4.3

### Patch Changes

- @getknext/lib@0.4.3

## 0.4.2

### Patch Changes

- @getknext/lib@0.4.2

## 0.4.1

### Patch Changes

- Republish the @getknext/* group at 0.4.1. The 0.4.0 tarballs shipped unresolvable `workspace:` ranges in their sibling dependencies (EUNSUPPORTEDPROTOCOL on install), so `@latest` was rolled back to 0.3.1. The release lane now rewrites `workspace:` ranges to the concrete published version at publish time and a guard verifies the packed tarballs before publishing (see docs/incidents/2026-09-08-npm-release-workspace-and-partial-publish.md). This patch re-ships the 0.4.0 content — the create verb, the OTel fix, and the rest — as an installable 0.4.1.
- Updated dependencies
  - @getknext/lib@0.4.1

## 0.4.0

### Patch Changes

- @getknext/lib@0.4.0

## 0.3.1

### Patch Changes

- bf03457: Version the three published packages in lockstep.
  
  `@getknext/core` depends on `@getknext/lib` and `@getknext/db`, so the three have always had to
  ship as a set — but that was a documented intention, and the tree had already drifted to three
  different numbers. They are now a Changesets `fixed` group, so every release moves all three to the
  same version, and a guard fails if they diverge or if a fourth publishable package appears.
  
  No API change. From this release on, pinning `@getknext/core@x.y.z` pins the whole set.
- Updated dependencies [bf03457]
  - @getknext/lib@0.3.1

## 0.2.1

### Patch Changes

- 2c156a7: Settle the drizzle dependency/peer shape before the first npmjs publish (ADR-0021
  amendment, supersedes Open decision 6). `drizzle-orm` is now a hard `dependency`
  only — the contradictory optional-peer duplicate is dropped (a dep cannot be both).
  `drizzle-kit` remains the sole **optional** peer, consulted lazily only inside
  `defineDrizzleConfig()`, which now throws an actionable named-peer error ("install
  it as a devDependency") instead of a bare `ERR_MODULE_NOT_FOUND` when it is absent.
  The `@getknext/db` main entry and the `kn-next db migrate` runner import cleanly
  without drizzle-kit installed. The re-exported drizzle-orm range is documented as
  part of `@getknext/db`'s semver contract. Runtime-neutral.

## 0.2.0

### Minor Changes

- 9810a00: feat(db): core `@getknext/db` data SDK — `getDb` + `getDbRO` (ADR-0021)

  Introduces `@getknext/db`, a thin drizzle-orm wrapper over the existing scale-to-zero
  Postgres pools. The core ships two explicit, never-auto-routed client accessors —
  `getDb()` (writer, `DATABASE_URL`, read-your-writes) and `getDbRO()` (reader,
  `DATABASE_URL_RO`, bounded-staleness ~9s, falls back to the writer with a one-time
  warning when unset) — plus the re-exported drizzle query surface (`eq`/`and`/`sql`/…).

  `@getknext/lib` gains a symmetric read-only pool (`getDbPoolRO` / `closeDbPoolRO`) over
  `DATABASE_URL_RO`, mirroring the writer pool's ADR-0019 contract and tunable via
  `DB_POOL_RO_*`. Schema primitives, extension helpers, and the migrate runner land in
  follow-up work (#239–#242).

- dd20ad2: feat(db): TimescaleDB + pgvector helpers on the schema seam (ADR-0021 §2; closes #240, #241)

  Adds the platform's Postgres-extension ergonomics to `@getknext/db/schema`, purely as
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

  Completes the `@getknext/db/migrate` surface with the writer-only migration runner.

  - **`@getknext/db/migrate` → `runMigrations(options?, deps?)`** applies
    drizzle-kit-generated migrations against the **writer** (`DATABASE_URL`) via
    drizzle-orm's node-postgres migrator, then exits. It resolves + guards the DSN
    (`resolveWriterDsn`): it **refuses** a read-replica DSN — an exact
    `DATABASE_URL_RO`, or any DSN on the RO gateway port `55434` — because
    single-writer forbids writes on the replica. Idempotent (drizzle tracks applied
    migrations) and **fail loud** (rejects on error; the connection is always
    closed). `pg` is now a runtime dependency of `@getknext/db`.
  - **`kn-next db migrate`** wraps it as a CLI subcommand — run it once per deploy
    (a CI step or a pre-deploy k8s Job), out of the request path, never on pod boot
    and never operator-run. A failure exits non-zero so a Job fails loudly.
  - **Docs:** the `@getknext/db` README gains a migrations section, the "running
    migrations for a NextApp" flow, and a one-shot **Job recipe** (writer-only,
    `restartPolicy: Never`, sequenced after the `AppDatabase` is `Ready`).

- 49a48e4: feat(db): schema surface + drizzle-kit config helper (ADR-0021 §2/§5)

  Adds two public subpaths to `@getknext/db`:

  - **`@getknext/db/schema`** — the knext schema surface: a thin re-export of drizzle's
    `pg-core` (`pgTable`, the column builders incl. `vector`, `index`/`uniqueIndex`,
    `primaryKey`/`foreignKey`, `pgEnum`/`pgSchema`, …) plus `relations`/`sql`, so an
    app imports its whole table vocabulary from one pinned-compatible place. No
    bespoke DSL; the TimescaleDB (#240) and pgvector (#241) helpers slot in on top of
    this surface without changing it.
  - **`@getknext/db/migrate`** — `defineDrizzleConfig({ schema?, out?, url? })`, which
    produces a valid `drizzle.config.ts`: dialect `postgresql`, the **writer**
    `DATABASE_URL` DSN (never the RO replica — migrations are writer-only), and the
    knext path conventions (`./src/db/schema.ts`, `./drizzle`). `drizzle-kit` is a
    type-only, optional-peer dependency — no runtime code is pulled from it.

### Patch Changes

- 82ddbef: docs(db): drizzle-sdk user guide + runnable `apps/db-demo` example; finalize PUBLIC_API (ADR-0021 §Consequences, #235)

  The capstone of the Drizzle data SDK. No runtime change to `@getknext/db` — this
  completes the documentation + example surface promised by ADR-0021.

  - **`docs/guides/drizzle-sdk.md`** — the end-to-end user guide: install, define
    schema (`@getknext/db/schema`), generate + apply migrations with `kn-next db migrate`
    (writer-only, one-shot Job recipe sequenced after the database is `Ready`), typed
    App Router queries + mutations, the `getDb` vs `getDbRO` staleness contract
    (read-your-writes on the writer; bounded-stale ~9s on the RO gateway; falls back to
    the writer + warns when `DATABASE_URL_RO` is unset — never auto-splits), TimescaleDB
    - pgvector (self-enable over the app's own `DATABASE_URL`, the Apache-2 bound and the
      scale-zero-pg ≥ v1.4.0 gate), and the pooling/wake contract (pool idle < 60s
      `GW_IDLE_MS`, connect ≥ 10s for cold wake).
  - **`apps/db-demo`** — a new minimal runnable example proving the SDK end-to-end:
    one `messages` table, a generated migration, a bounded-stale RO read and a
    single-writer server action, wired to `@getknext/db`. Additive (no existing app was
    changed); typechecks and `next build`s clean; a unit test asserts the drizzle config,
    the schema table, and the data-access + client modules.
  - **`packages/db/docs/PUBLIC_API.md`** — finalized to match the shipped exports across
    `.`, `./schema` (incl. the TimescaleDB/pgvector helpers + option types), and
    `./migrate` (incl. the injectable `RunMigrationsDeps` test seam).

- Re-release the full three-package set: `@getknext/db` joins the published packages
  (`@getknext/core` depends on it for `kn-next db migrate`), so all three bump
  together and ship as a set — publishing core without db breaks every consumer
  install with a 404 on the missing member.
- Updated dependencies [9810a00]
- Updated dependencies
  - @getknext/lib@0.2.0
