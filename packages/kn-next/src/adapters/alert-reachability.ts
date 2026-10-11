/**
 * alert-reachability.ts — is the series an alert reads served on a port the
 * shipped PodMonitor scrapes?
 *
 * Emission is not collection. `knext_deep_health_state` was emitted — by a real
 * prom-client registry, which `metric-contract.ts` resolves — on a loopback
 * port nothing scrapes, so two alerts keyed on it could never fire while every
 * "is this name real?" check stayed green. These helpers add the missing axis:
 * which PORT a series is served on, against the port the PodMonitor scrapes.
 *
 * Like `metric-contract.ts` everything here SCANS the real artifact. Nothing is
 * an enumerated list of names, which is how the next unreachable alert would
 * get through.
 */

import { extractMetricNames, type ParsedRule } from "./metric-contract";

/** The distinct `targetPort: <n>` values a PodMonitor/ServiceMonitor scrapes. */
export function scanScrapedPorts(monitorYaml: string): number[] {
    return [
        ...new Set(
            [...monitorYaml.matchAll(/^\s*-?\s*targetPort:\s*(\d+)\s*$/gm)].map(
                (m) => Number(m[1]),
            ),
        ),
    ].sort((a, b) => a - b);
}

/** The default metrics port a runtime entry binds (`METRICS_PORT ?? <n>`). */
export function scanEntryMetricsPort(entrySource: string): number | undefined {
    const m = entrySource.match(
        /METRICS_PORT\s*=\s*Number\(process\.env\.METRICS_PORT\s*\?\?\s*(\d+)\)/,
    );
    return m ? Number(m[1]) : undefined;
}

/** The families the runtime contract forwards from the app registry onto :9464. */
export function scanAppMetricFamilies(contractSource: string): string[] {
    const m = contractSource.match(
        /export const APP_METRIC_FAMILIES\s*=\s*\[([^\]]*)\]/,
    );
    if (!m) return [];
    return [...(m[1] as string).matchAll(/['"]([^'"]+)['"]/g)].map(
        (x) => x[1] as string,
    );
}

/**
 * Whether the :9464 listeners actually serve the bridged body: the contract's
 * node:http listener AND the bun entry's Bun.serve both go through
 * `renderScrape`. Allowlisting a family while a listener still calls the bare
 * `renderMetrics` is the same defect with more code.
 */
export function bridgeIsWired(
    contractSource: string,
    bunEntrySource: string,
): boolean {
    const at = contractSource.indexOf("export function metricsRequestListener");
    if (at === -1) return false;
    const listener = contractSource.slice(at);
    return (
        /await renderScrape\(state\)/.test(listener) &&
        /await renderScrape\(metrics\)/.test(bunEntrySource) &&
        !/new Response\(renderMetrics\(metrics\)/.test(bunEntrySource)
    );
}

/** One violation: a metric a live alert reads that no scraped port serves. */
export interface UnreachableAlert {
    readonly group: string;
    readonly alert: string;
    readonly metric: string;
}

/**
 * Every (alert, metric) pair where the metric is NOT in `reachable`. Fails
 * CLOSED: no rules at all, or a rule whose expression names no metric, is an
 * error rather than a pass — a parser that silently lost the file would
 * otherwise certify an empty set of alerts.
 */
export function unreachableAlerts(
    rules: readonly ParsedRule[],
    reachable: ReadonlySet<string>,
): UnreachableAlert[] {
    if (rules.length === 0) {
        throw new Error(
            "alert-reachability: no alerting rules were parsed — refusing to certify an empty set",
        );
    }
    const out: UnreachableAlert[] = [];
    for (const rule of rules) {
        const names = extractMetricNames(rule.expr);
        if (names.length === 0) {
            throw new Error(
                `alert-reachability: ${rule.group}/${rule.alert} names no metric — the expression was not understood`,
            );
        }
        for (const metric of names) {
            if (!reachable.has(metric)) {
                out.push({ group: rule.group, alert: rule.alert, metric });
            }
        }
    }
    return out;
}
