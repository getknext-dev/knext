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
/**
 * Deep-health state gauge (#348), labeled by `dependency` + `state`. For each
 * dependency (and the `overall` roll-up) the ACTIVE state is 1 and every other
 * state 0. This exposes the {@link import("@knext/lib/health").checkDeepHealth}
 * verdict as a SCRAPABLE series so Prometheus can alert on a SUSTAINED `waking`
 * — a permanent connection-level DB outage that `checkDeepHealth` correctly
 * classifies `waking` forever (never `down`), so `down`/503-keyed alerts alone
 * would never page.
 */
export const DEEP_HEALTH_STATE_METRIC = "knext_deep_health_state";

/**
 * The fixed, bounded set of deep-health states we emit for the `overall`
 * roll-up. Emitting every state as its own series (active=1, rest=0) means an
 * alert on `state="waking" == 1` is unambiguous AND self-clears when the state
 * flips (the prior `waking` series drops to 0). Bounded by construction — no
 * unbounded label growth.
 */
const DEEP_HEALTH_STATES = ["ok", "degraded", "down", "waking"] as const;
/** Per-dependency sub-check states (postgres adds `waking`; redis never wakes). */
const DEEP_HEALTH_DEP_STATES = [
    "up",
    "down",
    "unconfigured",
    "waking",
] as const;
/** Dependencies we roll up plus the composite. Bounded, no per-instance labels. */
const DEEP_HEALTH_DEPENDENCIES = ["overall", "postgres", "redis"] as const;

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
    readonly deepHealthState: Gauge<"app" | "dependency" | "state">;
}

/**
 * The minimal shape of a `@knext/lib` `HealthStatus` (deliberately duplicated
 * so this core module keeps NO dependency on `@knext/lib` — the app wiring
 * bridges the two). Structurally matches `checkDeepHealth`'s return.
 */
export interface DeepHealthSnapshot {
    readonly status: "ok" | "degraded" | "down" | "waking";
    readonly checks: {
        readonly postgres: "up" | "down" | "unconfigured" | "waking";
        readonly redis: "up" | "down" | "unconfigured";
    };
    /** Present on the real `@knext/lib` HealthStatus; unused here. */
    readonly timestamp?: string;
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
    const deepHealthState = new Gauge({
        name: DEEP_HEALTH_STATE_METRIC,
        help: "Deep-health verdict per dependency + the overall roll-up: the active state is 1, every other state 0 (#348). Alert on overall state='waking' sustained past the wake budget.",
        labelNames: ["app", "dependency", "state"] as const,
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
        deepHealthState,
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

/**
 * Refresh the `knext_deep_health_state` gauge (#348) from a deep-health
 * snapshot: for each dependency (and the `overall` roll-up) set the ACTIVE
 * state to 1 and every OTHER known state to 0. Emitting all states as explicit
 * 0/1 series means an alert on `state="waking" == 1` is unambiguous and
 * SELF-CLEARS when the state flips — the previously-active series drops to 0,
 * with no stale `waking=1` left behind.
 *
 * Called by the app wiring on the :9091 SCRAPE cadence (right before serving
 * exposition) after running `checkDeepHealth()` — no new background timer, the
 * deep check runs on Prometheus's scrape interval.
 */
export function refreshDeepHealthGauge(
    metrics: KnextMetrics,
    health: DeepHealthSnapshot,
): void {
    const { app } = metrics;
    for (const state of DEEP_HEALTH_STATES) {
        metrics.deepHealthState
            .labels({ app, dependency: "overall", state })
            .set(state === health.status ? 1 : 0);
    }
    for (const state of DEEP_HEALTH_DEP_STATES) {
        metrics.deepHealthState
            .labels({ app, dependency: "postgres", state })
            .set(state === health.checks.postgres ? 1 : 0);
    }
    for (const state of DEEP_HEALTH_DEP_STATES) {
        metrics.deepHealthState
            .labels({ app, dependency: "redis", state })
            .set(state === health.checks.redis ? 1 : 0);
    }
}

// Reference the bounded dependency list so it stays a documented source of
// truth (the loops above enumerate the individual members explicitly).
void DEEP_HEALTH_DEPENDENCIES;

/** Dependencies the scrape hook injects (kept core-owned + @knext/lib-free). */
export interface DeepHealthScrapeDeps {
    /** Runs the deep dependency check (bridged from `@knext/lib/health`). */
    readonly checkDeepHealth: () => Promise<DeepHealthSnapshot>;
    /**
     * Whether the app used the DB pool RECENTLY (bridged from `@knext/lib`'s
     * `isDbRecentlyActive`). When false, the hook SKIPS the deep check so an idle
     * app's scale-to-zero DB is never woken by the :9091 scrape (#348 gate fix).
     */
    readonly isRecentlyActive: () => boolean;
}

/**
 * Build the :9091 scrape hook that refreshes the deep-health gauge — ACTIVITY-
 * GATED (#348 gate fix). It runs `checkDeepHealth()` (which dials Postgres) ONLY
 * when `isRecentlyActive()` is true; when the app has been idle past the DB
 * activity budget it does NOTHING, leaving the gauge at its last-known value so
 * the idle DB can sleep normally. This preserves BOTH the alert (a real in-use
 * DB stuck `waking` still pages) AND scale-to-zero (an idle app's DB sleeps).
 *
 * Fail-open: a throwing deep check never rejects the scrape.
 */
export function makeDeepHealthScrapeHook(
    metrics: KnextMetrics,
    deps: DeepHealthScrapeDeps,
): () => Promise<void> {
    return async () => {
        // ACTIVITY GATE: skip the DB dial entirely when the pool is idle. This is
        // the whole fix — no `SELECT 1` on scrape while idle ⇒ the gateway lets
        // the DB sleep. A stuck-`waking` outage only matters while the app is
        // actively using the DB, which is exactly when this gate is open.
        if (!deps.isRecentlyActive()) {
            return;
        }
        try {
            const health = await deps.checkDeepHealth();
            refreshDeepHealthGauge(metrics, health);
        } catch {
            // Fail-open: a failed deep check must never fail the scrape; leave the
            // gauge at its last-known value.
        }
    };
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
    onScrape?: () => Promise<void> | void,
): http.Server {
    const server = http.createServer(async (req, res) => {
        if (req.url === "/metrics" && req.method === "GET") {
            // Refresh scrape-cadence-driven gauges (e.g. the #348 deep-health
            // state) right before serving. This runs the deep check on
            // Prometheus's scrape interval — no new background timer. FAIL-OPEN:
            // a throwing hook must never fail the scrape, so we still serve the
            // base registry (a missing refresh is a stale-but-present sample).
            if (onScrape) {
                try {
                    await onScrape();
                } catch {
                    // fall through and serve whatever the registry has
                }
            }
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

/** The slice of `http.IncomingMessage` the supervisor handler reads. */
interface MetricsRequest {
    readonly url?: string;
    readonly method?: string;
}

/** The slice of `http.ServerResponse` the supervisor handler writes. */
interface MetricsResponse {
    setHeader(name: string, value: string): unknown;
    writeHead(status: number): unknown;
    end(body?: string): unknown;
}

export interface SupervisorMetricsHandlerDeps {
    /** The supervisor's :9091 registry. */
    readonly registry: Registry;
    /**
     * Starts prom-client's default-metric collection if it has not started yet
     * (#441). A scrape that lands DURING the child's boot — i.e. before the
     * child-serving signal fires — must still return a complete exposition, so
     * the scrape itself is a start trigger. Idempotent by contract.
     */
    readonly ensureDefaultMetrics: () => boolean;
    /** Best-effort scrape of the child's core metrics (see `fetchChildMetrics`). */
    readonly fetchChild: () => Promise<string>;
}

/**
 * Build the supervisor's `/metrics` request listener: start deferred default
 * metrics on demand, then serve our own exposition merged with a best-effort
 * scrape of the child's. Extracted from `node-server.ts` so the deferral
 * behaviour is unit-testable without spawning a real child.
 */
export function createSupervisorMetricsHandler(
    deps: SupervisorMetricsHandlerDeps,
): (req: MetricsRequest, res: MetricsResponse) => Promise<void> {
    return async (req, res) => {
        if (req.url === "/metrics" && req.method === "GET") {
            // On-demand start: an early scrape gets real process metrics rather
            // than an empty registry (see deferred-default-metrics.ts).
            deps.ensureDefaultMetrics();
            res.setHeader("Content-Type", deps.registry.contentType);
            const [own, child] = await Promise.all([
                deps.registry.metrics(),
                deps.fetchChild(),
            ]);
            res.end(mergeExposition([own, child]));
            return;
        }
        res.writeHead(404);
        res.end("Not Found");
    };
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
