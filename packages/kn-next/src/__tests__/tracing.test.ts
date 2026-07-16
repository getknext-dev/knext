import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    activeTraceId,
    COLD_START_SPAN_NAME,
    DB_WAKE_SPAN_NAME,
    installTraceIdProvider,
    withColdStartSpan,
    withDbWakeSpan,
} from "../adapters/tracing";

/**
 * #317 — end-to-end distributed tracing (C3).
 *
 * The tracing PIPELINE (default-off gating in otel-config.ts, @vercel/otel
 * auto-instrumentation in instrumentation.ts, operator env plumbing) already
 * exists. This suite covers the DELTA: a MANUAL `knext.cold_start` span around
 * app boot / first-request wake and a `knext.db_wake` span around the
 * scale-zero-pg first-connect — both must nest inside the active REQUEST trace
 * so a cold, DB-backed request yields ONE trace showing where the time went,
 * and both must be a NO-OP with zero overhead when tracing is disabled
 * (ADR-0012 default-off posture).
 *
 * Real span behavior is asserted with the OTel SDK's InMemorySpanExporter and a
 * BasicTracerProvider — never a live collector.
 */

// A fresh exporter per enable() — `provider.shutdown()` also shuts the exporter
// down (InMemorySpanExporter refuses exports after shutdown), so reusing one
// across tests would silently drop later spans.
let exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;
const contextManager = new AsyncLocalStorageContextManager();

/** Register a real (recording) tracer provider — simulates tracing ENABLED. */
function enableTracing(): void {
    exporter = new InMemorySpanExporter();
    // A context manager makes `context.with(...)` propagate the active span,
    // mirroring the runtime (sdk-node/@vercel/otel register one). Without it,
    // `trace.getActiveSpan()` always reads the empty root context.
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
}

/** Tear down: disable global tracer provider — simulates tracing DISABLED. */
function disableTracing(): void {
    trace.disable();
    context.disable();
    contextManager.disable();
    provider = undefined;
    exporter = new InMemorySpanExporter();
}

afterEach(async () => {
    if (provider) {
        await provider.shutdown();
    }
    disableTracing();
});

describe("withColdStartSpan — default-OFF (no provider registered)", () => {
    beforeEach(() => {
        // No global tracer provider => OTel's built-in no-op tracer is used.
        disableTracing();
    });

    it("(a) creates NO span and is a no-op when tracing is disabled", async () => {
        let ran = false;
        const out = await withColdStartSpan({ cold: true }, () => {
            ran = true;
            return 42;
        });
        expect(out).toBe(42);
        expect(ran).toBe(true);
        // Nothing was exported — the no-op tracer records nothing.
        expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it("(a) db-wake helper is likewise a zero-overhead no-op", async () => {
        const out = await withDbWakeSpan(() => "connected");
        expect(out).toBe("connected");
        expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it("(a) activeTraceId is undefined with no active span", () => {
        expect(activeTraceId()).toBeUndefined();
    });
});

describe("withColdStartSpan — ENABLED", () => {
    beforeEach(() => {
        enableTracing();
    });

    it("(b) creates a cold_start span with the expected name + attributes", async () => {
        const result = await withColdStartSpan(
            { cold: true, wakeMs: 2500 },
            () => "booted",
        );
        expect(result).toBe("booted");

        const spans = exporter.getFinishedSpans();
        const cold = spans.find((s) => s.name === COLD_START_SPAN_NAME);
        expect(cold).toBeDefined();
        expect(cold?.name).toBe("knext.cold_start");
        expect(cold?.attributes["knext.cold_start"]).toBe(true);
        expect(cold?.attributes["knext.wake_ms"]).toBe(2500);
    });

    it("(b) records wake attributes only when provided", async () => {
        await withColdStartSpan({ cold: false }, () => undefined);
        const cold = exporter
            .getFinishedSpans()
            .find((s) => s.name === COLD_START_SPAN_NAME);
        expect(cold?.attributes["knext.cold_start"]).toBe(false);
        expect(cold?.attributes["knext.wake_ms"]).toBeUndefined();
    });

    it("(c) the cold_start span nests under the active REQUEST span (same trace, correct parent)", async () => {
        const tracer = trace.getTracer("test-request");
        const requestSpan = tracer.startSpan("request");
        const requestCtx = trace.setSpan(context.active(), requestSpan);

        await context.with(requestCtx, async () => {
            await withColdStartSpan({ cold: true }, () => undefined);
        });
        requestSpan.end();

        const spans = exporter.getFinishedSpans();
        const request = spans.find((s) => s.name === "request");
        const cold = spans.find((s) => s.name === COLD_START_SPAN_NAME);
        expect(request).toBeDefined();
        expect(cold).toBeDefined();
        // Same trace, and cold_start's parent is the request span.
        expect(cold?.spanContext().traceId).toBe(
            request?.spanContext().traceId,
        );
        expect(cold?.parentSpanContext?.spanId).toBe(
            request?.spanContext().spanId,
        );
    });

    it("(e) the db_wake span appears WITHIN the same trace as the request", async () => {
        const tracer = trace.getTracer("test-request");
        const requestSpan = tracer.startSpan("request");
        const requestCtx = trace.setSpan(context.active(), requestSpan);

        await context.with(requestCtx, async () => {
            // Simulate a cold, DB-backed request: cold_start then db-wake.
            await withColdStartSpan({ cold: true }, async () => {
                await withDbWakeSpan(() => "row");
            });
        });
        requestSpan.end();

        const spans = exporter.getFinishedSpans();
        const request = spans.find((s) => s.name === "request");
        const dbWake = spans.find((s) => s.name === DB_WAKE_SPAN_NAME);
        expect(dbWake).toBeDefined();
        expect(dbWake?.name).toBe("knext.db_wake");
        // One trace: db_wake shares the request's traceId.
        expect(dbWake?.spanContext().traceId).toBe(
            request?.spanContext().traceId,
        );
    });
});

describe("installTraceIdProvider — log↔trace join (C4 seam)", () => {
    beforeEach(() => {
        enableTracing();
    });

    it("(d) the trace_id exposed to the C4 context provider matches the active span's traceId", async () => {
        const captured: (string | undefined)[] = [];
        // The provider the C4 context layer will call.
        const provide = installTraceIdProvider();

        const tracer = trace.getTracer("test-request");
        const requestSpan = tracer.startSpan("request");
        const requestCtx = trace.setSpan(context.active(), requestSpan);

        await context.with(requestCtx, async () => {
            captured.push(provide());
        });
        requestSpan.end();

        expect(captured[0]).toBe(requestSpan.spanContext().traceId);
        // 32-hex-char W3C trace id.
        expect(captured[0]).toMatch(/^[0-9a-f]{32}$/);
    });

    it("(d) activeTraceId returns the active span's traceId", async () => {
        const tracer = trace.getTracer("test-request");
        const span = tracer.startSpan("request");
        const ctx = trace.setSpan(context.active(), span);
        const seen = context.with(ctx, () => activeTraceId());
        span.end();
        expect(seen).toBe(span.spanContext().traceId);
    });
});
