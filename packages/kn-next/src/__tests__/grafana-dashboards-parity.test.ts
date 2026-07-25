/**
 * grafana-dashboards-parity.test.ts (#316)
 *
 * The turnkey Grafana dashboards shipped in the operator bundle
 * (`packages/kn-next-operator/config/grafana/dashboards`) must never contain a
 * dangling query: every `knext_*` series a panel references has to exist in the
 * runtime metric set exported by `adapters/metrics.ts`. This test asserts that
 * parity, sourcing the allowed names from the code (EXPORTED_KNEXT_METRICS,
 * derived from the metrics.ts constants) — not a hand-copied list.
 *
 * Non-`knext_` metrics (kube_* replica counts, kn_next_* RUM/bytecode, knative
 * autoscaler) come from other exporters / the cluster and are out of scope for
 * the assertion — but we collect and surface them so a reviewer can see exactly
 * which external series each dashboard depends on.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    EXPORTED_KNEXT_METRICS,
    extractKnextMetricTokens,
    findDanglingKnextMetrics,
} from "../adapters/dashboard-metrics";

const DASHBOARD_DIR = path.resolve(
    import.meta.dirname,
    "../../../kn-next-operator/config/grafana/dashboards",
);

function dashboardFiles(): string[] {
    return readdirSync(DASHBOARD_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();
}

/** Every metric-ish token that is NOT a `knext_*` series (external deps). */
function externalMetricTokens(json: string): string[] {
    const all = json.match(/\b[a-z][a-z0-9_]*_[a-z0-9_]+\b/g) ?? [];
    return [...new Set(all)].filter(
        (t) =>
            !t.startsWith("knext_") &&
            // Grafana / PromQL helpers, not metrics.
            !["histogram_quantile", "label_values", "rate_interval"].includes(
                t,
            ),
    );
}

describe("Grafana dashboard ↔ exported-metric parity (#316)", () => {
    const files = dashboardFiles();

    it("ships the five bundled dashboards", () => {
        expect(files.length).toBe(5);
    });

    it.each(files)("%s references only real knext_* metrics", (file) => {
        const json = readFileSync(path.join(DASHBOARD_DIR, file), "utf8");
        // Parse — a dashboard must be valid JSON.
        expect(() => JSON.parse(json)).not.toThrow();

        const dangling = findDanglingKnextMetrics(json);
        expect(
            dangling,
            `${file} queries knext_* metric(s) not exported by metrics.ts: ${dangling.join(", ")}`,
        ).toEqual([]);
    });

    it("collects external (non-knext) metric dependencies for review", () => {
        const external: Record<string, string[]> = {};
        for (const file of files) {
            const json = readFileSync(path.join(DASHBOARD_DIR, file), "utf8");
            external[file] = externalMetricTokens(json);
        }
        // Not an assertion on values — this documents each dashboard's external
        // deps (kube_*, kn_next_* RUM/bytecode, knative autoscaler) so reviewers
        // can eyeball the cluster/other-exporter surface.
        // biome-ignore lint/suspicious/noConsole: intentional review surface.
        console.log(
            "External (non-knext_) metric deps per dashboard:\n" +
                JSON.stringify(external, null, 2),
        );
        expect(Object.keys(external).sort()).toEqual(files);
    });
});

describe("dashboard-metrics extractor (fail-first guard)", () => {
    it("flags a fake knext_* metric injected into a dashboard", () => {
        const bogus = JSON.stringify({
            panels: [
                {
                    targets: [
                        {
                            expr: "sum(rate(knext_totally_made_up_total[5m]))",
                        },
                    ],
                },
            ],
        });
        expect(findDanglingKnextMetrics(bogus)).toEqual([
            "knext_totally_made_up_total",
        ]);
    });

    it("accepts a real metric and its histogram-derived suffixes", () => {
        const good = JSON.stringify({
            expr: "histogram_quantile(0.99, sum by (le) (rate(knext_http_request_duration_seconds_bucket[5m])))",
            secondary: "knext_http_requests_total knext_http_inflight_requests",
        });
        expect(findDanglingKnextMetrics(good)).toEqual([]);
        expect(extractKnextMetricTokens(good)).toContain(
            "knext_http_request_duration_seconds_bucket",
        );
    });

    it("derives the allowed set from the exported metric constants", () => {
        expect(EXPORTED_KNEXT_METRICS).toContain("knext_http_requests_total");
        expect(EXPORTED_KNEXT_METRICS).toContain("knext_coldstart_total");
        expect(EXPORTED_KNEXT_METRICS).toContain(
            "knext_db_wake_duration_seconds",
        );
    });
});
