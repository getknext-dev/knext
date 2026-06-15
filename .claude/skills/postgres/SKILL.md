---
name: postgres
description: PostgreSQL for knext on Knative — connection pooling under scale-to-zero (the cold-start connection-storm problem), pgbouncer/proxy, the getDbPool() singleton pattern, graceful shutdown draining, and safe query/migration practices. Use when adding DB access, sizing pools, debugging "too many connections", wiring DATABASE_URL, or running migrations against a Knative-deployed app.
---

# PostgreSQL on knext (scale-to-zero aware)

knext apps reach Postgres via a lazy singleton pool in `packages/lib/src/clients.ts`:
```ts
import { Pool } from 'pg';
let pool: Pool | null = null;
export const getDbPool = () => {            // one pool per process, lazy
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL,
                               max: Number(process.env.PG_POOL_MAX ?? 5) });
  return pool;
};
```
`DATABASE_URL` is injected by the operator (K8s Secret/env) — **never hardcode it** (security
rule + `block-secrets` hook). Default DNS: `postgres.<ns>.svc.cluster.local:5432`.

## The scale-to-zero connection problem (the important part)
Knative scales **horizontally**: a burst can spin up many pods, each with its **own** pool.
`pods × pool.max` can blow past Postgres `max_connections` (default ~100) → `FATAL: too many
connections`, especially during cold-start storms where new pods connect simultaneously.

**Mitigations (in order):**
1. **Keep per-pod `max` small** (e.g. 2–5). With `containerConcurrency: 100` one pod multiplexes
   many requests over few connections — you don't need a big pool per pod.
2. **Put a pooler in front:** **pgbouncer** (transaction mode) or a managed proxy (RDS Proxy,
   Cloud SQL connector, Supabase pooler). The app connects to the pooler; the pooler holds a small
   real-connection set to Postgres. This is the robust answer for `maxScale > a few`.
3. **Cap autoscaling:** set a sane `maxScale` so worst-case `maxScale × max` ≤ `max_connections`
   minus headroom.
4. **Short idle timeouts** on the pool so scaled-down pods release connections promptly.

## Graceful shutdown (don't drop in-flight queries)
On `SIGTERM` (Knative scale-down): stop accepting new work, let in-flight queries finish, then
`await pool.end()`. Pair with the app's graceful-shutdown handler (drain HTTP + run Next.js
`after()` callbacks) — see security.md.

## Migrations
Run migrations as a **separate one-shot Job/initContainer**, never from the request path or N
autoscaled pods racing. Gate the app's readiness on the schema being present (the demo's
`/setup` route calls `setupDatabase()`). Use a migration tool (node-pg-migrate / drizzle-kit /
sqlx) with a locked, versioned history.

## Query hygiene
- Parameterized queries only (`$1,$2`) — never string-interpolate user input.
- Wrap multi-step writes in a transaction; release clients in `finally`.
- For ISR-cached reads, the cache (Redis `cache-handler.js`) front-runs the DB — invalidate by
  tag on writes (`revalidateTag`), don't bypass it.

## Health
`packages/lib/src/health/index.ts` (`checkDeepHealth`) pings the DB; `/api/health` reports
`{ postgres: up|down }`. Use it for Knative readiness, but keep the probe cheap (`SELECT 1`).

## Gotchas
- A 1-OCPU node + a big pool + many pods = contention; size for the node, not the max.
- TLS: managed Postgres usually needs `ssl: { rejectUnauthorized }` / `?sslmode=require`.
- Don't log the connection string (it contains the password).
