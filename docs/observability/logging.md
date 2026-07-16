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
| `correlation_id` | request context (§3) | present on every line emitted **during a request** |
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
- **One id per request**, ambient for the whole request via
  `AsyncLocalStorage` — no need to thread it through function signatures.
- **Trace tie-in:** when an OTel span is active the correlation id is joined to
  the span's `trace_id`, so a log query by `correlation_id` and a trace query by
  `trace_id` land on the same request.
- **Propagation:**
  - **Response:** `x-request-id` is echoed on the response so a client (and any
    fronting proxy/CDN) can report the id it saw.
  - **Downstream / db-wake:** forward `x-request-id` on outbound calls so a
    request is traceable app → db-wake → downstream. Across the Postgres hop
    (a TCP wake-on-connect gateway that carries no HTTP headers) the join key is
    the OTel `trace_id` (pg is auto-instrumented under ADR-0012); the
    `correlation_id`/`trace_id` pair on the app's log lines around the DB call
    stitches the two layers together.

## 3. Using the layer (`@knext/lib/context`)

The correlation layer is dependency-free (no OTel SDK import); the app injects
the active-trace-id reader once at startup.

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
