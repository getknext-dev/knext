/**
 * deferred-supervisor-init.ts — createLazyMetricsEndpoint (#441). The :9091
 * socket must bind EARLY with a lightweight listener, then lazy-load the heavy
 * prom-client/OTel graph on the first scrape or startCollector. Uses a real
 * ephemeral port + an injected fetchChild so no real child is scraped.
 */

import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyMetricsEndpoint } from "../adapters/deferred-supervisor-init";

const endpoints: { closable: { close(cb?: () => void): void } }[] = [];

afterEach(async () => {
    await Promise.all(
        endpoints
            .splice(0)
            .map((e) => new Promise<void>((r) => e.closable.close(() => r()))),
    );
    vi.restoreAllMocks();
});

function get(
    port: number,
    path: string,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => {
                body += c;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }).on("error", reject);
    });
}

describe("createLazyMetricsEndpoint", () => {
    it("binds early, reports its address, and is not listening before ensureListening", async () => {
        const ep = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () => "",
        });
        endpoints.push(ep);
        expect(ep.isListening()).toBe(false);
        expect(ep.address()).toBeUndefined();

        await ep.ensureListening("startup");
        expect(ep.isListening()).toBe(true);
        expect(typeof ep.address()).toBe("number");
    });

    it("ensureListening is idempotent (same underlying bind)", async () => {
        const ep = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () => "",
        });
        endpoints.push(ep);
        await ep.ensureListening("a");
        const addr = ep.address();
        await ep.ensureListening("b");
        expect(ep.address()).toBe(addr);
    });

    it("serves a COMPLETE exposition on the first scrape (lazy graph load)", async () => {
        const ep = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () => "",
        });
        endpoints.push(ep);
        await ep.ensureListening("startup");
        const res = await get(ep.address() as number, "/metrics");
        expect(res.status).toBe(200);
        // First scrape starts collectDefaultMetrics on demand.
        expect(res.body).toContain("process_cpu");
    });

    it("404s a non-/metrics request", async () => {
        const ep = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () => "",
        });
        endpoints.push(ep);
        await ep.ensureListening("startup");
        const res = await get(ep.address() as number, "/healthz");
        expect(res.status).toBe(404);
    });

    it("startCollector loads the graph and starts collection without throwing", async () => {
        const ep = createLazyMetricsEndpoint({
            port: 0,
            fetchChild: async () => "",
        });
        endpoints.push(ep);
        await expect(ep.startCollector("child-ready")).resolves.toBeUndefined();
    });

    it("closable.close before any bind is a safe no-op that still calls back", async () => {
        const ep = createLazyMetricsEndpoint({ port: 0 });
        await new Promise<void>((resolve) => ep.closable.close(resolve));
        // never listened → nothing to tear down; do not push to the cleanup list.
        expect(ep.isListening()).toBe(false);
    });
});
