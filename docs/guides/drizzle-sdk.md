# The knext data SDK: `@knext/db` (drizzle)

> **Status:** implemented (ADR-0021, epic #235). `@knext/db` is the typed
> data-access layer for knext apps — a **thin** [drizzle-orm](https://orm.drizzle.team)
> wrapper over the scale-to-zero Postgres pools the operator binds into your app.

knext and [scale-zero-pg](https://github.com/getknext-dev/scale-zero-pg) are **one
platform, two layers**: knext scales your *application* (Next.js on Knative),
scale-zero-pg scales its *database* (a wake-on-connect Postgres gateway). Both sleep
at zero and **wake together on one visitor request**. `@knext/db` gives that database
a typed schema, migrations, and queries — without building any database machinery of
its own (it provisions nothing and mutates no cluster resource; ADR-0021 §5).

It re-exports drizzle's whole query surface and adds only the knext-specific
ergonomics the platform needs. **You keep drizzle's own docs and lose no power.**

A complete, runnable version of everything below lives in
[`apps/db-demo`](../../apps/db-demo) — clone-and-run it as the reference.

---

## 1. Install

```bash
npm i @knext/db
npm i -D drizzle-kit        # dev-only: generates SQL migrations
```

`@knext/db` depends on `drizzle-orm` and re-exports it, so you get one
pinned-compatible drizzle. `drizzle-kit` is a **dev tool** (a type-only peer) — it
runs `generate` at dev time and ships no runtime code.

---

## 2. Define your schema

Put your tables in `src/db/schema.ts` (the knext convention) and import the builders
from `@knext/db/schema` — a thin re-export of drizzle's `pg-core` (plus
`relations`/`sql`). No bespoke DSL, so [drizzle's schema
docs](https://orm.drizzle.team/docs/sql-schema-declaration) apply directly.

```ts
// src/db/schema.ts
import { pgTable, serial, text, timestamp } from '@knext/db/schema';

export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  author: text('author').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Typed rows for free:
export type Message = typeof messages.$inferSelect; // row shape
export type NewMessage = typeof messages.$inferInsert; // insert shape
```

`@knext/db/schema` re-exports `pgTable`, the column builders (`serial`/`text`/
`integer`/`timestamp`/`jsonb`/`uuid`/`vector`/…), `index`/`uniqueIndex`,
`primaryKey`/`foreignKey`, `pgEnum`/`pgSchema`, and `relations`/`sql`. The
TimescaleDB and pgvector helpers (§6) slot in **on top of** this surface.

---

## 3. Generate + apply migrations with `kn-next db migrate`

Migrations answer *"who migrates a single-writer, scale-to-zero database?"* — a
**one-shot, writer-only** runner, out of the request path (ADR-0021 §3).

### 3a. Config

```ts
// drizzle.config.ts (app root)
import { defineDrizzleConfig } from '@knext/db/migrate';

// dialect: 'postgresql', schema: './src/db/schema.ts', out: './drizzle',
// dbCredentials.url: process.env.DATABASE_URL (the WRITER, injected by the operator).
export default defineDrizzleConfig();
```

`defineDrizzleConfig()` is wired to the **writer** `DATABASE_URL` — never the RO
replica. Override paths or pass an explicit writer DSN when you need to:

```ts
export default defineDrizzleConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  url: process.env.DATABASE_URL, // composes with an AppDatabase-provisioned credential
});
```

### 3b. Generate (dev time — no database needed)

```bash
npx drizzle-kit generate     # diff schema → ./drizzle/*.sql — commit these
```

`drizzle-kit generate` needs no live database (an unset `DATABASE_URL` still
generates SQL). **Commit `./drizzle`** — the generated SQL is your migration history.

### 3c. Apply — `kn-next db migrate`

```bash
kn-next db migrate                       # apply ./drizzle against the writer DATABASE_URL
kn-next db migrate --dir ./migrations    # custom migrations directory
kn-next db migrate --url "$WRITER_DSN"   # explicit writer DSN override
```

- **Writer-only.** It resolves `DATABASE_URL` and **refuses** a read-replica DSN —
  an exact `DATABASE_URL_RO`, or any DSN on the RO gateway port `55434`. Single-writer
  forbids writes on the replica.
- **Once per deploy, out of the request path.** Run it as a CI step or a pre-deploy
  Job — **not** on pod boot (that races N migrators and penalises cold start) and
  **not** by the operator (migrating app *data* is not a cluster-resource mutation;
  the operator owns ksvc/Secrets, not your schema — the ADR-0001 boundary).
- **Idempotent + fail loud.** drizzle records applied migrations in
  `__drizzle_migrations`, so a re-run is a no-op; a migration error exits **non-zero**
  so a Job fails instead of a half-applied schema going live.
- **Wakes the writer once.** Connecting wakes a scale-to-zero compute — a deliberate
  one-shot, with a cold-wake-tolerant 15s connect timeout (the wake is ~2.5s).

### 3d. Sequence it after the database is `Ready` (one-shot Job)

An `AppDatabase` provisioned on scale-zero-pg (or any BYO Postgres) gives the
app a writer `DATABASE_URL` Secret, bound via `spec.database.secretRef`.
Migrations run **after** the database is `Ready` and **before** app
pods serve:

```
AppDatabase provisions branch (template schema, ~4s) ──▶ Ready
                                                            │
        kn-next db migrate (CI / Job, writer, once) ◀───────┘
                                                            │
        app pods boot; getDb()/getDbRO() serve traffic ◀────┘
```

Run the migration as a one-shot Kubernetes `Job` on the **same image + Secret** the
NextApp uses. `restartPolicy: Never` + `backoffLimit: 2` fail a bad migration loudly.
(Full manifest: [`apps/db-demo/migrate-job.yaml`](../../apps/db-demo/migrate-job.yaml).)

```yaml
# migrate-job.yaml — apply once per deploy (CI `kubectl apply`), gated on Ready.
apiVersion: batch/v1
kind: Job
metadata:
  name: db-demo-migrate
  namespace: my-apps
spec:
  backoffLimit: 2 # fail loud — never ship a half-applied schema
  ttlSecondsAfterFinished: 300 # reap the finished Job
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example/db-demo:<same-digest-as-the-deploy>
          command: ['kn-next', 'db', 'migrate']
          env:
            # The WRITER DSN — the SAME Secret the operator injects into the app.
            # Writer only: never wire DATABASE_URL_RO here (the runner refuses it).
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-demo-db # the AppDatabase-provisioned (or BYO) Secret
                  key: DATABASE_URL
```

```bash
kubectl wait --for=condition=Ready appdatabase/db-demo -n my-apps --timeout=120s
kubectl apply -f migrate-job.yaml -n my-apps
kubectl wait --for=condition=Complete job/db-demo-migrate -n my-apps --timeout=300s
```

`kubectl wait --for=condition=Complete` returns non-zero if the Job fails — wire it
into your pipeline so a failed migration blocks the rollout.

---

## 4. Typed queries + mutations in the App Router

Reads run in server components / route handlers; mutations run in `'use server'`
actions. `@knext/db` re-exports drizzle's query builder and operators (`eq`, `and`,
`or`, `desc`, `sql`, …) — no bespoke DSL. Keep the data-access functions plain (no
`next/*`) so they import and unit-test cleanly, then wrap the write in an action.

```ts
// src/db/queries.ts — the read/write split, explicit clients
import { desc, getDb, getDbRO } from '@knext/db';
import { type Message, type NewMessage, messages } from './schema';

// staleness-tolerant list → the READER (bounded-stale RO gateway)
export function listMessages(limit = 50): Promise<Message[]> {
  return getDbRO({ messages }).select().from(messages).orderBy(desc(messages.createdAt)).limit(limit);
}

// insert → the WRITER; the returned row is read-your-writes
export async function addMessage(input: NewMessage): Promise<Message> {
  const [row] = await getDb({ messages }).insert(messages).values(input).returning();
  return row;
}
```

```ts
// src/app/actions.ts — the writer path as a server action
'use server';
import { revalidatePath } from 'next/cache';
import { addMessage } from '@/db/queries';

export async function postMessage(formData: FormData): Promise<void> {
  const author = String(formData.get('author') ?? '').trim() || 'anonymous';
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return;
  await addMessage({ author, body }); // writer → visible to the next getDb() read
  revalidatePath('/');
}
```

```tsx
// src/app/page.tsx — a server component reads on the RO gateway
import { listMessages } from '@/db/queries';
import { postMessage } from './actions';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const messages = await listMessages(); // getDbRO() — bounded-stale
  return (
    <main>
      <form action={postMessage}>
        <input name="author" />
        <textarea name="body" required />
        <button type="submit">Post</button>
      </form>
      <ul>{messages.map((m) => <li key={m.id}><b>{m.author}</b>: {m.body}</li>)}</ul>
    </main>
  );
}
```

---

## 5. `getDb` vs `getDbRO` — the staleness contract

Two clients, you pick per query — **nothing is auto-routed** (mirroring
scale-zero-pg's "you decide which queries are reads" contract):

| | `getDb()` | `getDbRO()` |
|---|---|---|
| DSN | `DATABASE_URL` (writer) | `DATABASE_URL_RO` (RO gateway, port `55434`) |
| Consistency | **read-your-writes**, single-writer | **bounded-stale ~9s**, **no** read-your-writes |
| Use for | every write; any read that must see its own write | dashboards / analytics / fan-out reads that tolerate a few seconds of lag |

- **Never auto-split.** The SDK does not parse SQL or route by statement — that would
  silently serve stale reads and break read-your-writes. You choose the client.
- **Fallback when unconfigured.** If `DATABASE_URL_RO` is **unset** there is no read
  replica, so `getDbRO()` **falls back to the writer with a one-time warning** — an
  app without a RO pool still works, it just reads from the primary. Set
  `DATABASE_URL_RO` (bind a `roSecretRef`, see the
  [postgres-binding guide](./postgres-binding.md)) to route staleness-tolerant reads
  to the RO gateway.

Rule of thumb: **write, or read-your-own-write → `getDb()`**; **read that tolerates
≤ ~9s staleness → `getDbRO()`**.

---

## 6. Extensions — TimescaleDB & pgvector

The scale-to-zero Postgres ships two extensions in its compute image, both **opt-in
and self-service**: your app enables the one it needs **itself**, once, over its own
`DATABASE_URL` — no operator, no superuser. Both are `trusted`, so a single
`CREATE EXTENSION IF NOT EXISTS …` is all it takes, and their data + indexes live on
the pageserver, so **they survive scale-to-zero** (scale-zero-pg
[`docs/connecting.md`](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/connecting.md)).

The helpers below are **migration SQL emitters** (drizzle-kit can't model these):
put their output in the migration that creates the table. `createTimescaleExtension()`
/ `createVectorExtension()` return the enable statement — run it at the **top** of
that migration.

### 6a. TimescaleDB (time-series) — #240

```ts
import {
  pgTable, timestamp, text, doublePrecision,
  hypertable, dropChunks, createTimescaleExtension,
} from '@knext/db/schema';

export const metrics = pgTable('metrics', {
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  device: text('device').notNull(),
  value: doublePrecision('value').notNull(),
});

// Emit these into your migration (drizzle-kit won't generate them):
createTimescaleExtension();
// → CREATE EXTENSION IF NOT EXISTS timescaledb;
hypertable(metrics, { by: 'ts', chunkInterval: '7 days' });
// → SELECT create_hypertable('metrics', 'ts',
//     chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);

// Retention — a ONE-SHOT drop, run by your migration/CI on a schedule you own:
dropChunks(metrics, { olderThan: '30 days' });
// → SELECT drop_chunks('metrics', INTERVAL '30 days');
```

> **Honest bound (Apache-2 tier only).** You get hypertables, `time_bucket()`, chunk
> pruning, and one-shot `drop_chunks()` retention. Columnar **compression** and
> **continuous aggregates** are **not** available here, and retention is
> `dropChunks()` — **not** `add_retention_policy()`. Both of those rely on
> *background policy jobs*, which cannot run on a compute that scales to zero
> (scale-zero-pg `adr-0001`). Run `dropChunks()` from a CI cron / a `kn-next` job.

### 6b. pgvector (embeddings / semantic search) — #241

```ts
import {
  pgTable, serial, text, vector,
  hnsw, ivfflat, createVectorExtension,
} from '@knext/db/schema';

export const docs = pgTable('docs', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
});

// Emit into your migration:
createVectorExtension();
// → CREATE EXTENSION IF NOT EXISTS vector;
hnsw('docs_embedding_idx', docs.embedding, { m: 16, efConstruction: 64 });
// → CREATE INDEX IF NOT EXISTS "docs_embedding_idx" ON "docs"
//     USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

// IVFFlat is the alternative access method (faster build, tune `lists` to row count):
ivfflat('docs_embedding_ivf', docs.embedding, { ops: 'vector_l2_ops', lists: 100 });
```

Query with the distance operators (re-exported from drizzle). **Match the operator to
the index's ops class**: `cosineDistance` (`<=>`) ⇄ `vector_cosine_ops`, `l2Distance`
(`<->`) ⇄ `vector_l2_ops`, `innerProduct` (`<#>`) ⇄ `vector_ip_ops`.

```ts
import { getDbRO, cosineDistance } from '@knext/db';
import { docs } from '@/db/schema';

const nearest = await getDbRO({ docs })
  .select()
  .from(docs)
  .orderBy(cosineDistance(docs.embedding, queryEmbedding))
  .limit(5);
```

Build the index while the compute is awake (index builds run on your own per-app
compute); it persists across scale-to-zero like any other table.

> **Version gate.** pgvector requires **scale-zero-pg ≥ v1.4.0** (the self-enable
> trusted-extension mechanism landed with scale-zero-pg #178). The helpers are
> designed + unit-tested regardless; the live `CREATE EXTENSION vector` needs the
> extension present on the compute image.

---

## 7. Pooling / wake contract

Both pools live in `@knext/lib` and inherit the scale-to-zero contract (ADR-0019,
measured):

- **Pool idle timeout < the gateway's 60s idle** — so the app never holds an idle
  socket open across the gateway's `GW_IDLE_MS`, and never keeps the database awake.
  (`@knext/lib` default: idle 10s.)
- **Connect timeout ≥ 10s** — to absorb the ~2.5s cold wake with margin.
  (`@knext/lib` default: connect 15s.)

The defaults already satisfy both — you rarely tune them. Override the writer with
`DB_POOL_*` and the reader with `DB_POOL_RO_*` if you must. Because the connect
timeout already tolerates the cold wake, **no app-side wake retry is needed**.

**Graceful drain on scale-down.** On `SIGTERM` (Knative scaling a replica down),
the runtime drains **both** pools — the writer *and* the RO pool — after in-flight
HTTP requests finish, so a terminating replica releases its gateway connections
cleanly instead of severing them mid-write or leaking idle sockets that hold a
scale-to-zero compute awake. Each close is idempotent and a no-op when its pool was
never opened (e.g. an app with no `DATABASE_URL_RO`), and the whole drain is bounded
by the shutdown grace cap so a slow/unreachable database can never wedge shutdown.
You get this for free — nothing to wire in app code.

This is the payoff of the unified platform: the app scales to zero on Knative, its
database scales to zero on scale-zero-pg, and **the first visitor request wakes both**
— the app pod, then (on the pool's first connection) its Postgres compute.

---

## See also

- Runnable example: [`apps/db-demo`](../../apps/db-demo)
- Public API + stability: [`packages/db/docs/PUBLIC_API.md`](../../packages/db/docs/PUBLIC_API.md)
- Binding a database: [postgres-binding](./postgres-binding.md) ·
  [database platform](./database-platform.md)
- ADR: [ADR-0021 — Drizzle data SDK](../adr/0021-drizzle-data-sdk.md)
```
