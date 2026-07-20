/**
 * Knative runtime entry for the Next.js standalone server.
 *
 * Responsibilities:
 *  1. Expose Prometheus metrics on :9091 (sidecar pattern — separate port from app).
 *  2. Spawn the Next.js standalone server.js produced by `next build` with
 *     output:'standalone'. The standalone server self-starts on $PORT (default 3000).
 *
 * The standalone server path can be overridden via STANDALONE_SERVER_PATH env var.
 * Default: ".next/standalone/server.js" (single-app repo).
 * Monorepo example: ".next/standalone/apps/file-manager/server.js"
 *
 * NOTE: The previous Nitro runtime entry was removed in the
 * vinext → official Next.js Adapter migration.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createLogger } from "../utils/logger";
import { registerDbPoolDrain } from "./db-drain";
import {
    probeIntervalMs,
    readyDeadlineMs,
    waitForChildServing,
} from "./deferred-default-metrics";
import {
    createDeferredSupervisorInit,
    createLazyMetricsEndpoint,
    isSupervisorInitDeferred,
} from "./deferred-supervisor-init";
import { buildChildEnv } from "./env";
import { type ChildLike, gracefulShutdown } from "./shutdown";

const log = createLogger({ module: "server" });
// Prometheus metrics port. Defaults to 9091 (no behavior change); overridable via
// METRICS_PORT so two runtime entries can coexist on one host without colliding on
// the fixed port (e.g. the sigterm e2es in CI). A metrics port is a legitimate
// production knob — mirrors the SHUTDOWN_GRACE_MS env pattern below.
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
// Hard cap for draining in-flight requests on SIGTERM. Keep below the pod's
// terminationGracePeriodSeconds (k8s default 30s) so the child drains in time.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

// ── Prometheus metrics endpoint on :9091 (DEFERRED — see #441) ────────────────
// Clean separation: Next.js standalone owns $PORT (3000), metrics owns 9091.
//
// Constructing this costs nothing: `prom-client` and `./metrics` (which pulls
// `@opentelemetry/api`) are loaded by a dynamic import inside `ensureListening`.
// That is the point — profiling showed the supervisor spends ~1 CPU-second on
// its own startup, dominated by static module graphs, and since it spawns the
// child at 52ms that cost lands on the child's boot (~847ms on a 0-CPU-request
// pod). Static ESM imports run BEFORE the module body, so deferring the *work*
// was not enough; the *imports* had to move.
//
// The golden-signal / cold-start / db-wake metrics (#315) are emitted in the
// Next.js CHILD (that's where the @vercel/otel HTTP spans + the #317 hooks run).
// The operator scrapes THIS supervisor endpoint (prometheus.io/port=9091), so we
// merge our own process metrics with a best-effort localhost scrape of the
// child's core metrics port. If the child is scaled to zero / not yet up / has
// tracing off (no child server), the fetch returns "" and we serve just the
// process metrics — never fatal. Overridable via KN_CHILD_METRICS_PORT.
const metricsEndpoint = createLazyMetricsEndpoint({ port: METRICS_PORT, log });

// ── Next.js standalone server ─────────────────────────────────────────────────
// `next build` with output:'standalone' emits server.js in .next/standalone/.
// We spawn it as a child process so SIGTERM can drain it cleanly before we exit.
const serverJs = resolve(
    process.cwd(),
    process.env.STANDALONE_SERVER_PATH ?? ".next/standalone/server.js",
);

log.info({ serverJs }, "Starting Next.js standalone server");

// ── Optimized-image variant cache sync (ADR-0006) ─────────────────────────────
// next/image writes optimized variants to `<distDir>/cache/images`, which is
// pod-local — so every cold pod re-optimizes images another pod already produced,
// burning the scale-to-zero cold-start budget. Persist those variants in the
// object store (keyed by Next's per-variant cacheKey = (src,w,q,accept)) so a
// variant computed once is reused by every later pod. No-op unless STORAGE_BUCKET
// is set. The standalone server keeps `.next/cache/images` next to server.js, so
// derive the dir from the server path (override via IMAGE_CACHE_DIR if needed).
// Deferred with the rest of the supervisor's init (#441): computing the path is
// free, but starting the sync (and loading its object-store client) is not, and
// nothing needs it until the app is actually serving images.
const imageCacheDir =
    process.env.IMAGE_CACHE_DIR ??
    resolve(dirname(serverJs), ".next", "cache", "images");
let stopImageCacheSync: () => void = () => {};

// ── The deferred non-safety init (#441) ───────────────────────────────────────
// Everything here is started only once the child is serving. NOTHING that
// affects shutdown safety is in this list — see the eager wiring below.
const deferredInit = createDeferredSupervisorInit({
    log,
    steps: [
        {
            name: "metrics-endpoint",
            run: () => metricsEndpoint.ensureListening("deferred-init"),
        },
        {
            name: "image-cache-sync",
            run: async () => {
                const { startImageCacheSync } = await import(
                    "./image-cache-sync"
                );
                const handle = await startImageCacheSync(
                    { ...process.env, IMAGE_CACHE_DIR: imageCacheDir },
                    { log },
                );
                stopImageCacheSync = handle.stop;
            },
        },
    ],
});

// ── Deployed-platform Cache-Control normalization (#175) ─────────────────────
// Next's origin emits shared-cache directives (`s-maxage=…`, the fallback-shell
// private value) that a deployment platform's cache layer consumes; deployed
// clients get `public, max-age=0, must-revalidate`. The official reference
// adapter (nextjs/adapter-bun src/runtime/server.ts) applies exactly these
// rules in its serving layer; knext applies them to the standalone child via a
// `--require` preload so the compat suite gates the SAME serving shape users
// run in production. The preload is a sibling file in both layouts
// (dist/adapters/ and src/adapters/ — plain dependency-free CJS). Fronting
// knext with your own s-maxage-honoring shared cache/CDN? Set
// KNEXT_CACHE_CONTROL_NORMALIZE=0 (the preload no-ops).
const cacheControlPreload = resolve(
    import.meta.dirname,
    "cache-control-normalize.cjs",
);
const preloadArgs = existsSync(cacheControlPreload)
    ? ["--require", cacheControlPreload]
    : [];
if (preloadArgs.length === 0) {
    log.warn(
        { cacheControlPreload },
        "cache-control-normalize preload not found; serving origin s-maxage headers to clients",
    );
}

// ── Bun ≤1.3.x keep-alive mitigation (#188) ──────────────────────────────────
// Bun ≤1.3.14 resets a reused keep-alive socket when the next request arrives
// immediately after the previous response completed (plain node:http repro;
// fixed in Bun canary 1.4.0) — clients see ECONNRESET ("socket hang up") on
// small/fast responses. When THIS runtime entry itself runs under Bun, the
// spawned standalone child is Bun too (process.execPath), so preload the
// guard: it advertises `Connection: close` on affected Bun versions only and
// self-disables on fixed ones. Node is never patched — the guard is only
// appended under Bun, keeping the Node spawn args byte-identical.
if (process.versions.bun) {
    const bunKeepaliveGuard = resolve(
        import.meta.dirname,
        "bun-keepalive-guard.cjs",
    );
    if (existsSync(bunKeepaliveGuard)) {
        preloadArgs.push("--require", bunKeepaliveGuard);
    } else {
        log.warn(
            { bunKeepaliveGuard },
            "bun-keepalive-guard preload not found; Bun ≤1.3.x keep-alive reuse may reset sockets",
        );
    }
}

// ═══ EAGER: shutdown safety (#441 — deliberately NOT deferred) ════════════════
// Everything below this line runs BEFORE the child is spawned. A SIGTERM can
// arrive at any moment, including mid-boot, and it must still drain correctly
// (`.claude/rules/security.md`; CI has a shipped-bundle drain gate). Registering
// a hook and installing a signal handler are microseconds of work — they are not
// what costs the supervisor its ~1 CPU-second, so there is nothing to win by
// deferring them and a correctness hole to lose.

// ── DB-pool drain (PGS-1) ─────────────────────────────────────────────────────
// Register the Postgres pools' drain so that on SIGTERM — after HTTP drains —
// in-flight transactions commit-or-rollback before connections close, instead of
// being severed mid-write on scale-down, and a scaling-down replica releases its
// gateway connections cleanly (no leaked sockets holding a scale-to-zero compute
// awake). Closes BOTH the writer pool AND the read-only pool (#246); each close
// is a no-op when its pool was never opened. Extracted to ./db-drain so the lib
// pools stay free of any dependency on the runtime — no circular dep.
//
// #441: the HOOK is registered here, eagerly. Only `@knext/lib/clients` itself
// (@cerbos/grpc + minio + pg — the supervisor's heaviest graph, needed solely to
// close two pools) is loaded lazily, inside the drain. That closes no safety
// window: the handler exists from this point on.
registerDbPoolDrain();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// On SIGTERM/SIGINT: close metrics, forward SIGTERM to the Next child so it
// drains in-flight requests + runs after(), await registered drains (DB pool),
// then exit as soon as they finish (hard cap SHUTDOWN_GRACE_MS). Logic lives in
// ./shutdown for unit testing.
//
// `childRef` is populated by the spawn below. A signal arriving in the window
// before the spawn finds it unset and uses a stub that reports an immediate
// "exit", so the registered drains still run and we exit cleanly instead of
// dereferencing an undefined child.
let childRef: ChildProcess | undefined;
const alreadyExitedChild: ChildLike = {
    kill: () => true,
    once: (_event, listener) => {
        setImmediate(listener);
    },
};

const onSignal = (signal: string) => {
    log.info(
        { signal, graceMs: SHUTDOWN_GRACE_MS },
        "Shutting down gracefully...",
    );
    stopImageCacheSync();
    gracefulShutdown(signal, {
        child: childRef ?? alreadyExitedChild,
        // Safe before the endpoint exists — closing an unbound lazy endpoint is
        // a no-op (see createLazyMetricsEndpoint).
        closables: [metricsEndpoint.closable],
        graceMs: SHUTDOWN_GRACE_MS,
        exit: (code) => process.exit(code),
    });
};

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

// ═══ Spawn the child — the cold-start critical path ═══════════════════════════
const nextProc = spawn(process.execPath, [...preloadArgs, serverJs], {
    stdio: "inherit",
    env: buildChildEnv(),
});
childRef = nextProc;

nextProc.on("error", (err) => {
    log.fatal({ err }, "Failed to start Next.js standalone server");
    process.exit(1);
});

nextProc.on("exit", (code, signal) => {
    log.info({ code, signal }, "Next.js standalone server exited");
    metricsEndpoint.closable.close();
    process.exit(code ?? 0);
});

// ── Deferred supervisor init (#441) ──────────────────────────────────────────
// The child self-starts on $PORT (see buildChildEnv), so its accepting socket
// IS the "child is serving" signal — no new protocol and no stdout parsing
// (stdio is `inherit`, so the child's logs stay untouched). Once it answers, the
// cold-start critical path is over and the supervisor can finally pay for its
// own startup: bind :9091 (loading prom-client + @opentelemetry/api) and start
// the image-cache sync. The deadline covers a child that never binds, so a
// broken app never costs us the metrics endpoint permanently.
if (isSupervisorInitDeferred()) {
    waitForChildServing({
        port: Number(process.env.PORT ?? 3000),
        intervalMs: probeIntervalMs(),
        deadlineMs: readyDeadlineMs(),
    })
        .then((outcome) => deferredInit.ensureStarted(`child-${outcome}`))
        .catch((err) => {
            // Never lose the metrics endpoint to a probe bug.
            log.warn({ err }, "Child readiness probe failed; initialising now");
            return deferredInit.ensureStarted("probe-error");
        });
} else {
    // Operator opt-out: pre-#441 behaviour (init on the cold-start path).
    void deferredInit.ensureStarted("deferral-disabled");
}
