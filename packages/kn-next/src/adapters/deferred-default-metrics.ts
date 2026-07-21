/**
 * deferred-default-metrics.ts — keep prom-client's default-metric collection
 * OFF the cold-start critical path (#441).
 *
 * ## Why
 *
 * Profiling the wrapper on OKE (#441) showed the parent's module-load + spawn
 * costs only ~52ms, yet the SAME Next.js standalone server boots ~847ms slower
 * under the wrapper than on its own. The mechanism is CPU contention: pods that
 * request 0 CPU sit on an oversubscribed node, so ANY concurrent work in the
 * supervisor is stolen from the child's boot.
 *
 * `collectDefaultMetrics()` is not a one-shot read — prom-client 15 starts
 * PERSISTENT background samplers at setup time: a libuv
 * `perf_hooks.monitorEventLoopDelay` histogram (10ms resolution,
 * `lib/metrics/eventLoopLag.js`) and a GC `PerformanceObserver`
 * (`lib/metrics/gc.js`). Those run for the entire duration of the child's boot.
 *
 * By contrast an idle `http.createServer(...).listen(...)` samples nothing — it
 * only wakes on a connection. So the supervisor keeps listening EARLY (the
 * :9091 scrape target must never be a moving target) and defers only the
 * sampler startup.
 *
 * ## When collection starts
 *
 * Whichever comes FIRST:
 *  1. the child is serving — a TCP connect to the child's app port succeeds
 *     (`waitForChildServing`); the child self-starts on `$PORT`, so its
 *     accepting socket is the readiness signal that already exists — no new
 *     protocol, no stdout parsing (stdio is `inherit`), no injected probe;
 *  2. the first `/metrics` scrape — collection starts ON DEMAND so a scrape
 *     that lands during the boot window still returns a complete, valid
 *     exposition rather than an empty registry;
 *  3. a deadline (`KNEXT_DEFAULT_METRICS_DEADLINE_MS`, default 60s) — a child
 *     that never binds must not cost us process metrics forever.
 *
 * Deferral is unconditional here — this collection is one STEP of the
 * supervisor-init deferral, whose single operator opt-out is
 * `KNEXT_DEFER_SUPERVISOR_INIT` at the `node-server.ts` layer.
 */

import net from "node:net";
// TYPE-ONLY (#441): a value import of prom-client here would load it in the
// supervisor before the spawn — the very cost this module exists to defer. The
// real `collectDefaultMetrics` is reached through a dynamic import at start time.
import type { Registry } from "prom-client";

/** Poll interval (ms) for the child-serving TCP probe. */
export const CHILD_READY_INTERVAL_ENV = "KNEXT_CHILD_READY_PROBE_MS";
/** Max wait (ms) before starting collection even if the child never binds. */
export const CHILD_READY_DEADLINE_ENV = "KNEXT_DEFAULT_METRICS_DEADLINE_MS";

/** Default probe cadence: cheap (one loopback connect) relative to a boot. */
export const DEFAULT_PROBE_INTERVAL_MS = 250;
/** Default give-up deadline: well past any realistic Next.js cold boot. */
export const DEFAULT_READY_DEADLINE_MS = 60_000;

type Env = Record<string, string | undefined>;

export interface DeferredDefaultMetricsOptions {
    /** Registry the default families are registered on (the :9091 registry). */
    readonly registry: Registry;
    /** Injected for tests; defaults to prom-client's `collectDefaultMetrics`. */
    readonly collect?: (opts: { register: Registry }) => void | Promise<void>;
    /** Optional structured logger (same shape as `createLogger`'s result). */
    readonly log?: { info: (obj: object, msg: string) => void };
}

export interface DeferredDefaultMetrics {
    /**
     * Start default-metric collection if it has not started yet. Idempotent —
     * resolves `true` only for the call that actually started it (a second
     * `collectDefaultMetrics` on the same registry would throw on duplicate
     * metric names).
     *
     * ASYNC because the default collector is reached via a dynamic import (#441).
     * Callers that need a complete exposition — the `/metrics` handler — must
     * AWAIT this before serializing the registry.
     */
    ensureStarted(reason: string): Promise<boolean>;
    /** Whether collection has started (set synchronously, so it is race-free). */
    isStarted(): boolean;
}

/** Load prom-client lazily and start its default collectors. */
async function collectViaDynamicImport(opts: {
    register: Registry;
}): Promise<void> {
    const { collectDefaultMetrics } = await import("prom-client");
    collectDefaultMetrics({ register: opts.register });
}

/**
 * Build the one-shot, idempotent starter for prom-client's default metrics.
 * Construction does NO work — that is the entire point.
 */
export function createDeferredDefaultMetrics(
    options: DeferredDefaultMetricsOptions,
): DeferredDefaultMetrics {
    const collect = options.collect ?? collectViaDynamicImport;
    let started = false;
    let inFlight: Promise<boolean> | undefined;
    return {
        ensureStarted(reason: string): Promise<boolean> {
            if (started) {
                // Concurrent triggers (child-ready racing a scrape) must await
                // the SAME start, or a scrape could serialize the registry
                // before the default families finish registering.
                return (inFlight ?? Promise.resolve(false)).then(() => false);
            }
            // Set synchronously: two callers in the same tick must not both
            // reach `collect` (prom-client throws on duplicate metric names).
            started = true;
            inFlight = Promise.resolve(collect({ register: options.registry }))
                .then(() => {
                    options.log?.info(
                        { reason },
                        "Started Prometheus default-metrics collection",
                    );
                    return true;
                })
                .catch(() => false);
            return inFlight.then(() => true);
        },
        isStarted(): boolean {
            return started;
        },
    };
}

/** Result of the readiness wait: the child bound, or we gave up. */
export type ChildServingOutcome = "serving" | "deadline";

export interface WaitForChildServingOptions {
    /** The child's app port (`$PORT`, default 3000 — see `buildChildEnv`). */
    readonly port: number;
    readonly host?: string;
    readonly intervalMs?: number;
    readonly deadlineMs?: number;
    /** Injected for tests; defaults to a loopback TCP connect. */
    readonly probe?: (port: number, host: string) => Promise<boolean>;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}

/**
 * Best-effort TCP liveness probe: can we open a connection to `host:port`?
 * Never throws — a refused/unreachable/timed-out connect is simply `false`.
 */
export function probeTcp(
    port: number,
    host = "127.0.0.1",
    timeoutMs = 1000,
): Promise<boolean> {
    return new Promise((resolvePromise) => {
        const socket = net.connect({ port, host });
        const finish = (ok: boolean) => {
            socket.removeAllListeners();
            socket.destroy();
            resolvePromise(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
    });
}

const defaultSleep = (ms: number) =>
    new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        // Never hold the process open on the readiness poll.
        t.unref?.();
    });

/**
 * Poll until the child accepts connections on its app port, or the deadline
 * elapses. Deliberately low-frequency (one loopback connect per interval) so the
 * probe itself does not become the contention it exists to avoid.
 */
export async function waitForChildServing(
    options: WaitForChildServingOptions,
): Promise<ChildServingOutcome> {
    const host = options.host ?? "127.0.0.1";
    const intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const deadlineMs = options.deadlineMs ?? DEFAULT_READY_DEADLINE_MS;
    const probe = options.probe ?? probeTcp;
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;

    const startedAt = now();
    for (;;) {
        if (await probe(options.port, host)) {
            return "serving";
        }
        if (now() - startedAt >= deadlineMs) {
            return "deadline";
        }
        await sleep(intervalMs);
        if (now() - startedAt >= deadlineMs) {
            return "deadline";
        }
    }
}

/** Read the probe interval knob (ms), falling back to the default. */
export function probeIntervalMs(env: Env = process.env): number {
    const raw = Number(env[CHILD_READY_INTERVAL_ENV]);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PROBE_INTERVAL_MS;
}

/** Read the give-up deadline knob (ms), falling back to the default. */
export function readyDeadlineMs(env: Env = process.env): number {
    const raw = Number(env[CHILD_READY_DEADLINE_ENV]);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_READY_DEADLINE_MS;
}
