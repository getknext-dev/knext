import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
    BasicTracerProvider,
    SimpleSpanProcessor,
    InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { Registry } from "prom-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    COLDSTART_DURATION_METRIC,
    COLDSTART_TOTAL_METRIC,
    createMetricsRegistry,
    DB_WAKE_TOTAL_METRIC,
    GoldenSignalMetricsProcessor,
    HTTP_INFLIGHT_METRIC,
    HTTP_REQUEST_DURATION_METRIC,
    HTTP_REQUESTS_TOTAL_METRIC,
    recordColdStart,
    recordDbWake,
    type KnextMetrics,
} from "../adapters/metrics";
import {
    ColdStartSpanProcessor,
    instrumentPoolForDbWake,
} from "../adapters/tracing";

/**
 * #315 — golden-signal metrics on the core-owned :9091 registry, derived from
 * core-owned OTel hooks (NO app route-handler wiring), mirroring #317's
 * tracing-integration style: exercise the REAL processor / pool wrapper, never
 * hand-increment a counter in the test body.
 */

let exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;
let metrics: KnextMetrics;
const contextManager = new AsyncLocalStorageContextManager();

/**
 * Boot a tracer provider that mirrors the runtime: the golden-signal metrics
 * processor PLUS the cold-start processor PLUS an export processor, with a real
 * async-hooks context manager (as @vercel/otel registers in prod).
 */
function bootRuntime(reg: Registry): {
    cold: ColdStartSpanProcessor;
    golden: GoldenSignalMetricsProcessor;
} {
    exporter = new InMemorySpanExporter();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const cold = new ColdStartSpanProcessor();
    const golden = new GoldenSignalMetricsProcessor(metrics);
    provider = new BasicTracerProvider({
        spanProcessors: [cold, golden, new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    return { cold, golden };
}

beforeEach(() => {
    const reg = new Registry();
    metrics = createMetricsRegistry(reg, "test-app");
});

afterEach(async () => {
    if (provider) {
        await provider.shutdown();
    }
    trace.disable();
    context.disable();
    contextManager.disable();
    provider = undefined;
});

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

/** Drive one inbound HTTP request through a SERVER span, as @vercel/otel would. */
async function handleRequest(
    name: string,
    opts: { kind?: SpanKind; error?: boolean } = {},
    handler: () => Promise<void> = async () => {},
): Promise<void> {
    const tracer = trace.getTracer("@vercel/otel");
    const server = tracer.startSpan(name, {
        kind: opts.kind ?? SpanKind.SERVER,
        attributes: { "http.request.method": "GET" },
    });
    const ctx = trace.setSpan(context.active(), server);
    await context.with(ctx, handler);
    if (opts.error) {
        server.setStatus({ code: SpanStatusCode.ERROR });
        server.setAttribute("http.response.status_code", 500);
    } else {
        server.setAttribute("http.response.status_code", 200);
    }
    server.end();
}

async function scrape(reg: Registry): Promise<string> {
    return reg.metrics();
}

describe("#315 golden signals from the core-owned HTTP-span processor", () => {
    it("increments request-rate + latency + saturation from the SERVER span lifecycle", async () => {
        const reg = metrics.registry;
        bootRuntime(reg);

        await handleRequest("GET /files", {}, async () => {});

        const out = await scrape(reg);
        // request counter, labeled by app + method + status_class (bounded)
        expect(out).toContain(HTTP_REQUESTS_TOTAL_METRIC);
        expect(out).toMatch(
            new RegExp(
                `${HTTP_REQUESTS_TOTAL_METRIC}\\{[^}]*app="test-app"[^}]*method="GET"[^}]*status_class="2xx"[^}]*\\} 1`,
            ),
        );
        // latency histogram present
        expect(out).toContain(`${HTTP_REQUEST_DURATION_METRIC}_bucket`);
        // saturation gauge back to 0 after the request completed
        expect(out).toMatch(
            new RegExp(`${HTTP_INFLIGHT_METRIC}\\{[^}]*\\} 0`),
        );
    });

    it("counts a 5xx / errored request under status_class=5xx", async () => {
        const reg = metrics.registry;
        bootRuntime(reg);
        await handleRequest("GET /boom", { error: true });
        const out = await scrape(reg);
        expect(out).toMatch(
            new RegExp(
                `${HTTP_REQUESTS_TOTAL_METRIC}\\{[^}]*status_class="5xx"[^}]*\\} 1`,
            ),
        );
    });

    it("uses NO per-route or per-user label (bounded cardinality)", async () => {
        const reg = metrics.registry;
        bootRuntime(reg);
        await handleRequest("GET /files/123", {});
        await handleRequest("GET /files/456", {});
        const out = await scrape(reg);
        // Two different raw paths must collapse to ONE series (no route label).
        const lines = out
            .split("\n")
            .filter((l) => l.startsWith(HTTP_REQUESTS_TOTAL_METRIC + "{"));
        expect(lines).toHaveLength(1);
        expect(out).not.toMatch(/route="/);
        expect(out).not.toMatch(/path="/);
    });

    it("ignores non-SERVER spans (only inbound requests count)", async () => {
        const reg = metrics.registry;
        bootRuntime(reg);
        await handleRequest("db query", { kind: SpanKind.CLIENT });
        const out = await scrape(reg);
        expect(out).not.toMatch(
            new RegExp(`${HTTP_REQUESTS_TOTAL_METRIC}\\{[^}]*\\} [1-9]`),
        );
    });
});

describe("#315 cold-start metrics from the #317 ColdStartSpanProcessor path", () => {
    it("increments coldstart_total + observes coldstart_duration on the first request", async () => {
        const reg = metrics.registry;
        bootRuntime(reg);
        await handleRequest("GET /one", {});
        await handleRequest("GET /two", {});
        const out = await scrape(reg);
        // Cold start counted exactly ONCE (first request only).
        expect(out).toMatch(
            new RegExp(`${COLDSTART_TOTAL_METRIC}\\{[^}]*\\} 1`),
        );
        expect(out).toContain(`${COLDSTART_DURATION_METRIC}_bucket`);
    });
});

describe("#315 db-wake metrics from the #317 instrumentPoolForDbWake path", () => {
    it("increments db_wake_total{role} only on the first (0→1) connect", async () => {
        const reg = metrics.registry;
        bootRuntime(reg);
        const pool = makeFakePool();
        instrumentPoolForDbWake(pool, "writer");
        await handleRequest("GET /a", {}, async () => {
            await (await pool.connect()).release();
            await (await pool.connect()).release(); // warm reuse
        });
        const out = await scrape(reg);
        expect(out).toMatch(
            new RegExp(
                `${DB_WAKE_TOTAL_METRIC}\\{[^}]*role="writer"[^}]*\\} 1`,
            ),
        );
        expect(pool.connects()).toBe(2);
    });
});

describe("#315 direct emitters record into the core registry", () => {
    it("recordColdStart / recordDbWake write to the shared registry", async () => {
        const reg = metrics.registry;
        recordColdStart(metrics, 42);
        recordDbWake(metrics, "reader", 17);
        const out = await scrape(reg);
        expect(out).toMatch(
            new RegExp(`${COLDSTART_TOTAL_METRIC}\\{[^}]*\\} 1`),
        );
        expect(out).toMatch(
            new RegExp(`${DB_WAKE_TOTAL_METRIC}\\{[^}]*role="reader"[^}]*\\} 1`),
        );
    });
});
