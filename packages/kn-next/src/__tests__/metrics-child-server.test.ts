/**
 * metrics.ts — the child↔supervisor scrape bridge + the runtime singleton.
 *  - startChildMetricsServer serves /metrics (running the onScrape hook first,
 *    fail-open on a throwing hook) and 404s everything else,
 *  - fetchChildMetrics round-trips the body over localhost and returns "" on a
 *    non-200 / connection error,
 *  - initRuntimeMetrics is idempotent and can seed prom-client defaults.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import http from "node:http";
import { Counter, Registry } from "prom-client";
import {
    CHILD_METRICS_PORT,
    fetchChildMetrics,
    getRuntimeMetrics,
    initRuntimeMetrics,
    resetRuntimeMetrics,
    startChildMetricsServer,
} from "../adapters/metrics";

const servers: http.Server[] = [];
function track<T extends http.Server>(s: T): T {
    servers.push(s);
    return s;
}
function port(s: http.Server): number {
    return (s.address() as { port: number }).port;
}
async function ready(s: http.Server): Promise<http.Server> {
    if (s.listening) return s;
    await new Promise((r) => s.once("listening", r));
    return s;
}

afterEach(async () => {
    await Promise.all(
        servers
            .splice(0)
            .map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    resetRuntimeMetrics();
    jest.restoreAllMocks();
});

function registryWith(name = "test_counter"): Registry {
    const reg = new Registry();
    new Counter({ name, help: "h", registers: [reg] }).inc();
    return reg;
}

describe("startChildMetricsServer + fetchChildMetrics", () => {
    it("round-trips the registry exposition over localhost", async () => {
        const reg = registryWith();
        const srv = await ready(
            track(startChildMetricsServer(reg, 0, "127.0.0.1")),
        );
        const body = await fetchChildMetrics(port(srv), "127.0.0.1");
        expect(body).toContain("test_counter");
    });

    it("runs the onScrape hook before serving and is fail-open on a throwing hook", async () => {
        const reg = registryWith();
        const good = mock(async () => {});
        const srvGood = await ready(
            track(startChildMetricsServer(reg, 0, "127.0.0.1", good)),
        );
        expect(await fetchChildMetrics(port(srvGood), "127.0.0.1")).toContain(
            "test_counter",
        );
        expect(good).toHaveBeenCalled();

        const bad = mock(async () => {
            throw new Error("scrape hook boom");
        });
        const srvBad = await ready(
            track(startChildMetricsServer(reg, 0, "127.0.0.1", bad)),
        );
        // Still serves the base registry despite the hook throwing.
        expect(await fetchChildMetrics(port(srvBad), "127.0.0.1")).toContain(
            "test_counter",
        );
    });

    it("404s any non-/metrics request", async () => {
        const srv = await ready(
            track(startChildMetricsServer(registryWith(), 0, "127.0.0.1")),
        );
        const status = await new Promise<number>((resolve) => {
            http.get(
                { host: "127.0.0.1", port: port(srv), path: "/nope" },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                },
            );
        });
        expect(status).toBe(404);
    });

    it("fetchChildMetrics returns '' on a non-200 response", async () => {
        const srv = await ready(
            track(
                http
                    .createServer((_req, res) => {
                        res.writeHead(500);
                        res.end("nope");
                    })
                    .listen(0, "127.0.0.1"),
            ),
        );
        expect(await fetchChildMetrics(port(srv), "127.0.0.1")).toBe("");
    });

    it("fetchChildMetrics returns '' when nothing is listening", async () => {
        // Reserve then close a port to guarantee a refused connect.
        const srv = await ready(
            track(http.createServer().listen(0, "127.0.0.1")),
        );
        const p = port(srv);
        await new Promise<void>((r) => srv.close(() => r()));
        servers.pop();
        expect(await fetchChildMetrics(p, "127.0.0.1")).toBe("");
    });

    it("exposes a default child metrics port constant", () => {
        expect(typeof CHILD_METRICS_PORT).toBe("number");
    });
});

describe("initRuntimeMetrics singleton", () => {
    it("is idempotent and returns the same instance", () => {
        const reg = new Registry();
        const first = initRuntimeMetrics(reg, "app-a");
        const second = initRuntimeMetrics(new Registry(), "app-b");
        expect(second).toBe(first);
        expect(getRuntimeMetrics()).toBe(first);
    });

    it("seeds prom-client default metrics when asked", async () => {
        const reg = new Registry();
        initRuntimeMetrics(reg, "app-c", true);
        expect(await reg.metrics()).toContain("process_cpu");
    });

    it("getRuntimeMetrics is undefined after reset", () => {
        initRuntimeMetrics(new Registry(), "app-d");
        resetRuntimeMetrics();
        expect(getRuntimeMetrics()).toBeUndefined();
    });
});
