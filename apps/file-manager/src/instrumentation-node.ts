/**
 * #342: Node-only instrumentation body, split out of `instrumentation.ts`.
 *
 * Next.js compiles `instrumentation.ts` for BOTH the `nodejs` AND the `edge`
 * runtimes (this app has `middleware.ts`, which forces an edge build). ALL of
 * this wiring is Node-only by nature: `@knext/lib/clients` transitively imports
 * `@cerbos/grpc` (→ `@grpc/grpc-js`, needing `zlib`/`stream`/`net`/`tls`/`fs`),
 * plus `pg` and `minio`. If any of it is reachable from the edge bundle the
 * production `next build` fails with `Module not found`.
 *
 * Keeping this body in a SEPARATE module that `instrumentation.ts` loads via a
 * dynamic `await import(...)` with a runtime-computed specifier means webpack
 * never traces it into the edge bundle. `instrumentation.ts` calls this ONLY
 * when `process.env.NEXT_RUNTIME === 'nodejs'`, so on the edge runtime nothing
 * here is ever imported or executed. The knext runtime runs the app on Node
 * (the standalone server), so no behavior is lost.
 *
 * This module MUST be loaded lazily (never statically imported from an
 * edge-compiled file) — the static-import guard in
 * `apps/file-manager/instrumentation-edge-safe.test.ts` enforces that
 * `instrumentation.ts` stays edge-clean.
 */

import {
  GoldenSignalMetricsProcessor,
  initRuntimeMetrics,
  recordColdStart,
  recordDbWake,
  startChildMetricsServer,
} from '@knext/core/adapters/metrics';
import { resolveOtelOptions } from '@knext/core/adapters/otel-config';
import {
  ColdStartSpanProcessor,
  correlationAttributesFromHeaders,
  installCorrelationIdProvider,
  installTraceIdProvider,
  instrumentPoolForDbWake,
} from '@knext/core/adapters/tracing';
import { setPoolInstrumentor } from '@knext/lib/clients';
import { setCorrelationIdProvider, setTraceIdProvider } from '@knext/lib/context';
import { registerOTel } from '@vercel/otel';
import { Registry } from 'prom-client';

export function registerNode() {
  // OTel tracing is DEFAULT-OFF (#30, ADR-0012). `resolveOtelOptions` returns
  // null unless the operator set OTEL_TRACING_ENABLED=true (from
  // spec.observability.tracing.enabled on the NextApp CR). When null we return
  // WITHOUT initializing OTel — zero overhead, no exporter, no span processors.
  const otel = resolveOtelOptions(process.env);
  if (!otel) {
    return;
  }

  // Golden-signal / cold-start / db-wake Prometheus metrics (#315). These are
  // DERIVED from the same core-owned OTel hooks (the HTTP SERVER span lifecycle,
  // the cold-start processor, the db-wake pool wrapper) — NO app route-handler
  // wiring. They live in a core-owned registry served on a localhost-only child
  // port; the supervisor's :9091 (the operator's scrape target) merges it in.
  // Because they ride the OTel spans, they share tracing's default-off gate.
  const metrics = initRuntimeMetrics(new Registry());
  startChildMetricsServer(metrics.registry);

  // @vercel/otel reads the OTLP endpoint from OTEL_EXPORTER_OTLP_ENDPOINT and
  // the sampler arg from OTEL_TRACES_SAMPLER_ARG (both set by the operator).
  // We pass the resolved service name + Knative resource attributes explicitly,
  // and use ratio-based head sampling. The exporter target is a self-hostable
  // OTLP collector — never a SaaS default (CLAUDE.md §8: no lock-in).
  registerOTel({
    serviceName: otel.serviceName,
    attributes: otel.resourceAttributes,
    // Establish the request correlation id on the REAL path (#346): this hook
    // runs per-request with the inbound headers, adopts a well-formed
    // `x-request-id` (else generates one) and stamps it on the inbound SERVER
    // span as `knext.correlation_id`. Since @vercel/otel propagates that span via
    // an AsyncLocalStorageContextManager, the correlation-id provider below reads
    // it back at log time — no `runWithRequestContext` handler wrapping needed.
    attributesFromHeaders: correlationAttributesFromHeaders,
    traceSampler: otel.sampleRate >= 1 ? 'always_on' : 'parentbased_traceidratio',
    // Emit `knext.cold_start` under the FIRST inbound request span, automatically
    // (#317) — the app-boot/first-request wake auto-instrumentation doesn't show.
    // The processor also bumps the `knext_coldstart_*` metric (#315).
    // The golden-signal processor derives request rate/error/latency/saturation
    // from each inbound HTTP SERVER span — no handler wrapping (#315).
    spanProcessors: [
      'auto',
      new ColdStartSpanProcessor(undefined, (wakeMs) => recordColdStart(metrics, wakeMs)),
      new GoldenSignalMetricsProcessor(metrics),
    ],
  });

  // Automatic `knext.db_wake` (#317): wrap each pg pool's first connect (the
  // scale-zero-pg 0→1 wake) so any DB-backed request gets the span with no app
  // code. The lib stays OTel-free — it calls this instrumentor via a seam. The
  // wrapper also bumps the `knext_db_wake_*` metric on the 0→1 wake (#315).
  setPoolInstrumentor((pool, role) =>
    instrumentPoolForDbWake(pool, role, (r, wakeMs) => recordDbWake(metrics, r, wakeMs)),
  );

  // Join logs to traces (C4, #318): the correlation layer stamps every
  // in-request log line with the active span's `trace_id` via this provider,
  // so a `knext.cold_start` / `knext.db_wake` span and its log lines share one
  // id. Only wired when tracing is on — when disabled the provider is never
  // installed (the C4 default no-trace provider stays in place, zero overhead).
  setTraceIdProvider(installTraceIdProvider());

  // Correlate logs on the REAL request path (#346): resolve the request's
  // `correlation_id` from the ACTIVE OTel span (the `knext.correlation_id`
  // attribute stamped by `attributesFromHeaders` above) at log time. Together
  // with the trace-id provider, every in-request log line now carries BOTH
  // correlation_id + trace_id with no `runWithRequestContext` handler wrapping.
  // Only wired when tracing is on (rides the default-off gate).
  setCorrelationIdProvider(installCorrelationIdProvider());
}
