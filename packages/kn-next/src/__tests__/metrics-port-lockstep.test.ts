/**
 * metrics-port-lockstep — observability guard (#153 system-design review gap).
 *
 * The runtime exposes Prometheus metrics on METRICS_PORT, whose default literal
 * lives in node-server.ts:
 *     const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
 *
 * The operator hardcodes the scrape target on the KSVC revision template:
 *     annotations["prometheus.io/port"] = "9091"
 *
 * In production the operator does NOT inject a METRICS_PORT env, so the runtime
 * default and the scrape annotation MUST be the same number. If someone changes
 * one without the other, Prometheus scrapes the wrong port and app metrics go
 * dark silently — no test catches the drift today.
 *
 * This is a pure cross-file guard: it reads both source files as text, extracts
 * each number, and asserts they are equal. It changes neither file. If either
 * value cannot be located the test FAILS loudly (rather than soft-skipping) so
 * the guard can never silently no-op after a refactor.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// repo root: packages/kn-next/src/__tests__ -> up 4
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const RUNTIME_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next",
    "src",
    "adapters",
    "node-server.ts",
);
const OPERATOR_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next-operator",
    "internal",
    "controller",
    "nextapp_controller.go",
);

/**
 * Runtime default: `process.env.METRICS_PORT ?? <N>`.
 * Tolerant of whitespace and numeric separators (e.g. 9_091).
 */
function extractRuntimeMetricsPort(src: string): number {
    const m = src.match(/process\.env\.METRICS_PORT\s*\?\?\s*([0-9][0-9_]*)/);
    if (!m) {
        throw new Error(
            `Could not find the METRICS_PORT default (process.env.METRICS_PORT ?? <N>) ` +
                `in ${RUNTIME_FILE}. The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    return Number(m[1].replace(/_/g, ""));
}

/**
 * Operator scrape target: the Go assignment of the `prometheus.io/port` annotation
 * to a quoted numeric string, e.g.  annotations["prometheus.io/port"] = "9091".
 */
function extractOperatorScrapePort(src: string): number {
    const m = src.match(
        /["']prometheus\.io\/port["']\s*\]?\s*[:=]\s*["']([0-9]+)["']/,
    );
    if (!m) {
        throw new Error(
            `Could not find the prometheus.io/port annotation ("prometheus.io/port" = "<N>") ` +
                `in ${OPERATOR_FILE}. The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    return Number(m[1]);
}

describe("metrics-port lockstep (runtime default ↔ operator scrape annotation)", () => {
    it("locates both values (fails loudly rather than silently no-op'ing)", () => {
        const runtimePort = extractRuntimeMetricsPort(
            readFileSync(RUNTIME_FILE, "utf8"),
        );
        const operatorPort = extractOperatorScrapePort(
            readFileSync(OPERATOR_FILE, "utf8"),
        );
        expect(Number.isInteger(runtimePort)).toBe(true);
        expect(Number.isInteger(operatorPort)).toBe(true);
        expect(runtimePort).toBeGreaterThan(0);
        expect(operatorPort).toBeGreaterThan(0);
    });

    it("runtime METRICS_PORT default EQUALS operator prometheus.io/port annotation", () => {
        const runtimePort = extractRuntimeMetricsPort(
            readFileSync(RUNTIME_FILE, "utf8"),
        );
        const operatorPort = extractOperatorScrapePort(
            readFileSync(OPERATOR_FILE, "utf8"),
        );

        // The operator injects NO METRICS_PORT env in production, so these two
        // numbers are the ONLY contract between the metrics server and Prometheus.
        expect(
            runtimePort,
            `Prometheus scrape-port drift: runtime METRICS_PORT default is ${runtimePort} ` +
                `(${RUNTIME_FILE}) but the operator scrapes ${operatorPort} ` +
                `(${OPERATOR_FILE}, prometheus.io/port). Since the operator injects no ` +
                `METRICS_PORT env in production, these MUST match or app metrics go dark. ` +
                `Update both files together.`,
        ).toBe(operatorPort);
    });

    // Self-test of the extraction logic so the guard can't drift into a no-op:
    // proves a hypothetical divergence WOULD be caught (criterion 2).
    it("self-test: detects a divergence in either value", () => {
        expect(
            extractRuntimeMetricsPort(
                "const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);",
            ),
        ).toBe(9091);
        expect(
            extractOperatorScrapePort(
                'annotations["prometheus.io/port"] = "9091"',
            ),
        ).toBe(9091);
        // If the operator value were changed in isolation, the comparison above
        // would surface 9091 !== 9099 and fail.
        const runtime = extractRuntimeMetricsPort(
            "Number(process.env.METRICS_PORT ?? 9091)",
        );
        const drifted = extractOperatorScrapePort(
            'annotations["prometheus.io/port"] = "9099"',
        );
        expect(runtime).not.toBe(drifted);
    });
});
