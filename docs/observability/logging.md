# knext structured logging + correlation IDs

How knext logs are shaped so they are machine-parseable, correlated by a request
id, and joinable to traces (ADR-0012). This is the standard for both the runtime
(app) and the operator; the correlation layer ships in `@knext/lib`.

Related: [distributed tracing](./tracing.md) · [Prometheus metrics catalog](./metrics.md) · [SLOs / SLIs](./slos.md) · [OTel tracing backend](../adr/0012-otel-tracing-backend.md).

## 1. Structured (JSON) log schema

Logs are **line-delimited JSON** (one object per line) in production — the format
a collector (Loki via Promtail/Alloy, Fluent Bit, Vector, Datadog, Elastic)
ingests without a regex parser. In local dev, `pino-pretty` renders the same
records for humans. The runtime logger is `@knext/lib/logger`
(`packages/lib/src/logger/index.ts`); the CLI/framework logger is
`@knext/kn-next`'s `logger`.

Every line carries these load-bearing fields:

| Field | Source | Meaning |
| --- | --- | --- |
| `level` | logger | string label (`debug`/`info`/`warn`/`error`/`fatal`), never a pino number |
| `time` | logger | epoch millis |
| `app` | `KN_APP_NAME` (fallback `kn-next`) | which app/service emitted it |
| `env` | `NODE_ENV` | deployment environment |
| `msg` | call site | human message |
| `correlation_id` | request context / active OTel span (§3) | present on every line emitted **during a request** (automatic when tracing is on) |
| `trace_id` | active OTel span (§3) | present when tracing is enabled and a span is active |

Secrets are redacted at the logger: `req.headers.authorization`,
`req.headers.cookie`, `password`, `token` serialize as `[Redacted]`. Never log a
`DATABASE_URL`, bearer token, or secret value (`.claude/rules/security.md`).

### Log levels

| Level | Use for |
| --- | --- |
| `debug` | verbose local/dev diagnostics; off in prod by default |
| `info` | normal lifecycle (startup, request handled, scale events) — **prod default** |
| `warn` | recoverable / degraded (retry, fallback, non-fatal misconfig) |
| `error` | a request/operation failed |
| `fatal` | the process cannot continue and is exiting |

Set the floor with `LOG_LEVEL` (default `info` in production, `debug` in dev).

### Example log line

```json
{"level":"info","time":1731800000123,"app":"zone-checkout","env":"production","correlation_id":"7b1c2f9a-3e4d-4a1b-9c2e-0f5a6b7c8d9e","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","msg":"order placed","orderId":"ord_42"}
```

## 2. The correlation-ID contract

- **Header:** `x-request-id` (lowercase; matches Node/undici header keys).
- **Adopt-or-generate:** an inbound `x-request-id` is **adopted only when
  well-formed** — a safe token (`[A-Za-z0-9._-]`, 1–128 chars: uuid, ULID, W3C
  trace id, or a short prefixed id all qualify). Anything else (whitespace,
  control chars, markup, oversized, empty) is **not trusted** and a fresh uuid
  is generated. The id is a log/propagation field, so untrusted structure is a
  log-injection / cardinality hazard.
- **One id per request**, ambient for the whole request — no need to thread it
  through function signatures. On the real request path this is established
  **automatically** (§3a): knext-core does not own the Next.js route-handler
  chain, so it rides the per-request OTel context `@vercel/otel` already
  propagates rather than requiring the app to wrap every handler.
- **Trace tie-in:** when an OTel span is active the correlation id is joined to
  the span's `trace_id`, so a log query by `correlation_id` and a trace query by
  `trace_id` land on the same request.
- **Propagation:**
  - **Response echo — automatic on the real path (default when tracing is on).**
    knext-core echoes `x-request-id` on the HTTP **response** automatically, with
    no app handler wrapping (#350). The `correlation-response` adapter
    (`installCorrelationResponseEcho()`, wired once in `instrumentation.ts`'s Node
    path when tracing is on) patches `http.ServerResponse.prototype` — the same
    core-owned seam the deploy-mode cache-control normalizer uses — so at the
    header-flush point the response carries `x-request-id` = the **active**
    correlation id (read from the same OTel Context the logger mixin resolves
    from). It only fills the header when the id is present and the app has **not**
    already set it (an app-set value always wins), is **fail-open** (a throw never
    breaks the response), **idempotent**, and **default-off** (installed only when
    tracing is enabled). Defense-in-depth (#368): the id is **re-validated**
    against the correlation-id charset immediately before stamping, so a value
    that fails the §2 well-formedness rules is **never** echoed — the header is
    simply left unset rather than stamping raw bytes. (The same predicate is
    also applied when the id is **read** off the Context — #401, §3a — so the
    logger mixin and span attribute are guarded by the one rule.) So a client
    that sends (or is assigned) an `x-request-id` gets it back on the response,
    joinable to the correlated logs/trace.
    `@knext/lib` still ships `applyCorrelationHeader(...)` for routes the app owns
    and explicit `runWithRequestContext` paths (§3).
  - **Downstream / db-wake:** forward `x-request-id` on outbound calls so a
    request is traceable app → db-wake → downstream. Across the Postgres hop
    (a TCP wake-on-connect gateway that carries no HTTP headers) the join key is
    the OTel `trace_id` (pg is auto-instrumented under ADR-0012); the
    `correlation_id`/`trace_id` pair on the app's log lines around the DB call
    stitches the two layers together.

## 3a. Automatic correlation on the real request path (default when tracing is on)

You do **not** need to wrap handlers to get correlated logs. When tracing is
enabled (`spec.observability.tracing.enabled`, ADR-0012), knext-core establishes
the correlation id automatically for every inbound request — no app code, no
`runWithRequestContext` in your route handlers (#346).

How it works (all core-owned, wired once in `instrumentation-node.ts`). The id
rides the **OTel Context**, not a single span — that is what makes it correct for
log lines emitted under *any* span in the request, including child spans:

1. **Establish (per request):** a `CorrelationContextPropagator`
   (`@knext/core/adapters/tracing`), registered via
   `registerOTel({ propagators: ['auto', new CorrelationContextPropagator()] })`.
   `@opentelemetry/instrumentation-http` (what `@vercel/otel` uses) runs
   `propagation.extract(activeContext, requestHeaders)` for each inbound request
   and starts the SERVER span **under** the returned context. Our `extract`
   **adopts a well-formed `x-request-id` (else generates one)** by the §2 rules
   and puts it on the Context under a private key.
2. **Carry:** `@vercel/otel` installs an `AsyncLocalStorageContextManager`, so
   the extracted Context is the **active Context** for the whole request (across
   `await`s). OTel Context values **descend to every child span by
   construction** (a child's context derives from its parent's) — so the id is
   present whether the innermost active span is the SERVER span, `knext.db_wake`,
   `knext.cold_start`, an app `startActiveSpan`, or an auto-instrumented pg/fetch
   span. (A span **attribute** would *not* have this property — it lives only on
   the span it is set on — which is why logs resolve from the context key, not an
   attribute.)
3. **Resolve (at log time):** `@knext/lib`'s logger `mixin` reads
   `correlation_id` from the active **Context key** and `trace_id` from the
   active span, via two injected providers — `installCorrelationIdProvider()` /
   `installTraceIdProvider()`, installed via `setCorrelationIdProvider` /
   `setTraceIdProvider`. `@knext/lib` stays OTel-free (dependency-inversion seam);
   the OTel-aware `@knext/core` supplies the resolvers.

A `CorrelationSpanProcessor` additionally copies the context-key id onto the
inbound SERVER span as the `knext.correlation_id` attribute **for trace export
only** (so a backend can index/echo it on the request span); logs never read that
attribute.

**Read-path validation (#401, defense-in-depth).** All three consumers of the
context key — the logger mixin, the `CorrelationSpanProcessor` SERVER-span
attribute, and the response echo — read it through ONE shared reader,
`correlationIdFromContext`, which **re-validates** the value against the §2
well-formedness rules on every read. The propagator only ever writes validated
ids, but the `withCorrelationId` seam writes the key **verbatim**; validating on
read means an id seeded from any unvalidated source behaves as if **no id was
seeded** (fail-open — nothing is logged, stamped, or echoed; no substitute is
minted on the hot path). The echo additionally re-validates at the stamp site
(#368), which stays load-bearing for embedders injecting their own resolver.
Proven by the `#401` describe in
`packages/kn-next/src/__tests__/correlation-integration.test.ts` (hostile +
over-long `withCorrelationId`-seeded ids are omitted by all three readers; a
well-formed seeded id still flows) together with the `#368` suite in
`correlation-response.test.ts`.

This is why the schema table marks `correlation_id` "automatic when tracing is
on". **Default-off / zero overhead:** with tracing disabled the propagator and
providers are never installed, `correlationLogFields()` returns `{}`, and no
correlation work runs — non-request and background logs stay clean and no id ever
leaks.

The proof is the integration test
`packages/kn-next/src/__tests__/correlation-integration.test.ts`: it drives a
simulated request through the exact wiring (the propagator's `extract` seeding
the context + the SERVER span opened under it + a real tracer provider +
`AsyncLocalStorageContextManager` + `CorrelationSpanProcessor` + injected
resolvers), emits a log field set inside the request — **including inside a
`knext.db_wake` child span** — with **no** hand-call to `runWithRequestContext`,
and asserts every line carries a `correlation_id` (adopted from inbound
`x-request-id` when present, generated otherwise) and the matching `trace_id`.

**OTel-upgrade tripwire.** The automatic correlation rests on one load-bearing
behavior of the inbound HTTP auto-instrumentation
(`@opentelemetry/instrumentation-http`, which `@vercel/otel` uses): it runs
`propagation.extract(activeContext, requestHeaders)` **then** starts the SERVER
span **under** the extracted context, so the seeded id descends to every child
span. `packages/kn-next/src/__tests__/otel-http-extract-tripwire.test.ts` pins
that assumption — it resolves the runtime's actual `@vercel/otel` node build,
checks the `registerOTel` seam + the bundled extract/SERVER-span machinery still
exist, and asserts the extract→SERVER-span contract in-process (with a
counter-proof showing the broken ordering loses the id). A future `@vercel/otel`
/ `@opentelemetry/instrumentation-http` bump that changes the extract-then-parent
behavior fails this test instead of silently breaking child-span correlation. Add
running this tripwire to the OTel-dependency-bump checklist.

The response-echo of `x-request-id` (§2, automatic path) is proven by
`packages/kn-next/src/__tests__/correlation-response.test.ts`: the
`ServerResponse.prototype` patch stamps the active id at header flush, does not
override an app-set value, is fail-open + idempotent, and is inert when tracing
is off.

## 3. Using the layer explicitly (`@knext/lib/context`)

For code paths that knext-core **does** own (a custom server entry, an operator
task, a script) you can establish the context by hand. This is the same layer;
an explicit `runWithRequestContext` always takes precedence over the automatic
provider (one path, no double-stamping). The layer is dependency-free (no OTel
SDK import); the app injects the active-trace-id reader once at startup.

```ts
import { trace } from '@opentelemetry/api';
import {
  applyCorrelationHeader,
  beginRequest,
  correlationHeaders,
  runWithRequestContext,
  setTraceIdProvider,
} from '@knext/lib/context';

// Once, at startup — ties correlation_id to the active trace (skip if no OTel).
// The tracing adapter ships this provider (`installTraceIdProvider()`); see
// ./tracing.md §5. Inline form shown here for illustration.
setTraceIdProvider(() => trace.getActiveSpan()?.spanContext().traceId);

// Per request (e.g. Next.js middleware / route handler / server entry):
export async function handle(req: Request): Promise<Response> {
  const ctx = beginRequest(req.headers); // adopt or generate x-request-id
  return runWithRequestContext(ctx, async () => {
    // Any logger.info(...) here carries correlation_id (+ trace_id).
    const res = await doWork();
    // Forward to a downstream service:
    await fetch(downstreamUrl, { headers: correlationHeaders() });
    // Echo on the response:
    applyCorrelationHeader(res.headers);
    return res;
  });
}
```

The `@knext/lib/logger` `mixin` reads the ambient context, so **no extra
argument is needed** to get `correlation_id`/`trace_id` onto a line — it is
added automatically inside `runWithRequestContext`, and omitted outside a
request (so background/startup logs stay clean and no id leaks).

## 4. Recommended collection setup

- **Loki + Grafana Alloy / Promtail** (or **Fluent Bit** / **Vector**): tail
  container stdout, parse the JSON, keep `level`/`app`/`env`/`correlation_id`/
  `trace_id` as fields (do **not** promote `correlation_id` to a Loki *label* —
  it is high-cardinality; keep it a structured field / use structured metadata).
- **Trace join:** with the Grafana Loki ↔ Tempo/Jaeger integration, click a log
  line's `trace_id` to open the trace, and vice-versa. `correlation_id` gives the
  same join for requests where tracing is sampled out.
- Keep exporters self-hostable / cluster-local — no SaaS default (CLAUDE.md §8,
  ADR-0012).
