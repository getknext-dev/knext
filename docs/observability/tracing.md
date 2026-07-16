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

Auto-instrumentation (`@vercel/otel`) captures the HTTP handler, `fetch`, and
`pg` **queries**. It does **not** emit a span for the knext-specific waits — the
app boot / first-request wake, and the `scale-zero-pg` 0→1 scale + first connect
that happens *before* the first query. knext adds two manual spans so those show
up in the same trace:

| Span | Emitted by | Covers |
| --- | --- | --- |
| *(request)* | `@vercel/otel` (auto) | the inbound HTTP handler |
| `knext.cold_start` | `@knext/core/adapters/tracing` | app boot / first-request wake |
| `knext.db_wake` | `@knext/core/adapters/tracing` | `scale-zero-pg` 0→1 scale + first connect |
| *(pg query)* | `@vercel/otel` (auto) | the SQL query itself |

They compose into one trace (`knext.cold_start` and `knext.db_wake` are children
of the active request span, so they share its `traceId`):

```
request  (auto, HTTP)
├─ knext.cold_start          knext.cold_start=true  knext.wake_ms=2500
│  └─ knext.db_wake
└─ pg  select …              (auto)
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

## 4. The manual spans (`@knext/core/adapters/tracing`)

`withColdStartSpan` and `withDbWakeSpan` wrap the boot/wake work. Both are a
**zero-overhead no-op when tracing is disabled** — with no registered tracer
provider, OTel's built-in no-op tracer runs the callback with a non-recording
span, so nothing is exported. Both nest under the active request span, so they
appear in the same trace.

```ts
import { withColdStartSpan, withDbWakeSpan } from '@knext/core/adapters/tracing';

// Around app boot / the first-request wake:
const rows = await withColdStartSpan({ cold: isColdBoot, wakeMs }, () =>
  // Around the scale-zero-pg 0→1 wake + first connect (the query itself is
  // already auto-instrumented by @vercel/otel's pg instrumentation):
  withDbWakeSpan(() => db.query('select 1')),
);
```

`withColdStartSpan` records `knext.cold_start` (boolean) and, when supplied,
`knext.wake_ms` (the measured wake duration) so wake latency is attributable per
request.

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

The span behavior is unit-tested with the OTel SDK's in-memory span exporter
(`packages/kn-next/src/__tests__/tracing.test.ts`): the no-op posture when
disabled, the `knext.cold_start` name + attributes, the parent/child nesting
under a request span, the `db_wake` span in the same trace, and the
`trace_id`↔context join. On a live cluster, send one cold request and confirm a
single trace in Tempo/Jaeger with `knext.cold_start` → `knext.db_wake` nested
under the HTTP span.
