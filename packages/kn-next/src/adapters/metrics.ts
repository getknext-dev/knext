/**
 * metrics.ts — knext runtime golden-signal metrics on the core-owned :9091
 * Prometheus registry (#315, C1).
 *
 * ## Why this is core-owned, not app-owned
 *
 * `node-server.ts` is a SUPERVISOR: it spawns the standalone Next.js child and
 * exposes a metrics endpoint on :9091, but knext-core does NOT own the app's
 * route-handler chain (`.claude/rules/architecture.md` — request routing is out
 * of scope). So per-request golden signals must NOT be produced by wrapping app
 * route handlers (that pushes hand-instrumentation onto app authors and lives in
 * app code, not core).
 *
 * Instead we reuse the SAME core-owned hook #317 proved for tracing: an OTel
 * `SpanProcessor`. `@vercel/otel` auto-instruments every inbound HTTP request as
 * a SERVER-kind span with no app wiring; a processor's `onStart`/`onEnd` fire for
 * each such span with its timing and status. `GoldenSignalMetricsProcessor`
 * derives the four golden signals from that span lifecycle:
 *
 *   - request RATE     → `knext_http_requests_total{app,method,status_class}`
 *   - ERROR rate       → the `status_class="5xx"` slice of the same counter
 *   - LATENCY          → `knext_http_request_duration_seconds` histogram
 *   - SATURATION       → `knext_http_inflight_requests{app}` gauge (concurrency)
 *
 * It is registered once alongside the #317 `ColdStartSpanProcessor` via
 * `registerOTel({ spanProcessors: [...] })` in the app's `instrumentation.ts` —
 * exactly the same integration point, no handler wrapping.
 *
 * ## Cold-start & DB-wake counters
 *
 * The #317 cold-start / db-wake tracing HOOKS already compute the wake latency;
 * `recordColdStart` / `recordDbWake` let those same hooks also bump a Prometheus
 * counter + duration histogram in this registry, so the numbers show up on the
 * :9091 scrape (not only as spans). Emission stays on the core-owned path — no
 * app code.
 *
 * ## Cardinality
 *
 * Labels are deliberately bounded: `app` (KN_APP_NAME), `method` (HTTP verb),
 * `status_class` ("2xx".."5xx"), and `role` (writer|reader) for DB wakes. NEVER
 * a raw path/route or per-user label — those explode series count. This mirrors
 * the app-side RED registry's bounded-label discipline.
 */

import http from "node:http";
import type { Context, SpanKind } from "@opentelemetry/api";
import { SpanKind as OtelSpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
    Counter,
    collectDefaultMetrics,
    Gauge,
    Histogram,
    type Registry,
} from "prom-client";
import type { KnextSpanProcessor } from "./tracing";

// ── Metric names (exported so tests + docs reference one source of truth) ─────

/** Request-rate + error-rate counter (error rate = the 5xx slice). */
export const HTTP_REQUESTS_TOTAL_METRIC = "knext_http_requests_total";
/** Request-latency histogram (the golden LATENCY signal). */
export const HTTP_REQUEST_DURATION_METRIC =
    "knext_http_request_duration_seconds";
/** In-flight-request gauge (the golden SATURATION signal). */
export const HTTP_INFLIGHT_METRIC = "knext_http_inflight_requests";
/** Cold-start (app boot / first-request wake) counter. */
export const COLDSTART_TOTAL_METRIC = "knext_coldstart_total";
/** Cold-start wake-latency histogram (seconds). */
export const COLDSTART_DURATION_METRIC = "knext_coldstart_duration_seconds";
/** DB 0→1 wake counter, labeled by pool role. */
export const DB_WAKE_TOTAL_METRIC = "knext_db_wake_total";
/** DB wake-latency histogram (seconds), labeled by pool role. */
export const DB_WAKE_DURATION_METRIC = "knext_db_wake_duration_seconds";

/** Latency buckets: sub-ms floor up to slow / cold paths (seconds). */
const REQUEST_LATENCY_BUCKETS = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
/** Wake buckets: scale-to-zero wakes are 100ms..tens of seconds. */
const WAKE_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/**
 * The bundle of knext runtime metrics plus the registry they live in. Grouped so
 * the processor + the cold-start/db-wake emitters share ONE registry instance
 * (the one served on :9091), and tests can stand up an isolated registry.
 */
export interface KnextMetrics {
    readonly registry: Registry;
    readonly app: string;
    readonly httpRequestsTotal: Counter<"app" | "method" | "status_class">;
    readonly httpRequestDuration: Histogram<"app" | "method" | "status_class">;
    readonly httpInflight: Gauge<"app">;
    readonly coldstartTotal: Counter<"app">;
    readonly coldstartDuration: Histogram<"app">;
    readonly dbWakeTotal: Counter<"app" | "role">;
    readonly dbWakeDuration: Histogram<"app" | "role">;
}

/**
 * Build the knext metric set against `registry`, labeled by `app` (KN_APP_NAME).
 * Callers register these on the SAME registry that `node-server.ts` serves on
 * :9091 so the golden signals merge with the default process metrics.
 */
export function createMetricsRegistry(
    registry: Registry,
    app: string,
): KnextMetrics {
    const httpRequestsTotal = new Counter({
        name: HTTP_REQUESTS_TOTAL_METRIC,
        help: "Total inbound HTTP requests, by method and status class.",
        labelNames: ["app", "method", "status_class"] as const,
        registers: [registry],
    });
    const httpRequestDuration = new Histogram({
        name: HTTP_REQUEST_DURATION_METRIC,
        help: "Inbound HTTP request duration in seconds, by method and status class.",
        labelNames: ["app", "method", "status_class"] as const,
        buckets: REQUEST_LATENCY_BUCKETS,
        registers: [registry],
    });
    const httpInflight = new Gauge({
        name: HTTP_INFLIGHT_METRIC,
        help: "In-flight (concurrently-handled) inbound HTTP requests.",
        labelNames: ["app"] as const,
        registers: [registry],
    });
    const coldstartTotal = new Counter({
        name: COLDSTART_TOTAL_METRIC,
        help: "Total cold starts (app boot / first-request wake) observed.",
        labelNames: ["app"] as const,
        registers: [registry],
    });
    const coldstartDuration = new Histogram({
        name: COLDSTART_DURATION_METRIC,
        help: "Cold-start wake duration in seconds.",
        labelNames: ["app"] as const,
        buckets: WAKE_LATENCY_BUCKETS,
        registers: [registry],
    });
    const dbWakeTotal = new Counter({
        name: DB_WAKE_TOTAL_METRIC,
        help: "Total scale-zero-pg 0→1 DB wakes (first connect), by pool role.",
        labelNames: ["app", "role"] as const,
        registers: [registry],
    });
    const dbWakeDuration = new Histogram({
        name: DB_WAKE_DURATION_METRIC,
        help: "DB 0→1 wake / first-connect duration in seconds, by pool role.",
        labelNames: ["app", "role"] as const,
        buckets: WAKE_LATENCY_BUCKETS,
        registers: [registry],
    });
    return {
        registry,
        app,
        httpRequestsTotal,
        httpRequestDuration,
        httpInflight,
        coldstartTotal,
        coldstartDuration,
        dbWakeTotal,
        dbWakeDuration,
    };
}

/**
 * Bucket an HTTP status code into its class ("1xx".."5xx"); anything outside
 * 100–599 (or unknown) is "other" so a bad value can never create unbounded
 * series. This is the ONLY status label we emit — never the raw code.
 */
export function statusClass(status: number | undefined): string {
    if (status === undefined || !Number.isFinite(status)) {
        return "other";
    }
    if (status >= 100 && status < 600) {
        return `${Math.floor(status / 100)}xx`;
    }
    return "other";
}

/** Record a cold start (count + duration) into the core registry. */
export function recordColdStart(metrics: KnextMetrics, wakeMs: number): void {
    metrics.coldstartTotal.labels({ app: metrics.app }).inc();
    metrics.coldstartDuration
        .labels({ app: metrics.app })
        .observe(Math.max(0, wakeMs) / 1000);
}

/** Record a DB 0→1 wake (count + duration) into the core registry. */
export function recordDbWake(
    metrics: KnextMetrics,
    role: "writer" | "reader",
    wakeMs: number,
): void {
    metrics.dbWakeTotal.labels({ app: metrics.app, role }).inc();
    metrics.dbWakeDuration
        .labels({ app: metrics.app, role })
        .observe(Math.max(0, wakeMs) / 1000);
}

// ── The golden-signal span processor ──────────────────────────────────────────

/** Read-only view of a span the processor needs on start (duck-typed vs SDK). */
interface StartedServerSpan {
    readonly kind: SpanKind;
    spanContext(): { traceId: string; spanId: string };
}

/**
 * Read-only view of an ended span: its attributes (for method/status) and its
 * timing. Structurally matches the SDK's `ReadableSpan` fields we use, so this
 * module needs no `@opentelemetry/sdk-trace-base` runtime dependency.
 */
interface EndedServerSpan {
    readonly kind: SpanKind;
    readonly attributes: Record<string, unknown>;
    readonly duration: [number, number]; // [seconds, nanos] HrTime
    readonly status?: { code: SpanStatusCode };
}

function hrTimeToSeconds(duration: [number, number] | undefined): number {
    if (!duration) {
        return 0;
    }
    return duration[0] + duration[1] / 1e9;
}

/**
 * Extract the HTTP method from an inbound-request span's attributes, tolerating
 * both the stable (`http.request.method`) and legacy (`http.method`) OTel
 * conventions. Upper-cased; unknown → "UNKNOWN" (a single bounded value).
 */
function methodOf(attrs: Record<string, unknown>): string {
    const raw = attrs["http.request.method"] ?? attrs["http.method"];
    return typeof raw === "string" && raw.length > 0
        ? raw.toUpperCase()
        : "UNKNOWN";
}

/** Extract the HTTP status code across stable + legacy attribute keys. */
function statusOf(attrs: Record<string, unknown>): number | undefined {
    const raw = attrs["http.response.status_code"] ?? attrs["http.status_code"];
    return typeof raw === "number" ? raw : undefined;
}

/**
 * Derives the four golden signals from the inbound HTTP SERVER span lifecycle —
 * automatically, with NO app route-handler wiring. Register it once next to the
 * #317 cold-start processor:
 *
 *   registerOTel({ spanProcessors: [
 *     new ColdStartSpanProcessor(),
 *     new GoldenSignalMetricsProcessor(metrics),
 *   ]});
 *
 * `onStart` bumps the in-flight gauge for each SERVER span; `onEnd` decrements
 * it and records the request counter (by method + status class) + latency
 * histogram. Non-SERVER spans (DB clients, internal work) are ignored. When
 * tracing is disabled this processor is never registered — zero overhead.
 */
export class GoldenSignalMetricsProcessor implements KnextSpanProcessor {
    constructor(private readonly metrics: KnextMetrics) {}

    onStart(span: StartedServerSpan, _parentContext: Context): void {
        if (span.kind !== OtelSpanKind.SERVER) {
            return;
        }
        this.metrics.httpInflight.labels({ app: this.metrics.app }).inc();
    }

    onEnd(span: unknown): void {
        const ended = span as EndedServerSpan;
        if (ended?.kind !== OtelSpanKind.SERVER) {
            return;
        }
        this.metrics.httpInflight.labels({ app: this.metrics.app }).dec();

        const attrs = ended.attributes ?? {};
        // An OTel ERROR status with no explicit HTTP code is a server error.
        let status = statusOf(attrs);
        if (
            status === undefined &&
            ended.status?.code === SpanStatusCode.ERROR
        ) {
            status = 500;
        }
        const labels = {
            app: this.metrics.app,
            method: methodOf(attrs),
            status_class: statusClass(status),
        };
        this.metrics.httpRequestsTotal.labels(labels).inc();
        this.metrics.httpRequestDuration
            .labels(labels)
            .observe(hrTimeToSeconds(ended.duration));
    }

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

// ── Runtime singleton wiring (used by node-server.ts) ─────────────────────────

let runtimeMetrics: KnextMetrics | undefined;

/**
 * Initialise (once) the knext metric set on `registry`. Idempotent: a second
 * call returns the first instance so the cold-start / db-wake emitters and the
 * span processor share one registry. `app` defaults to KN_APP_NAME.
 *
 * This is the CHILD-process path (called from `instrumentation.ts`). It carries
 * ONLY the `knext_*` families — it deliberately does NOT seed prom-client's
 * default process metrics, because the persistent SUPERVISOR (`node-server.ts`)
 * already owns them on its own registry. Seeding them here too would duplicate
 * every default family (`process_*`, `nodejs_*`) in the supervisor's merged
 * `:9091` exposition on the healthy warm path — duplicate `# HELP`/`# TYPE`
 * lines and duplicate zero-label samples, which Prometheus rejects. Opt in via
 * `collectDefaults` only for a standalone registry that has no supervisor in
 * front of it (not the case for the knext runtime).
 */
export function initRuntimeMetrics(
    registry: Registry,
    app: string = process.env.KN_APP_NAME ?? "unknown",
    collectDefaults = false,
): KnextMetrics {
    if (runtimeMetrics) {
        return runtimeMetrics;
    }
    if (collectDefaults) {
        collectDefaultMetrics({ register: registry });
    }
    runtimeMetrics = createMetricsRegistry(registry, app);
    return runtimeMetrics;
}

/** The initialised runtime metrics, or `undefined` before `initRuntimeMetrics`. */
export function getRuntimeMetrics(): KnextMetrics | undefined {
    return runtimeMetrics;
}

/** Reset the runtime singleton (tests only). */
export function resetRuntimeMetrics(): void {
    runtimeMetrics = undefined;
}

// ── Cross-process bridge: child emits, supervisor scrapes ─────────────────────
//
// The golden-signal / cold-start / db-wake metrics are emitted in the Next.js
// CHILD process (that's where the @vercel/otel HTTP spans and the #317 hooks
// run). But the operator scrapes the SUPERVISOR's :9091 (it injects
// prometheus.io/port=9091). So the child serves its core registry on a small
// localhost-only port, and the supervisor's :9091 handler merges its own
// process-metric exposition with a best-effort fetch of the child's — no app
// route code, one core-owned scrape target unchanged (:9091).

/** Default port the child binds for its core metrics (supervisor scrapes it). */
export const CHILD_METRICS_PORT = Number(
    process.env.KN_CHILD_METRICS_PORT ?? 9092,
);

/**
 * Bind a tiny localhost HTTP server that serves `registry` at `/metrics`. Used
 * by the child (Next standalone) so the supervisor can scrape its core series.
 * Bound to 127.0.0.1 by default — never externally reachable; the pod-external
 * scrape target stays the supervisor's :9091.
 */
export function startChildMetricsServer(
    registry: Registry,
    port: number = CHILD_METRICS_PORT,
    host = "127.0.0.1",
): http.Server {
    const server = http.createServer(async (req, res) => {
        if (req.url === "/metrics" && req.method === "GET") {
            res.setHeader("Content-Type", registry.contentType);
            res.end(await registry.metrics());
            return;
        }
        res.writeHead(404);
        res.end("Not Found");
    });
    server.listen(port, host);
    return server;
}

/**
 * Best-effort scrape of the child's core metrics over localhost. Returns the
 * exposition body, or an empty string on ANY error (child not up yet, tracing
 * off so no child server, timeout) — the supervisor must still serve its own
 * process metrics, so a missing child is never fatal.
 */
export function fetchChildMetrics(
    port: number = CHILD_METRICS_PORT,
    host = "127.0.0.1",
    timeoutMs = 2000,
): Promise<string> {
    return new Promise((resolve) => {
        const req = http.get(
            { host, port, path: "/metrics", timeout: timeoutMs },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve("");
                    return;
                }
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () => resolve(body));
            },
        );
        req.on("error", () => resolve(""));
        req.on("timeout", () => {
            req.destroy();
            resolve("");
        });
    });
}

/**
 * Merge several Prometheus exposition bodies into one, dropping empty sources
 * (e.g. an unreachable child) and ensuring exactly one separating newline
 * between non-empty sources. Prometheus tolerates concatenated exposition as
 * long as each metric's HELP/TYPE precedes its samples, which holds because
 * each source is a self-contained registry dump.
 */
export function mergeExposition(sources: string[]): string {
    const parts = sources.filter((s) => s.length > 0);
    if (parts.length === 0) {
        return "";
    }
    // Ensure each source ends in exactly one newline so the seam between two
    // registry dumps is a single blank-free boundary (Prometheus ignores blank
    // lines, but we keep the output tidy and avoid a doubled newline at joins).
    return parts.map((p) => p.replace(/\n*$/, "\n")).join("");
}
