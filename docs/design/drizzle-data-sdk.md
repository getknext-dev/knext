# Design — `@knext/db`, the knext Drizzle data SDK

Companion to **ADR-0021**. This doc holds the concrete API sketches, package shape,
and the request/migration flows. The ADR holds the decisions + open questions.
Snippets are illustrative, not final.

> **Status — core landed (#238/#236/#237).** `packages/db` (`@knext/db`) is
> scaffolded and the two client accessors are shipped: `getDb()` (writer) +
> `getDbRO()` (reader, with writer fallback + one-time warning), over a new
> `@knext/lib` read-only pool (`getDbPoolRO`/`closeDbPoolRO`). The re-exported
> drizzle query surface (`§6`) is live. **Still to land:** `@knext/db/schema`
> primitives + extension helpers (#239–#241) and the `@knext/db/migrate` runner
> (#242) — those subpaths are reserved but not yet exported.

## 1. Where it fits

```
apps/<app>/src/db/schema.ts      author-owned schema (drizzle pgTable)
apps/<app>/src/app/**            server components / route handlers / actions
        │  import { getDb, getDbRO } from '@knext/db'
        ▼
@knext/db          drizzle-orm wrapper + extension helpers + migrate runner
        │  reuses the pool
        ▼
@knext/lib clients getDbPool()  (writer)   +  getDbPoolRO()  (NEW, reader)
        │  DATABASE_URL / DATABASE_URL_RO   (injected by the operator, ADR-0018/0019)
        ▼
scale-zero-pg gateway  pggw:55432 (writer)  ·  pggw:55434 (RO pool, ~9s stale)
```

`@knext/db` depends on `@knext/lib` (`workspace:^`), `drizzle-orm`, and (dev)
`drizzle-kit`. It provisions nothing and mutates no cluster resource — it is a
client library (ADR-0021 §5 / ADR-0001 boundary).

## 2. Package shape (`packages/db`)

```jsonc
// packages/db/package.json  (illustrative; versions pinned at scaffold time)
{
  "name": "@knext/db",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".":         { "types": "./dist/index.d.ts",   "import": "./dist/index.js" },
    "./schema":  { "types": "./dist/schema.d.ts",  "import": "./dist/schema.js" },
    "./migrate": { "types": "./dist/migrate.d.ts", "import": "./dist/migrate.js" }
  },
  "knext": { "publicApi": { "public": [".", "./schema", "./migrate"] } },
  "dependencies": { "@knext/lib": "workspace:^", "drizzle-orm": "^x" },
  "peerDependencies": { "drizzle-orm": "^x" },
  "devDependencies": { "drizzle-kit": "^x", "vitest": "...", "typescript": "..." }
}
```

Structure mirrors `packages/lib`: `src/`, colocated `src/__tests__/*.test.ts`
(vitest, happy-dom), biome (100-width, single quotes, semicolons, trailing-all),
`tsc` build, changeset per PR, `docs/PUBLIC_API.md`.

## 3. Clients

```ts
// @knext/db  (index)
import { drizzle } from 'drizzle-orm/node-postgres';
import { getDbPool, getDbPoolRO } from '@knext/lib/clients';

let _db: ReturnType<typeof drizzle> | null = null;
let _dbRO: ReturnType<typeof drizzle> | null = null;

export function getDb<TSchema extends Record<string, unknown>>(schema?: TSchema) {
  if (!_db) _db = drizzle(getDbPool(), { schema });   // writer — DATABASE_URL
  return _db;
}

export function getDbRO<TSchema extends Record<string, unknown>>(schema?: TSchema) {
  if (!_dbRO) {
    const ro = getDbPoolRO();                 // null if DATABASE_URL_RO unset
    if (!ro) { warnOnce('DATABASE_URL_RO unset — getDbRO() falls back to writer'); return getDb(schema); }
    _dbRO = drizzle(ro, { schema });          // reader — DATABASE_URL_RO (~9s stale)
  }
  return _dbRO;
}
```

New in `@knext/lib/clients` (additive, semver-minor):

```ts
// mirrors getDbPool(): same scale-to-zero defaults, DB_POOL_RO_* overrides,
// reads DATABASE_URL_RO; returns null when unset (no RO pool configured).
export const getDbPoolRO = (): Pool | null => { /* … */ };
export const closeDbPoolRO = async (): Promise<void> => { /* … */ };
```

The runtime's SIGTERM drain (`registerShutdownDrain`) calls both `closeDbPool()` and
`closeDbPoolRO()`.

**Rule of thumb for authors** (also in the guide):
- write, or read-your-own-write → `getDb()`
- dashboard/analytics/fan-out read that tolerates ≤ ~9s staleness → `getDbRO()`

## 4. Schema + extensions

```ts
// apps/shop/src/db/schema.ts
import { pgTable, serial, text, timestamp, doublePrecision } from '@knext/db/schema';
import { hypertable, vector, hnsw } from '@knext/db/schema';

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  total: doublePrecision('total').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// TimescaleDB: turn `metrics` into a hypertable partitioned on `ts`.
export const metrics = pgTable('metrics', {
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  device: text('device').notNull(),
  value: doublePrecision('value').notNull(),
});
export const metricsHyper = hypertable(metrics, { by: 'ts', chunkInterval: '7 days' });
//   ↑ emits SELECT create_hypertable('metrics','ts', chunk_time_interval => INTERVAL '7 days')
//     in the generated migration. NO compression / continuous aggregates (scale-to-zero bound).

// pgvector (GATED on scale-zero-pg #178): CREATE EXTENSION vector in the migration.
export const docs = pgTable('docs', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
}, (t) => ({ embIdx: hnsw('emb_idx', t.embedding, { m: 16, efConstruction: 64 }) }));
```

Similarity query helper:

```ts
import { cosineDistance } from '@knext/db';           // <=> ; also l2Distance (<->)
const near = await getDbRO({ docs }).select()
  .from(docs).orderBy(cosineDistance(docs.embedding, queryEmbedding)).limit(5);
```

`@knext/db/schema` re-exports drizzle's `pg-core` primitives so an app imports from
one place; `hypertable`/retention are knext additions, `vector`/`hnsw`/`ivfflat`/
distance ops are re-exports of drizzle's own vector support wired into our migration
+ extension gating.

## 5. Migrations

```ts
// drizzle.config.ts  (app root) — @knext/db ships defineDrizzleConfig()
import { defineDrizzleConfig } from '@knext/db/migrate';
export default defineDrizzleConfig({ schema: './src/db/schema.ts', out: './drizzle' });
//   dialect: 'postgresql', url: process.env.DATABASE_URL (writer), sane defaults.
```

Author generates SQL at dev time (`drizzle-kit generate`), commits `drizzle/`.
Applied per-deploy by the one-shot runner:

```
CI / pre-deploy step (once):        or a k8s Job (once):
  kn-next db migrate                   image: <app>, command: ["kn-next","db","migrate"]
     → connects DATABASE_URL (writer)  restartPolicy: Never, backoffLimit: small
     → drizzle-kit migrate             (waits for AppDatabase Ready; wakes compute once)
     → exits 0
```

Guarantees: **writer-only** (never `DATABASE_URL_RO`), **single migrator** (a Job is
one pod; drizzle's migration table + lock also guards concurrent runs), **out of the
request path** (never on pod boot). Composes with `AppDatabase`: provision → `Ready`
→ migrate → app serves.

```
NextApp(spec.database) ──▶ AppDatabase provisions branch (template schema, ~4s) ──▶ Ready
                                                                                      │
                          kn-next db migrate (CI/Job, writer, once) ◀────────────────┘
                                                                                      │
                          app pods boot; getDb()/getDbRO() serve traffic ◀────────────┘
```

## 6. Queries & mutations (App Router)

```ts
// route handler — staleness-tolerant read → RO pool
// app/api/orders/route.ts
import { getDbRO } from '@knext/db';
import { orders } from '@/db/schema';
import { eq } from '@knext/db';
export async function GET(req: Request) {
  const uid = new URL(req.url).searchParams.get('u')!;
  const rows = await getDbRO({ orders }).select().from(orders).where(eq(orders.userId, uid));
  return Response.json(rows);
}
```

```ts
// server action — write → writer pool, read-your-writes
// app/orders/actions.ts
'use server';
import { getDb } from '@knext/db';
import { orders } from '@/db/schema';
export async function createOrder(userId: string, total: number) {
  const [row] = await getDb({ orders }).insert(orders).values({ userId, total }).returning();
  return row;                                   // visible immediately on getDb()
}
```

No bespoke query DSL: `@knext/db` re-exports drizzle's `eq/and/or/…` and the query
builder. The knext value-add is client selection + extensions + migrate.

## 7. Testing strategy

- **Unit (vitest, no DB):** client singletons + fallback, `defineDrizzleConfig`
  defaults, `hypertable`/retention SQL emission, vector column/index/DDL emission,
  RO-fallback warning. Mock `@knext/lib` pools.
- **Integration (gated):** against a real scale-zero-pg DB —
  writer/RO round-trip + staleness, migrate runner idempotency, TimescaleDB
  create_hypertable + drop_chunks. **pgvector integration is skipped until
  scale-zero-pg #178** enables the extension.
- **E2E (proof):** the ported example app on cluster — provision `AppDatabase`,
  `kn-next db migrate`, serve a query, both wake on one request.

## 8. Cross-repo dependencies

| Needs | From | Status |
|---|---|---|
| `DATABASE_URL` / `DATABASE_URL_RO` injection | knext ADR-0018/0019 (operator) | shipped |
| RO pool endpoint (`pggw:55434`, ~9s stale) | scale-zero-pg `docs/connecting.md` | shipped |
| TimescaleDB (hypertables, `drop_chunks`) | scale-zero-pg ADR-0001 | shipped (no compression / continuous aggs) |
| pgvector (`CREATE EXTENSION vector`) | scale-zero-pg **#178** | **open** — gate vector helpers on it |
