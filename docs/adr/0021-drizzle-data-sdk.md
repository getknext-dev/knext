# ADR-0021 — Drizzle-based data SDK: `@knext/db` (typed schema · migrations · queries · extensions)

- **Status:** Accepted (implemented — `@knext/db` shipped; **amended 2026-07-14**:
  drizzle dependency/peer shape settled before the first npmjs publish — see the
  *Amendment* below, which SUPERSEDES Open decision 6)
- **Date:** 2026-07-11 (amended 2026-07-14)
- **Relates to:** ADR-0001 (operator = single source of truth), ADR-0018
  (`spec.database` managed mode), ADR-0019 (`spec.database.secretRef` BYO binding +
  the pool/connect-timeout contract), issue #235 (this ADR), scale-zero-pg
  ADR-0006 (unified config), scale-zero-pg `docs/connecting.md` (the `DATABASE_URL` /
  `DATABASE_URL_RO` wire contract), scale-zero-pg #178 (pgvector, **not yet shipped**),
  scale-zero-pg ADR-0001 (TimescaleDB feature bounds).
- **Companion design doc:** `docs/design/drizzle-data-sdk.md` (full API sketches).

## Context

ADR-0018/0019 solved **binding** a NextApp to a Postgres — the operator injects
`DATABASE_URL` (and optionally `DATABASE_URL_RO`) into the app container. But the
**app-side data-access story stops at a raw `pg.Pool`**: `@knext/lib`'s `getDbPool()`
(`packages/lib/src/clients.ts`) returns an untyped `pg.Pool` reading `DATABASE_URL`.
An app author who wants tables, migrations, typed queries, or the platform's
Postgres extensions is on their own — hand-written SQL, no schema-as-code, no
migration story, no compile-time safety, and no first-class use of the two
extensions the database layer ships (TimescaleDB now; pgvector once scale-zero-pg
#178 lands).

The unified-platform pitch (app + database, both scale-to-zero, one `DATABASE_URL`)
is only half-built on the app side. #235 asks for the flagship **data SDK** that
completes it. Concretely, the SDK must respect five constraints that already exist
in the platform and are easy to get wrong:

1. **Single-writer is intrinsic** (scale-zero-pg, Neon). All writes go to
   `DATABASE_URL`; there is exactly one primary compute. Migrations especially must
   run against the writer, once, never concurrently.
2. **Reads are an explicit, eventually-consistent opt-in.** `DATABASE_URL_RO`
   (gateway port `55434`) is a **bounded-staleness** pool (~9s ceiling, **no
   read-your-writes**). scale-zero-pg's contract is deliberate: *nothing is
   automatic; you decide which queries are reads* (`docs/connecting.md`). The SDK
   must not silently route.
3. **Scale-to-zero pooling contract** (ADR-0019, measured): pool idle timeout **<
   gateway idle 60s** (else dead sockets), connect timeout **≥ 10s** (a cold wake is
   ~2.5s, now settled via scale-zero-pg #132). `@knext/lib`'s defaults already encode
   this (max 5, idle 10s, connect 15s); the SDK must inherit them, not re-derive them.
4. **Extension bounds are real.** TimescaleDB hypertables + `drop_chunks()` retention
   work today, but **columnar compression and continuous aggregates do not** —
   background policy jobs cannot run on a compute that scales to zero
   (scale-zero-pg ADR-0001). pgvector is **not yet available** (scale-zero-pg #178
   open); the SDK can *design* for it but cannot claim it works.
5. **knext builds no database machinery** (2026-06-26 scope decision; ADR-0019).
   The SDK is an **app-side client library** — schema, migrations *of the app's own
   data*, typed queries. It provisions nothing, mutates no cluster resource, and does
   not touch the storage plane. This keeps it clear of ADR-0001 (operator owns
   *cluster* state) and the "no DB machinery" rule (that governs the *engine* /
   provisioning, owned by scale-zero-pg).

## Decision

Ship **`@knext/db`** — a new `@knext/*` package (sibling to `@knext/lib`) that wraps
**drizzle-orm** over the existing `@knext/lib` pool. **Thin, not a framework:** we
re-export drizzle-orm and add only the knext-specific ergonomics the platform needs
(client wiring, RO routing, extensions, a migration runner). Apps keep drizzle's own
docs and lose no power.

### 1. Clients — writer / reader are explicit, never auto-routed

```ts
import { getDb, getDbRO } from '@knext/db';
import { schema } from '@/db/schema';

const db   = getDb();     // writer  — DATABASE_URL      (read-your-writes)
const dbRO = getDbRO();   // reader  — DATABASE_URL_RO   (bounded-stale, ~9s ceiling)
```

- `getDb()` drizzle-wraps `@knext/lib`'s `getDbPool()` singleton
  (`drizzle-orm/node-postgres`, `drizzle(pool, { schema })`). **One pool per pod**,
  shared with any raw-`pg` use, drained by the existing `closeDbPool()` SIGTERM hook.
- `getDbRO()` wraps a **new** RO pool. `@knext/lib` gains `getDbPoolRO()` /
  `closeDbPoolRO()` (env `DB_POOL_RO_*`, DSN `DATABASE_URL_RO`) so pool lifecycle +
  drain stay in `@knext/lib`, its established job. `@knext/db` only drizzle-wraps.
- **No SQL parsing, no automatic read/write split.** Two clients, the author picks —
  mirroring scale-zero-pg's explicit two-DSN stance. `getDbRO()` when
  `DATABASE_URL_RO` is unset **falls back to the writer with a one-time warning**
  (an app without a read pool still works; see Open decision 2).

### 2. Schema — expose drizzle, add extension helpers

Apps define schema in `src/db/schema.ts` with drizzle's `pgTable`, re-exported from
`@knext/db/schema` so the app has **one** dependency at a pinned-compatible version.
`@knext/db` adds only what the platform's extensions require:

- **TimescaleDB** — `hypertable(table, { by, chunkInterval })` is a **migration
  helper** (emits `SELECT create_hypertable(...)` after the table DDL) plus a
  `dropChunksPolicy` retention helper that generates a `drop_chunks()` call for the
  migration/CI to run (**not** a background policy — that cannot run on scale-to-zero).
  The helper docstring + guide state the compression/continuous-aggregate bound loudly.
  **Minimum supported TimescaleDB: 2.13** (#259) — the emitter targets the modern
  dimension-builder interface (`create_hypertable(<table>, by_range('<col>'[, INTERVAL]))`,
  stable since 2.13 and the only interface on 2.24+, where the legacy
  `create_hypertable(regclass, name, ...)` signature was removed). No legacy fork.
- **pgvector** — re-export drizzle's `vector(n)` column + `hnsw`/`ivfflat` index
  helpers and a `<->`/`<=>` similarity query helper; the migration emits
  `CREATE EXTENSION vector`. **Gated on scale-zero-pg #178**: shipped as designed +
  unit-tested, with the live integration test skipped until the extension is enabled
  on the compute (see Open decision 4). The guide marks it "requires scale-zero-pg
  ≥ the #178 release."

### 3. Migrations — a one-shot runner against the writer, never in the request path

`drizzle-kit`-generated migrations are applied by a **dedicated single-shot runner**:
a `kn-next db migrate` CLI subcommand (and a Job recipe) that connects on
`DATABASE_URL` (**writer only**), runs the migrations, and exits. This is the
k8s-idiomatic answer to *"who migrates a single-writer, scale-to-zero DB?"*:

- Runs **once per deploy** (CI step or a pre-deploy `Job`), waking the compute a
  single time — **not** on every pod boot (races N migrators, penalises cold start)
  and **not** by the operator (would couple the operator to app schemas and breach
  "no DB machinery").
- **Composes with provisioning:** an `AppDatabase` provisions the empty branch
  (inherits the template schema copy-on-write); the app's own migrations then run
  against it after it is `Ready`.
- **Not an ADR-0001 concern:** migrating app *data* is not a cluster-resource
  mutation. The runner touches Postgres, never ksvc/Secrets.

### 4. Queries & mutations — idiomatic App Router, thin over drizzle

Reads via route handlers / server components use `getDb()` (or `getDbRO()` for
staleness-tolerant reads); mutations use drizzle's typed `insert/update/delete` inside
`'use server'` actions, always on the writer. `@knext/db` re-exports drizzle's query
builder and `eq`/`and`/… operators; it does **not** wrap them in a bespoke DSL
(Open decision 3). Ergonomic sugar is limited to the client accessors + extension
helpers above.

### 5. Pooling — inherit ADR-0019, add a symmetric RO pool

Writer pool is unchanged (`@knext/lib` defaults: max 5, idle 10s < 60s, connect 15s ≥
10s). The RO pool mirrors those defaults with `DB_POOL_RO_*` overrides and wakes only
the RO compute. Both drain on SIGTERM. The 15s connect timeout already tolerates the
~2.5s cold wake with margin, so **no app-side wake retry is needed**.

## Options considered

| Decision point | Options | Verdict |
|---|---|---|
| ORM | **drizzle-orm** / Prisma / TypeORM / raw pg | **drizzle-orm** — TS-first, Postgres-native, takes a `pg.Pool` directly (reuses our pool), first-class `vector`/index primitives, no engine/binary. Prisma: heavyweight, own schema language, awkward extensions. TypeORM: decorator-heavy, overkill for scale-to-zero. Raw pg: the untyped status quo #235 removes. |
| Abstraction level | **Re-export drizzle + thin helpers** / knext-bespoke query API | **Thin** — drizzle's docs stay applicable, low lock-in, we add only platform-specific value (clients, RO, extensions, migrate). A bespoke API is a maintenance sink with no upside. |
| RO routing | **Explicit `getDb`/`getDbRO`** / per-query hint / auto-route by statement | **Explicit two clients** — matches scale-zero-pg's "nothing is automatic" contract; auto-routing would silently serve stale reads and break read-your-writes. |
| Migration execution | **One-shot `kn-next db migrate` (CLI/Job)** / on-boot in-app / operator-run | **One-shot runner** — single writer, no request-path penalty, no N-pod race, no operator↔schema coupling. |
| Pool ownership | **Reuse/extend `@knext/lib`** / `@knext/db` owns its own pool | **Reuse** — one pool per pod, one SIGTERM drain, one home for the ADR-0019 contract. `@knext/lib` gains the RO pool; `@knext/db` only wraps. |

## Consequences

- `@knext/db` becomes the **recommended** app data path; raw `@knext/lib`
  `getDbPool()` remains the escape hatch (a drizzle client *is* that pool).
- `@knext/lib` grows a **read-only pool** (`getDbPoolRO`/`closeDbPoolRO`) — a small,
  additive, semver-minor change with its own tests; the runtime SIGTERM drain wires it
  alongside `closeDbPool`.
- A new **`kn-next db migrate`** CLI surface + Job recipe; documented as a per-deploy
  step composing with `AppDatabase` provisioning. No operator change.
- **Extension parity is version-coupled to scale-zero-pg**, and the guide says so:
  TimescaleDB minus compression/continuous-aggregates today; pgvector only once #178
  ships. A cross-repo tracking note lives in both the guide and issue #178.
- New user guide `docs/guides/drizzle-sdk.md`; `@knext/db/docs/PUBLIC_API.md` declares
  the stable subpaths (`.`, `./schema`, `./migrate`); released via changesets on the
  next `@knext/*` publish.
- Positioning stays honest (`.claude/rules/architecture.md §5`): this is the app
  **data-access** layer, not a PaaS and not database machinery — provisioning and
  scale-to-zero stay with scale-zero-pg.

## Amendment (2026-07-14) — drizzle dependency/peer shape settled (SUPERSEDES Open decision 6)

### Context

Open decision 6 was implemented **literally**, producing a contradictory
`packages/db/package.json`: `drizzle-orm` was declared **both** a hard
`dependency` (`^0.45.2`) **and** an entry in `peerDependencies` +
`peerDependenciesMeta.optional: true`. A dependency cannot coherently be both — the
resolver already installs it (the hard dep), so the "optional peer" duplicate is
dead metadata that only misleads consumers and tooling. `drizzle-kit` was correctly
an optional peer, but its lazy-import discipline was undocumented and unverified.
With the first `@knext/*` npmjs publish imminent (issue #53 may unblock any day) and
`@knext/db` in the published set (ADR-0020 amendment), the shape must be coherent
**before** it is frozen on the registry.

The technical reality that drove the recommendation: `@knext/db`'s main entry
(`.`) **re-exports drizzle-orm** (`export * from 'drizzle-orm'`) and `getDb`/`getDbRO`
call `drizzle(...)` at runtime — drizzle-orm is a **real runtime dependency**, not an
app-supplied peer. drizzle-**kit**, by contrast, is only ever a **type** in the
source (`Config`) and a **dev/CI tool** the app runs against the generated
`drizzle.config.ts`; the `@knext/db` main entry and the `kn-next db migrate` runner
never load it.

### Decision

1. **`drizzle-orm` is a hard `dependency` only.** Drop the `peerDependencies` /
   `peerDependenciesMeta` duplicate. The re-exported drizzle-orm range
   (`^0.45.2`) is **part of `@knext/db`'s semver contract**: because apps import
   drizzle's query surface *through* `@knext/db`, a range change that could move an
   app to an incompatible drizzle-orm major/minor is itself at least a **minor**
   `@knext/db` release (a major-range bump ⇒ a `@knext/db` major). This is stated in
   the README and PUBLIC_API stability note.
2. **`drizzle-kit` stays the sole optional peer**
   (`peerDependencies.drizzle-kit` + `peerDependenciesMeta.drizzle-kit.optional: true`),
   **lazily** consulted only inside `defineDrizzleConfig`. It is never imported for
   value at module top-level; `defineDrizzleConfig` probes its resolvability
   (`require.resolve('drizzle-kit')`) and, if absent, throws an **actionable
   named-peer error** ("drizzle-kit is required for defineDrizzleConfig — install it
   as a devDependency"), never a bare `ERR_MODULE_NOT_FOUND`. A contract test
   (`packages/db/src/__tests__/peer-shape.test.ts`) pins both the manifest shape and
   the runtime behaviour: the built main entry + `runMigrations` load in a subprocess
   with drizzle-kit made unresolvable, and only `defineDrizzleConfig` errors — with
   the named message.
3. **App-pinning path.** A consumer that must pin a specific drizzle version (e.g. to
   a patched or newer compatible release) does so with a package-manager
   **`overrides`** (npm/pnpm) / **`resolutions`** (yarn) entry for `drizzle-orm` — the
   standard mechanism for constraining a transitive/hard dep — rather than relying on
   a peer range. The removed optional-peer entry added nothing over this: it did not
   let an app *substitute* drizzle-orm (the hard dep still installs one), it only
   duplicated the constraint.

### Consequences

- The manifest is coherent and publish-safe: `drizzle-orm` a hard dep, `drizzle-kit`
  an optional peer; no dependency appears in two conflicting roles.
- The drizzle-orm re-export range is now an explicit **semver-contract** surface —
  range bumps are gated at ≥ minor, documented in README + PUBLIC_API.md.
- The `defineDrizzleConfig` peer guard turns a confusing downstream loader failure
  into a one-line fix instruction, verified by the contract test and an
  install-smoke leg (`scripts/install-smoke.mjs`) that proves `@knext/db` installs +
  its main entry imports + `runMigrations` resolves **without** drizzle-kit in the
  tree.
- Change is runtime-neutral (dropping dead metadata + a lazy guard that only fires on
  a genuinely-missing peer) → shipped as a **patch** changeset.
- No new ADR needed; this is a settlement of a pre-existing open decision.

## Open decisions (for the owner)

1. **Migration execution model.** Recommend the one-shot `kn-next db migrate`
   CLI/Job, run by CI/pre-deploy. **Question:** also ship an *optional*
   operator-triggered post-`Ready` migration Job (opt-in, `spec.database.migrate:
   true`) as a convenience, or keep migrations strictly outside the operator? (Recommend
   keep-outside for v1; revisit.)
2. **`getDbRO()` with no `DATABASE_URL_RO`.** Recommend **fall back to the writer + a
   one-time warning** (app keeps working). Alternative: **throw** (force explicit
   config). Owner call on strictness.
3. **Abstraction level.** Recommend **re-export drizzle + thin helpers** (no bespoke
   query DSL). Confirm we are comfortable exposing raw drizzle as the public query API
   (its API surface becomes our compatibility surface).
4. **pgvector sequencing.** Recommend **ship vector helpers now, gated** (designed +
   unit-tested, live test skipped until scale-zero-pg #178 enables `CREATE EXTENSION
   vector`). Alternative: **defer** all vector code until #178 merges. Owner call.
5. **Package name.** Recommend **`@knext/db`**. Alternatives: `@knext/data`,
   `@knext/orm`. Confirm.
6. **drizzle dependency shape.** ~~Recommend `@knext/db` **re-exports** drizzle-orm
   (apps get one pinned dep) **and** declares it a peer range, so apps may pin their
   own compatible drizzle. Confirm vs. hard-pinning.~~ **SUPERSEDED by the
   2026-07-14 amendment (see below): drizzle-orm is a hard `dependency` only (a dep
   cannot coherently be both a dep and an optional peer); drizzle-kit stays the sole
   optional peer.**
7. **Example app.** Recommend porting an existing sample (`apps/file-manager`) to
   `@knext/db` as the runnable proof, vs. a fresh minimal `apps/db-demo`. Owner
   preference.

## Action items

- [ ] Owner review of this ADR + the open decisions above.
- [ ] Scaffold `packages/db` (`@knext/db`) — package.json, tsconfig, biome, vitest,
      PUBLIC_API.md, changeset (issue: scaffold).
- [ ] `getDb()` writer client over `@knext/lib` pool + SIGTERM drain (issue: writer).
- [ ] `getDbPoolRO`/`closeDbPoolRO` in `@knext/lib` + `getDbRO()` (issue: RO routing).
- [ ] Schema surface + `drizzle-kit` config helper (issue: schema).
- [ ] TimescaleDB `hypertable`/retention helpers + bounds docs (issue: timescale).
- [ ] pgvector column/index/similarity helpers, gated on #178 (issue: pgvector).
- [x] `kn-next db migrate` runner + Job recipe (issue: migrations, #242).
- [ ] `docs/guides/drizzle-sdk.md` + port the example app (issue: docs+example).
