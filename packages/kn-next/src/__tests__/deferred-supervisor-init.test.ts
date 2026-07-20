/**
 * deferred-supervisor-init — keep the supervisor's WHOLE non-safety init off the
 * child's cold-start path (#441).
 *
 * ## What changed since the first attempt
 *
 * `cdd3f7c` deferred `collectDefaultMetrics` on the hypothesis that its samplers
 * were the contention. Profiling refuted that: the supervisor burns ~1 CPU-second
 * / ~1.75-2s of wall time **even with a trivial one-line child**, so the cost is
 * its AGGREGATE startup, not any single feature. It spawns the child at 52ms and
 * then keeps initialising, so that CPU lands squarely on the child's boot window
 * on a 0-CPU-request pod.
 *
 * The decisive detail: **static ESM imports are evaluated before the module body
 * runs**, so deferring *work* is not enough — the heavy module GRAPH loads before
 * the spawn either way. `@knext/lib/clients` (imported only so SIGTERM can drain
 * the pools) statically pulls `@cerbos/grpc`, `minio` and `pg`; `./metrics` pulls
 * `@opentelemetry/api` and `prom-client`. None of that is needed to spawn a child.
 *
 * These tests pin the resulting contract:
 *  - the heavy graphs are NOT statically imported on the pre-spawn path,
 *  - the deferred steps do not run before the child is ready, and DO after,
 *  - `/metrics` is a complete, valid exposition once the endpoint is up, and the
 *    child-metrics merge is unchanged,
 *  - **safety is NOT deferred**: signal handlers and `registerDbPoolDrain()` are
 *    wired before the spawn, and an early SIGTERM still drains the pools.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drainDbPools, registerDbPoolDrain } from "../adapters/db-drain";
import {
    createDeferredSupervisorInit,
    createLazyMetricsEndpoint,
    DEFER_SUPERVISOR_INIT_ENV,
    isSupervisorInitDeferred,
} from "../adapters/deferred-supervisor-init";
import { clearShutdownDrains, gracefulShutdown } from "../adapters/shutdown";

const ADAPTERS = resolve(__dirname, "..", "adapters");
const NODE_SERVER_SRC = resolve(ADAPTERS, "node-server.ts");
const DB_DRAIN_SRC = resolve(ADAPTERS, "db-drain.ts");
const DEFERRED_METRICS_SRC = resolve(ADAPTERS, "deferred-default-metrics.ts");
const DEFERRED_INIT_SRC = resolve(ADAPTERS, "deferred-supervisor-init.ts");

/** Static `import ... from "<spec>"` at line start (ignores dynamic imports). */
function hasStaticImport(src: string, spec: string): boolean {
    const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
        `^import\\s+(?!type\\b)[^;]*?from\\s+["']${escaped}["']`,
        "m",
    ).test(src);
}

afterEach(() => {
    clearShutdownDrains();
});

describe("pre-spawn module graph (the actual ~1 CPU-second)", () => {
    const nodeServer = readFileSync(NODE_SERVER_SRC, "utf8");
    const dbDrain = readFileSync(DB_DRAIN_SRC, "utf8");
    const deferredMetrics = readFileSync(DEFERRED_METRICS_SRC, "utf8");
    const deferredInit = readFileSync(DEFERRED_INIT_SRC, "utf8");

    it("node-server.ts does not statically import prom-client", () => {
        expect(hasStaticImport(nodeServer, "prom-client")).toBe(false);
    });

    it("node-server.ts does not statically import ./metrics", () => {
        expect(hasStaticImport(nodeServer, "./metrics")).toBe(false);
    });

    it("node-server.ts does not statically import ./image-cache-sync", () => {
        expect(hasStaticImport(nodeServer, "./image-cache-sync")).toBe(false);
    });

    it("db-drain.ts loads @knext/lib/clients lazily, not at module scope", () => {
        // The heaviest graph in the supervisor: @cerbos/grpc + minio + pg, all
        // pulled in purely so SIGTERM can close two pools.
        expect(hasStaticImport(dbDrain, "@knext/lib/clients")).toBe(false);
        expect(dbDrain).toMatch(/import\(\s*["']@knext\/lib\/clients["']\s*\)/);
    });

    it("the deferral modules themselves stay free of the heavy graphs", () => {
        // A deferral module that statically imports what it defers defeats
        // itself: node-server.ts imports it eagerly.
        expect(hasStaticImport(deferredMetrics, "prom-client")).toBe(false);
        expect(hasStaticImport(deferredInit, "prom-client")).toBe(false);
        expect(hasStaticImport(deferredInit, "./metrics")).toBe(false);
    });
});

describe("safety is NOT deferred (regression guard)", () => {
    const src = readFileSync(NODE_SERVER_SRC, "utf8");
    const spawnAt = src.indexOf("spawn(process.execPath");

    it("spawns the child (anchor for the ordering assertions)", () => {
        expect(spawnAt).toBeGreaterThan(-1);
    });

    it("registers the DB-pool drain BEFORE spawning the child", () => {
        const drainAt = src.indexOf("registerDbPoolDrain()");
        expect(drainAt).toBeGreaterThan(-1);
        expect(drainAt).toBeLessThan(spawnAt);
    });

    it("installs SIGTERM/SIGINT handlers BEFORE spawning the child", () => {
        const sigterm = src.indexOf('process.on("SIGTERM"');
        const sigint = src.indexOf('process.on("SIGINT"');
        expect(sigterm).toBeGreaterThan(-1);
        expect(sigint).toBeGreaterThan(-1);
        expect(sigterm).toBeLessThan(spawnAt);
        expect(sigint).toBeLessThan(spawnAt);
    });

    it("keeps the grace cap and the child drain wiring", () => {
        expect(src).toContain(
            "const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);",
        );
        expect(src).toContain("graceMs: SHUTDOWN_GRACE_MS");
    });
});

describe("an early SIGTERM still drains the DB pools", () => {
    it("runs the registered drain even though nothing was initialised yet", async () => {
        const closed: string[] = [];
        registerDbPoolDrain({
            loadClients: async () => ({
                closeDbPool: async () => {
                    closed.push("writer");
                },
                closeDbPoolRO: async () => {
                    closed.push("ro");
                },
            }),
        });

        let exitCode: number | undefined;
        let onExit: (() => void) | undefined;
        gracefulShutdown("SIGTERM", {
            // The lazily-created metrics endpoint's closable must tolerate
            // being closed before it ever listened.
            closables: [createLazyMetricsEndpoint({ port: 0 }).closable],
            child: {
                kill: () => true,
                once: (_e, listener) => {
                    onExit = listener;
                },
            },
            graceMs: 1000,
            exit: (code) => {
                exitCode = code;
            },
            setTimeoutFn: () => undefined,
        });

        expect(onExit).toBeDefined();
        onExit?.();
        // Let the drain's dynamic import + closes settle.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(closed.sort()).toEqual(["ro", "writer"]);
        expect(exitCode).toBe(0);
    });

    it("drainDbPools closes both pools and never throws when one fails", async () => {
        const closed: string[] = [];
        await expect(
            drainDbPools({
                loadClients: async () => ({
                    closeDbPool: async () => {
                        throw new Error("writer boom");
                    },
                    closeDbPoolRO: async () => {
                        closed.push("ro");
                    },
                }),
            }),
        ).resolves.toBeUndefined();
        expect(closed).toEqual(["ro"]);
    });

    it("never throws when the clients module itself fails to load", async () => {
        await expect(
            drainDbPools({
                loadClients: async () => {
                    throw new Error("module load boom");
                },
            }),
        ).resolves.toBeUndefined();
    });
});

describe("createDeferredSupervisorInit", () => {
    it("runs NO step at construction (that is the whole point)", () => {
        const ran: string[] = [];
        const init = createDeferredSupervisorInit({
            steps: [
                { name: "a", run: () => void ran.push("a") },
                { name: "b", run: () => void ran.push("b") },
            ],
        });

        expect(ran).toEqual([]);
        expect(init.isStarted()).toBe(false);
    });

    it("runs every step once the child is ready — exactly once", async () => {
        const ran: string[] = [];
        const init = createDeferredSupervisorInit({
            steps: [
                { name: "a", run: () => void ran.push("a") },
                { name: "b", run: async () => void ran.push("b") },
            ],
        });

        await init.ensureStarted("child-serving");
        expect(ran).toEqual(["a", "b"]);
        expect(init.isStarted()).toBe(true);

        await init.ensureStarted("scrape");
        expect(ran).toEqual(["a", "b"]);
    });

    it("is idempotent under concurrent triggers (ready + deadline race)", async () => {
        let runs = 0;
        const init = createDeferredSupervisorInit({
            steps: [
                {
                    name: "a",
                    run: async () => {
                        runs += 1;
                        await new Promise((r) => setTimeout(r, 5));
                    },
                },
            ],
        });

        await Promise.all([
            init.ensureStarted("child-serving"),
            init.ensureStarted("deadline"),
        ]);
        expect(runs).toBe(1);
    });

    it("a failing step never rejects and never blocks the others", async () => {
        const ran: string[] = [];
        const warned: string[] = [];
        const init = createDeferredSupervisorInit({
            steps: [
                {
                    name: "boom",
                    run: () => {
                        throw new Error("nope");
                    },
                },
                { name: "ok", run: () => void ran.push("ok") },
            ],
            log: {
                info: () => {},
                warn: (obj: object) =>
                    void warned.push((obj as { step: string }).step),
            },
        });

        await expect(init.ensureStarted("child-serving")).resolves.toBe(
            undefined,
        );
        expect(ran).toEqual(["ok"]);
        expect(warned).toEqual(["boom"]);
    });
});

describe("deferral policy (env override)", () => {
    it("defers by default", () => {
        expect(isSupervisorInitDeferred({})).toBe(true);
    });

    it("restores eager init with KNEXT_DEFER_SUPERVISOR_INIT=0", () => {
        expect(
            isSupervisorInitDeferred({ [DEFER_SUPERVISOR_INIT_ENV]: "0" }),
        ).toBe(false);
        expect(
            isSupervisorInitDeferred({ [DEFER_SUPERVISOR_INIT_ENV]: "false" }),
        ).toBe(false);
    });

    it("stays deferred for any other value", () => {
        expect(
            isSupervisorInitDeferred({ [DEFER_SUPERVISOR_INIT_ENV]: "1" }),
        ).toBe(true);
    });
});

describe("createLazyMetricsEndpoint", () => {
    it("does not create or listen a server at construction", () => {
        const endpoint = createLazyMetricsEndpoint({ port: 0 });
        expect(endpoint.isListening()).toBe(false);
    });

    it("closing before it ever listened is a no-op, not a throw", () => {
        const endpoint = createLazyMetricsEndpoint({ port: 0 });
        expect(() => endpoint.closable.close()).not.toThrow();
    });

    it("listens on demand and serves a COMPLETE, valid exposition", async () => {
        const endpoint = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () =>
                "# HELP knext_http_requests_total x\n# TYPE knext_http_requests_total counter\nknext_http_requests_total 1\n",
        });

        await endpoint.ensureListening("child-serving");
        expect(endpoint.isListening()).toBe(true);

        const port = endpoint.address();
        expect(port).toBeGreaterThan(0);
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        const body = await res.text();

        expect(res.status).toBe(200);
        // prom-client default families really are registered...
        expect(body).toContain("# HELP process_cpu_user_seconds_total");
        expect(body).toContain("# TYPE process_cpu_user_seconds_total");
        // ...and the child-metrics merge is unchanged.
        expect(body).toContain("knext_http_requests_total 1");

        await new Promise<void>((r) => endpoint.closable.close(() => r()));
    });

    it("404s anything that is not GET /metrics", async () => {
        const endpoint = createLazyMetricsEndpoint({ port: 0 });
        await endpoint.ensureListening("child-serving");
        const res = await fetch(
            `http://127.0.0.1:${endpoint.address()}/healthz`,
        );
        expect(res.status).toBe(404);
        await new Promise<void>((r) => endpoint.closable.close(() => r()));
    });

    it("is idempotent — a second ensureListening does not rebind or re-register", async () => {
        const endpoint = createLazyMetricsEndpoint({ port: 0 });
        await endpoint.ensureListening("child-serving");
        const port = endpoint.address();
        // A duplicate collectDefaultMetrics on the same registry throws; a
        // duplicate listen throws EADDRINUSE. Neither may happen.
        await expect(
            endpoint.ensureListening("deadline"),
        ).resolves.toBeUndefined();
        expect(endpoint.address()).toBe(port);
        await new Promise<void>((r) => endpoint.closable.close(() => r()));
    });

    it("binds the socket WITHOUT the collector, then a scrape warms it (#441)", async () => {
        // The regression fix: listen() is early + cheap, the heavy graph loads
        // lazily. ensureListening must bind the port even though startCollector
        // was never called, and the FIRST scrape must still produce a complete
        // exposition (default families warmed on demand). This is exactly what
        // the shipped-bundle drain gate asserts against :9091.
        const endpoint = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () => "",
        });
        await endpoint.ensureListening("startup");
        expect(endpoint.isListening()).toBe(true);

        const res = await fetch(
            `http://127.0.0.1:${endpoint.address()}/metrics`,
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(
            "# HELP process_cpu_user_seconds_total",
        );
        await new Promise<void>((r) => endpoint.closable.close(() => r()));
    });

    it("startCollector warms the default families before any scrape, idempotently", async () => {
        // Driven off the child-ready probe: warm the graph so post-ready scrapes
        // are fast. A second call must not double-register (prom-client throws on
        // duplicate default metrics), and it must not require ensureListening.
        const endpoint = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () => "",
        });
        await expect(
            endpoint.startCollector("child-ready"),
        ).resolves.toBeUndefined();
        // Idempotent — a duplicate collectDefaultMetrics on the same registry
        // would throw; this must not.
        await expect(
            endpoint.startCollector("scrape"),
        ).resolves.toBeUndefined();

        // The warmed families surface once we bind + scrape.
        await endpoint.ensureListening("startup");
        const res = await fetch(
            `http://127.0.0.1:${endpoint.address()}/metrics`,
        );
        expect(await res.text()).toContain(
            "# HELP process_cpu_user_seconds_total",
        );
        await new Promise<void>((r) => endpoint.closable.close(() => r()));
    });
});
