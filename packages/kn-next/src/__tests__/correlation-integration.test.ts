import {
    correlationLogFields,
    resetCorrelationIdProvider,
    resetTraceIdProvider,
    setCorrelationIdProvider,
    setTraceIdProvider,
} from "@knext/lib/context";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    CORRELATION_ATTRIBUTE,
    CorrelationContextPropagator,
    CorrelationSpanProcessor,
    installCorrelationIdProvider,
    installTraceIdProvider,
} from "../adapters/tracing";

/**
 * #346 — the ACCEPTANCE-CRITERION proof: a request log line carries a
 * `correlation_id` (+ matching `trace_id`) emitted AUTOMATICALLY on the real
 * request path, with NO hand-call to `runWithRequestContext` in the handler,
 * INCLUDING log lines emitted while a CHILD span (db_wake / cold_start / any
 * app or auto-instrumented span) is active.
 *
 * This exercises exactly the wiring `instrumentation-node.ts` installs when
 * tracing is on:
 *   1. `CorrelationContextPropagator` — a `TextMapPropagator` whose `extract`
 *      runs per-request on the inbound headers (before the SERVER span opens),
 *      adopts a well-formed `x-request-id` (else generates one) and puts it on
 *      the OTel Context under a private key. `@opentelemetry/instrumentation-http`
 *      starts the SERVER span under this extracted context, so the key descends
 *      to the SERVER span AND every child span by construction.
 *   2. `CorrelationSpanProcessor` — copies the context-key id onto the SERVER
 *      span as `knext.correlation_id` for TRACE EXPORT (so a backend can index /
 *      echo it). Logs are NOT resolved from this attribute.
 *   3. `installCorrelationIdProvider()` / `installTraceIdProvider()` — injected
 *      into `@knext/lib/context`. At log time the logger mixin resolves
 *      `correlation_id` from the active OTel CONTEXT KEY (constant across the
 *      whole trace incl. child spans) and `trace_id` from the active span.
 *
 * We simulate the runtime with the SDK's `BasicTracerProvider` +
 * `InMemorySpanExporter` and a real async-hooks context manager (what
 * @vercel/otel registers). The handler body NEVER calls runWithRequestContext.
 */

let exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;
const contextManager = new AsyncLocalStorageContextManager();
const propagator = new CorrelationContextPropagator();

function bootRuntime(): void {
    exporter = new InMemorySpanExporter();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider({
        spanProcessors: [
            new CorrelationSpanProcessor(),
            new SimpleSpanProcessor(exporter),
        ],
    });
    trace.setGlobalTracerProvider(provider);
    // The one-time wiring instrumentation-node.ts performs when tracing is on.
    setCorrelationIdProvider(installCorrelationIdProvider());
    setTraceIdProvider(installTraceIdProvider());
}

afterEach(async () => {
    if (provider) {
        await provider.shutdown();
    }
    resetCorrelationIdProvider();
    resetTraceIdProvider();
    trace.disable();
    context.disable();
    contextManager.disable();
    provider = undefined;
    exporter = new InMemorySpanExporter();
});

/**
 * A minimal getter over a plain header map, matching @opentelemetry/api's
 * TextMapGetter shape that instrumentation-http passes to a propagator.
 */
const headerGetter = {
    keys: (carrier: Record<string, string>) => Object.keys(carrier),
    get: (carrier: Record<string, string>, key: string) => carrier[key],
};

/**
 * Drive one inbound HTTP request through the runtime exactly as
 * instrumentation-http does: EXTRACT the inbound context (our propagator seeds
 * the correlation key), then open the SERVER span UNDER the extracted context,
 * run the handler under it, end it. The handler emits a log line WITHOUT any
 * knext ALS wrapping. `body` may open child spans to model the DB-wake path.
 */
async function handleRequest(
    name: string,
    headers: Record<string, string>,
    handler: () => void,
): Promise<Record<string, string | undefined>> {
    const tracer = trace.getTracer("@vercel/otel");
    // instrumentation-http: parent context = propagation.extract(active, headers)
    const extracted = propagator.extract(
        context.active(),
        headers,
        headerGetter,
    );
    const server = tracer.startSpan(name, { kind: SpanKind.SERVER }, extracted);
    const ctx = trace.setSpan(extracted, server);
    let captured: Record<string, string | undefined> = {};
    await context.with(ctx, async () => {
        // No runWithRequestContext here — this is the whole point of #346.
        captured = correlationLogFields();
        handler();
    });
    server.end();
    return captured;
}

describe("#346 acceptance: in-request log line is auto-correlated on the real path", () => {
    beforeEach(() => {
        bootRuntime();
    });

    it("a log line inside a request carries correlation_id + the matching trace_id, no ALS wrapping", async () => {
        const fields = await handleRequest("GET /files", {}, () => {});

        const server = exporter
            .getFinishedSpans()
            .find((s) => s.name === "GET /files");
        const traceId = server?.spanContext().traceId;

        // The mixin fields resolved purely from the active OTel span.
        expect(fields.correlation_id, "correlation_id present").toBeTruthy();
        expect(fields.trace_id).toBe(traceId);
        // The correlation id landed on the SERVER span too (for echo/export).
        expect(server?.attributes[CORRELATION_ATTRIBUTE]).toBe(
            fields.correlation_id,
        );
    });

    it("adopts a well-formed inbound x-request-id as the correlation_id", async () => {
        const fields = await handleRequest(
            "GET /files",
            { "x-request-id": "inbound-req-42" },
            () => {},
        );
        expect(fields.correlation_id).toBe("inbound-req-42");
    });

    it("generates a correlation_id when x-request-id is absent", async () => {
        const fields = await handleRequest("GET /files", {}, () => {});
        expect(fields.correlation_id).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it("generates a correlation_id when x-request-id is malformed (untrusted input)", async () => {
        const fields = await handleRequest(
            "GET /files",
            { "x-request-id": "<script>alert(1)</script>" },
            () => {},
        );
        expect(fields.correlation_id).not.toContain("<script>");
        expect(fields.correlation_id).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it("distinct requests get distinct generated correlation ids", async () => {
        const a = await handleRequest("GET /a", {}, () => {});
        const b = await handleRequest("GET /b", {}, () => {});
        expect(a.correlation_id).not.toBe(b.correlation_id);
    });

    it("a log line emitted while a CHILD span is active STILL carries the request's correlation_id (BLOCKER 1)", async () => {
        // The db_wake / cold_start path opens ACTIVE child spans via
        // startActiveSpan, which re-parents `trace.getActiveSpan()` to the child.
        // The correlation id must ride the OTel CONTEXT (constant across the
        // trace), not the innermost span's attributes, so a log line on the
        // DB-wake path — exactly where the diagnostic value is — still resolves
        // the SERVER-level correlation id (and the same trace_id).
        let atServer: Record<string, string | undefined> = {};
        let inChild: Record<string, string | undefined> = {};
        const tracer = trace.getTracer("@knext/core");

        await handleRequest(
            "GET /files",
            { "x-request-id": "req-child-1" },
            () => {
                atServer = correlationLogFields();
                // Open a child span (models knext.db_wake) and log inside it.
                tracer.startActiveSpan("knext.db_wake", (child) => {
                    inChild = correlationLogFields();
                    child.end();
                });
            },
        );

        expect(atServer.correlation_id).toBe("req-child-1");
        // The gap this blocker names: WITHOUT the context-key carrier this is
        // undefined (attribute lives only on the SERVER span).
        expect(inChild.correlation_id).toBe("req-child-1");
        // trace_id stays constant across the trace, so it must match too.
        expect(inChild.trace_id).toBe(atServer.trace_id);
        expect(inChild.trace_id).toBeTruthy();
    });

    it("nested child spans all resolve the same correlation_id (context descends)", async () => {
        const seen: (string | undefined)[] = [];
        const tracer = trace.getTracer("@knext/core");
        await handleRequest(
            "GET /files",
            { "x-request-id": "req-nested-1" },
            () => {
                seen.push(correlationLogFields().correlation_id);
                tracer.startActiveSpan("knext.cold_start", (a) => {
                    seen.push(correlationLogFields().correlation_id);
                    tracer.startActiveSpan("knext.db_wake", (b) => {
                        seen.push(correlationLogFields().correlation_id);
                        b.end();
                    });
                    a.end();
                });
            },
        );
        expect(seen).toEqual(["req-nested-1", "req-nested-1", "req-nested-1"]);
    });
});

describe("#346 acceptance: zero-overhead when tracing is DISABLED", () => {
    it("no provider ⇒ no correlation fields on a log line (default-off)", () => {
        // No bootRuntime(): no tracer provider, no injected providers.
        trace.disable();
        resetCorrelationIdProvider();
        resetTraceIdProvider();
        expect(correlationLogFields()).toEqual({});
    });
});
