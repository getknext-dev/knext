/**
 * deferred-default-metrics — cold-start critical-path guard (#441).
 *
 * Profiling (issue #441) attributes ~847ms of the knext wrapper's cold-start
 * overhead to CPU contention while the Next.js child boots, NOT to the parent's
 * module load (~52ms) or the spawn args/env. The mechanism: `node-server.ts`
 * called `collectDefaultMetrics({ register })` at MODULE SCOPE, and prom-client
 * 15's default-metric setup starts persistent background samplers immediately —
 * a libuv `monitorEventLoopDelay` histogram (10ms resolution) and a GC
 * `PerformanceObserver` — which run for the whole duration of the child's boot.
 *
 * The fix: keep the metrics HTTP server listening early (an idle
 * `http.createServer` + `listen` is inert — it samples nothing), and defer only
 * `collectDefaultMetrics` until the child is actually serving, or until the
 * first `/metrics` scrape, whichever comes first.
 *
 * These tests pin that contract:
 *  - default metrics are NOT collected before the child is ready,
 *  - they ARE collected once the child is ready (and exactly once),
 *  - `/metrics` serves valid Prometheus exposition in BOTH windows (an early
 *    scrape starts collection on demand rather than serving nothing),
 *  - the deferral is env-overridable,
 *  - the SIGTERM drain wiring in node-server.ts is untouched.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import {
    createDeferredDefaultMetrics,
    DEFER_DEFAULT_METRICS_ENV,
    isDeferralEnabled,
    waitForChildServing,
} from "../adapters/deferred-default-metrics";
import { createSupervisorMetricsHandler } from "../adapters/metrics";

const NODE_SERVER_SRC = resolve(__dirname, "..", "adapters", "node-server.ts");

/** Minimal fake of the `http.ServerResponse` surface the handler touches. */
function fakeRes() {
    const headers: Record<string, string> = {};
    let statusCode: number | undefined;
    let body = "";
    let ended = false;
    return {
        headers,
        get statusCode() {
            return statusCode;
        },
        get body() {
            return body;
        },
        get ended() {
            return ended;
        },
        setHeader(name: string, value: string) {
            headers[name.toLowerCase()] = value;
        },
        writeHead(code: number) {
            statusCode = code;
        },
        end(chunk?: string) {
            body = chunk ?? "";
            ended = true;
        },
    };
}

describe("deferral policy (env override)", () => {
    it("defers by default (no env set)", () => {
        expect(isDeferralEnabled({})).toBe(true);
    });

    it("collects immediately when KNEXT_DEFER_DEFAULT_METRICS=0", () => {
        expect(isDeferralEnabled({ [DEFER_DEFAULT_METRICS_ENV]: "0" })).toBe(
            false,
        );
        expect(
            isDeferralEnabled({ [DEFER_DEFAULT_METRICS_ENV]: "false" }),
        ).toBe(false);
    });

    it("stays deferred for any other value", () => {
        expect(isDeferralEnabled({ [DEFER_DEFAULT_METRICS_ENV]: "1" })).toBe(
            true,
        );
    });
});

describe("createDeferredDefaultMetrics", () => {
    it("does NOT collect default metrics at construction (cold-start path)", () => {
        const registry = new Registry();
        const calls: string[] = [];
        const deferred = createDeferredDefaultMetrics({
            registry,
            collect: () => calls.push("collect"),
        });

        expect(calls).toEqual([]);
        expect(deferred.isStarted()).toBe(false);
    });

    it("collects once the child is ready — and only once", () => {
        const registry = new Registry();
        const calls: Registry[] = [];
        const deferred = createDeferredDefaultMetrics({
            registry,
            collect: (opts) => calls.push(opts.register),
        });

        expect(deferred.ensureStarted("child-ready")).toBe(true);
        expect(calls).toEqual([registry]);
        // Idempotent: a later scrape must not double-register the default
        // families (prom-client throws on duplicate metric names).
        expect(deferred.ensureStarted("scrape")).toBe(false);
        expect(calls).toHaveLength(1);
    });

    it("really registers prom-client default families when started", async () => {
        const registry = new Registry();
        const deferred = createDeferredDefaultMetrics({ registry });

        expect(await registry.metrics()).not.toContain("process_cpu");
        deferred.ensureStarted("child-ready");
        expect(await registry.metrics()).toContain("process_cpu");
    });
});

describe("waitForChildServing (readiness signal)", () => {
    it("resolves 'serving' as soon as the child's port accepts a connection", async () => {
        let attempts = 0;
        const result = await waitForChildServing({
            port: 3000,
            intervalMs: 0,
            deadlineMs: 10_000,
            probe: async () => {
                attempts += 1;
                return attempts >= 3;
            },
            sleep: async () => {},
            now: () => 0,
        });

        expect(result).toBe("serving");
        expect(attempts).toBe(3);
    });

    it("gives up with 'deadline' if the child never serves", async () => {
        let clock = 0;
        const result = await waitForChildServing({
            port: 3000,
            intervalMs: 100,
            deadlineMs: 500,
            probe: async () => false,
            sleep: async () => {
                clock += 100;
            },
            now: () => clock,
        });

        expect(result).toBe("deadline");
    });
});

describe("supervisor /metrics handler", () => {
    it("serves valid exposition BEFORE the child is ready (starts collection on demand)", async () => {
        const registry = new Registry();
        const deferred = createDeferredDefaultMetrics({ registry });
        const handler = createSupervisorMetricsHandler({
            registry,
            ensureDefaultMetrics: () => deferred.ensureStarted("scrape"),
            fetchChild: async () => "",
        });

        const res = fakeRes();
        await handler({ url: "/metrics", method: "GET" }, res);

        expect(res.ended).toBe(true);
        expect(res.headers["content-type"]).toBe(registry.contentType);
        // Valid Prometheus exposition: HELP/TYPE lines present, not empty.
        expect(res.body).toContain("# HELP process_cpu_user_seconds_total");
        expect(res.body).toContain("# TYPE process_cpu_user_seconds_total");
        expect(deferred.isStarted()).toBe(true);
    });

    it("merges the child's exposition AFTER the child is ready", async () => {
        const registry = new Registry();
        const deferred = createDeferredDefaultMetrics({ registry });
        deferred.ensureStarted("child-ready");
        const handler = createSupervisorMetricsHandler({
            registry,
            ensureDefaultMetrics: () => deferred.ensureStarted("scrape"),
            fetchChild: async () =>
                "# HELP knext_http_requests_total x\n# TYPE knext_http_requests_total counter\nknext_http_requests_total 1\n",
        });

        const res = fakeRes();
        await handler({ url: "/metrics", method: "GET" }, res);

        expect(res.body).toContain("process_cpu_user_seconds_total");
        expect(res.body).toContain("knext_http_requests_total 1");
    });

    it("404s anything that is not GET /metrics", async () => {
        const registry = new Registry();
        const handler = createSupervisorMetricsHandler({
            registry,
            ensureDefaultMetrics: () => false,
            fetchChild: async () => "",
        });

        const res = fakeRes();
        await handler({ url: "/healthz", method: "GET" }, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toBe("Not Found");
    });
});

describe("node-server.ts wiring (source guard)", () => {
    const src = readFileSync(NODE_SERVER_SRC, "utf8");

    it("no longer calls collectDefaultMetrics at module scope", () => {
        expect(src).not.toMatch(/^collectDefaultMetrics\(/m);
    });

    it("wires the deferred collector", () => {
        expect(src).toContain("createDeferredDefaultMetrics");
        expect(src).toContain("waitForChildServing");
    });

    it("still listens on the metrics port BEFORE spawning the child", () => {
        const listenAt = src.indexOf("metricsServer.listen(");
        const spawnAt = src.indexOf("spawn(process.execPath");
        expect(listenAt).toBeGreaterThan(-1);
        expect(spawnAt).toBeGreaterThan(-1);
        expect(listenAt).toBeLessThan(spawnAt);
    });

    it("leaves the SIGTERM drain wiring untouched", () => {
        expect(src).toContain(
            "const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);",
        );
        expect(src).toContain("graceMs: SHUTDOWN_GRACE_MS");
        expect(src).toContain("closables: [metricsServer]");
        expect(src).toContain(
            'process.on("SIGTERM", () => onSignal("SIGTERM"));',
        );
        expect(src).toContain(
            'process.on("SIGINT", () => onSignal("SIGINT"));',
        );
    });
});
