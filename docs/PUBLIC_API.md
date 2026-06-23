# knext Public API reference

This page lists the **supported imports** a knext application may use at build time
and runtime, and the **stability contract** behind them. If an import is listed
here as public, you can rely on it. If it is not listed — or lives under an
`/internal/` path — it is framework wiring with no compatibility guarantee.

Two packages make up the application surface:

- **`@knext/core`** — your Next.js config type, the deployment adapter, and
  observability wiring.
- **`@knext/lib`** — runtime helpers your application code calls (database and
  object-store clients, a health check, a logger).

---

## `@knext/core`

### `@knext/core`

The configuration type for your `kn-next.config.ts`.

```ts
import type { KnativeNextConfig } from '@knext/core';

const config: KnativeNextConfig = {
  // storage, cache, queue, infrastructure, scaling, observability, secrets…
};

export default config;
```

Exported types: `KnativeNextConfig`, `StorageConfig`, `StorageProvider`,
`CacheConfig`, `CacheProvider`, `RedisCacheConfig`, `DynamoDBCacheConfig`,
`QueueConfig`, `QueueProvider`, `KafkaQueueConfig`, `NoQueueConfig`,
`InfrastructureConfig`, `PostgresConfig`, `RedisInfraConfig`, `MinioInfraConfig`,
`ScalingConfig`, `ObservabilityConfig`, `SecretsConfig`, `SecretRef`.

### `@knext/core/adapter`

The official Next.js deployment adapter. Wire it into your Next.js config so the
build produces a knext-deployable output.

```ts
import adapter from '@knext/core/adapter';

export default {
  experimental: { adapterPath: '@knext/core/adapter' },
};
```

Signature: `default` export — a Next.js deployment adapter object.

### `@knext/core/adapters/otel-config`

Resolves OpenTelemetry options from the environment for your
`instrumentation.ts`. Tracing is off unless an endpoint is configured, so
unconfigured apps pay nothing.

```ts
import { resolveOtelOptions } from '@knext/core/adapters/otel-config';

const otel = resolveOtelOptions(); // OtelOptions | null
```

Exports: `resolveOtelOptions(): OtelOptions | null`, and the types `OtelOptions`,
`OtelEnv`.

---

## `@knext/lib`

All `@knext/lib` subpaths are public application API.

### `@knext/lib/clients`

Lazily-constructed clients for your zone's own data stores. Connection details
come from the environment (`DATABASE_URL`, object-store credentials) — never
hardcode them.

```ts
import { getDbPool, getMinioClient } from '@knext/lib/clients';

const pool = getDbPool();        // pg.Pool
const minio = getMinioClient();  // Minio.Client
```

Exports:
- `getDbPool(): Pool` — a PostgreSQL connection pool (`pg`).
- `getMinioClient(): Minio.Client` — an S3/MinIO-compatible object-store client.
- `getCerbosClient(): Cerbos` — a Cerbos authorization client.

### `@knext/lib/health`

A deep readiness probe for your `/api/health` route. Verifies connectivity to
core dependencies (Postgres, Redis).

```ts
import { checkDeepHealth } from '@knext/lib/health';

const status = await checkDeepHealth(); // HealthStatus
```

Exports:
- `checkDeepHealth(): Promise<HealthStatus>`
- `HealthStatus` — `{ status: 'ok' | 'degraded' | 'down'; timestamp: string;
  checks: { postgres: 'up' | 'down' | 'unconfigured'; redis: 'up' | 'down' |
  'unconfigured' } }`.

### `@knext/lib/logger`

A shared JSON logger (`pino`) — structured JSON in production, pretty output in
development.

```ts
import { logger } from '@knext/lib/logger';

logger.info({ msg: 'ready' });
```

Exports: `logger` — a `pino.Logger`.

### `@knext/lib`

The package root re-exports everything from `@knext/lib/clients`,
`@knext/lib/health`, and `@knext/lib/logger` for convenience.

```ts
import { getDbPool, checkDeepHealth, logger } from '@knext/lib';
```

---

## Internal subpaths — NOT supported

The following `@knext/core` subpaths are **framework wiring** used by the knext
runtime, CLI, and operator. They live under an `/internal/` prefix so the
boundary is visible in the import path itself. **Do not import them from
application code** — they have no stability guarantee and may change or disappear
in any release, including patch releases.

| Internal import | What it is |
| --- | --- |
| `@knext/core/internal/next-adapter` | The adapter implementation behind `@knext/core/adapter`; import the public alias instead. |
| `@knext/core/internal/node-server` | The standalone server entry the runtime spawns. |
| `@knext/core/internal/cache-handler` | The ISR/data cache handler wired in by the framework. |
| `@knext/core/internal/loader` | Internal config loader. |
| `@knext/core/internal/logger` | Internal CLI/runtime logger (apps use `@knext/lib/logger`). |
| `@knext/core/internal/cli-validate` | CLI config validation helpers. |
| `@knext/core/internal/cli-shared` | Shared CLI utilities. |

`@knext/lib` exposes no internal subpaths — its entire surface is public.

---

## Stability & versioning

The **public surface** above follows [semantic versioning](https://semver.org/):

- **Patch / minor releases** never remove or break a public import. New public
  imports may be added in minor releases.
- **Breaking changes** to any public import (removal, renamed export, changed
  signature or type) require a **major version bump**.
- Before a public import is removed, it is **deprecated** for at least one minor
  release — marked deprecated in its types and noted in the changelog — so you
  have a migration window.

**Internal subpaths** (anything under `/internal/`, and any subpath not listed in
this document) carry **no stability guarantee**. They may change or be removed in
any release. If you find yourself needing one, please open an issue describing
the use case so the capability can be considered for the public surface.
