/**
 * dashboard-metrics.ts — the source-of-truth link between the exported knext
 * runtime metrics (metrics.ts) and the Grafana dashboards shipped in the
 * operator bundle (`packages/kn-next-operator/config/grafana/dashboards`).
 *
 * The parity test (grafana-dashboards-parity.test.ts) uses this to guarantee
 * every `knext_*` series a dashboard panel queries actually exists in the
 * exported metric set — so the turnkey dashboards never contain a dangling
 * query. Kept next to metrics.ts so the allowed-name list is derived from the
 * SAME constants the runtime registers, never a hand-copied duplicate.
 */

import {
    COLDSTART_DURATION_METRIC,
    COLDSTART_TOTAL_METRIC,
    DB_WAKE_DURATION_METRIC,
    DB_WAKE_TOTAL_METRIC,
    DEEP_HEALTH_STATE_METRIC,
    HTTP_INFLIGHT_METRIC,
    HTTP_REQUEST_DURATION_METRIC,
    HTTP_REQUESTS_TOTAL_METRIC,
} from "./metrics";

/**
 * The full set of `knext_*` metric BASE names the runtime registers on the
 * :9091 registry — the single source of truth a dashboard query may reference.
 * Derived from the metrics.ts constants (not re-typed) so the two can never
 * drift.
 */
export const EXPORTED_KNEXT_METRICS: readonly string[] = [
    HTTP_REQUESTS_TOTAL_METRIC,
    HTTP_REQUEST_DURATION_METRIC,
    HTTP_INFLIGHT_METRIC,
    COLDSTART_TOTAL_METRIC,
    COLDSTART_DURATION_METRIC,
    DB_WAKE_TOTAL_METRIC,
    DB_WAKE_DURATION_METRIC,
    DEEP_HEALTH_STATE_METRIC,
];

/**
 * Prometheus histogram families expose derived timeseries with these suffixes
 * (`knext_http_request_duration_seconds` → `..._bucket` / `..._sum` /
 * `..._count`). A dashboard query legitimately references those, so we strip a
 * trailing derived suffix before checking membership. `_total` is NOT stripped:
 * counter base names already END in `_total`, so their exported constant
 * matches directly.
 */
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"] as const;

/** Every `knext_*` token that appears anywhere in a dashboard JSON string. */
export function extractKnextMetricTokens(dashboardJson: string): string[] {
    const matches = dashboardJson.match(/knext_[a-z_]+/g) ?? [];
    return [...new Set(matches)].sort();
}

/**
 * Normalise a queried token to its registered base metric name by stripping a
 * single trailing histogram-derived suffix if present.
 */
export function baseMetricName(token: string): string {
    for (const suffix of HISTOGRAM_SUFFIXES) {
        if (token.endsWith(suffix)) {
            return token.slice(0, -suffix.length);
        }
    }
    return token;
}

/**
 * Validate a dashboard's `knext_*` queries against the exported metric set.
 * Returns the list of tokens that do NOT resolve to a registered metric (empty
 * ⇒ every query references a real series). Non-`knext_` metrics (kube_*,
 * kn_next_* RUM/bytecode, knative autoscaler) are out of scope here.
 */
export function findDanglingKnextMetrics(
    dashboardJson: string,
    exported: readonly string[] = EXPORTED_KNEXT_METRICS,
): string[] {
    const allowed = new Set(exported);
    return extractKnextMetricTokens(dashboardJson).filter(
        (token) => !allowed.has(baseMetricName(token)),
    );
}
