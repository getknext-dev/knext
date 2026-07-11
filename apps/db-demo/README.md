# db-demo — the `@knext/db` example app

A minimal, runnable proof of the [knext data SDK](../../packages/db) (`@knext/db`,
ADR-0021). One table, one read, one write — it demonstrates the whole SDK surface
end-to-end: schema, a generated migration, a **read-only** list query, and a
**writer** server action, all over the scale-to-zero Postgres pools.

The companion user guide is [`docs/guides/drizzle-sdk.md`](../../docs/guides/drizzle-sdk.md).

## What it shows

| Piece | File | SDK surface |
|---|---|---|
| Schema (1 table) | `src/db/schema.ts` | `@knext/db/schema` (`pgTable`, columns) |
| drizzle-kit config | `drizzle.config.ts` | `@knext/db/migrate` → `defineDrizzleConfig()` |
| Generated migration | `drizzle/0000_*.sql` | `drizzle-kit generate` |
| RO read | `src/db/queries.ts` → `listMessages()` | `getDbRO()` (bounded-stale) |
| Writer server action | `src/app/actions.ts` → `postMessage()` | `getDb()` (read-your-writes) |
| App Router page | `src/app/page.tsx` | server component + `<form action>` |

**Nothing is auto-routed.** The read uses `getDbRO()`, the write uses `getDb()` —
the explicit two-client contract (ADR-0021 §1). If `DATABASE_URL_RO` is unset,
`getDbRO()` falls back to the writer and warns once.

## Run it locally

```bash
pnpm install
pnpm --filter @knext/lib --filter @knext/db build   # the SDK is consumed from dist
pnpm --filter db-demo db:generate                   # (re)generate ./drizzle from the schema
DATABASE_URL=postgres://user:pass@localhost:5432/db pnpm --filter db-demo db:migrate
pnpm --filter db-demo dev
```

## Deploy on knext (both wake on one request)

1. **Bind a database** — either managed (`kn-next db bind --managed`) or BYO
   (`kn-next db bind --secret db-demo-db`). The operator injects `DATABASE_URL`
   (and optionally `DATABASE_URL_RO`) into the app container (ADR-0019).
2. **Migrate once** — after the database is `Ready`, run the writer-only one-shot
   Job ([`migrate-job.yaml`](./migrate-job.yaml)) — `restartPolicy: Never`,
   sequenced with `kubectl wait`. See the guide's migrations section.
3. **Deploy** — `kn-next deploy`. The app scales to zero; the first visitor request
   wakes the app pod, and the pool's first connection wakes its scale-to-zero
   compute. App + database sleep and wake together on one request.

## Pooling / wake contract

Inherited from `@knext/lib` (ADR-0019): pool idle timeout **< 60s** gateway idle
(no dead sockets), connect timeout **≥ 10s** (absorbs the ~2.5s cold wake). Tune
with `DB_POOL_*` (writer) / `DB_POOL_RO_*` (reader) — defaults already satisfy it.
