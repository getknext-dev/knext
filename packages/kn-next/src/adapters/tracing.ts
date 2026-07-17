/**
 * tracing.ts — manual knext spans on the cold, DB-backed request path (#317, C3).
 *
 * The tracing PIPELINE already exists and is DEFAULT-OFF (ADR-0012):
 *   - `otel-config.ts` gates + resolves options (`resolveOtelOptions` → null
 *     unless `OTEL_TRACING_ENABLED=true`).
 *   - `apps/file-manager/src/instrumentation.ts` calls `registerOTel(...)` from
 *     `@vercel/otel`, which auto-instruments the inbound HTTP handler + `fetch`.
 *     (It does NOT bundle pg instrumentation, so the DB path is a black box.)
 *   - the operator (#30) injects the OTLP endpoint / sampler from the NextApp CR.
 *
 * What auto-instrumentation does NOT emit is a span for the knext-specific
 * latency that hides on a cold request: the app boot / first-request wake, and
 * the scale-zero-pg 0→1 DB wake. This module adds those two spans so a cold,
 * DB-backed request produces ONE trace showing where the time went:
 *
 *   request (auto)                          ← @vercel/otel HTTP span
 *   ├─ knext.cold_start   (this module)     ← app boot / first-request wake
 *   └─ knext.db_wake      (this module)     ← scale-zero-pg 0→1 + first connect
 *
 * They are emitted AUTOMATICALLY on the real request path — no app route-handler
 * wiring — via two knext-core-owned hooks:
 *
 *   1. `ColdStartSpanProcessor` — a `SpanProcessor` the app registers once via
 *      `registerOTel({ spanProcessors: [new ColdStartSpanProcessor()] })` in its
 *      `instrumentation.ts`. Its `onStart` fires for the FIRST inbound HTTP
 *      SERVER span after boot and opens a `knext.cold_start` child under it
 *      (nested in the same trace), carrying the measured process-boot→first-
 *      request wake. It is inert for every request after the first.
 *   2. `instrumentPoolForDbWake` — wraps a pg pool's FIRST `connect()`. It is
 *      installed once via `@knext/lib/clients`' `setPoolInstrumentor` seam
 *      (`setPoolInstrumentor(instrumentPoolForDbWake)`), so every pool the lib
 *      creates gets a `knext.db_wake` span around its 0→1 wake, opened in the
 *      caller's active context (the request span) — automatically, per request.
 *
 * The `withColdStartSpan` / `withDbWakeSpan` helpers remain for callers that
 * want to bracket a specific span of work by hand; the two hooks above are what
 * satisfy "a cold DB-backed request produces a single trace" with no app wiring.
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

import { CORRELATION_HEADER, resolveCorrelationId } from "@knext/lib/context";
import {
    type Context,
    context,
    createContextKey,
    type Span,
    SpanKind,
    SpanStatusCode,
    type TextMapGetter,
    type TextMapPropagator,
    type TextMapSetter,
    trace,
} from "@opentelemetry/api";

/** Tracer name for all manually-instrumented knext runtime spans. */
export const TRACER_NAME = "@knext/core";

/**
 * Span attribute that carries the request correlation id (#346). It rides the
 * inbound SERVER span PURELY FOR TRACE EXPORT — so a tracing backend can index /
 * echo the id on the request span. LOGS are NOT resolved from this attribute
 * (an attribute lives only on the span it is set on, so a log line emitted while
 * a CHILD span is active would miss it); logs resolve from the OTel context key
 * below, which descends to all child spans. `knext.` keeps it vendor-neutral.
 */
export const CORRELATION_ATTRIBUTE = "knext.correlation_id";

/**
 * Private OTel Context key that carries the request correlation id across the
 * WHOLE trace (#346, BLOCKER-1 fix). Context values descend to every child span
 * by construction (the SDK derives a child span's context from its parent's), so
 * reading the id from `context.active()` resolves the SAME request id whether the
 * innermost active span is the SERVER span, `knext.db_wake`, `knext.cold_start`,
 * an app `startActiveSpan`, or an auto-instrumented pg/fetch span. This is why
 * the id must ride the CONTEXT, not a single span's attributes.
 */
const CORRELATION_CTX_KEY = createContextKey("knext.correlation_id");

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

// ── Automatic request correlation on the real path (#346) ─────────────────────

/**
 * Read the request correlation id off an OTel `Context` (our private key).
 * Returns `undefined` when the key is absent.
 */
export function correlationIdFromContext(ctx: Context): string | undefined {
    const value = ctx.getValue(CORRELATION_CTX_KEY);
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Put a correlation id on an OTel `Context`, returning the derived context. */
export function withCorrelationId(ctx: Context, id: string): Context {
    return ctx.setValue(CORRELATION_CTX_KEY, id);
}

/**
 * A `TextMapPropagator` that ESTABLISHES the request correlation id on the OTel
 * Context from the inbound headers (#346). This is the correct seam because
 * `@opentelemetry/instrumentation-http` (what `@vercel/otel` uses) runs
 * `propagation.extract(activeContext, requestHeaders)` for each inbound request
 * and starts the SERVER span UNDER the returned context — so whatever this
 * `extract` puts on the context descends to the SERVER span AND every child span
 * (db_wake / cold_start / pg / fetch), closing BLOCKER-1's child-span gap with
 * no parent-walk.
 *
 * `extract` adopts a WELL-FORMED inbound `x-request-id` (else mints a fresh uuid
 * — untrusted-input rules live in `@knext/lib/context`) and stores it on the
 * context. `inject` is a deliberate no-op: the id already flows downstream as the
 * `x-request-id` header via `@knext/lib`'s `correlationHeaders()` on the app's
 * outbound calls, and W3C tracecontext carries the trace itself — this propagator
 * exists only to seed the INBOUND context, so we don't also emit a bespoke header.
 *
 * Register it composed with the default propagators (it only ADDS a context key,
 * it never strips tracecontext):
 *   registerOTel({ propagators: ['auto', new CorrelationContextPropagator()] })
 *
 * Registered only when tracing is on (default-off gate) — zero overhead otherwise.
 */
export class CorrelationContextPropagator implements TextMapPropagator {
    extract<Carrier>(
        ctx: Context,
        carrier: Carrier,
        getter: TextMapGetter<Carrier>,
    ): Context {
        const raw = getter.get(carrier, CORRELATION_HEADER);
        const id = resolveCorrelationId(Array.isArray(raw) ? raw[0] : raw);
        return ctx.setValue(CORRELATION_CTX_KEY, id);
    }

    inject<Carrier>(
        _ctx: Context,
        _carrier: Carrier,
        _setter: TextMapSetter<Carrier>,
    ): void {
        // No-op: correlation flows downstream via the app's x-request-id header
        // (@knext/lib correlationHeaders()); this propagator only seeds inbound.
    }

    fields(): string[] {
        return [CORRELATION_HEADER];
    }
}

/**
 * Read the request correlation id from the ACTIVE OTel context (the key seeded
 * by `CorrelationContextPropagator.extract`). Because it reads the CONTEXT — not
 * the innermost span's attributes — it resolves the SAME request id from any
 * child span, so a log line on the db_wake / cold_start path still carries it
 * (BLOCKER-1 fix). Returns `undefined` outside a request / when tracing is
 * disabled (the key was never seeded).
 */
export function activeCorrelationId(): string | undefined {
    return correlationIdFromContext(context.active());
}

/**
 * Return a provider suitable for `@knext/lib`'s `setCorrelationIdProvider`
 * (#346). Wiring it once at startup makes every in-request log line carry the
 * active request's `correlation_id`, read from the active OTel CONTEXT, so logs
 * are correlated on the real path with no handler wrapping — on the SERVER span
 * AND under any child span:
 *
 *   import { setCorrelationIdProvider } from '@knext/lib/context';
 *   setCorrelationIdProvider(installCorrelationIdProvider());
 *
 * Kept dependency-inverted (returns the provider rather than calling the setter)
 * so this module stays independently unit-testable and the app owns the wiring.
 */
export function installCorrelationIdProvider(): () => string | undefined {
    return activeCorrelationId;
}

/**
 * A `SpanProcessor` that copies the context-key correlation id onto the inbound
 * SERVER span as the `knext.correlation_id` attribute FOR TRACE EXPORT (so a
 * backend can index / echo it on the request span). It reads the id from the
 * span's `parentContext` (which is the context the SERVER span was started
 * under — the extracted context our propagator seeded), so no header re-parse.
 *
 * Only the SERVER span is stamped: the id is already on the context for logs and
 * for children, so tagging child spans would be redundant cardinality. When the
 * key is absent (tracing off / non-request span) this is a no-op.
 *
 * Register it alongside the other knext processors:
 *   registerOTel({ spanProcessors: ['auto', new CorrelationSpanProcessor()] })
 */
export class CorrelationSpanProcessor implements KnextSpanProcessor {
    onStart(span: StartedSpanLike, parentContext: Context): void {
        if (span.kind !== SpanKind.SERVER) {
            return;
        }
        const id = correlationIdFromContext(parentContext);
        if (!id) {
            return;
        }
        // `onStart` receives the concrete SDK span, which supports setAttribute.
        (span as unknown as Span).setAttribute(CORRELATION_ATTRIBUTE, id);
    }

    onEnd(): void {}

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

// ── Automatic cold-start span (a SpanProcessor) ───────────────────────────────

/**
 * A read-only view of a started span, plus the `SpanKind` and span context the
 * processor needs. Structurally matches the SDK's `Span` passed to
 * `SpanProcessor.onStart`, so this module needs no `@opentelemetry/sdk-trace-base`
 * runtime dependency (the shape is duck-typed).
 */
interface StartedSpanLike {
    readonly kind: SpanKind;
    spanContext(): { traceId: string; spanId: string };
}

/**
 * The minimal `SpanProcessor` surface we implement. Kept as a local structural
 * type (not an `implements SpanProcessor` against the SDK) so this module stays
 * `@opentelemetry/api`-only at runtime — the app passes an instance straight to
 * `registerOTel({ spanProcessors: [...] })`, which accepts any conforming object.
 */
export interface KnextSpanProcessor {
    onStart(span: StartedSpanLike, parentContext: Context): void;
    onEnd(span: unknown): void;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
}

/**
 * Emits `knext.cold_start` as a child of the FIRST inbound HTTP request span the
 * process sees — automatically, with no app route-handler wiring. Register it
 * once in `instrumentation.ts`:
 *
 *   registerOTel({ ..., spanProcessors: [new ColdStartSpanProcessor()] });
 *
 * `onStart` fires for every span as it starts; we act only on the first SERVER-
 * kind span (an inbound request) and record `knext.wake_ms` = time from module
 * load (≈ process boot / cold start) to that first request, then flip a latch so
 * every later request is a plain no-op. The cold-start span nests under the
 * request span (via its `parentContext`), so it lands in the same trace.
 *
 * When tracing is disabled this processor is never registered — zero overhead.
 */
export class ColdStartSpanProcessor implements KnextSpanProcessor {
    /** Reference instant for the wake measurement — set when the app loads. */
    private readonly bootAt: number;
    /** Latch: the cold-start span is emitted at most once, on the first request. */
    private emitted = false;
    /**
     * Optional Prometheus emitter (#315). When supplied, the FIRST-request wake
     * is ALSO recorded as a `knext_coldstart_*` metric on the core :9091
     * registry, not only as a span. Kept optional so #317's tracing-only wiring
     * (and its tests) is unchanged and this module stays prom-client-free unless
     * the runtime passes an emitter.
     */
    private readonly onColdStart?: (wakeMs: number) => void;

    constructor(
        bootAt: number = Date.now(),
        onColdStart?: (wakeMs: number) => void,
    ) {
        this.bootAt = bootAt;
        this.onColdStart = onColdStart;
    }

    onStart(span: StartedSpanLike, parentContext: Context): void {
        if (this.emitted || span.kind !== SpanKind.SERVER) {
            return;
        }
        this.emitted = true;
        const wakeMs = Math.max(0, Date.now() - this.bootAt);
        this.onColdStart?.(wakeMs);
        // Parent the cold-start span under the request span that just started.
        const parent = trace.setSpan(parentContext, span as unknown as Span);
        const cold = tracer().startSpan(
            COLD_START_SPAN_NAME,
            {
                attributes: {
                    "knext.cold_start": true,
                    "knext.wake_ms": wakeMs,
                },
            },
            parent,
        );
        cold.end();
    }

    onEnd(): void {
        // Nothing to export here — the pipeline's export processor handles it.
    }

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

// ── Automatic db-wake span (a pool instrumentor) ──────────────────────────────

/** Minimal shape of the pg pool this module instruments: a `connect()` method. */
interface ConnectablePool {
    connect: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Wrap a pg pool's FIRST `connect()` in a `knext.db_wake` span so the
 * scale-zero-pg 0→1 DB wake shows up on the request trace — automatically, with
 * no app code. Install once at startup via `@knext/lib/clients`:
 *
 *   import { setPoolInstrumentor } from '@knext/lib/clients';
 *   import { instrumentPoolForDbWake } from '@knext/core/adapters/tracing';
 *   setPoolInstrumentor(instrumentPoolForDbWake);
 *
 * The lib then calls this for each pool it creates. Only the FIRST connect (the
 * cold 0→1 wake) is spanned; warm connects from the ready pool are untouched, so
 * the span marks the wake, not every checkout. The span opens in the caller's
 * active context — inside a request handler that means it nests under the request
 * span. It is best-effort and fail-open: if wrapping throws, the original pool
 * behavior is preserved. A no-op when tracing is disabled (no-op tracer).
 *
 * @param pool - the freshly-created pool (its `connect` is monkey-patched once)
 * @param role - 'writer' | 'reader', recorded as `knext.db_role`
 * @param onDbWake - optional Prometheus emitter (#315); called with (role,
 *                   wakeMs) on the 0→1 wake so the wake is also a
 *                   `knext_db_wake_*` metric, not only a span
 */
export function instrumentPoolForDbWake(
    pool: ConnectablePool,
    role: "writer" | "reader",
    onDbWake?: (role: "writer" | "reader", wakeMs: number) => void,
): void {
    const originalConnect = pool.connect;
    if (typeof originalConnect !== "function") {
        return;
    }
    let waked = false;
    pool.connect = function instrumentedConnect(
        this: unknown,
        ...args: unknown[]
    ): Promise<unknown> {
        const call = () => originalConnect.apply(this ?? pool, args);
        if (waked) {
            return call();
        }
        waked = true;
        const startedAt = Date.now();
        return tracer().startActiveSpan(
            DB_WAKE_SPAN_NAME,
            { attributes: { "knext.db_role": role } },
            (span) => {
                const finish = () => {
                    const wakeMs = Math.max(0, Date.now() - startedAt);
                    span.setAttribute("knext.wake_ms", wakeMs);
                    // #315: also record the 0→1 wake as a Prometheus counter +
                    // duration on the core :9091 registry, when an emitter is
                    // wired. Optional so #317's tracing-only path is unchanged.
                    onDbWake?.(role, wakeMs);
                    span.end();
                };
                let result: Promise<unknown>;
                try {
                    result = call();
                } catch (err) {
                    recordError(span, err);
                    finish();
                    throw err;
                }
                return result.then(
                    (client) => {
                        finish();
                        return client;
                    },
                    (err) => {
                        recordError(span, err);
                        finish();
                        throw err;
                    },
                );
            },
        );
    } as ConnectablePool["connect"];
}
