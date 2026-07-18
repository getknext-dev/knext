import { ServerResponse } from "node:http";
import {
    CORRELATION_HEADER,
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
    CORRELATION_RESPONSE_INSTALLED,
    installCorrelationResponseEcho,
} from "../adapters/correlation-response";
import {
    CORRELATION_ATTRIBUTE,
    CorrelationContextPropagator,
    CorrelationSpanProcessor,
    installCorrelationIdProvider,
    installTraceIdProvider,
    withCorrelationId,
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

describe("#401: the shared context reader re-validates — all three readers inherit the guard", () => {
    beforeEach(() => {
        bootRuntime();
    });

    /**
     * Capture `x-request-id` header writes on the echo patch without a live
     * socket: replace the prototype's BASE methods with a shared store (the
     * patch closes over these as its "originals"), install the echo, run `fn`,
     * then restore everything (including the install latch) in `finally`.
     */
    function withEchoCapture(
        fn: (headers: Record<string, unknown>) => void,
    ): void {
        const pristineWriteHead = ServerResponse.prototype.writeHead;
        const pristineSetHeader = ServerResponse.prototype.setHeader;
        const pristineGetHeader = ServerResponse.prototype.getHeader;
        const headers: Record<string, unknown> = {};
        ServerResponse.prototype.setHeader = function baseSetHeader(
            this: ServerResponse,
            name: string,
            value: unknown,
        ) {
            headers[String(name).toLowerCase()] = value;
            return this;
        } as ServerResponse["setHeader"];
        ServerResponse.prototype.getHeader = function baseGetHeader(
            this: ServerResponse,
            name: string,
        ) {
            return headers[String(name).toLowerCase()] as
                | number
                | string
                | string[]
                | undefined;
        } as ServerResponse["getHeader"];
        ServerResponse.prototype.writeHead = function baseWriteHead(
            this: ServerResponse,
        ) {
            return this;
        } as ServerResponse["writeHead"];
        try {
            // biome-ignore lint/suspicious/noExplicitAny: clearing the install latch for isolation.
            delete (ServerResponse.prototype as any)[
                CORRELATION_RESPONSE_INSTALLED
            ];
            installCorrelationResponseEcho();
            const res = Object.create(
                ServerResponse.prototype,
            ) as ServerResponse;
            fn(headers);
            res.writeHead(200);
        } finally {
            ServerResponse.prototype.writeHead = pristineWriteHead;
            ServerResponse.prototype.setHeader = pristineSetHeader;
            ServerResponse.prototype.getHeader = pristineGetHeader;
            // biome-ignore lint/suspicious/noExplicitAny: clearing the install latch for isolation.
            delete (ServerResponse.prototype as any)[
                CORRELATION_RESPONSE_INSTALLED
            ];
        }
    }

    it("a hostile id seeded via the verbatim withCorrelationId seam is omitted from log fields, the SERVER-span attribute, AND the response echo", async () => {
        // UNVALIDATED source: `withCorrelationId` writes the context key
        // verbatim (any future caller could seed from an unvalidated source).
        // The shared reader (`correlationIdFromContext`) must refuse the value
        // so ALL THREE readers of the key behave as if no id was seeded:
        //   1. the logger mixin (via installCorrelationIdProvider)
        //   2. the CorrelationSpanProcessor SERVER-span attribute
        //   3. the response echo (installCorrelationResponseEcho)
        const tracer = trace.getTracer("@vercel/otel");
        const hostile = "evil\r\nx-injected: 1";
        const seeded = withCorrelationId(context.active(), hostile);
        const server = tracer.startSpan(
            "GET /hostile",
            { kind: SpanKind.SERVER },
            seeded,
        );

        let fields: Record<string, string | undefined> = {};
        let stamped: Record<string, unknown> = {};
        await context.with(trace.setSpan(seeded, server), async () => {
            fields = correlationLogFields(); // reader 1: logger mixin
            withEchoCapture((headers) => {
                stamped = headers; // reader 3: response echo at writeHead
            });
        });
        server.end();

        const finished = exporter
            .getFinishedSpans()
            .find((s) => s.name === "GET /hostile");

        expect(
            fields.correlation_id,
            "logger mixin must omit a hostile context-seeded id (fail-open: no id)",
        ).toBeUndefined();
        expect(
            finished?.attributes[CORRELATION_ATTRIBUTE],
            "SERVER-span attribute must omit a hostile context-seeded id",
        ).toBeUndefined();
        expect(
            stamped[CORRELATION_HEADER],
            "response echo must omit a hostile context-seeded id",
        ).toBeUndefined();
    });

    it("an over-long id (> MAX_ID_LENGTH) seeded via withCorrelationId is omitted from log fields and the span attribute", async () => {
        const tracer = trace.getTracer("@vercel/otel");
        const seeded = withCorrelationId(context.active(), "a".repeat(129));
        const server = tracer.startSpan(
            "GET /too-long",
            { kind: SpanKind.SERVER },
            seeded,
        );
        let fields: Record<string, string | undefined> = {};
        await context.with(trace.setSpan(seeded, server), async () => {
            fields = correlationLogFields();
        });
        server.end();

        const finished = exporter
            .getFinishedSpans()
            .find((s) => s.name === "GET /too-long");
        expect(fields.correlation_id).toBeUndefined();
        expect(finished?.attributes[CORRELATION_ATTRIBUTE]).toBeUndefined();
    });

    it("a well-formed id seeded via withCorrelationId still flows to log fields and the span attribute (no behavior change)", async () => {
        const tracer = trace.getTracer("@vercel/otel");
        const seeded = withCorrelationId(context.active(), "manual-seed_1.2-3");
        const server = tracer.startSpan(
            "GET /manual",
            { kind: SpanKind.SERVER },
            seeded,
        );
        let fields: Record<string, string | undefined> = {};
        await context.with(trace.setSpan(seeded, server), async () => {
            fields = correlationLogFields();
        });
        server.end();

        const finished = exporter
            .getFinishedSpans()
            .find((s) => s.name === "GET /manual");
        expect(fields.correlation_id).toBe("manual-seed_1.2-3");
        expect(fields.trace_id).toBe(finished?.spanContext().traceId);
        expect(finished?.attributes[CORRELATION_ATTRIBUTE]).toBe(
            "manual-seed_1.2-3",
        );
    });
});
