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

/**
 * Non-`knext_` tokens surfaced for review. This is a coarse token scrape, not a
 * true metric parser — PromQL functions, template variables, and Prometheus
 * label names get filtered out by the deny-list below so they are not mislabeled
 * as metrics. Anything left is (approximately) an external metric dependency
 * (kube_*, kn_next_* RUM/bytecode, http_server_* OTel, knative autoscaler).
 */
const NON_METRIC_TOKENS = new Set([
    // PromQL functions / keywords.
    "histogram_quantile",
    "label_values",
    "rate_interval",
    "clamp_min",
    "clamp_max",
    // Prometheus label names we match on (not metrics).
    "status_class",
    "http_response_status_code",
    "le",
]);

function nonKnextReviewTokens(json: string): string[] {
    const all = json.match(/\b[a-z][a-z0-9_]*_[a-z0-9_]+\b/g) ?? [];
    return [...new Set(all)].filter(
        (t) => !t.startsWith("knext_") && !NON_METRIC_TOKENS.has(t),
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

    it("collects non-knext tokens (review surface)", () => {
        const external: Record<string, string[]> = {};
        for (const file of files) {
            const json = readFileSync(path.join(DASHBOARD_DIR, file), "utf8");
            external[file] = nonKnextReviewTokens(json);
        }
        // Not an assertion on values — this documents each dashboard's external
        // deps (kube_*, kn_next_* RUM/bytecode, knative autoscaler) so reviewers
        // can eyeball the cluster/other-exporter surface.
        // biome-ignore lint/suspicious/noConsole: intentional review surface.
        console.log(
            "Non-knext tokens per dashboard (review surface):\n" +
                JSON.stringify(external, null, 2),
        );
        expect(Object.keys(external).sort()).toEqual(files);
    });

    // Structural invariants that hold for EVERY bundled dashboard — these run on
    // all five (unlike the knext_* parity assertion, which is vacuous for the
    // three dashboards that carry no knext_* series). This is the guard that
    // would have caught an HTTP-API import envelope masquerading as a raw model.
    it.each(
        files,
    )("%s is a RAW dashboard model (not an import envelope)", (file) => {
        const model = JSON.parse(
            readFileSync(path.join(DASHBOARD_DIR, file), "utf8"),
        );
        // The Grafana sidecar provisioner expects the raw model at top level;
        // the HTTP-API envelope `{ dashboard, message, overwrite }` won't load.
        expect(
            model.dashboard,
            `${file} is wrapped in an import envelope (top-level "dashboard" key) — unwrap it`,
        ).toBeUndefined();
        expect(Array.isArray(model.panels)).toBe(true);
        expect(model.panels.length).toBeGreaterThan(0);
        expect(typeof model.uid).toBe("string");
        expect(model.uid.length).toBeGreaterThan(0);
        expect(typeof model.title).toBe("string");
        expect(model.title.length).toBeGreaterThan(0);
    });

    // Pins the docs claim "every dashboard uses a datasource template variable"
    // as a tested invariant.
    it.each(files)("%s exposes a datasource template variable", (file) => {
        const model = JSON.parse(
            readFileSync(path.join(DASHBOARD_DIR, file), "utf8"),
        );
        const vars: Array<{ type?: string }> = model.templating?.list ?? [];
        expect(vars.some((v) => v.type === "datasource")).toBe(true);
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
