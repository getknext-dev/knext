# knext distributed tracing (OpenTelemetry)

How a single cold, database-backed request becomes **one trace** that shows
exactly where the time went — activator wake, app boot, cache, and the
`scale-zero-pg` database wake — and how that trace joins the
[correlation-ID logging](./logging.md) so a `correlation_id` log query and a
`trace_id` trace query land on the same request.

Related: [structured logging + correlation IDs](./logging.md) ·
[SLOs / SLIs](./slos.md) · [Prometheus metrics catalog](./metrics.md) (the
`knext_coldstart_*` / `knext_db_wake_*` counters mirror these spans) ·
[OTel tracing backend](../adr/0012-otel-tracing-backend.md).

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
| `knext.db_wake` | pg-pool acquire wrapper (auto) | `scale-zero-pg` 0→1 scale + first `query()`/`connect()` |

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

**`knext.db_wake` — a pg-pool acquisition wrapper.** `instrumentPoolForDbWake` is
installed once via `@knext/lib/clients`' `setPoolInstrumentor` seam. The lib
(which stays OTel-free) calls it for every pool it creates; the wrapper spans the
pool's **first client acquisition — via `pool.query(...)` OR `pool.connect()`** —
the scale-zero-pg 0→1 wake — as `knext.db_wake` (attributes `knext.db_role` =
`writer`/`reader`, `knext.wake_ms`). It opens in the caller's active context, so
inside a request handler it nests under the request span. Both entry points share
one per-pool latch that is consumed on the **first _successful_ acquisition**, so
the wake metric fires **exactly once** no matter which path runs first; warm
queries/connects from the ready pool are untouched — the span marks the wake, not
every checkout.

> Why both paths (#345): the common app pattern is `db.query(...)`, never
> `db.connect()`. node-pg's `Pool.query()` acquires a client through an internal
> path that does **not** call the public `connect()`, so wrapping `connect` alone
> left `knext.db_wake` (and the `knext_db_wake_*` metric) dead for typical usage.
> The wrapper now covers `query` too, preserving every pg overload (text, params,
> config object, with/without callback) and staying fail-open.

> Why the latch consumes on **success only** (#336): the previous code flipped
> the `waked` latch _before_ awaiting `connect()`/`query()`, so if the very first
> 0→1 acquisition **rejected** (the scale-zero-pg cold case: gateway still waking
> / connect timeout) the failed attempt consumed the latch and the successful
> **retry** — the real wake — was recorded as a warm no-op. `knext_db_wake_*` then
> measured the failed attempt's latency, not the actual wake, and lost the metric
> precisely on the slow/failure-prone cold path. The latch is now consumed **only
> when an acquisition resolves successfully**: a failed attempt is still
> error-spanned (`knext.db_wake` with ERROR status) but does **not** steal the
> latch, so the next attempt is treated as the first wake and its success gets the
> span + `knext.wake_ms` + metric. Under concurrency (Node single-threaded), each
> not-yet-warm acquisition opens its own span but the success + metric are recorded
> only by the **first attempt to resolve** (check-then-set on `waked`), so N racing
> first-connects — even one rejecting while another succeeds — yield exactly one
> metric increment and one successful `knext.db_wake` span.

> Why the seam state lives on `globalThis` (#352): every `@knext/lib` seam that
> is SET by `instrumentation.ts` but READ elsewhere on the request path
> (`setPoolInstrumentor` in `@knext/lib/clients`; `setTraceIdProvider` /
> `setCorrelationIdProvider` in `@knext/lib/context`) stores its provider on a
> `Symbol.for('knext.lib.*')` slot on `globalThis` — never a plain module-level
> `let`. In the Next.js **standalone** build `instrumentation.ts` compiles in a
> SEPARATE webpack layer from the app server bundles, and `@knext/lib` is bundled
> (not externalized) into each layer, so `instrumentation-node`'s copy of
> `@knext/lib/clients` and the app server component's copy are two PHYSICAL
> modules with independent module state. A module-level `let` written by the
> instrumentation copy is invisible to the copy `getDbPool()` reads — the pool is
> never wrapped and `knext_db_wake_*` silently never fires (the live #352 defect;
> SpanProcessor-based `golden-signal`/`cold_start` metrics kept working because
> they are passed directly into `registerOTel`, crossing no seam). Anchoring the
> state on the single shared `globalThis` makes set-from-copy-A visible to
> read-from-copy-B regardless of bundling; `Symbol.for` uses the cross-realm
> registry so the key is identical in every copy. **Any future `@knext/lib` seam
> that is installed from `instrumentation.ts` MUST follow this pattern** — see
> `packages/lib/src/__tests__/seam-duplication.test.ts` for the two-instances
> guard. The public API and fail-open / default-off semantics are unchanged.
>
> **CI keeps this fixed (#344):** the unit guard above is complemented by a
> build-artifact gate, `apps/file-manager/standalone-seam-alive.test.ts`, run in
> the `bytecode-cache-reuse` CI job (which already produces the standalone
> build, so no extra build cost). It asserts the `Symbol.for('knext.lib.*')`
> seam keys co-occur in BOTH the instrumentation (writer) chunk AND an app-server
> (reader) chunk of the real `next build --webpack` output, and that `@knext/lib`
> is never added to `serverExternalPackages` (which would re-split the dedup). A
> re-broken seam fails the gate, not the deploy. Since #356 (ADR-0031) this
> guard also **ships with every app generated from the knext template**
> (`turbo gen zone`), parameterized for the generated app name.

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
setPoolInstrumentor(instrumentPoolForDbWake); // knext.db_wake on first query OR connect
setTraceIdProvider(installTraceIdProvider());  // log ↔ trace join (§5)
```

An app that uses `@knext/lib`'s pools (`getDbPool` / `getDbPoolRO`) or the
`@knext/db` SDK gets `knext.db_wake` for free — no query-site changes.

### Edge-runtime safety (REQUIRED for apps with middleware) — #342

Next.js compiles `instrumentation.ts` for **both** the `nodejs` **and** the
`edge` runtimes (any app with a `middleware.ts` triggers an edge build). All of
the wiring above is **Node-only**: `@knext/lib/clients` transitively pulls in
`@cerbos/grpc` (→ `@grpc/grpc-js`, needing `zlib`/`stream`/`net`/`tls`/`fs`),
plus `pg` and `minio`. A **top-level static import** of any of that lands in the
edge bundle and fails the production `next build` with
`Module not found: Can't resolve 'stream' / 'fs' / 'tls' / 'net' / 'zlib'`.

**Apps generated from the knext template (`pnpm generate` / `turbo gen zone`)
inherit the full guarded-instrumentation pair by default (#356, ADR-0031)** —
this section is the reference for what the template emits and why. Hand-rolled
apps must follow the same pattern.

App instrumentation **must guard the Node-only wiring behind
`NEXT_RUNTIME === 'nodejs'`** and load it via a dynamic import, so it never
enters the edge bundle. The canonical pattern (see
`apps/file-manager/src/instrumentation.ts`):

```ts
// instrumentation.ts — EDGE-CLEAN. No top-level import of a Node-only client.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // edge: no-op
  const { registerNode } = await import('./instrumentation-node');
  registerNode();
}
```

The Node-only body (the `registerOTel` / metrics / `setPoolInstrumentor` calls
shown above) lives in `instrumentation-node.ts`, which is only reached on the
nodejs runtime. Because webpack still *statically traces* a dynamic import into
both runtime bundles, `instrumentation-node` must also be excluded from the
**edge** compile via an `IgnorePlugin` scoped to `nextRuntime === 'edge'` — the
nodejs bundle is untouched and keeps the real wiring. The knext runtime runs the
app on Node (the standalone server), so nothing is lost.

**Since #356 (ADR-0031) that `IgnorePlugin` is platform-owned:** the knext
adapter's `modifyConfig` injects it for every app wired through `adapterPath`
(the template wires it by default), composed after any webpack hook the app
still owns — app authors no longer hand-write the webpack hook. An app that
does NOT use the knext adapter (e.g. an external app deployed with `kn-next
deploy` and no `adapterPath` in its `next.config.ts`) must still hand-write the
edge-scoped `IgnorePlugin` in its own `next.config.ts` exactly as
`apps/file-manager` did pre-#356.

A fast static-analysis guard fails the gate if EITHER half of the fence breaks:
(a) `instrumentation.ts` regains a top-level import of a Node-only client
module, OR (b) the adapter wiring disappears (or a hand-written `IgnorePlugin`
reappears in app code). The guard shipped with `apps/file-manager`
(`instrumentation-edge-safe.test.ts`, #344) and now **ships with every generated
app** from the template (#356); the adapter injection itself is unit-guarded in
`@knext/core` (`adapter-edge-ignore-plugin.test.ts`). Both classes must fail the
gate, not the deploy build.

Belt-and-suspenders: the webpack production build itself is a **PR-triggered CI
gate** — `pnpm --filter file-manager build` runs in the `compat-smoke`,
`bytecode-cache-reuse`, and `sigterm-drain-shipped` jobs, so an edge-bundle
regression that slips past the static guard still fails `next build` in CI
before merge (#344).

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
import {
  CorrelationContextPropagator,
  CorrelationSpanProcessor,
  installCorrelationIdProvider,
  installTraceIdProvider,
} from '@knext/core/adapters/tracing';
import { setCorrelationIdProvider, setTraceIdProvider } from '@knext/lib/context';
import { registerOTel } from '@vercel/otel';

registerOTel({
  // Establish the correlation id per request from inbound headers (#346): the
  // propagator's `extract` seeds it onto the OTel Context, which descends to the
  // SERVER span AND every child span (db_wake / cold_start / pg / fetch).
  propagators: ['auto', new CorrelationContextPropagator()],
  // Copy the context-key id onto the SERVER span for trace export (index/echo).
  spanProcessors: ['auto', new CorrelationSpanProcessor()],
  // ...serviceName, other spanProcessors, etc.
});
setTraceIdProvider(installTraceIdProvider());          // trace_id resolver
setCorrelationIdProvider(installCorrelationIdProvider()); // correlation_id resolver
```

After this, every in-request log line carries the active span's `trace_id`
**and** its `correlation_id` — established automatically on the real request
path, with no `runWithRequestContext` handler wrapping (#346; see
[logging.md §3a](./logging.md)). The id rides the **OTel Context** (seeded by the
propagator's `extract`, which adopts/generates it from the inbound
`x-request-id`), so it resolves correctly under **any** span — the SERVER span
and every child span alike (a span *attribute* would not, hence the context key).
The `CorrelationSpanProcessor` mirrors the id onto the SERVER span as
`knext.correlation_id` **for trace export only**; logs read the context key, not
the attribute. A log query by `correlation_id` and a trace query by `trace_id`
then resolve to the same request. When tracing is disabled neither provider,
propagator, nor processor is installed, so the correlation layer stays on its
default no-trace / no-correlation behavior (zero overhead).

## 6. Verifying

The behavior is proven with the OTel SDK's in-memory span exporter (no live
collector):

- `packages/kn-next/src/__tests__/tracing-integration.test.ts` — the acceptance
  proof. It drives a simulated cold, DB-backed request through the **automatic**
  hooks (`ColdStartSpanProcessor` + the pool acquire wrapper, exactly as
  `instrumentation.ts` wires them) and asserts one trace containing
  HTTP → `knext.cold_start` + `knext.db_wake`, correctly nested — with no
  hand-opened spans. It also proves cold_start fires only on the first request,
  db_wake only on the first (0→1) acquisition, and zero spans when tracing is off.
- `packages/kn-next/src/__tests__/tracing-dbwake-query.test.ts` — #345: db_wake
  fires on the `pool.query()` path (the real usage), a shared connect+query latch
  fires exactly once, pg query overloads keep their semantics, and the error/
  fail-open paths never break the query.
- `packages/kn-next/src/__tests__/tracing-dbwake-reject.test.ts` — #336: when the
  first 0→1 acquisition REJECTS and a retry succeeds, the db_wake span + metric
  land on the successful retry (not the failed attempt); failed attempts stay
  error-spanned; exactly-once on success holds across query+connect; and a
  concurrent reject/succeed race yields exactly one successful db_wake span.
- `packages/kn-next/src/__tests__/tracing.test.ts` — the helper units
  (`withColdStartSpan` / `withDbWakeSpan`, attributes, nesting, `trace_id` join).
- `packages/lib/src/__tests__/clients-instrumentor.test.ts` — the `@knext/lib`
  `setPoolInstrumentor` seam (invoked once per pool, fail-open, default no-op).

On a live cluster, send one cold request and confirm a single trace in
Tempo/Jaeger with `knext.cold_start` and `knext.db_wake` nested under the HTTP
span.
