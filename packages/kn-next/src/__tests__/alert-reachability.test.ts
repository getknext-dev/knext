/**
 * alert-reachability.test.ts — every shipped alert reads only series that are
 * served on a port the shipped PodMonitor scrapes.
 *
 * THE DEFECT CLASS. `observability-metric-contract.test.ts` proves a PromQL name
 * is EMITTED by something. It cannot prove the emitter is COLLECTED. The
 * deep-health gauge was emitted by a real registry on a loopback port that
 * nothing scrapes, so `KnextDeepHealthStuckWaking` / `KnextDeepHealthDown`
 * sat in an opt-in group and a dead database paged nobody — with every
 * emission check green.
 *
 * The scrape surface is DERIVED here, never enumerated:
 *   - the PodMonitor's `targetPort`, read from the shipped manifest;
 *   - the port each runtime entry binds `:9464` on, read from the entries;
 *   - the families the runtime contract forwards from the app registry onto
 *     that port, read from the contract, and counted only if BOTH listeners
 *     actually serve the bridged body.
 *
 * Fail-closed: an unreadable rule file throws, an empty parse throws, and a rule
 * whose expression names no metric throws. A scan that goes quiet when it cannot
 * see its subject is worse than none.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    bridgeIsWired,
    scanAppMetricFamilies,
    scanEntryMetricsPort,
    scanScrapedPorts,
    unreachableAlerts,
} from "../adapters/alert-reachability";
import {
    expandFamily,
    type ParsedRule,
    parsePrometheusRules,
    scanBunexecMetrics,
    scanNameConstants,
    scanOperatorMetrics,
    scanPromClientMetrics,
    seriesNames,
} from "../adapters/metric-contract";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const PKG_ROOT = resolve(here, "../..");
const OPERATOR = join(REPO_ROOT, "packages", "kn-next-operator");
const TEMPLATES = join(PKG_ROOT, "templates", "app");

const read = (p: string) => readFileSync(p, "utf8");

const RULE_FILE = join(OPERATOR, "config/observability/prometheusrule.yaml");
const PODMONITOR = join(OPERATOR, "config/prometheus/app-podmonitor.yaml");
const OPERATOR_MONITOR = join(OPERATOR, "config/prometheus/monitor.yaml");
const CONTRACT = join(TEMPLATES, "runtime-contract.mjs.hbs");
const BUN_ENTRY = join(TEMPLATES, "knext-bun-entry.mjs.hbs");
const NODE_ENTRY = join(TEMPLATES, "knext-node-entry.mjs.hbs");
const METRICS_TS = join(PKG_ROOT, "src", "adapters", "metrics.ts");

/** Prometheus-side series nothing in this repo can scan (see the contract test). */
const EXTERNAL = new Set([
    "up",
    "kube_deployment_status_replicas",
    "kube_pod_status_phase",
    "knext_nextapp_condition",
]);

interface Surface {
    readonly scrapedPorts: readonly number[];
    readonly contract: string;
    readonly bunEntry: string;
}

/**
 * The set of series a live alert may read. Computed from the artifacts, so
 * removing the bridge, moving the entry off the scraped port, or dropping the
 * family from the allowlist each shrink it.
 */
function reachableSeries(s: Surface, operatorScraped: boolean): Set<string> {
    const out = new Set<string>(EXTERNAL);
    const entryPorts = [
        scanEntryMetricsPort(NODE_ENTRY_SRC),
        scanEntryMetricsPort(s.bunEntry),
    ];
    const entriesOnScrapedPort = entryPorts.every(
        (p) => p !== undefined && s.scrapedPorts.includes(p),
    );
    if (entriesOnScrapedPort) {
        for (const n of seriesNames(scanBunexecMetrics(s.contract))) out.add(n);
        if (bridgeIsWired(s.contract, s.bunEntry)) {
            const registered = scanPromClientMetrics(
                read(METRICS_TS),
                scanNameConstants(read(METRICS_TS)),
            );
            for (const family of scanAppMetricFamilies(s.contract)) {
                const type = registered.get(family);
                if (type)
                    for (const n of expandFamily(family, type)) out.add(n);
            }
        }
    }
    if (operatorScraped) {
        for (const n of OPERATOR_SERIES) out.add(n);
    }
    return out;
}

const NODE_ENTRY_SRC = read(NODE_ENTRY);
const OPERATOR_SERIES = (() => {
    const dir = join(OPERATOR, "internal", "controller", "metrics.go");
    return seriesNames(scanOperatorMetrics(read(dir)));
})();

const REAL: Surface = {
    scrapedPorts: scanScrapedPorts(read(PODMONITOR)),
    contract: read(CONTRACT),
    bunEntry: read(BUN_ENTRY),
};
const OPERATOR_SCRAPED = /kind:\s*ServiceMonitor/.test(read(OPERATOR_MONITOR));

/** Parse the shipped rules, throwing (not returning []) when it cannot. */
function loadRules(path: string): ParsedRule[] {
    const yaml = readFileSync(path, "utf8"); // throws on an unreadable file
    const rules = parsePrometheusRules(yaml);
    const declared = (yaml.match(/^\s*-\s+alert:/gm) ?? []).length;
    if (rules.length === 0 || rules.length !== declared) {
        throw new Error(
            `alert-reachability: parsed ${rules.length} of ${declared} alerts from ${path}`,
        );
    }
    return rules;
}

describe("the scrape surface is derived from the shipped artifacts", () => {
    it("the PodMonitor scrapes exactly the port the entries bind", () => {
        expect(REAL.scrapedPorts).toEqual([9464]);
        expect(scanEntryMetricsPort(NODE_ENTRY_SRC)).toBe(9464);
        expect(scanEntryMetricsPort(REAL.bunEntry)).toBe(9464);
    });

    it("the contract forwards the deep-health family and both listeners serve it", () => {
        expect(scanAppMetricFamilies(REAL.contract)).toEqual([
            "knext_deep_health_state",
        ]);
        expect(bridgeIsWired(REAL.contract, REAL.bunEntry)).toBe(true);
    });

    it("the bridge counts as wired only when BOTH listeners go through it", () => {
        const bareBun = REAL.bunEntry.replace(
            "await renderScrape(metrics)",
            "renderMetrics(metrics)",
        );
        expect(bareBun).not.toBe(REAL.bunEntry);
        expect(bridgeIsWired(REAL.contract, bareBun)).toBe(false);
        const bareNode = REAL.contract.replace(
            "await renderScrape(state)",
            "renderMetrics(state)",
        );
        expect(bareNode).not.toBe(REAL.contract);
        expect(bridgeIsWired(bareNode, REAL.bunEntry)).toBe(false);
    });
});

describe("every shipped alert reads only series a scraped port serves", () => {
    it("the shipped rules are all reachable", () => {
        const rules = loadRules(RULE_FILE);
        expect(rules.length).toBeGreaterThan(8);
        const bad = unreachableAlerts(
            rules,
            reachableSeries(REAL, OPERATOR_SCRAPED),
        );
        expect(
            bad,
            `these alerts read series that no scraped port serves — they can never fire:\n${bad
                .map((b) => `${b.group}/${b.alert}: ${b.metric}`)
                .join("\n")}`,
        ).toEqual([]);
    });

    it("the deep-health alerts sit in the LIVE app group, not an opt-in one", () => {
        const rules = loadRules(RULE_FILE);
        for (const alert of [
            "KnextDeepHealthStuckWaking",
            "KnextDeepHealthDown",
        ]) {
            const rule = rules.find((r) => r.alert === alert);
            expect(rule, `${alert} is missing`).toBeDefined();
            expect(rule?.group).toBe("knext.app");
        }
        // No group may re-introduce an inert "opt-in" bucket: an alert that is
        // "not live by default" is the defect this scan exists to prevent.
        const groups = [...new Set(rules.map((r) => r.group))];
        for (const g of groups) expect(g).not.toMatch(/legacy|opt-?in/i);
    });

    it("FLAGS a rule whose metric lives only on the app port (the original defect)", () => {
        const rules: ParsedRule[] = [
            ...loadRules(RULE_FILE),
            {
                group: "knext.app",
                alert: "AppPortOnly",
                // registered by file-manager's /api/metrics route, never forwarded
                expr: "sum(rate(kn_next_http_requests_total[5m])) > 1",
            },
        ];
        const bad = unreachableAlerts(
            rules,
            reachableSeries(REAL, OPERATOR_SCRAPED),
        );
        expect(bad).toEqual([
            {
                group: "knext.app",
                alert: "AppPortOnly",
                metric: "kn_next_http_requests_total",
            },
        ]);
    });

    it("FLAGS the deep-health alerts again the moment the bridge is unwired", () => {
        const unwired: Surface = {
            ...REAL,
            bunEntry: REAL.bunEntry.replace(
                "await renderScrape(metrics)",
                "renderMetrics(metrics)",
            ),
        };
        const bad = unreachableAlerts(
            loadRules(RULE_FILE),
            reachableSeries(unwired, OPERATOR_SCRAPED),
        );
        expect(bad.map((b) => b.alert).sort()).toEqual([
            "KnextDeepHealthDown",
            "KnextDeepHealthStuckWaking",
        ]);
    });

    it("FLAGS them when the entry is no longer on the port the PodMonitor scrapes", () => {
        const moved: Surface = { ...REAL, scrapedPorts: [9999] };
        const bad = unreachableAlerts(
            loadRules(RULE_FILE),
            reachableSeries(moved, OPERATOR_SCRAPED),
        );
        expect(bad.length).toBeGreaterThan(0);
        expect(bad.map((b) => b.alert)).toContain("KnextDeepHealthDown");
    });
});

describe("the scan fails closed", () => {
    it("throws on an unreadable rule file", () => {
        expect(() => loadRules(join(OPERATOR, "no-such-rules.yaml"))).toThrow();
    });

    it("throws on a rule file that parses to nothing", () => {
        expect(() => unreachableAlerts([], new Set())).toThrow(
            /no alerting rules/,
        );
        expect(parsePrometheusRules("this: is\nnot: a rule file\n")).toEqual(
            [],
        );
    });

    it("throws on a rule whose expression names no metric", () => {
        expect(() =>
            unreachableAlerts(
                [{ group: "g", alert: "A", expr: "1 > 0" }],
                new Set(),
            ),
        ).toThrow(/names no metric/);
    });
});
