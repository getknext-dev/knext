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
    correlationAttributesFromHeaders,
    installCorrelationIdProvider,
    installTraceIdProvider,
} from "../adapters/tracing";

/**
 * #346 — the ACCEPTANCE-CRITERION proof: a request log line carries a
 * `correlation_id` (+ matching `trace_id`) emitted AUTOMATICALLY on the real
 * request path, with NO hand-call to `runWithRequestContext` in the handler.
 *
 * This exercises exactly the wiring `instrumentation-node.ts` installs when
 * tracing is on:
 *   1. `correlationAttributesFromHeaders` — the `@vercel/otel`
 *      `attributesFromHeaders` hook. It runs per-request with the inbound
 *      headers, adopts a well-formed `x-request-id` (else generates one), and
 *      stamps it as the `knext.correlation_id` attribute on the SERVER span.
 *   2. `installCorrelationIdProvider()` / `installTraceIdProvider()` — injected
 *      into `@knext/lib/context` via `setCorrelationIdProvider` /
 *      `setTraceIdProvider`. At log time the logger mixin resolves both fields
 *      from the ACTIVE OTel span (rides @vercel/otel's
 *      AsyncLocalStorageContextManager), so no ALS wrapping is needed.
 *
 * We simulate the runtime with the SDK's `BasicTracerProvider` +
 * `InMemorySpanExporter` and a real async-hooks context manager (what
 * @vercel/otel registers). The handler body NEVER calls runWithRequestContext.
 */

let exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;
const contextManager = new AsyncLocalStorageContextManager();

function bootRuntime(): void {
    exporter = new InMemorySpanExporter();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
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
 * TextMapGetter shape that @vercel/otel passes to attributesFromHeaders.
 */
const headerGetter = {
    keys: (carrier: Record<string, string>) => Object.keys(carrier),
    get: (carrier: Record<string, string>, key: string) => carrier[key],
};

/**
 * Drive one inbound HTTP request through the runtime exactly as @vercel/otel
 * would: compute the SERVER span's attributes from the inbound headers (via the
 * knext hook), open the SERVER span with them, run the handler under its
 * context, end it. The handler emits a log line WITHOUT any knext ALS wrapping.
 */
async function handleRequest(
    name: string,
    headers: Record<string, string>,
    handler: () => void,
): Promise<Record<string, string | undefined>> {
    const tracer = trace.getTracer("@vercel/otel");
    const attrs = correlationAttributesFromHeaders(headers, headerGetter);
    const server = tracer.startSpan(name, {
        kind: SpanKind.SERVER,
        attributes: attrs,
    });
    const ctx = trace.setSpan(context.active(), server);
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
