---
"@knext/db": minor
"@knext/lib": minor
---

feat(db): core `@knext/db` data SDK — `getDb` + `getDbRO` (ADR-0021)

Introduces `@knext/db`, a thin drizzle-orm wrapper over the existing scale-to-zero
Postgres pools. The core ships two explicit, never-auto-routed client accessors —
`getDb()` (writer, `DATABASE_URL`, read-your-writes) and `getDbRO()` (reader,
`DATABASE_URL_RO`, bounded-staleness ~9s, falls back to the writer with a one-time
warning when unset) — plus the re-exported drizzle query surface (`eq`/`and`/`sql`/…).

`@knext/lib` gains a symmetric read-only pool (`getDbPoolRO` / `closeDbPoolRO`) over
`DATABASE_URL_RO`, mirroring the writer pool's ADR-0019 contract and tunable via
`DB_POOL_RO_*`. Schema primitives, extension helpers, and the migrate runner land in
follow-up work (#239–#242).
