/**
 * The deep-health gauge for a tracing-OFF install — a cold-start-neutral twin of
 * the `makeDeepHealthScrapeHook` + `refreshDeepHealthGauge` path.
 *
 * WHY IT EXISTS. `knext_deep_health_state` is registered by `instrumentation-node`,
 * which the scaffolded `instrumentation.ts` does not load while tracing is off
 * (evaluating it costs ~0.9 s of every cold start). So on the default install
 * there was no series and `KnextDeepHealthDown` / `KnextDeepHealthStuckWaking`
 * could not fire. Un-gating the registration would hand that cost back, so this
 * module does the same job with none of the weight:
 *
 *   - its only STATIC import is `node:http`. It deliberately does NOT import
 *     `prom-client`, `@getknext/lib/clients` or the OTel stack — each of those is
 *     exactly the cost being avoided. A guard scans the source and fails on any
 *     other import;
 *   - the activity gate reads the slot `@getknext/lib/clients` already writes
 *     (`globalThis[Symbol.for('knext.lib.clients.lastDbActivityAt')]`). That is
 *     a READING seam on an existing ADR-0027 key — it adds no mutable state of
 *     its own. Direct-pass (importing `isDbRecentlyActive`) is impossible here
 *     because that import is the cost;
 *   - the health check is imported on the FIRST scrape that needs it. By then
 *     the app has used its database, so the pool code is loaded anyway, and the
 *     import is paid inside a scrape, not on the boot path;
 *   - the exposition is rendered by hand, byte-identical to prom-client's for
 *     the same snapshot (pinned by a test), and served on the loopback port the
 *     runtime contract already bridges onto the scraped metrics port.
 *
 * IDLE. While the gate is closed — the app has not touched its database inside
 * the activity budget — the body is EMPTY. The probe is skipped (it must never
 * wake a scale-to-zero database) and nothing is claimed in its place, so
 * Prometheus marks the series stale on the next scrape and a `for:` clause
 * resets instead of a stale `waking`/`down` firing for an app that is simply
 * idle.
 *
 * This module is loaded only when tracing is OFF. With tracing on,
 * `instrumentation-node` binds the same loopback port first, so lite is never
 * started and the two cannot race for it.
 */

import { createServer, type Server } from "node:http";

/**
 * The slot `@getknext/lib/clients` writes on every tracked pool use. Duplicated
 * by literal on purpose (see the header); `deep-health-lite-guards.test.ts`
 * fails when this string and the lib's diverge.
 */
const DB_ACTIVITY_KEY = Symbol.for("knext.lib.clients.lastDbActivityAt");

/** Same default as `@getknext/lib/clients` (`DEFAULT_DB_ACTIVITY_BUDGET_MS`). */
const DEFAULT_DB_ACTIVITY_BUDGET_MS = 45_000;

/**
 * How long a probe's result is reused. The same constant, and the same reason,
 * as `DEEP_HEALTH_PROBE_TTL_MS` in `metrics.ts` (a test pins them equal): below
 * the 30 s scrape interval so a normal scrape probes fresh, while a burst of
 * extra requests cannot multiply probes.
 */
export const DEEP_HEALTH_LITE_TTL_MS = 10_000;

const METRIC = "knext_deep_health_state";

/**
 * The CDN metrics seam the header preload publishes in CDN mode
 * (`cdn-edge.cjs` `publishMetricsSeam`). Duplicated by literal on purpose, like
 * `DB_ACTIVITY_KEY`: importing `cdn-edge.cjs` here would add a static import.
 * `cdn-metrics-seam.test.ts` fails when the literals diverge.
 */
const CDN_METRICS_SEAM = Symbol.for("knext.core.cdn.renderMetrics");

/**
 * The CDN counters this process holds, in Prometheus text, or `""` when CDN
 * mode is off (no seam) or the render throws. Fail-open: a scrape never fails
 * because of it. Appended by the loopback listeners the supervisor merges onto
 * the app's metrics port, so the counters reach it without a new port.
 */
export function readCdnMetrics(): string {
    return readSeam(CDN_METRICS_SEAM);
}

/**
 * The `'use cache'` metrics seam the use-cache handler publishes when it is
 * built (`use-cache-handler.js`). Duplicated by literal for the same reason as
 * the CDN key; `use-cache-metrics-seam.test.ts` fails when the literals diverge.
 */
const USE_CACHE_METRICS_SEAM = Symbol.for("knext.core.useCache.renderMetrics");

/**
 * The `'use cache'` counters this process holds, in Prometheus text, or `""`
 * when no use-cache handler was built (no seam) or the render throws. Fail-open,
 * like {@link readCdnMetrics}.
 */
export function readUseCacheMetrics(): string {
    return readSeam(USE_CACHE_METRICS_SEAM);
}

/**
 * The in-process Rust seam. The module `knext ffi generate` writes into an app
 * that opts in (app code; core never imports the ffi package) counts calls
 * slower than its threshold and reports its first load, and publishes a render
 * function under this key once its library has loaded. Duplicated by literal
 * like the keys above; `ffi-metrics-seam.test.ts` pins it against the
 * generator's source. Without the opt-in nothing publishes it.
 */
const FFI_METRICS_SEAM = Symbol.for("knext.ffi.renderMetrics");

/**
 * The in-process Rust counters this process holds, in Prometheus text, or `""`
 * when the app has none (no seam) or the render throws. Fail-open, like
 * {@link readCdnMetrics}.
 */
export function readFfiMetrics(): string {
    return readSeam(FFI_METRICS_SEAM);
}

/**
 * Every seam-published family this process holds (CDN, `'use cache'`, then
 * in-process Rust), joined into one exposition: what the loopback listeners
 * append.
 */
export function readSeamMetrics(): string {
    return appendExposition(
        appendExposition(readCdnMetrics(), readUseCacheMetrics()),
        readFfiMetrics(),
    );
}

function readSeam(key: symbol): string {
    const render = (globalThis as Record<symbol, unknown>)[key];
    if (typeof render !== "function") return "";
    try {
        const text = render();
        return typeof text === "string" ? text : "";
    } catch {
        return "";
    }
}

/** Join two exposition bodies, keeping exactly one newline at the seam. */
export function appendExposition(body: string, extra: string): string {
    if (extra.length === 0) return body;
    if (body.length === 0) return extra;
    return `${body.replace(/\n*$/, "\n")}${extra}`;
}

// Must match `createMetricsRegistry` in metrics.ts character for character; the
// byte-parity test fails the moment either side is edited alone.
const HELP =
    "Deep-health verdict per dependency + the overall roll-up: the active state is 1, every other state 0 (#348). Alert on overall state='waking' sustained past the wake budget.";

const OVERALL_STATES = ["ok", "degraded", "down", "waking"] as const;
const DEP_STATES = ["up", "down", "unconfigured", "waking"] as const;

/** Structural twin of `HealthStatus` (kept local: this module imports nothing). */
export interface DeepHealthSnapshot {
    readonly status: string;
    readonly checks: {
        readonly postgres: string;
        readonly redis: string;
    };
}

interface HealthModule {
    readonly checkDeepHealth: () => Promise<DeepHealthSnapshot>;
}

export interface DeepHealthLiteDeps {
    /** The `app` label. Defaults to `KN_APP_NAME`, then `unknown` (as `initRuntimeMetrics`). */
    readonly app?: string;
    /** Clock, injectable for tests. */
    readonly now?: () => number;
    /** The last DB activity instant, or undefined. Defaults to the lib's slot. */
    readonly readActivityAt?: () => number | undefined;
    /** Loads the deep check. Defaults to a lazy `import('@getknext/lib/health')`. */
    readonly loadHealth?: () => Promise<HealthModule>;
    readonly env?: Record<string, string | undefined>;
}

function readActivitySlot(): number | undefined {
    const v = (globalThis as unknown as Record<symbol, unknown>)[
        DB_ACTIVITY_KEY
    ];
    return typeof v === "number" ? v : undefined;
}

function activityBudgetMs(env: Record<string, string | undefined>): number {
    const raw = env.DB_ACTIVITY_BUDGET_MS;
    if (raw !== undefined) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_DB_ACTIVITY_BUDGET_MS;
}

/** Prometheus text-format label-value escaping (what prom-client applies). */
function escapeLabel(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function render(app: string, snap: DeepHealthSnapshot): string {
    const a = escapeLabel(app);
    const out = [`# HELP ${METRIC} ${HELP}`, `# TYPE ${METRIC} gauge`];
    const series = (dep: string, state: string, active: string) =>
        out.push(
            `${METRIC}{app="${a}",dependency="${dep}",state="${state}"} ${state === active ? 1 : 0}`,
        );
    for (const s of OVERALL_STATES) series("overall", s, snap.status);
    for (const s of DEP_STATES) series("postgres", s, snap.checks.postgres);
    for (const s of DEP_STATES) series("redis", s, snap.checks.redis);
    return `${out.join("\n")}\n`;
}

export interface DeepHealthLite {
    /** One scrape: the exposition body, `""` while idle or when nothing was probed. */
    scrape(): Promise<string>;
}

/**
 * Build the scrape function. All state (the cached snapshot, the single-flight
 * promise, the memoised health import) lives in this closure — never in module
 * state, per ADR-0027.
 */
export function createDeepHealthLite(
    deps: DeepHealthLiteDeps = {},
): DeepHealthLite {
    const env = deps.env ?? process.env;
    const app = deps.app ?? env.KN_APP_NAME ?? "unknown";
    const now = deps.now ?? Date.now;
    const readActivityAt = deps.readActivityAt ?? readActivitySlot;
    const loadHealth =
        deps.loadHealth ??
        (() => import("@getknext/lib/health") as Promise<HealthModule>);

    let health: Promise<HealthModule> | undefined;
    let inFlight: Promise<void> | undefined;
    let current: DeepHealthSnapshot | undefined;
    let lastFinishedAt = Number.NEGATIVE_INFINITY;

    // FAIL-CLOSED: anything that stops us establishing recent activity — a throwing
    // read, a non-number slot — leaves the gate shut. The probe dials Postgres, so
    // "not sure" must mean "do not dial".
    const gateOpen = (): boolean => {
        try {
            const last = readActivityAt();
            if (typeof last !== "number") return false;
            return now() - last <= activityBudgetMs(env);
        } catch {
            return false;
        }
    };

    const probe = async (): Promise<void> => {
        try {
            if (!health) {
                // Memoise only a SUCCESSFUL load: a failed import is retried later.
                health = loadHealth().catch((e) => {
                    health = undefined;
                    throw e;
                });
            }
            const mod = await health;
            current = await mod.checkDeepHealth();
        } catch {
            // Fail-open for the scrape, stale-free for the claim: a failed probe says nothing.
            current = undefined;
        } finally {
            lastFinishedAt = now();
            inFlight = undefined;
        }
    };

    return {
        async scrape(): Promise<string> {
            // Concurrent callers share the running probe and carry its result.
            if (inFlight) {
                await inFlight;
                return current ? render(app, current) : "";
            }
            // The gate comes BEFORE the TTL: the claim must not outlive the activity
            // that justified it, and an idle app is not probed.
            if (!gateOpen()) {
                // Clearing the TTL forces a fresh probe when traffic resumes, which
                // overwrites `current`; until then nothing is rendered.
                lastFinishedAt = Number.NEGATIVE_INFINITY;
                return "";
            }
            if (now() - lastFinishedAt >= DEEP_HEALTH_LITE_TTL_MS) {
                inFlight = probe();
                await inFlight;
            }
            return current ? render(app, current) : "";
        },
    };
}

/**
 * The loopback port: the contract's own rule (`appMetricsPort`) — an integer in
 * 1..65535 from `KN_CHILD_METRICS_PORT`, else 9092.
 */
export function resolveLitePort(
    env: Record<string, string | undefined> = process.env,
): number {
    const n = Number.parseInt(env.KN_CHILD_METRICS_PORT ?? "", 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 9092;
}

export interface StartDeepHealthLiteOptions extends DeepHealthLiteDeps {
    /** Override the port (tests pass 0 for an ephemeral one). */
    readonly port?: number;
}

/**
 * Bind the loopback server and serve `GET /metrics`. Returns the server (already
 * `listen`ing). Never throws and never keeps the process alive:
 *
 *   - `unref()`: it must not hold a draining pod open;
 *   - every `error` (EADDRINUSE when another registration owns the port, EACCES)
 *     is swallowed — observability must never break boot;
 *   - a throwing scrape is a 200 with an empty body, never a 5xx.
 */
export function startDeepHealthLite(
    opts: StartDeepHealthLiteOptions = {},
): Server {
    const env = opts.env ?? process.env;
    const lite = createDeepHealthLite({ ...opts, env });
    const server = createServer(async (req, res) => {
        if (req.method !== "GET" || req.url !== "/metrics") {
            res.writeHead(404);
            res.end("Not Found");
            return;
        }
        let body = "";
        try {
            body = await lite.scrape();
        } catch {
            body = "";
        }
        // The CDN counters (CDN mode only) and the `'use cache'` counters (when
        // the handler is wired) ride the same loopback listener.
        body = appendExposition(body, readSeamMetrics());
        res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        });
        res.end(body);
    });
    server.on("error", () => {});
    server.unref();
    server.listen(opts.port ?? resolveLitePort(env), "127.0.0.1");
    return server;
}
