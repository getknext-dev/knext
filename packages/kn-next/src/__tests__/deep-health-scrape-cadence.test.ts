import http from "node:http";
import type { AddressInfo } from "node:net";
import { Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";

import {
    createMetricsRegistry,
    DEEP_HEALTH_STATE_METRIC,
    refreshDeepHealthGauge,
    startChildMetricsServer,
} from "../adapters/metrics";

/**
 * #348 — the deep-health gauge must refresh ON THE SCRAPE CADENCE (no new
 * background timer). `startChildMetricsServer` accepts an optional async
 * `onScrape` hook that runs before each exposition is served; the app wiring
 * passes a hook that runs `checkDeepHealth()` and calls `refreshDeepHealthGauge`.
 * Prometheus scraping :9091 (~30s) is what drives the deep check — no extra load.
 */

let server: http.Server | undefined;

afterEach(() => {
    server?.close();
    server = undefined;
});

/** Resolve once the ephemeral-port (`listen(0)`) server is bound. */
function boundPort(s: http.Server): Promise<number> {
    return new Promise((resolve) => {
        const addr = s.address() as AddressInfo | null;
        if (addr) {
            resolve(addr.port);
            return;
        }
        s.once("listening", () => resolve((s.address() as AddressInfo).port));
    });
}

function fetchMetrics(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/metrics" }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => {
                body += c;
            });
            res.on("end", () => resolve(body));
        }).on("error", reject);
    });
}

describe("#348 deep-health gauge refreshes on the :9091 scrape cadence", () => {
    it("runs the onScrape hook before serving so a scrape reflects the latest deep-health state", async () => {
        const metrics = createMetricsRegistry(new Registry(), "test-app");

        // Simulate the deep check flipping between scrapes: first scrape sees a
        // waking DB, the second sees it recovered — proving the hook runs each scrape.
        const states: Array<"waking" | "ok"> = ["waking", "ok"];
        let call = 0;
        server = startChildMetricsServer(
            metrics.registry,
            0,
            "127.0.0.1",
            async () => {
                const status = states[Math.min(call, states.length - 1)];
                call += 1;
                refreshDeepHealthGauge(metrics, {
                    status,
                    timestamp: new Date().toISOString(),
                    checks: {
                        postgres: status === "waking" ? "waking" : "up",
                        redis: "unconfigured",
                    },
                });
            },
        );
        const port = await boundPort(server);

        const first = await fetchMetrics(port);
        expect(first).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="waking"[^}]*\\} 1`,
            ),
        );

        const second = await fetchMetrics(port);
        expect(second).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="ok"[^}]*\\} 1`,
            ),
        );
        // And the earlier waking is now cleared (so the alert can resolve).
        expect(second).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="waking"[^}]*\\} 0`,
            ),
        );

        // The hook ran exactly once per scrape — no background timer.
        expect(call).toBe(2);
    });

    it("serves exposition even if the onScrape hook throws (fail-open)", async () => {
        const metrics = createMetricsRegistry(new Registry(), "test-app");
        server = startChildMetricsServer(
            metrics.registry,
            0,
            "127.0.0.1",
            async () => {
                throw new Error("deep check blew up");
            },
        );
        const port = await boundPort(server);

        const out = await fetchMetrics(port);
        // The scrape must still succeed with the base registry (fail-open).
        expect(typeof out).toBe("string");
    });
});
