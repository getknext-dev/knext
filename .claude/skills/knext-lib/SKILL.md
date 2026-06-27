---
name: knext-lib
description: >-
  Use the @knext/lib runtime helper library inside a knext application (a Next.js
  "zone"): the Postgres pool (getDbPool), the S3/MinIO object-store client
  (getMinioClient), the Cerbos authorization client (getCerbosClient), the deep
  health check (checkDeepHealth) for /api/health, and the shared pino logger.
  Use this skill whenever app code needs a database connection, object storage, a
  readiness/health endpoint, structured logging, or imports anything from
  @knext/lib — even if "@knext/lib" isn't named explicitly. For deep DB
  connection-pool sizing and the scale-to-zero connection-storm problem, also load
  the `postgres` skill.
---

# Using `@knext/lib`

`@knext/lib` is the small runtime helper library a knext zone imports from its
**server** code. Its entire surface is public and semver-stable (see
`docs/PUBLIC_API.md`). Connection details always come from the **environment** —
never hardcode hosts or credentials (the operator injects them as env from K8s
Secrets).

## The surface (all public)

```ts
// One import for everything (the root re-exports the three subpaths):
import { getDbPool, getMinioClient, getCerbosClient, checkDeepHealth, logger } from '@knext/lib';
```

| Import | Returns | Use for |
| --- | --- | --- |
| `@knext/lib/clients` → `getDbPool()` | `pg.Pool` (from `DATABASE_URL`) | PostgreSQL access |
| `@knext/lib/clients` → `getMinioClient()` | `Minio.Client` | S3/MinIO object storage |
| `@knext/lib/clients` → `getCerbosClient()` | `Cerbos` | authorization checks |
| `@knext/lib/health` → `checkDeepHealth()` | `Promise<HealthStatus>` | the `/api/health` route |
| `@knext/lib/logger` → `logger` | `pino.Logger` | structured JSON logging |

The clients are **lazily constructed singletons** — call `getDbPool()` wherever
you need it; it returns the same pool.

## Database — `getDbPool()`

```ts
import { getDbPool } from '@knext/lib/clients';

export async function listUsers() {
  const { rows } = await getDbPool().query('SELECT id, name FROM users');
  return rows;
}
```

- It reads `DATABASE_URL` from the environment (injected by the operator from a
  K8s Secret — see the `knext-deploy` skill for `spec.secrets.envMap`).
- **Scale-to-zero caveat:** a zone scales `0 → N` pods under load, and each pod
  holds its own pool. Point `DATABASE_URL` at a **transaction-mode pooler**
  (CloudNativePG `Pooler` / PgBouncer), keep the per-instance pool **small**, and
  drain it on `SIGTERM`. The `postgres` skill covers the sizing math and the
  prepared-statement caveat; load it before tuning pools.

## Object storage — `getMinioClient()`

```ts
import { getMinioClient } from '@knext/lib/clients';
const minio = getMinioClient(); // S3-compatible: GCS / S3 / MinIO via env
```

Use this for app media/blobs (e.g. Payload uploads). It is separate from the
build-time static-asset upload the CLI does.

## Health — `checkDeepHealth()`

Wire it into a Route Handler so Knative/Kubernetes readiness probes reflect real
dependency health:

```ts
// app/api/health/route.ts
import { checkDeepHealth } from '@knext/lib/health';
import { NextResponse } from 'next/server';

export async function GET() {
  const status = await checkDeepHealth();
  // HealthStatus = { status: 'ok'|'degraded'|'down', timestamp, checks: { postgres, redis } }
  return NextResponse.json(status, { status: status.status === 'down' ? 503 : 200 });
}
```

The operator points the pod's readiness/liveness probes at `spec.healthCheckPath`
(default `/api/health`).

## Logging — `logger`

```ts
import { logger } from '@knext/lib/logger';
logger.info({ msg: 'order placed', orderId });   // JSON in prod, pretty in dev
```

Use this in app code; the CLI/runtime have their own internal logger
(`@knext/core/internal/logger` — do not import that from an app).

## Rules
- **Never import `@knext/core/internal/*`** from application code — those are
  framework wiring with no stability guarantee (`docs/PUBLIC_API.md`).
- **Never hardcode** `DATABASE_URL` or object-store credentials — read them from
  the environment; the operator provisions them from Secrets.
- These helpers run **server-side only** (Node runtime), never in client
  components or edge.

## Related skills
- `postgres` — connection pooling under scale-to-zero, pool sizing, the pooler.
- `knext-app` — wiring `@knext/core` (adapter, config, cache handler) into the app.
- `knext-deploy` — how `DATABASE_URL`/secrets/scaling reach the pod via the CR.
