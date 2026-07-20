/**
 * deferred-supervisor-init.ts — keep the supervisor's ENTIRE non-safety startup
 * off the child's cold-start path (#441).
 *
 * ## Why this supersedes the default-metrics-only deferral
 *
 * The first attempt (`cdd3f7c`) deferred `collectDefaultMetrics` on the theory
 * that its background samplers were stealing CPU. Profiling refuted that, along
 * with six other single-feature hypotheses. The decisive measurement: running the
 * supervisor with a TRIVIAL child (a one-line `http.createServer` that binds
 * :3000 instantly) still burned ~97-108 CPU ticks and took ~1.75-2s to settle —
 * with essentially no child workload to compete against.
 *
 * So the cost is the supervisor's AGGREGATE startup, ~1 CPU-second, and it lands
 * on the child's boot because the spawn happens at 52ms while the supervisor keeps
 * initialising. On a 0-CPU-request pod (oversubscribed node) the two compete, and
 * the child's boot stretches by the measured ~847ms. The supervisor is, in effect,
 * its own busy sibling.
 *
 * ## The critical detail: imports, not work
 *
 * **Static ESM imports are evaluated before the importing module's body runs.**
 * Deferring *work* therefore does nothing for the module GRAPH — it loads before
 * the spawn regardless. The supervisor's heavy graphs are:
 *
 *  - `@knext/lib/clients` → `@cerbos/grpc` + `minio` + `pg` (needed only to close
 *    two pools at SIGTERM) — moved to a dynamic import in `db-drain.ts`;
 *  - `./metrics` → `@opentelemetry/api` + `prom-client` (needed only to serve
 *    :9091) — moved behind {@link createLazyMetricsEndpoint};
 *  - `./image-cache-sync` (a no-op unless `STORAGE_BUCKET` is set) — moved into a
 *    deferred step.
 *
 * None of that is required to spawn a child process.
 *
 * ## What is deliberately NOT deferred
 *
 * Shutdown safety. The SIGTERM/SIGINT handlers and `registerDbPoolDrain()` are
 * wired BEFORE the spawn, so a signal arriving mid-boot still drains correctly
 * (`.claude/rules/security.md`). Only the drain's module LOAD is lazy, which
 * cannot open a mishandled-signal window: the hook is registered, and the load
 * happens inside the drain, bounded by the grace cap.
 *
 * ## Cost of the trade
 *
 * :9091 is not bound until the deferred init runs, so a scrape landing inside the
 * boot window is refused rather than answered. Prometheus records a failed scrape
 * and retries; this is the price of moving `prom-client` + `@opentelemetry/api`
 * off the critical path. Once bound, the exposition is COMPLETE — the default
 * families are registered as part of the same step, and the first scrape still
 * starts them on demand if it somehow wins the race. Operators who prefer
 * metrics-from-t=0 set `KNEXT_DEFER_SUPERVISOR_INIT=0`.
 */

import http from "node:http";
import { createDeferredDefaultMetrics } from "./deferred-default-metrics";
import type { Closable } from "./shutdown";

/** Set to `0`/`false` to run the supervisor's init eagerly (pre-#441 behaviour). */
export const DEFER_SUPERVISOR_INIT_ENV = "KNEXT_DEFER_SUPERVISOR_INIT";

type Env = Record<string, string | undefined>;

interface StepLogger {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
}

/**
 * Whether the supervisor's non-safety init should be deferred until the child is
 * serving. Deferred unless the operator explicitly opts out (fail-safe toward the
 * cold-start budget; every component still ends up initialised either way).
 */
export function isSupervisorInitDeferred(env: Env = process.env): boolean {
    const raw = env[DEFER_SUPERVISOR_INIT_ENV];
    if (raw === undefined) {
        return true;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized !== "0" && normalized !== "false";
}

/** One unit of deferred startup work (metrics endpoint, image-cache sync, …). */
export interface DeferredStep {
    readonly name: string;
    run(): void | Promise<void>;
}

export interface DeferredSupervisorInitOptions {
    readonly steps: readonly DeferredStep[];
    readonly log?: StepLogger;
}

export interface DeferredSupervisorInit {
    /**
     * Run every step exactly once. Idempotent and concurrency-safe — the
     * child-ready probe, the deadline and an early scrape can all trigger it.
     * NEVER rejects: a failed step is logged and the rest still run, because
     * this path runs after the child is already serving traffic.
     */
    ensureStarted(reason: string): Promise<void>;
    isStarted(): boolean;
}

/** Build the one-shot runner for the supervisor's deferred init. */
export function createDeferredSupervisorInit(
    options: DeferredSupervisorInitOptions,
): DeferredSupervisorInit {
    let started = false;
    let inFlight: Promise<void> | undefined;

    const runAll = async (reason: string): Promise<void> => {
        for (const step of options.steps) {
            try {
                await step.run();
            } catch (err) {
                options.log?.warn(
                    { err, step: step.name },
                    "Deferred supervisor init step failed (non-fatal)",
                );
            }
        }
        options.log?.info({ reason }, "Deferred supervisor init complete");
    };

    return {
        ensureStarted(reason: string): Promise<void> {
            if (started) {
                return inFlight ?? Promise.resolve();
            }
            started = true;
            inFlight = runAll(reason);
            return inFlight;
        },
        isStarted(): boolean {
            return started;
        },
    };
}

export interface LazyMetricsEndpointOptions {
    /** Port to bind (`METRICS_PORT`, default 9091). `0` picks a free port. */
    readonly port: number;
    readonly log?: StepLogger;
    /**
     * Best-effort scrape of the child's core metrics. Injected in tests;
     * defaults to `fetchChildMetrics(CHILD_METRICS_PORT)` from `./metrics`,
     * reached through the same dynamic import as the handler.
     */
    readonly fetchChild?: () => Promise<string>;
}

export interface LazyMetricsEndpoint {
    /**
     * Safe to pass to `gracefulShutdown`'s `closables` at ANY time, including
     * before the server exists — closing an uncreated endpoint is a no-op. This
     * is what lets the SIGTERM handler be wired before the deferred init runs.
     */
    readonly closable: Closable;
    /** Create the registry + server and bind the port. Idempotent. */
    ensureListening(reason: string): Promise<void>;
    isListening(): boolean;
    /** The bound port (useful when `port: 0`), or `undefined` if not listening. */
    address(): number | undefined;
}

/**
 * A :9091 metrics endpoint that costs NOTHING until it is first needed.
 *
 * Construction touches no heavy module: `prom-client` and `./metrics` (which
 * pulls `@opentelemetry/api`) are loaded by the dynamic import inside
 * {@link LazyMetricsEndpoint.ensureListening}, so they stay off the pre-spawn
 * path entirely.
 */
export function createLazyMetricsEndpoint(
    options: LazyMetricsEndpointOptions,
): LazyMetricsEndpoint {
    let server: http.Server | undefined;
    let starting: Promise<void> | undefined;

    const start = async (reason: string): Promise<void> => {
        // The ONE place the heavy metrics graph is loaded.
        const metrics = await import("./metrics");
        const { Registry: PromRegistry } = await import("prom-client");

        const reg = new PromRegistry();
        const deferred = createDeferredDefaultMetrics({
            registry: reg,
            log: options.log,
        });

        const fetchChild =
            options.fetchChild ??
            (() => metrics.fetchChildMetrics(metrics.CHILD_METRICS_PORT));

        const srv = http.createServer(
            metrics.createSupervisorMetricsHandler({
                registry: reg,
                // Still on-demand: if a scrape somehow beats the line below,
                // it starts collection itself rather than serving an empty
                // registry. Idempotent, so the two can race safely.
                ensureDefaultMetrics: () => deferred.ensureStarted("scrape"),
                fetchChild,
            }),
        );
        server = srv;

        await deferred.ensureStarted(reason);

        await new Promise<void>((resolvePromise, rejectPromise) => {
            const onError = (err: Error) => {
                srv.removeListener("error", onError);
                rejectPromise(err);
            };
            srv.once("error", onError);
            srv.listen(options.port, () => {
                srv.removeListener("error", onError);
                options.log?.info(
                    { port: addressOf(srv), reason },
                    "Prometheus metrics server started",
                );
                resolvePromise();
            });
        });
    };

    return {
        closable: {
            close(callback?: () => void): void {
                if (!server) {
                    callback?.();
                    return;
                }
                server.close(() => callback?.());
            },
        },
        ensureListening(reason: string): Promise<void> {
            starting ??= start(reason);
            return starting;
        },
        isListening(): boolean {
            return server?.listening ?? false;
        },
        address(): number | undefined {
            return server ? addressOf(server) : undefined;
        },
    };

    function addressOf(srv: http.Server): number | undefined {
        const addr = srv.address();
        return typeof addr === "object" && addr !== null
            ? addr.port
            : undefined;
    }
}
