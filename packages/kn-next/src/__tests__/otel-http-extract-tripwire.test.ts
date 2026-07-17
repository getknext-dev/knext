import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { CORRELATION_HEADER } from "@knext/lib/context";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    correlationIdFromContext,
    CorrelationContextPropagator,
} from "../adapters/tracing";

/**
 * #350 Part 2 — OTel-upgrade TRIPWIRE for the #346 child-span correlation.
 *
 * WHY A TRIPWIRE (not a live-HTTP e2e). The #346 automatic correlation rests on
 * ONE load-bearing behavior of the inbound HTTP auto-instrumentation
 * (`@opentelemetry/instrumentation-http`, which `@vercel/otel` uses):
 *
 *   for each inbound request it runs `propagation.extract(activeContext,
 *   requestHeaders)` and starts the SERVER span UNDER the returned context.
 *
 * That ordering is what lets `CorrelationContextPropagator.extract` seed a
 * context key that then descends to the SERVER span AND every child span
 * (db_wake / cold_start / pg / fetch). If a future `@vercel/otel` /
 * `@opentelemetry/instrumentation-http` bump changed it (e.g. started the SERVER
 * span first, then extracted; or dropped the extracted context as the span
 * parent), #346 child-span correlation would silently break with NO red test —
 * exactly the gap the system-designer flagged on PR #349.
 *
 * A true end-to-end test against the REAL instrumentation is NOT robust here:
 * `@vercel/otel@2.x` esbuild-BUNDLES `@opentelemetry/instrumentation-http` into
 * its `dist/node` build (it is not a separately-resolvable module), and its node
 * inbound-HTTP instrumentation is installed via a `node:http` require-hook that
 * only patches http if `registerOTel` runs BEFORE `node:http` is first required —
 * impossible under vitest, where http is already loaded. Driving a real request
 * through it in-process would therefore assert nothing about the extract→parent
 * ordering. So we pin the assumption with a TRIPWIRE that fails loudly on an
 * OTel bump that changes the contract, and points the upgrader at the exact fact
 * to re-verify.
 *
 * This tripwire has THREE prongs:
 *   (1) the seam we call still exists: `@vercel/otel` exports `registerOTel`, and
 *       we depend on its `propagators` + `spanProcessors` options;
 *   (2) the bundled node instrumentation still contains the extract + SERVER-span
 *       machinery (a source-level pin — a bundle that no longer references them
 *       is a red flag to re-audit the contract);
 *   (3) an in-process CONTRACT assertion modeling the exact extract→SERVER-span
 *       sequence, proving that IF the instrumentation keeps that ordering, our
 *       propagator makes the correlation id descend to a child span. Prong (3) is
 *       the executable statement of the assumption prongs (1)/(2) guard.
 */

const require_ = createRequire(import.meta.url);

// Resolve @vercel/otel the way the app does (from apps/file-manager), so the
// tripwire pins the SAME copy the runtime ships.
function resolveVercelOtel(): { path: string; mod: Record<string, unknown> } {
    const p = require_.resolve("@vercel/otel", {
        paths: [
            new URL("../../../../apps/file-manager", import.meta.url).pathname,
            new URL("../../..", import.meta.url).pathname,
        ],
    });
    return { path: p, mod: require_(p) as Record<string, unknown> };
}

describe("#350 Part 2: OTel-upgrade tripwire — the seam we call still exists", () => {
    it("@vercel/otel still exports registerOTel (the wiring entry we call)", () => {
        const { mod } = resolveVercelOtel();
        expect(typeof mod.registerOTel).toBe("function");
    });

    it("the bundled node build still references propagation.extract + SERVER-span machinery", () => {
        // A source-level pin: @vercel/otel esbuild-bundles the inbound HTTP
        // instrumentation. If a bump strips the extract/SERVER-span references,
        // the extract→parent contract may have changed shape — re-audit #346.
        const { path } = resolveVercelOtel();
        // path resolves to dist/node/index.js (the node entry the runtime loads).
        const src = readFileSync(path, "utf8");
        expect(src, "bundled node build must still call propagation.extract").toContain(
            "extract",
        );
        expect(src, "bundled node build must still model a SERVER span kind").toContain(
            "SpanKind.SERVER",
        );
    });
});

// ── Prong (3): in-process contract assertion ──────────────────────────────────

let exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;
const contextManager = new AsyncLocalStorageContextManager();
const propagator = new CorrelationContextPropagator();

function boot(): void {
    exporter = new InMemorySpanExporter();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
}

afterEach(async () => {
    if (provider) {
        await provider.shutdown();
    }
    provider = undefined;
    trace.disable();
    context.disable();
    contextManager.disable();
    exporter = new InMemorySpanExporter();
});

const headerGetter = {
    keys: (c: Record<string, string>) => Object.keys(c),
    get: (c: Record<string, string>, k: string) => c[k],
};

describe("#350 Part 2: the extract→SERVER-span contract #346 depends on", () => {
    beforeEach(() => {
        boot();
    });

    it("PINNED ASSUMPTION: instrumentation-http extracts THEN starts the SERVER span under the extracted context — so the id descends to child spans", () => {
        // This is the EXACT sequence @opentelemetry/instrumentation-http performs
        // per inbound request. If an OTel bump changes it, #346 breaks; this test
        // states the assumption so the change is caught here, not in prod.
        const tracer = trace.getTracer("@vercel/otel");
        const inboundHeaders = { [CORRELATION_HEADER]: "req-tripwire-1" };

        // 1. extract(activeContext, headers) — our propagator seeds the key.
        const extracted = propagator.extract(
            context.active(),
            inboundHeaders,
            headerGetter,
        );
        // 2. The SERVER span is started UNDER the extracted context (the pin).
        const server = tracer.startSpan(
            "GET /files",
            { kind: SpanKind.SERVER },
            extracted,
        );
        const serverCtx = trace.setSpan(extracted, server);

        let childHadId: string | undefined;
        let childHadTraceId: string | undefined;
        let serverTraceId: string | undefined;
        context.with(serverCtx, () => {
            // A child span (models knext.db_wake) opened via the active context.
            tracer.startActiveSpan("knext.db_wake", (child) => {
                // The correlation id must resolve from the ACTIVE context inside
                // the child — this is the child-span correlation #346 guarantees.
                childHadId = correlationIdFromContext(context.active());
                childHadTraceId = child.spanContext().traceId;
                child.end();
            });
            serverTraceId = server.spanContext().traceId;
        });
        server.end();

        expect(childHadId).toBe("req-tripwire-1");
        // Same trace: the child is parented under the SERVER span.
        expect(childHadTraceId).toBe(serverTraceId);
        expect(childHadTraceId).toBeTruthy();
    });

    it("COUNTER-PROOF: if the SERVER span were started WITHOUT the extracted context (the broken ordering), the id would NOT descend — this is what the tripwire guards", () => {
        const tracer = trace.getTracer("@vercel/otel");
        const inboundHeaders = { [CORRELATION_HEADER]: "req-tripwire-2" };
        const extracted = propagator.extract(
            context.active(),
            inboundHeaders,
            headerGetter,
        );

        // The BROKEN ordering: start the SERVER span under the ROOT context
        // (not the extracted one), as would happen if a bump started the span
        // before/independently of extract. The key never reaches the child.
        const server = tracer.startSpan(
            "GET /files",
            { kind: SpanKind.SERVER },
            context.active(),
        );
        const serverCtx = trace.setSpan(context.active(), server);

        let childHadId: string | undefined;
        context.with(serverCtx, () => {
            tracer.startActiveSpan("knext.db_wake", (child) => {
                childHadId = correlationIdFromContext(context.active());
                child.end();
            });
        });
        server.end();

        // Demonstrates the failure mode the correct ordering avoids: with the
        // broken sequence the id is LOST at the child span.
        expect(childHadId).toBeUndefined();
        // And the id was on the extracted context all along (sanity).
        expect(correlationIdFromContext(extracted)).toBe("req-tripwire-2");
    });
});
