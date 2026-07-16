/**
 * tracing.ts — manual knext spans on the cold, DB-backed request path (#317, C3).
 *
 * The tracing PIPELINE already exists and is DEFAULT-OFF (ADR-0012):
 *   - `otel-config.ts` gates + resolves options (`resolveOtelOptions` → null
 *     unless `OTEL_TRACING_ENABLED=true`).
 *   - `apps/file-manager/src/instrumentation.ts` calls `registerOTel(...)` from
 *     `@vercel/otel`, which auto-instruments the HTTP handler + `fetch` + `pg`.
 *   - the operator (#30) injects the OTLP endpoint / sampler from the NextApp CR.
 *
 * What auto-instrumentation does NOT emit is a span for the knext-specific
 * latency that hides on a cold request: the activator wake / app boot, and the
 * scale-zero-pg 0→1 DB wake. This module adds those two manual spans so a cold,
 * DB-backed request produces ONE trace showing where the time went:
 *
 *   request (auto)                          ← @vercel/otel HTTP span
 *   ├─ knext.cold_start   (this module)     ← app boot / first-request wake
 *   │  └─ knext.db_wake   (this module)     ← scale-zero-pg 0→1 + first connect
 *   └─ pg query           (auto)            ← @vercel/otel pg instrumentation
 *
 * Zero-overhead default-off: this module depends ONLY on `@opentelemetry/api`
 * (a declared runtime dep). When tracing is disabled no `TracerProvider` is
 * registered, so `trace.getTracer(...)` returns OTel's built-in NO-OP tracer:
 * `startActiveSpan` runs the callback with a non-recording span, records
 * nothing, exports nothing, and costs a plain function call. We do NOT import
 * `resolveOtelOptions` or the SDK here — gating is the SDK's own no-op tracer,
 * which is the cheapest and most honest signal of "is tracing on?".
 *
 * The active trace id is surfaced to `@knext/lib`'s correlation layer (C4, #318)
 * via `setTraceIdProvider` so a log line and a span share the same `trace_id`.
 */

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

/** Tracer name for all manually-instrumented knext runtime spans. */
export const TRACER_NAME = "@knext/core";

/** Span name for the app boot / first-request wake. */
export const COLD_START_SPAN_NAME = "knext.cold_start";

/** Span name for the scale-zero-pg 0→1 DB wake / first connect. */
export const DB_WAKE_SPAN_NAME = "knext.db_wake";

/** Attributes for the cold-start span. */
export interface ColdStartAttrs {
    /** Whether this was a genuine cold boot (vs. a warm request). */
    cold: boolean;
    /** Wake duration in ms, when known (e.g. measured boot/wake latency). */
    wakeMs?: number;
}

function tracer() {
    // No registered provider ⇒ OTel returns its built-in no-op tracer (default
    // OFF, zero overhead). No SDK import, no `resolveOtelOptions` call needed.
    return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside a `knext.cold_start` span. The span becomes a child of the
 * currently-active request span (via ambient OTel context), so it nests in the
 * same trace as the auto-instrumented HTTP handler. Wraps the app boot /
 * first-request wake path.
 *
 * NO-OP when tracing is disabled: the no-op tracer runs `fn` with a
 * non-recording span, so there is zero overhead and no span is exported.
 *
 * @param attrs - cold-start attributes (cold boot?, wake duration)
 * @param fn    - the boot/wake work to time; its result (sync or async) is
 *                returned unchanged
 */
export function withColdStartSpan<T>(attrs: ColdStartAttrs, fn: () => T): T {
    return tracer().startActiveSpan(COLD_START_SPAN_NAME, (span) => {
        span.setAttribute("knext.cold_start", attrs.cold);
        if (attrs.wakeMs !== undefined) {
            span.setAttribute("knext.wake_ms", attrs.wakeMs);
        }
        return runInSpan(span, fn);
    });
}

/**
 * Run `fn` inside a `knext.db_wake` span, nested under the active request/
 * cold-start span. Wraps the scale-zero-pg 0→1 scale + first-connect latency
 * so a cold, DB-backed request attributes its DB-wake time in the same trace.
 *
 * `@vercel/otel`'s pg auto-instrumentation covers the *query*, but the 0→1
 * gateway wake + connect happens before the first query is issued, so it is not
 * otherwise represented. This manual span makes that latency visible.
 *
 * NO-OP when tracing is disabled (same posture as `withColdStartSpan`).
 *
 * @param fn - the DB-wake/connect work to time
 */
export function withDbWakeSpan<T>(fn: () => T): T {
    return tracer().startActiveSpan(DB_WAKE_SPAN_NAME, (span) =>
        runInSpan(span, fn),
    );
}

/**
 * Execute `fn` under `span`, ending the span when the work completes (awaiting
 * a returned promise) and recording an ERROR status + exception on throw/reject.
 * Returns `fn`'s result unchanged (sync value or the same promise type).
 */
function runInSpan<T>(span: Span, fn: () => T): T {
    let result: T;
    try {
        result = fn();
    } catch (err) {
        recordError(span, err);
        span.end();
        throw err;
    }
    if (isPromise(result)) {
        return result.then(
            (value) => {
                span.end();
                return value;
            },
            (err) => {
                recordError(span, err);
                span.end();
                throw err;
            },
        ) as T;
    }
    span.end();
    return result;
}

function recordError(span: Span, err: unknown): void {
    span.recordException(err as Error);
    span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
    });
}

function isPromise<T>(value: T): value is T & Promise<unknown> {
    return (
        value != null &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

/**
 * The trace id of the currently-active span, or `undefined` when no span is
 * active (or tracing is disabled — the no-op span carries an all-zero,
 * invalid span context). This is the join key between a structured log line
 * and its trace.
 */
export function activeTraceId(): string | undefined {
    const span = trace.getActiveSpan();
    if (!span) {
        return undefined;
    }
    const ctx = span.spanContext();
    // The no-op / invalid span context has an all-zero trace id — treat it as
    // "no trace" so disabled tracing never surfaces a bogus id to logs.
    if (!ctx.traceId || /^0+$/.test(ctx.traceId)) {
        return undefined;
    }
    return ctx.traceId;
}

/**
 * Return a provider function suitable for `@knext/lib`'s `setTraceIdProvider`
 * (C4, #318). Wiring it once at startup makes every in-request log line carry
 * the active span's `trace_id`, so logs and traces share one id:
 *
 *   import { setTraceIdProvider } from '@knext/lib/context';
 *   setTraceIdProvider(installTraceIdProvider());
 *
 * Kept dependency-free of `@knext/lib` (returns the provider rather than calling
 * `setTraceIdProvider` itself) so this module stays independently unit-testable
 * and the app owns the one-time wiring.
 */
export function installTraceIdProvider(): () => string | undefined {
    return activeTraceId;
}
