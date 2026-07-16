import http from "node:http";
import { Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";

import {
    createMetricsRegistry,
    startChildMetricsServer,
    fetchChildMetrics,
    mergeExposition,
} from "../adapters/metrics";

/**
 * #315 — the cross-process bridge. Golden-signal / cold-start / db-wake metrics
 * are emitted in the Next.js CHILD process (from the #317 OTel hooks); the
 * operator scrapes the SUPERVISOR's :9091. So the supervisor's /metrics must
 * merge its own (default process) series with the child's core series, fetched
 * over localhost. These tests exercise the REAL child server + fetch + merge.
 */

const servers: http.Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (s) =>
                new Promise<void>((resolve) => {
                    s.close(() => resolve());
                }),
        ),
    );
});

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
    });
}

describe("#315 child metrics server", () => {
    it("serves the child registry exposition over HTTP", async () => {
        const reg = new Registry();
        const metrics = createMetricsRegistry(reg, "child-app");
        metrics.coldstartTotal.labels({ app: "child-app" }).inc();

        const server = startChildMetricsServer(reg, 0, "127.0.0.1");
        servers.push(server);
        const port = await listen(server);

        const body = await fetchChildMetrics(port, "127.0.0.1", 1000);
        expect(body).toContain("knext_coldstart_total");
        expect(body).toMatch(/app="child-app"/);
    });

    it("fetchChildMetrics resolves empty string when the child is unreachable", async () => {
        // Nothing listening on this port → best-effort empty, never throws.
        const body = await fetchChildMetrics(1, "127.0.0.1", 200);
        expect(body).toBe("");
    });
});

describe("#315 supervisor merge", () => {
    it("concatenates supervisor + child exposition with a separating newline", () => {
        const merged = mergeExposition([
            "# process metric\nprocess_cpu 1\n",
            "# app metric\nknext_http_requests_total 5\n",
        ]);
        expect(merged).toContain("process_cpu 1");
        expect(merged).toContain("knext_http_requests_total 5");
    });

    it("drops empty sources (an unreachable child) without a trailing gap", () => {
        const merged = mergeExposition(["process_cpu 1\n", ""]);
        expect(merged).toBe("process_cpu 1\n");
    });
});
