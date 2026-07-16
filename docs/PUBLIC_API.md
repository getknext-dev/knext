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
// next.config.ts — Next.js 16.2+ (adapterPath is top-level config)
export default {
  adapterPath: '@knext/core/adapter',
};
```

On Next.js 16.0.x–16.1.x the option lives under `experimental` instead
(`experimental: { adapterPath: '@knext/core/adapter' }`). The 16.2+ config
loader auto-migrates the old `experimental` key (with a warning), but 16.0.x
does **not** recognize the top-level form — match the form to your Next.js
version.

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

### `@knext/core/adapters/tracing`

Manual OpenTelemetry spans for the cold, DB-backed request path — the wake
latency that auto-instrumentation does not otherwise capture. `withColdStartSpan`
times the app boot / first-request wake and `withDbWakeSpan` times the database
0→1 wake + first connect; both nest inside the active request trace, so one cold
request yields a single trace showing where the time went. Both are a
zero-overhead no-op when tracing is disabled. `installTraceIdProvider()` returns
the provider you pass to `@knext/lib`'s `setTraceIdProvider` so log lines and
spans share one `trace_id`.

```ts
import { withColdStartSpan, withDbWakeSpan } from '@knext/core/adapters/tracing';

const rows = await withColdStartSpan({ cold: true, wakeMs }, () =>
  withDbWakeSpan(() => db.query('select 1')),
);
```

Exports: `withColdStartSpan(attrs, fn)`, `withDbWakeSpan(fn)`,
`activeTraceId(): string | undefined`, `installTraceIdProvider()`, the type
`ColdStartAttrs`, and the span-name constants `COLD_START_SPAN_NAME`,
`DB_WAKE_SPAN_NAME`, `TRACER_NAME`.

### `@knext/core/adapters/cache-handler`

The ISR / Redis cache handler. Next.js requires its `cacheHandler` option to be a
**file path**, so each app ships a thin local `cache-handler.js` that re-exports
this module — keeping the cache logic in the framework so fixes apply everywhere.

```js
// cache-handler.js (at your app root)
export { default } from '@knext/core/adapters/cache-handler';
```

```ts
// next.config.ts
import path from 'node:path';

export default {
  cacheHandler: path.resolve(import.meta.dirname, 'cache-handler.js'),
};
```

This module is plain JavaScript (no `.d.ts`); you reference it by path rather than
calling it directly, so no type surface is exposed.

### `@knext/core/validate`

Validates a `kn-next.config.ts` against the **exact same rules** the `kn-next`
deploy step applies. Use it as a config-quality gate in your own CI — call it in
a test or a build script so a bad deploy config fails fast, before it reaches the
cluster.

```ts
import { validateConfig, ConfigValidationError } from '@knext/core/validate';
import type { KnativeNextConfig } from '@knext/core';
import config from './kn-next.config';

try {
  validateConfig(config); // returns void when valid
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
```

This module is **pure**: importing it runs no I/O and never exits your process —
it is safe to pull into your own build/test process. On an invalid config,
`validateConfig` throws a `ConfigValidationError`; on a valid config it returns
`void`.

Exports:
- `validateConfig(config: KnativeNextConfig): void` — throws `ConfigValidationError`
  on invalid config.
- `ConfigValidationError` — the error type thrown on failure (`instanceof`-checkable).

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

### `@knext/lib/context`

Request correlation for the runtime path. Each request carries an ambient
correlation id (adopted from a well-formed inbound `x-request-id`, else
generated) that flows through `AsyncLocalStorage`, lands on every structured log
line, is echoed on the response, and is forwarded to downstream / db-wake calls.
When an OpenTelemetry span is active, the id is joined to the span's `trace_id`
via an injectable provider — wire it once with `setTraceIdProvider` (see
`@knext/core/adapters/tracing`'s `installTraceIdProvider`) so logs and traces
share one id.

```ts
import { beginRequest, runWithRequestContext, setTraceIdProvider } from '@knext/lib/context';

const ctx = beginRequest(request.headers);
runWithRequestContext(ctx, () => handle(request));
```

Exports: `beginRequest`, `createRequestContext`, `runWithRequestContext`,
`getRequestContext`, `getCorrelationId`, `getTraceId`, `resolveCorrelationId`,
`isWellFormedCorrelationId`, `readHeader`, `correlationLogFields`,
`correlationHeaders`, `applyCorrelationHeader`, `setTraceIdProvider`,
`resetTraceIdProvider`, `CORRELATION_HEADER`, and the type `RequestContext`.

### `@knext/lib`

The package root re-exports everything from `@knext/lib/clients`,
`@knext/lib/context`, `@knext/lib/health`, and `@knext/lib/logger` for
convenience.

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
