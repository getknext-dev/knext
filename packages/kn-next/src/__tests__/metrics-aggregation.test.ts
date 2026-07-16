import type http from "node:http";
import { collectDefaultMetrics, Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";

import {
    createMetricsRegistry,
    fetchChildMetrics,
    initRuntimeMetrics,
    mergeExposition,
    resetRuntimeMetrics,
    startChildMetricsServer,
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

/**
 * #315 DEFECT (system-designer BLOCK): the persistent SUPERVISOR seeds the
 * default process metrics. The CHILD must NOT seed them again, or the healthy
 * warm scrape (child reachable) emits every default family TWICE — duplicate
 * `# HELP`/`# TYPE` + duplicate zero-label samples — which Prometheus rejects.
 * These tests exercise the REAL supervisor+child registries and merge.
 */
describe("#315 default process metrics are not duplicated in the merged scrape", () => {
    afterEach(() => {
        resetRuntimeMetrics();
    });

    /** How many times a metric FAMILY (a `# TYPE <name> ...` line) appears. */
    function typeLineCount(exposition: string, family: string): number {
        return exposition
            .split("\n")
            .filter((l) => l.startsWith(`# TYPE ${family} `)).length;
    }

    it("the child registry carries only knext_* families, no process/nodejs defaults", async () => {
        const childReg = new Registry();
        const metrics = initRuntimeMetrics(childReg, "child-app");
        metrics.httpInflight.labels({ app: "child-app" }).set(0);
        const childBody = await childReg.metrics();

        // Default families must NOT be present on the child (the supervisor owns them).
        expect(typeLineCount(childBody, "process_cpu_seconds_total")).toBe(0);
        expect(childBody).not.toMatch(/# TYPE nodejs_/);
        // The knext series are still there.
        expect(childBody).toContain("knext_http_inflight_requests");
    });

    it("merging the supervisor default dump with the child yields each default family EXACTLY once", async () => {
        // Supervisor: the persistent process registry with the default metrics.
        const supervisorReg = new Registry();
        collectDefaultMetrics({ register: supervisorReg });
        const supervisorBody = await supervisorReg.metrics();

        // Child: the knext runtime registry (must NOT re-seed defaults).
        const childReg = new Registry();
        initRuntimeMetrics(childReg, "child-app");
        const childBody = await childReg.metrics();

        const merged = mergeExposition([supervisorBody, childBody]);

        // Each default family appears exactly once — no duplicate TYPE/samples.
        expect(typeLineCount(merged, "process_cpu_seconds_total")).toBe(1);
        // A representative nodejs default family, whichever the platform emits.
        const nodejsFamily = supervisorBody
            .split("\n")
            .map((l) => l.match(/^# TYPE (nodejs_\w+) /)?.[1])
            .find(Boolean);
        if (nodejsFamily) {
            expect(typeLineCount(merged, nodejsFamily)).toBe(1);
        }
        // No default family's TYPE line is duplicated anywhere in the merge.
        const typeLines = merged
            .split("\n")
            .filter((l) => l.startsWith("# TYPE "));
        const seen = new Set<string>();
        const dupes = typeLines.filter((l) => {
            if (seen.has(l)) return true;
            seen.add(l);
            return false;
        });
        expect(dupes, `duplicate # TYPE lines: ${dupes.join(" | ")}`).toEqual(
            [],
        );
    });
});
