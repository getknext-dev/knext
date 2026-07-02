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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { closeDbPool } from "@knext/lib/clients";
import { collectDefaultMetrics, Registry } from "prom-client";
import { createLogger } from "../utils/logger";
import { buildChildEnv } from "./env";
import { startImageCacheSync } from "./image-cache-sync";
import { gracefulShutdown, registerShutdownDrain } from "./shutdown";

const log = createLogger({ module: "server" });
// Prometheus metrics port. Defaults to 9091 (no behavior change); overridable via
// METRICS_PORT so two runtime entries can coexist on one host without colliding on
// the fixed port (e.g. the sigterm e2es in CI). A metrics port is a legitimate
// production knob — mirrors the SHUTDOWN_GRACE_MS env pattern below.
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
// Hard cap for draining in-flight requests on SIGTERM. Keep below the pod's
// terminationGracePeriodSeconds (k8s default 30s) so the child drains in time.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

// ── Prometheus metrics server on :9091 ────────────────────────────────────────
// Clean separation: Next.js standalone owns $PORT (3000), metrics owns 9091.
const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const metricsServer = http.createServer(async (req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
        res.setHeader("Content-Type", metricsRegistry.contentType);
        const metrics = await metricsRegistry.metrics();
        res.end(metrics);
        return;
    }
    res.writeHead(404);
    res.end("Not Found");
});

metricsServer.listen(METRICS_PORT, () => {
    log.info({ port: METRICS_PORT }, "Prometheus metrics server started");
});

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
const imageCacheDir =
    process.env.IMAGE_CACHE_DIR ??
    resolve(dirname(serverJs), ".next", "cache", "images");
let stopImageCacheSync: () => void = () => {};
startImageCacheSync({ ...process.env, IMAGE_CACHE_DIR: imageCacheDir }, { log })
    .then((handle) => {
        stopImageCacheSync = handle.stop;
    })
    .catch((err) => {
        log.warn({ err }, "Image cache sync failed to start (non-fatal)");
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

const nextProc = spawn(process.execPath, [...preloadArgs, serverJs], {
    stdio: "inherit",
    env: buildChildEnv(),
});

nextProc.on("error", (err) => {
    log.fatal({ err }, "Failed to start Next.js standalone server");
    process.exit(1);
});

nextProc.on("exit", (code, signal) => {
    log.info({ code, signal }, "Next.js standalone server exited");
    metricsServer.close();
    process.exit(code ?? 0);
});

// ── DB-pool drain (PGS-1) ─────────────────────────────────────────────────────
// Register the Postgres pool's drain so that on SIGTERM — after HTTP drains —
// in-flight transactions commit-or-rollback before connections close, instead of
// being severed mid-write on scale-down. Wired here (the runtime depends on both
// @knext/lib and ./shutdown) so the lib pool stays free of any dependency on the
// runtime — no circular dep. `closeDbPool()` is a no-op if no pool was opened.
registerShutdownDrain(async () => {
    try {
        await closeDbPool();
    } catch (err) {
        log.warn({ err }, "DB pool drain failed during shutdown (non-fatal)");
    }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// On SIGTERM/SIGINT: close metrics, forward SIGTERM to the Next child so it
// drains in-flight requests + runs after(), await registered drains (DB pool),
// then exit as soon as they finish (hard cap SHUTDOWN_GRACE_MS). Logic lives in
// ./shutdown for unit testing.
const onSignal = (signal: string) => {
    log.info(
        { signal, graceMs: SHUTDOWN_GRACE_MS },
        "Shutting down gracefully...",
    );
    stopImageCacheSync();
    gracefulShutdown(signal, {
        child: nextProc,
        closables: [metricsServer],
        graceMs: SHUTDOWN_GRACE_MS,
        exit: (code) => process.exit(code),
    });
};

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
