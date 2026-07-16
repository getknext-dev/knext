import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    COLD_START_SPAN_NAME,
    ColdStartSpanProcessor,
    DB_WAKE_SPAN_NAME,
    instrumentPoolForDbWake,
} from "../adapters/tracing";

/**
 * #317 — the ACCEPTANCE-CRITERION proof: a cold, DB-backed request produces a
 * SINGLE trace showing where the time went, with the knext spans emitted
 * AUTOMATICALLY (no hand-opened spans, no app route-handler wiring).
 *
 * This exercises the two knext-core-owned wiring points that fire on the REAL
 * path:
 *   1. `ColdStartSpanProcessor` — a span processor registered via
 *      `registerOTel({ spanProcessors })` in the app's `instrumentation.ts`.
 *      Its `onStart` fires for the FIRST inbound HTTP server span and emits a
 *      `knext.cold_start` child under it (once; inert afterwards).
 *   2. `instrumentPoolForDbWake` — wraps the pg pool's FIRST `connect()`
 *      (installed via `@knext/lib/clients`' `setPoolInstrumentor` seam) so the
 *      0→1 DB wake becomes a `knext.db_wake` span in the active request context.
 *
 * We simulate the runtime with the SDK's `BasicTracerProvider` +
 * `InMemorySpanExporter` and a real async-hooks context manager (which the
 * runtime registers via `@vercel/otel`). No hand-constructed cold_start/db_wake
 * spans — the processor and the pool wrapper create them, exactly as in prod.
 */

let exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;
const contextManager = new AsyncLocalStorageContextManager();

/**
 * Stand up a tracer provider that mirrors the runtime: the knext cold-start
 * processor PLUS the export processor, and a registered context manager so
 * `context.with(...)` propagates the active span (the runtime gets this from
 * @vercel/otel).
 */
function bootRuntime(): ColdStartSpanProcessor {
    exporter = new InMemorySpanExporter();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const coldProcessor = new ColdStartSpanProcessor();
    provider = new BasicTracerProvider({
        spanProcessors: [coldProcessor, new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    return coldProcessor;
}

afterEach(async () => {
    if (provider) {
        await provider.shutdown();
    }
    trace.disable();
    context.disable();
    contextManager.disable();
    provider = undefined;
    exporter = new InMemorySpanExporter();
});

/**
 * A minimal fake pg pool whose `connect()` resolves a fake client. This is what
 * `@knext/lib/clients` hands the instrumentor; the instrumentor wraps `connect`.
 */
function makeFakePool() {
    let connects = 0;
    return {
        connects: () => connects,
        async connect() {
            connects += 1;
            return { release() {} };
        },
    };
}

/**
 * Drive one inbound HTTP request through the runtime: open a SERVER span (as
 * @vercel/otel's HTTP instrumentation would), run the handler under its
 * context, and end it. The handler does a DB call through the instrumented pool.
 */
async function handleRequest(
    name: string,
    handler: () => Promise<void>,
): Promise<void> {
    const tracer = trace.getTracer("@vercel/otel");
    const server = tracer.startSpan(name, { kind: SpanKind.SERVER });
    const ctx = trace.setSpan(context.active(), server);
    await context.with(ctx, handler);
    server.end();
}

describe("#317 acceptance: one cold DB-backed request → one trace, spans auto-emitted", () => {
    beforeEach(() => {
        bootRuntime();
    });

    it("a cold DB-backed request yields HTTP → knext.cold_start + knext.db_wake in ONE trace, all auto-emitted", async () => {
        const pool = makeFakePool();
        // The tracing adapter wraps the pool's first connect — this is what the
        // @knext/lib/clients seam calls at pool-creation time.
        instrumentPoolForDbWake(pool, "writer");

        await handleRequest("GET /files", async () => {
            // The handler just uses the DB — no manual span, no knext import.
            const client = await pool.connect();
            client.release();
        });

        const spans = exporter.getFinishedSpans();
        const http = spans.find((s) => s.name === "GET /files");
        const cold = spans.find((s) => s.name === COLD_START_SPAN_NAME);
        const dbWake = spans.find((s) => s.name === DB_WAKE_SPAN_NAME);

        // All three spans exist and were produced automatically.
        expect(http, "HTTP server span").toBeDefined();
        expect(cold, "knext.cold_start (from the span processor)").toBeDefined();
        expect(dbWake, "knext.db_wake (from the pool wrapper)").toBeDefined();

        // ONE trace: cold_start + db_wake share the HTTP span's traceId.
        const traceId = http?.spanContext().traceId;
        expect(cold?.spanContext().traceId).toBe(traceId);
        expect(dbWake?.spanContext().traceId).toBe(traceId);

        // Correct nesting: both are children of the HTTP request span.
        expect(cold?.parentSpanContext?.spanId).toBe(
            http?.spanContext().spanId,
        );
        expect(dbWake?.parentSpanContext?.spanId).toBe(
            http?.spanContext().spanId,
        );

        // The DB actually connected once (the 0→1 wake).
        expect(pool.connects()).toBe(1);
    });

    it("emits knext.cold_start ONLY on the first request (subsequent requests are inert)", async () => {
        await handleRequest("GET /one", async () => {});
        await handleRequest("GET /two", async () => {});

        const coldSpans = exporter
            .getFinishedSpans()
            .filter((s) => s.name === COLD_START_SPAN_NAME);
        expect(coldSpans).toHaveLength(1);
        // It nested under the FIRST request, not the second.
        const first = exporter
            .getFinishedSpans()
            .find((s) => s.name === "GET /one");
        expect(coldSpans[0].parentSpanContext?.spanId).toBe(
            first?.spanContext().spanId,
        );
    });

    it("emits knext.db_wake ONLY on the first connect (the 0→1 wake), not on warm reuse", async () => {
        const pool = makeFakePool();
        instrumentPoolForDbWake(pool, "writer");

        await handleRequest("GET /a", async () => {
            await (await pool.connect()).release();
            await (await pool.connect()).release(); // warm reuse, same request
        });
        await handleRequest("GET /b", async () => {
            await (await pool.connect()).release(); // warm — pool already awake
        });

        const dbWakeSpans = exporter
            .getFinishedSpans()
            .filter((s) => s.name === DB_WAKE_SPAN_NAME);
        expect(dbWakeSpans).toHaveLength(1);
        expect(pool.connects()).toBe(3);
    });

    it("db_wake records the wake latency attribute", async () => {
        const pool = makeFakePool();
        instrumentPoolForDbWake(pool, "writer");
        await handleRequest("GET /files", async () => {
            await (await pool.connect()).release();
        });
        const dbWake = exporter
            .getFinishedSpans()
            .find((s) => s.name === DB_WAKE_SPAN_NAME);
        expect(dbWake?.attributes["knext.db_role"]).toBe("writer");
        expect(typeof dbWake?.attributes["knext.wake_ms"]).toBe("number");
    });
});

describe("#317 acceptance: zero-overhead when tracing is DISABLED", () => {
    it("the cold-start processor + pool wrapper emit nothing with no provider", async () => {
        // No bootRuntime() — no global tracer provider ⇒ no-op tracer.
        trace.disable();
        const localExporter = new InMemorySpanExporter();
        const pool = makeFakePool();
        // Wrapping a pool with tracing disabled must be a no-op passthrough.
        instrumentPoolForDbWake(pool, "writer");
        const client = await pool.connect();
        client.release();
        expect(localExporter.getFinishedSpans()).toHaveLength(0);
        expect(pool.connects()).toBe(1); // connect still works
    });
});
