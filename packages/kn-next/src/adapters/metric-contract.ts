/**
 * metric-contract.ts — the link between what the shipped artifacts EMIT and
 * what the shipped alerts + dashboards QUERY.
 *
 * #792's mechanism, generalised: a PromQL query naming a series nobody emits
 * returns an empty vector. `for:` is never satisfied, the panel is blank, and
 * the alert never fires — silently, indefinitely. Nothing goes red; there is no
 * error anywhere. The only way to catch it is to compare the two sides
 * mechanically, which is what this module exists to make possible.
 *
 * Everything here SCANS a real emitter rather than enumerating names. An
 * enumerated allowlist is how the second call site gets missed, and it is also
 * how a dead name survives a rename: someone updates the list instead of the
 * query. The scanners below read the emitter's own source, so renaming an
 * emitted metric moves the set, and every query that still names the old series
 * goes red.
 *
 * Four emitters, because "is this name real?" has four different answers and
 * collapsing them is what let the drift hide:
 *
 *   bunexec      the compiled single-executable runtime (ADR-0048). This is the
 *                ONLY emitter the shipped PodMonitor scrapes (:9464 /metrics),
 *                so it is the only one a turnkey alert can rely on.
 *   operator     the Go controller's own /metrics.
 *   node-legacy  the prom-client registries reachable only through an app-level
 *                `/api/metrics` route (the pre-ADR-0048 node-server supervisor
 *                merged these onto :9464; the compiled binary does not). REAL
 *                series, but NOT on the shipped scrape path — referencing one
 *                is a declared choice, never the default.
 *   external     kube-state-metrics, `up`, k6/OTel. Not ours; allowlisted with
 *                a reason each, since nothing in this repo can scan them.
 */

/**
 * Prometheus expands a histogram family into three derived series. A query
 * legitimately names any of them, so an emitted histogram contributes all four
 * names to the emitted set. Summaries expose `_sum`/`_count` only.
 */
const HISTOGRAM_DERIVED = ["_bucket", "_sum", "_count"] as const;

/** Expand one emitted `name`/`type` pair into every series name it produces. */
export function expandFamily(name: string, type: string): string[] {
    if (type === "histogram") {
        return [name, ...HISTOGRAM_DERIVED.map((s) => `${name}${s}`)];
    }
    if (type === "summary") return [name, `${name}_sum`, `${name}_count`];
    return [name];
}

/**
 * Scan the Prometheus exposition the bun-exec runtime renders.
 *
 * `runtime-contract.mjs.hbs` hand-rolls its exposition (no prom-client — the
 * module has to stay compile-safe inside `bun build --compile`), so the
 * authoritative declaration of what it emits is the `# TYPE <name> <type>`
 * lines themselves. Those lines are not decoration: Prometheus parses them, so
 * a metric cannot be emitted without one. Scanning them therefore cannot miss
 * a series, and cannot be satisfied by a comment.
 */
export function scanBunexecMetrics(source: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of source.matchAll(
        /#\s*TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(counter|gauge|histogram|summary|untyped)\b/g,
    )) {
        out.set(m[1] as string, m[2] as string);
    }
    return out;
}

/**
 * Scan the operator's Go metric registry.
 *
 * Matches a `prometheus.New<Kind>[Vec](prometheus.<Kind>Opts{ … Name: "…" })`
 * construction and pairs the kind with the name, so a histogram contributes its
 * `_bucket`/`_sum`/`_count` names too.
 */
export function scanOperatorMetrics(goSource: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of goSource.matchAll(
        /New(Counter|Gauge|Histogram|Summary)(?:Vec)?\s*\(\s*prometheus\.\w+\{([\s\S]{0,400}?)\}/g,
    )) {
        const kind = (m[1] as string).toLowerCase();
        const body = m[2] as string;
        const name = body.match(/Name:\s*"([^"]+)"/)?.[1];
        if (name) out.set(name, kind);
    }
    return out;
}

/**
 * `export const FOO = "bar";` → `FOO → bar`.
 *
 * Lets `scanPromClientMetrics` resolve a metric declared as
 * `new Counter({ name: HTTP_REQUESTS_TOTAL_METRIC })` without importing the
 * module — metrics.ts pulls in the OpenTelemetry SDK, which a source-scanning
 * test has no business loading. Reading the constants is the same source of
 * truth as importing them; it is not a hand-copied duplicate.
 */
export function scanNameConstants(tsSource: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of tsSource.matchAll(
        /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*['"`]([^'"`]+)['"`]\s*;/g,
    )) {
        out.set(m[1] as string, m[2] as string);
    }
    return out;
}

/**
 * Scan a prom-client registry module (`new Histogram({ name: '…' })`, etc.).
 *
 * Resolves both string-literal names and identifier names, the latter through
 * `constants` (see `scanNameConstants`). An identifier that does not resolve is
 * DROPPED — which is why the callers assert on known members of the resulting
 * set rather than trusting it blind.
 */
export function scanPromClientMetrics(
    tsSource: string,
    constants: Map<string, string> = new Map(),
): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of tsSource.matchAll(
        /new\s+(?:client\.)?(Counter|Gauge|Histogram|Summary)\s*(?:<[^>]*>)?\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/g,
    )) {
        const kind = (m[1] as string).toLowerCase();
        const body = m[2] as string;
        const literal = body.match(/name:\s*['"`]([^'"`]+)['"`]/)?.[1];
        if (literal) {
            out.set(literal, kind);
            continue;
        }
        const ident = body.match(/name:\s*([A-Za-z_$][\w$]*)\s*,/)?.[1];
        const resolved = ident ? constants.get(ident) : undefined;
        if (resolved) out.set(resolved, kind);
    }
    return out;
}

/** Flatten a scanned `name → type` map into every series name it emits. */
export function seriesNames(families: Map<string, string>): Set<string> {
    const out = new Set<string>();
    for (const [name, type] of families) {
        for (const s of expandFamily(name, type)) out.add(s);
    }
    return out;
}

/**
 * Every knext metric name a MARKDOWN document names, in backticks (S5).
 *
 * The third side of the contract. #792 closed alerts-vs-emitters and
 * dashboards-vs-emitters; the docs were swept by hand, which is the mechanism
 * that fails silently — a rename moves the emitted set and every prose reference
 * to the old name simply keeps reading correct. Nothing errors, nobody notices,
 * and the doc is published (`apps/docs/content/docs/observability.mdx` is
 * user-facing).
 *
 * Only BACKTICKED tokens count. Prose naming a metric without code formatting is
 * not a claim this can resolve, and widening the match to bare words drags in
 * every `knext_`-prefixed identifier that is not a metric at all.
 *
 * A trailing `*` is kept: docs legitimately name a FAMILY (`knext_coldstart_*`),
 * and the caller resolves that as a prefix against at least one emitted series.
 */
export function extractDocMetricTokens(markdown: string): string[] {
    const out = new Set<string>();
    for (const m of markdown.matchAll(/`((?:knext|kn_next)_[a-z0-9_]*\*?)`/g)) {
        out.add(m[1] as string);
    }
    return [...out].sort();
}

/**
 * Does `token` — an exact name or a `prefix_*` family — resolve against
 * `emitted`?
 */
export function docTokenResolves(
    token: string,
    emitted: ReadonlySet<string>,
): boolean {
    if (token.endsWith("*")) {
        const prefix = token.slice(0, -1);
        for (const name of emitted) if (name.startsWith(prefix)) return true;
        return false;
    }
    return emitted.has(token);
}

/**
 * The text between `<!-- metric-contract:<id> start -->` and its `end` marker.
 *
 * FAILS CLOSED: a missing or unbalanced fence returns `null`, and the caller
 * treats that as a failure. A doc section that quietly stops being checked
 * because someone reflowed a paragraph is the exact decay this guards against.
 */
export function fencedDocSection(markdown: string, id: string): string | null {
    const start = markdown.indexOf(`<!-- metric-contract:${id} start -->`);
    const end = markdown.indexOf(`<!-- metric-contract:${id} end -->`);
    if (start === -1 || end === -1 || end <= start) return null;
    return markdown.slice(start, end);
}

/**
 * PromQL tokens that are NOT metric names: functions, keywords, aggregation
 * modifiers, and the label names this repo's queries match on. Anything left
 * after this filter is treated as a metric selector, which is the fail-closed
 * direction — an unrecognised token is reported, never silently dropped.
 */
const PROMQL_RESERVED = new Set([
    // functions
    "abs",
    "absent",
    "absent_over_time",
    "avg_over_time",
    "ceil",
    "changes",
    "clamp",
    "clamp_max",
    "clamp_min",
    "count_over_time",
    "day_of_month",
    "day_of_week",
    "days_in_month",
    "delta",
    "deriv",
    "exp",
    "floor",
    "histogram_quantile",
    "holt_winters",
    "hour",
    "idelta",
    "increase",
    "irate",
    "label_join",
    "label_replace",
    "label_values",
    "last_over_time",
    "ln",
    "log2",
    "log10",
    "max_over_time",
    "min_over_time",
    "minute",
    "month",
    "predict_linear",
    "present_over_time",
    "quantile_over_time",
    "rate",
    "resets",
    "round",
    "scalar",
    "sgn",
    "sort",
    "sort_desc",
    "sqrt",
    "stddev_over_time",
    "stdvar_over_time",
    "sum_over_time",
    "time",
    "timestamp",
    "vector",
    "year",
    // aggregation operators + modifiers + set operators
    "sum",
    "min",
    "max",
    "avg",
    "group",
    "stddev",
    "stdvar",
    "count",
    "count_values",
    "bottomk",
    "topk",
    "quantile",
    "by",
    "without",
    "ignoring",
    "on",
    "group_left",
    "group_right",
    "and",
    "or",
    "unless",
    "offset",
    "bool",
    "inf",
    "nan",
    "start",
    "end",
    "atan2",
    // grafana template interpolation
    "__rate_interval",
    "__interval",
    "__range",
    "rate_interval",
]);

/**
 * Label NAMES this repo's queries select or aggregate on. They appear in the
 * same token position as a metric name inside `{…}` and `by (…)`, so they are
 * excluded explicitly rather than by heuristic.
 */
const LABEL_NAMES = new Set([
    "app",
    "namespace",
    "name",
    "pod",
    "job",
    "instance",
    "service",
    "container",
    "deployment",
    "cronjob",
    "le",
    "status_class",
    "route",
    "method",
    "type",
    "status",
    "dependency",
    "state",
    "cache_status",
    "role",
    "rating",
    "phase",
    "http_response_status_code",
    "owner_name",
    "severity",
    "revision",
    "reason",
    "kind",
]);

/**
 * Extract the metric-name selectors from a PromQL expression.
 *
 * Deliberately coarse-but-fail-closed: strip string literals and label-matcher
 * bodies, then treat every remaining identifier that is neither reserved nor a
 * known label name as a metric selector. Over-reporting shows up as a red test
 * naming the token, which a human resolves once; under-reporting is the failure
 * this whole module exists to prevent.
 */
export function extractMetricNames(expr: string): string[] {
    const stripped = expr
        // label-matcher bodies: {app=~"$app", status_class="5xx"}
        .replace(/\{[^{}]*\}/g, " ")
        // any surviving quoted literal
        .replace(/"[^"]*"/g, " ")
        .replace(/'[^']*'/g, " ")
        // durations/offsets: [5m], [$__rate_interval]
        .replace(/\[[^\]]*\]/g, " ");
    const names = new Set<string>();
    for (const m of stripped.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)) {
        const tok = m[0] as string;
        if (PROMQL_RESERVED.has(tok) || LABEL_NAMES.has(tok)) continue;
        names.add(tok);
    }
    return [...names].sort();
}

/** Every `expr` string anywhere in a Grafana dashboard model. */
export function dashboardExprs(model: unknown): string[] {
    const out: string[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            for (const n of node) walk(n);
            return;
        }
        const rec = node as Record<string, unknown>;
        if (typeof rec.expr === "string") out.push(rec.expr);
        for (const v of Object.values(rec)) walk(v);
    };
    walk(model);
    return out;
}

/** One alerting rule lifted out of a PrometheusRule manifest. */
export interface ParsedRule {
    readonly group: string;
    readonly alert: string;
    readonly expr: string;
}

/**
 * Parse `spec.groups[].rules[].{alert,expr}` out of a PrometheusRule YAML
 * WITHOUT a YAML dependency — the manifest uses a small, stable subset
 * (`- name:` groups, `- alert:` rules, `expr:` scalars/folded blocks) and this
 * package ships no YAML parser.
 *
 * Fail-closed on shape: `assertParsedEveryAlert` below cross-checks the count
 * against a raw `- alert:` grep, so a rule this parser cannot see reds the test
 * instead of being skipped.
 */
export function parsePrometheusRules(yaml: string): ParsedRule[] {
    const lines = yaml.split("\n");
    const rules: ParsedRule[] = [];
    let group = "";
    let current: { alert: string; exprLines: string[] } | null = null;
    let exprIndent = -1;

    const flush = () => {
        if (current) {
            rules.push({
                group,
                alert: current.alert,
                expr: current.exprLines.join(" ").replace(/\s+/g, " ").trim(),
            });
            current = null;
        }
        exprIndent = -1;
    };

    for (const line of lines) {
        const groupMatch = line.match(/^\s*-\s+name:\s*(\S+)/);
        if (groupMatch) {
            flush();
            group = groupMatch[1] as string;
            continue;
        }
        const alertMatch = line.match(/^\s*-\s+alert:\s*(\S+)/);
        if (alertMatch) {
            flush();
            current = { alert: alertMatch[1] as string, exprLines: [] };
            continue;
        }
        if (!current) continue;

        const exprMatch = line.match(/^(\s*)expr:\s*(.*)$/);
        if (exprMatch) {
            exprIndent = (exprMatch[1] as string).length;
            const inline = (exprMatch[2] as string).trim();
            // `>-` / `|` open a folded block; anything else is an inline scalar.
            if (inline && !/^[>|][-+]?$/.test(inline)) {
                current.exprLines.push(inline);
                exprIndent = -1;
            }
            continue;
        }
        if (exprIndent >= 0) {
            const indent = line.length - line.trimStart().length;
            if (line.trim() === "") continue;
            if (indent > exprIndent) {
                current.exprLines.push(line.trim());
                continue;
            }
            exprIndent = -1;
        }
    }
    flush();
    return rules.filter((r) => r.expr.length > 0);
}
