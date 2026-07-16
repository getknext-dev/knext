# knext distributed tracing (OpenTelemetry)

How a single cold, database-backed request becomes **one trace** that shows
exactly where the time went — activator wake, app boot, cache, and the
`scale-zero-pg` database wake — and how that trace joins the
[correlation-ID logging](./logging.md) so a `correlation_id` log query and a
`trace_id` trace query land on the same request.

Related: [structured logging + correlation IDs](./logging.md) ·
[SLOs / SLIs](./slos.md) · [OTel tracing backend](../adr/0012-otel-tracing-backend.md).

## 1. What tracing buys you

The latency that hides on a knext request is the cold path:

```
activator wake → app boot (cold start) → ISR/cache → DB wake (0→1) → query → render
```

Auto-instrumentation (`@vercel/otel`) captures the inbound HTTP handler and
`fetch`. It does **not** bundle `pg` instrumentation, and it emits nothing for
the knext-specific waits — the app boot / first-request wake, and the
`scale-zero-pg` 0→1 scale + first connect. knext adds two spans that fill exactly
that gap, and — this is the important part — they are emitted **automatically on
the real request path with no app route-handler wiring** (see §4 for how):

| Span | Emitted by | Covers |
| --- | --- | --- |
| *(request)* | `@vercel/otel` (auto) | the inbound HTTP handler |
| `knext.cold_start` | `ColdStartSpanProcessor` (auto) | app boot / first-request wake |
| `knext.db_wake` | pg-pool connect wrapper (auto) | `scale-zero-pg` 0→1 scale + first connect |

They compose into one trace (`knext.cold_start` and `knext.db_wake` are children
of the request span, so they share its `traceId`):

```
request  (auto, HTTP)
├─ knext.cold_start          knext.cold_start=true  knext.wake_ms=2500
└─ knext.db_wake             knext.db_role=writer   knext.wake_ms=2480
```

## 2. Enabling tracing (default-OFF)

Tracing is **off by default** — an app that has not opted in initializes no OTel
SDK, exporter, or span processors and pays nothing (ADR-0012). Turn it on with
one config field; the operator does the env plumbing (it is the single source of
truth for pod env):

```ts
// kn-next.config.ts
export default defineConfig({
  observability: {
    tracing: {
      enabled: true,
      // Self-hostable OTLP collector — NEVER a SaaS default (see §4).
      endpoint: 'http://otel-collector.monitoring:4317',
      sampleRate: 1, // head-based; 0..1 (1 = sample all)
    },
  },
});
```

This lands on the `NextApp` CR as `spec.observability.tracing`; the operator
appends to the pod env:

| Env var | From | Meaning |
| --- | --- | --- |
| `OTEL_TRACING_ENABLED=true` | `enabled` | the default-off gate — the ONLY switch that turns the SDK on |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` | OTLP/gRPC collector target (in-cluster) |
| `OTEL_TRACES_SAMPLER_ARG` | `sampleRate` | head-based sampling fraction |

The app never reads config directly — only env. `resolveOtelOptions(process.env)`
(`@knext/core/adapters/otel-config`) returns `null` unless
`OTEL_TRACING_ENABLED === 'true'`, and `instrumentation.ts` returns *without*
initializing OTel on `null`.

## 3. The exporter (self-hostable OTLP only)

Transport is **OTLP/gRPC to a cluster-local collector** — the default endpoint
`http://otel-collector.monitoring:4317` has no public ingress. Recommended
self-hostable backends:

- **Grafana Tempo** (recommended) — OTLP-native, shares your existing Grafana,
  first-class trace→metric exemplars.
- **Jaeger** (alternative) — OTLP receiver, separate UI.

SaaS exporters (Honeycomb, Datadog, Vercel's OTel integrations, …) are
**rejected as a default** — they reintroduce lock-in. You may still point
`endpoint` at any OTLP backend you operate. The collector/Tempo deployment
itself is not provisioned by knext today; knext only *emits* OTLP and assumes a
collector at the endpoint.

## 4. Automatic wiring (`@knext/core/adapters/tracing`)

Both knext spans are emitted **automatically** — you do **not** hand-open spans
in your route handlers. When tracing is enabled, knext's `instrumentation.ts`
registers two knext-core-owned hooks; when tracing is disabled neither is
installed, so the cost is zero (OTel's no-op tracer records nothing).

**`knext.cold_start` — a span processor.** `ColdStartSpanProcessor` is passed to
`registerOTel({ spanProcessors: ['auto', new ColdStartSpanProcessor()] })`. Its
`onStart` fires for the **first** inbound HTTP server span the process sees after
boot and opens a `knext.cold_start` child under it, recording
`knext.wake_ms` = time from process boot to that first request. Every request
after the first is a no-op. Because it parents under the request span, the
cold-start span lands in the same trace.

**`knext.db_wake` — a pg-pool connect wrapper.** `instrumentPoolForDbWake` is
installed once via `@knext/lib/clients`' `setPoolInstrumentor` seam. The lib
(which stays OTel-free) calls it for every pool it creates; the wrapper spans the
pool's **first** `connect()` — the scale-zero-pg 0→1 wake — as `knext.db_wake`
(attributes `knext.db_role` = `writer`/`reader`, `knext.wake_ms`). It opens in
the caller's active context, so inside a request handler it nests under the
request span. Warm connects from the ready pool are untouched: the span marks the
wake, not every checkout.

Both are wired in `instrumentation.ts` (only when tracing is enabled):

```ts
import {
  ColdStartSpanProcessor,
  installTraceIdProvider,
  instrumentPoolForDbWake,
} from '@knext/core/adapters/tracing';
import { setPoolInstrumentor } from '@knext/lib/clients';
import { setTraceIdProvider } from '@knext/lib/context';
import { registerOTel } from '@vercel/otel';

registerOTel({
  serviceName,
  spanProcessors: ['auto', new ColdStartSpanProcessor()], // knext.cold_start
});
setPoolInstrumentor(instrumentPoolForDbWake); // knext.db_wake on first connect
setTraceIdProvider(installTraceIdProvider());  // log ↔ trace join (§5)
```

An app that uses `@knext/lib`'s pools (`getDbPool` / `getDbPoolRO`) or the
`@knext/db` SDK gets `knext.db_wake` for free — no query-site changes.

### Manual bracketing (optional)

For code paths outside the automatic hooks, `withColdStartSpan(attrs, fn)` and
`withDbWakeSpan(fn)` bracket a specific span of work by hand. Same zero-overhead
no-op posture when tracing is disabled; both nest under the active request span.

```ts
import { withDbWakeSpan } from '@knext/core/adapters/tracing';
const rows = await withDbWakeSpan(() => db.query('select 1'));
```

## 5. Joining logs to traces (C4 correlation layer)

The trace and its logs share one `trace_id`. The tracing module exposes the
active trace id to the [correlation layer](./logging.md) via the injectable
`setTraceIdProvider` seam, so no OTel dependency leaks into `@knext/lib`:

```ts
// instrumentation.ts — wired once at startup, only when tracing is enabled.
import { installTraceIdProvider } from '@knext/core/adapters/tracing';
import { setTraceIdProvider } from '@knext/lib/context';

setTraceIdProvider(installTraceIdProvider());
```

After this, every in-request log line carries the active span's `trace_id`
alongside its `correlation_id` (see [logging.md §3](./logging.md)). A log query
by `correlation_id` and a trace query by `trace_id` then resolve to the same
request — the bridge between the two observability planes. When tracing is
disabled the provider is never installed, so the correlation layer stays on its
default no-trace behavior (zero overhead).

## 6. Verifying

The behavior is proven with the OTel SDK's in-memory span exporter (no live
collector):

- `packages/kn-next/src/__tests__/tracing-integration.test.ts` — the acceptance
  proof. It drives a simulated cold, DB-backed request through the **automatic**
  hooks (`ColdStartSpanProcessor` + the pool `connect` wrapper, exactly as
  `instrumentation.ts` wires them) and asserts one trace containing
  HTTP → `knext.cold_start` + `knext.db_wake`, correctly nested — with no
  hand-opened spans. It also proves cold_start fires only on the first request,
  db_wake only on the first (0→1) connect, and zero spans when tracing is off.
- `packages/kn-next/src/__tests__/tracing.test.ts` — the helper units
  (`withColdStartSpan` / `withDbWakeSpan`, attributes, nesting, `trace_id` join).
- `packages/lib/src/__tests__/clients-instrumentor.test.ts` — the `@knext/lib`
  `setPoolInstrumentor` seam (invoked once per pool, fail-open, default no-op).

On a live cluster, send one cold request and confirm a single trace in
Tempo/Jaeger with `knext.cold_start` and `knext.db_wake` nested under the HTTP
span.
