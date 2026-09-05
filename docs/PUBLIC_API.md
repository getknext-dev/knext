# knext Public API reference

This page lists the **supported imports** a knext application may use at build time
and runtime, and the **stability contract** behind them. If an import is listed
here as public, you can rely on it. If it is not listed — or lives under an
`/internal/` path — it is framework wiring with no compatibility guarantee.

Two packages make up the application surface:

- **`@getknext/core`** — your Next.js config type, the deployment adapter, and
  observability wiring.
- **`@getknext/lib`** — runtime helpers your application code calls (database and
  object-store clients, a health check, a logger).

---

## `@getknext/core`

### `@getknext/core`

The configuration type for your `kn-next.config.ts`.

```ts
import type { KnativeNextConfig } from '@getknext/core';

const config: KnativeNextConfig = {
  // storage, cache, queue, infrastructure, scaling, observability, secrets…
};

export default config;
```

Exported types: `KnativeNextConfig`, `StorageConfig`, `StorageProvider`,
`CacheConfig`, `CacheProvider`, `RedisCacheConfig`,
`QueueConfig`, `QueueProvider`, `KafkaQueueConfig`, `NoQueueConfig`,
`InfrastructureConfig`, `PostgresConfig`, `RedisInfraConfig`, `MinioInfraConfig`,
`ScalingConfig`, `ObservabilityConfig`, `SecretsConfig`, `SecretRef`.

### `@getknext/core/adapter`

The official Next.js deployment adapter. Wire it into your Next.js config so the
build produces a knext-deployable output.

```ts
// next.config.ts — Next.js 16.2+ (adapterPath is top-level config)
export default {
  adapterPath: '@getknext/core/adapter',
};
```

On Next.js 16.0.x–16.1.x the option lives under `experimental` instead
(`experimental: { adapterPath: '@getknext/core/adapter' }`). The 16.2+ config
loader auto-migrates the old `experimental` key (with a warning), but 16.0.x
does **not** recognize the top-level form — match the form to your Next.js
version.

Signature: `default` export — a Next.js deployment adapter object.

### `@getknext/core/adapters/otel-config`

Resolves OpenTelemetry options from the environment for your
`instrumentation.ts`. Tracing is off unless an endpoint is configured, so
unconfigured apps pay nothing.

```ts
import { resolveOtelOptions } from '@getknext/core/adapters/otel-config';

const otel = resolveOtelOptions(); // OtelOptions | null
```

Exports: `resolveOtelOptions(): OtelOptions | null`, and the types `OtelOptions`,
`OtelEnv`.

### `@getknext/core/adapters/tracing`

OpenTelemetry spans for the cold, DB-backed request path — the wake latency that
auto-instrumentation does not otherwise capture — emitted **automatically** on
the real request path via two hooks you wire once in `instrumentation.ts` (only
when tracing is enabled; a zero-overhead no-op otherwise):

- `ColdStartSpanProcessor` — pass to `registerOTel({ spanProcessors: [...] })`.
  It opens `knext.cold_start` under the first inbound request span (the app boot
  / first-request wake), once.
- `instrumentPoolForDbWake` — install via `@getknext/lib/clients`'
  `setPoolInstrumentor`. It spans each pool's first `connect()` (the database
  0→1 wake) as `knext.db_wake`, nested in the request trace.

Both nest inside the active request trace, so one cold request yields a single
trace showing where the time went. `installTraceIdProvider()` returns the
provider you pass to `@getknext/lib`'s `setTraceIdProvider` so log lines and spans
share one `trace_id`. `withColdStartSpan` / `withDbWakeSpan` remain for manual
bracketing of a specific span of work.

```ts
import {
  ColdStartSpanProcessor,
  instrumentPoolForDbWake,
} from '@getknext/core/adapters/tracing';
import { setPoolInstrumentor } from '@getknext/lib/clients';

registerOTel({ serviceName, spanProcessors: ['auto', new ColdStartSpanProcessor()] });
setPoolInstrumentor(instrumentPoolForDbWake);
```

Exports: `ColdStartSpanProcessor`, `instrumentPoolForDbWake(pool, role)`,
`withColdStartSpan(attrs, fn)`, `withDbWakeSpan(fn)`,
`activeTraceId(): string | undefined`, `installTraceIdProvider()`, the types
`ColdStartAttrs`, `KnextSpanProcessor`, and the span-name constants
`COLD_START_SPAN_NAME`, `DB_WAKE_SPAN_NAME`, `TRACER_NAME`.

### `@getknext/core/adapters/metrics`

Prometheus golden-signal, cold-start and DB-wake metrics for a `NextApp`,
derived from the **same** core-owned OTel hooks as tracing (no app route-handler
wiring). `GoldenSignalMetricsProcessor` (pass to `registerOTel({ spanProcessors })`)
turns each inbound HTTP SERVER span into request rate / error rate / latency /
saturation series; `recordColdStart` / `recordDbWake` bump the cold-start and
DB-wake counters from the tracing hooks. The metrics live in a core-owned
registry served on a localhost-only child port; the runtime supervisor's `:9091`
(the operator's scrape target) merges it in. Because they ride the OTel spans,
they share tracing's default-off gate.

```ts
import {
  GoldenSignalMetricsProcessor,
  initRuntimeMetrics,
  recordColdStart,
  recordDbWake,
  startChildMetricsServer,
} from '@getknext/core/adapters/metrics';
import { Registry } from 'prom-client';

const metrics = initRuntimeMetrics(new Registry());
startChildMetricsServer(metrics.registry);
registerOTel({
  serviceName,
  spanProcessors: [
    'auto',
    new ColdStartSpanProcessor(undefined, (ms) => recordColdStart(metrics, ms)),
    new GoldenSignalMetricsProcessor(metrics),
  ],
});
```

Exports: `initRuntimeMetrics(registry, app?)`, `createMetricsRegistry(registry, app)`,
`GoldenSignalMetricsProcessor`, `recordColdStart(metrics, wakeMs)`,
`recordDbWake(metrics, role, wakeMs)`, `startChildMetricsServer(registry, port?, host?)`,
`fetchChildMetrics(port?, host?, timeoutMs?)`, `mergeExposition(sources)`,
`statusClass(status)`, `getRuntimeMetrics()`, the `KnextMetrics` type, the
`CHILD_METRICS_PORT` constant, and the metric-name constants
(`HTTP_REQUESTS_TOTAL_METRIC`, `HTTP_REQUEST_DURATION_METRIC`,
`HTTP_INFLIGHT_METRIC`, `COLDSTART_TOTAL_METRIC`, `COLDSTART_DURATION_METRIC`,
`DB_WAKE_TOTAL_METRIC`, `DB_WAKE_DURATION_METRIC`).

### `@getknext/core/adapters/correlation-response`

Automatic **response-echo** of `x-request-id`. The correlation layer establishes
the request correlation id on the OTel Context and correlates logs from it, but
does not echo the id back on the HTTP response — `@vercel/otel` exposes no inbound
response hook and knext-core does not own the app's response chain.
`installCorrelationResponseEcho()` patches `http.ServerResponse.prototype` (the
same mechanism as the cache-control normalizer) so that at the header-flush point
the response carries `x-request-id` = the **active** correlation id (read from the
same OTel Context the logger mixin uses), **only if** it is present and the app
has not already set it. The id is validated against the correlation-id charset
(`isWellFormedCorrelationId`) **twice**: once when it is read off the OTel
Context (the shared reader every consumer of the id goes through, so an
ill-formed value behaves as if no id was seeded — in logs, on the request span,
and here), and again immediately before stamping: an id that fails the
well-formedness rules is never echoed — the header is left unset.
Node-only (touches `node:http`), so wire it exclusively
from the Node path of `instrumentation.ts`, and only when tracing is on. It is
fail-open, idempotent, and default-off.

```ts
import { installCorrelationResponseEcho } from '@getknext/core/adapters/correlation-response';

// In the NEXT_RUNTIME === 'nodejs' branch, after registerOTel(...) with the
// CorrelationContextPropagator, and only when tracing is enabled:
installCorrelationResponseEcho();
```

Exports: `installCorrelationResponseEcho(deps?)`, the `CorrelationResponseDeps`
type, and the `CORRELATION_RESPONSE_INSTALLED` idempotency symbol.

### `@getknext/core/adapters/cache-handler`

The ISR / Redis cache handler. Next.js requires its `cacheHandler` option to be a
**file path**, so each app ships a thin local `cache-handler.js` that re-exports
this module — keeping the cache logic in the framework so fixes apply everywhere.

```js
// cache-handler.js (at your app root)
export { default } from '@getknext/core/adapters/cache-handler';
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

### `@getknext/core/validate`

Validates a `kn-next.config.ts` against the **exact same rules** the `kn-next`
deploy step applies. Use it as a config-quality gate in your own CI — call it in
a test or a build script so a bad deploy config fails fast, before it reaches the
cluster.

```ts
import { validateConfig, ConfigValidationError } from '@getknext/core/validate';
import type { KnativeNextConfig } from '@getknext/core';
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

## `@getknext/lib`

All `@getknext/lib` subpaths are public application API.

### `@getknext/lib/clients`

Lazily-constructed clients for your zone's own data stores. Connection details
come from the environment (`DATABASE_URL`, object-store credentials) — never
hardcode them.

```ts
import { getDbPool, getMinioClient } from '@getknext/lib/clients';

const pool = getDbPool();        // pg.Pool
const minio = getMinioClient();  // Minio.Client
```

Exports:
- `getDbPool(): Pool` — a PostgreSQL connection pool (`pg`).
- `getDbPoolRO(): Pool | null` — a read-only pool over `DATABASE_URL_RO`, or
  `null` when no read replica is configured.
- `closeDbPool()` / `closeDbPoolRO()` — drain + close the pools (SIGTERM path).
- `getMinioClient(): Minio.Client` — an S3/MinIO-compatible object-store client.
- `getCerbosClient(): Cerbos` — a Cerbos authorization client.
- `setPoolInstrumentor(fn)` / `resetPoolInstrumentor()` — a dependency-inversion
  seam (this package stays OTel-free) invoked once per pool as it is created, so
  an OTel-aware layer can wrap the first connect for a `knext.db_wake` span (see
  `@getknext/core/adapters/tracing`'s `instrumentPoolForDbWake`). Default is a no-op.

### `@getknext/lib/health`

Two health checks with different jobs:

- **`checkShallowHealth()` — readiness/liveness.** Returns healthy whenever the
  process/server is up, WITHOUT dialing Postgres or Redis. This is what backs
  your Knative readiness + liveness probes (serve it at `/api/health`). Gating
  readiness on a scale-to-zero DB's reachability defeats scale-to-zero — an
  asleep/waking database is normal, and a deep check would flap readiness on
  every cold wake.
- **`checkDeepHealth()` — observability only.** Verifies connectivity to core
  dependencies (Postgres, Redis) for monitoring/alerting. Serve it at a separate
  route (e.g. `/api/health/deep`) and do NOT wire it to a probe. It is
  wake-aware: a connection-refused/timeout against a scale-to-zero DB is
  classified `waking` (transient, not a fault); a reachable-but-erroring query
  is `down`; a cache blip is `degraded`. Its cluster timeout is configurable via
  `HEALTH_DEEP_TIMEOUT_MS` (default 8000ms, aligned with the DB wake budget).

```ts
import { checkShallowHealth, checkDeepHealth } from '@getknext/lib/health';

// /api/health — readiness/liveness (no DB dial)
const ready = checkShallowHealth(); // ShallowHealthStatus, always { status: 'ok' }

// /api/health/deep — observability only
const deep = await checkDeepHealth(); // HealthStatus
```

Exports:
- `checkShallowHealth(): ShallowHealthStatus`
- `checkDeepHealth(): Promise<HealthStatus>`
- `ShallowHealthStatus` — `{ status: 'ok'; timestamp: string; check: 'shallow' }`.
- `HealthStatus` — `{ status: 'ok' | 'degraded' | 'down' | 'waking'; timestamp:
  string; checks: { postgres: 'up' | 'down' | 'waking' | 'unconfigured'; redis:
  'up' | 'down' | 'unconfigured' } }`.

### `@getknext/lib/logger`

A shared JSON logger (`pino`) — structured JSON in production, pretty output in
development.

```ts
import { logger } from '@getknext/lib/logger';

logger.info({ msg: 'ready' });
```

Exports: `logger` — a `pino.Logger`.

### `@getknext/lib/context`

Request correlation for the runtime path. Each request carries an ambient
correlation id (adopted from a well-formed inbound `x-request-id`, else
generated) that flows through `AsyncLocalStorage`, lands on every structured log
line, is echoed on the response, and is forwarded to downstream / db-wake calls.
When an OpenTelemetry span is active, the id is joined to the span's `trace_id`
via an injectable provider — wire it once with `setTraceIdProvider` (see
`@getknext/core/adapters/tracing`'s `installTraceIdProvider`) so logs and traces
share one id.

```ts
import { beginRequest, runWithRequestContext, setTraceIdProvider } from '@getknext/lib/context';

const ctx = beginRequest(request.headers);
runWithRequestContext(ctx, () => handle(request));
```

Exports: `beginRequest`, `createRequestContext`, `runWithRequestContext`,
`getRequestContext`, `getCorrelationId`, `getTraceId`, `resolveCorrelationId`,
`isWellFormedCorrelationId`, `readHeader`, `correlationLogFields`,
`correlationHeaders`, `applyCorrelationHeader`, `setTraceIdProvider`,
`resetTraceIdProvider`, `CORRELATION_HEADER`, and the type `RequestContext`.

### `@getknext/lib`

The package root re-exports everything from `@getknext/lib/clients`,
`@getknext/lib/context`, `@getknext/lib/health`, and `@getknext/lib/logger` for
convenience.

```ts
import { getDbPool, checkDeepHealth, logger } from '@getknext/lib';
```

---

## Internal subpaths — NOT supported

The following `@getknext/core` subpaths are **framework wiring** used by the knext
runtime, CLI, and operator. They live under an `/internal/` prefix so the
boundary is visible in the import path itself. **Do not import them from
application code** — they have no stability guarantee and may change or disappear
in any release, including patch releases.

| Internal import | What it is |
| --- | --- |
| `@getknext/core/internal/next-adapter` | The adapter implementation behind `@getknext/core/adapter`; import the public alias instead. |
| `@getknext/core/internal/node-server` | The standalone server entry the runtime spawns. **Generated-file-referenced** (see below). |
| `@getknext/core/internal/loader` | Internal config loader. |
| `@getknext/core/internal/logger` | Internal CLI/runtime logger (apps use `@getknext/lib/logger`). |
| `@getknext/core/internal/cli-validate` | CLI config validation helpers. |
| `@getknext/core/internal/cli-shared` | Shared CLI utilities. |
| `@getknext/core/internal/cache-drain` | Cache-write registry the runtime drains on shutdown; wiring, not an app API. |
| `@getknext/core/internal/vinext-cache-adapter` | The data-cache adapter factory the scaffold's `vite.config.ts` hands to the `vinext()` plugin (Redis ISR/data cache). **Generated-file-referenced** (see below). |
| `@getknext/core/internal/vinext-image-optimizer` | The `/_next/image` intercept the scaffolded runtime entry imports. **Generated-file-referenced** (see below). |
| `@getknext/core/internal/cache-control-normalize` | Deployed-platform `Cache-Control` preload (CJS, loaded with `--require`). |
| `@getknext/core/internal/bun-keepalive-guard` | Bun ≤1.3.x keep-alive mitigation preload; Node-inert. |
| `@getknext/core/internal/sandbox-fetch-debug` | Opt-in sandbox-fetch instrumentation (compat investigation lane). |
| `@getknext/core/internal/sandbox-fetch-realm-debug` | In-realm variant of the sandbox-fetch instrumentation. |
| `@getknext/core/internal/standalone-bun-exports` | Post-build standalone-exports heal used by the deploy pipeline. |
| `@getknext/core/internal/credential-scope` | The CI credential classifier the GitHub Action preflight reads. |

### Generated-file-referenced internal subpaths

Three internal subpaths are imported by **files knext generates into user
projects** (`kn-next create` / `turbo gen zone`): `internal/vinext-cache-adapter`
(the scaffolded `vite.config.ts`), `internal/vinext-image-optimizer` (the
scaffolded runtime entry), and `internal/node-server` (deploy wiring). The
`/internal/` prefix still means "not an API you call" — but because already
scaffolded apps reference these by name, they carry a **real obligation** the
other internal subpaths do not: **no rename or removal without a minor version
bump, a changelog entry, and a scaffold/codemod migration path** for existing
apps. Breaking one of these silently breaks every previously generated project
on its next dependency update.

`@getknext/lib` exposes no internal subpaths — its entire surface is public.

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

### The `NextApp` CRD is versioned separately

The semver rules above cover the **npm packages only**. The `NextApp` custom
resource the CLI emits and the operator reconciles is on its own version axis —
the Kubernetes `v1alpha1` → `v1beta1` → `v1` ladder — and it ships with the
**operator image**, not with an npm package. A major version of `@getknext/core`
does not graduate the CRD, and graduating the CRD does not force a major npm
version.

In short: write `apiVersion: apps.kn-next.dev/v1alpha1`. Within that version the
schema is **additive-only**, so a `NextApp` that applies today keeps applying
against later operators. There is **no conversion webhook**, so if the version
string ever changes, hand-authored and GitOps-managed manifests must be updated
by hand.

**Additive-only covers the schema, not behaviour.** A field's *meaning* is not
frozen: a field for a capability that has not shipped may become **inert** — the
manifest still applies and the operator still reconciles the app, but the field
stops doing anything. When that happens it is announced in the release notes and
surfaced on the resource as a status condition (and an event), never as a
rejected write. `spec.revalidation.provisionKafkaSource` is the current example.
The distinction is deliberate and is spelled out in
[the CRD versioning policy](adr/0017-crd-stays-v1alpha1-conversion-webhook-deferred.md):
narrowing what the schema *accepts* needs a new API version, while changing what
an accepted value *does* does not.

The declared version, the full guarantee that comes with it, and what would make
us move off `v1alpha1` are written up in
[the CRD versioning policy](adr/0017-crd-stays-v1alpha1-conversion-webhook-deferred.md).

**Upgrade order: the operator (and its CRD) first, then the CLI.** An older CLI
against a newer CRD is always valid; the reverse is unsupported. See
[the release and upgrade policy](adr/0020-release-channels.md) and
`docs/RELEASING.md` § "Upgrade order".
