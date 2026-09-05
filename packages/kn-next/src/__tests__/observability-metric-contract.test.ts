/**
 * observability-metric-contract.test.ts (#792, sprint task D13 + D14)
 *
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE.
 *
 * A PromQL query naming a series nobody emits does not error. It returns an
 * empty vector: the panel is blank, `for:` is never satisfied, the alert never
 * fires. Nothing is red anywhere. #792 lived for five weeks that way in
 * scale-zero-pg; after ADR-0048 moved the runtime to a compiled single
 * executable, the same drift went repo-wide — every `knext.app` alert and every
 * app dashboard queried `kn_next_*` / `knext_*` names while the binary emitted
 * four `knext_bunexec_*` series, with ZERO overlap.
 *
 * So the two sides are compared mechanically, and the emitted side is SCANNED
 * from the emitters' own source (metric-contract.ts) rather than enumerated
 * here. Renaming an emitted metric moves the set and reds every query that
 * still names the old one — which is the mutation proof for this whole file.
 *
 * The classification below is an ALLOWLIST that FAILS CLOSED: every rule group
 * and every dashboard must be classified, so a new one reds this test until
 * someone decides which emitters it is allowed to depend on. That matters more
 * than it looks — `bunexec` is the ONLY emitter the shipped PodMonitor
 * scrapes, so classifying something `node-legacy` is a statement that it is
 * blank on a default knext deployment, and it has to be made deliberately.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    dashboardExprs,
    docTokenResolves,
    expandFamily,
    extractDocMetricTokens,
    extractMetricNames,
    fencedDocSection,
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
const DASHBOARD_DIR = join(OPERATOR, "config", "grafana", "dashboards");
const RULE_FILE = join(
    OPERATOR,
    "config",
    "observability",
    "prometheusrule.yaml",
);

/** The canonical bun-exec runtime contract — what `kn-next create` emits. */
const BUNEXEC_TEMPLATE = join(
    PKG_ROOT,
    "templates",
    "app",
    "runtime-contract.mjs.hbs",
);

/**
 * Every shipped copy of the runtime contract. The two `.hbs` trees are pinned
 * byte-identical by create-scaffold-parity.test.ts, but the three checked-in
 * `.mjs` copies are NOT — and `examples/bun-exec`'s copy is the one the
 * container e2e actually boots (the "reality binding"). A metric added to the
 * template and forgotten in the example would leave the gate green while the
 * binary under test emitted the old set, so every copy is compared here.
 */
const CONTRACT_COPIES = [
    BUNEXEC_TEMPLATE,
    join(REPO_ROOT, "turbo/generators/templates/zone/runtime-contract.mjs.hbs"),
    join(REPO_ROOT, "examples/bun-exec/runtime-contract.mjs"),
    join(REPO_ROOT, "apps/file-manager/runtime-contract.mjs"),
    join(REPO_ROOT, "apps/docs/runtime-contract.mjs"),
];

const read = (p: string) => readFileSync(p, "utf8");

// ── The emitted side ────────────────────────────────────────────────────────

/** The compiled single executable's :9464 exposition (the scraped emitter). */
const BUNEXEC = seriesNames(scanBunexecMetrics(read(BUNEXEC_TEMPLATE)));

/** The Go controller's own /metrics. */
const OPERATOR_EMITTED = seriesNames(
    scanOperatorMetrics(read(join(OPERATOR, "internal/controller/metrics.go"))),
);

/**
 * prom-client registries reachable only through an app-level `/api/metrics`
 * route. Real series; NOT on the shipped :9464 scrape path since ADR-0048.
 *
 * metrics.ts names its metrics through exported constants, so the scan reads
 * those constants out of the same file — the same source of truth as importing
 * them, without dragging the OpenTelemetry SDK into a source-scanning test.
 * file-manager's registry uses string literals.
 */
const METRICS_TS = read(join(PKG_ROOT, "src", "adapters", "metrics.ts"));
const NODE_LEGACY_TYPES = scanPromClientMetrics(
    METRICS_TS,
    scanNameConstants(METRICS_TS),
);
for (const [name, type] of scanPromClientMetrics(
    read(join(REPO_ROOT, "apps/file-manager/src/app/api/_metrics/registry.ts")),
)) {
    NODE_LEGACY_TYPES.set(name, type);
}
const NODE_LEGACY = seriesNames(NODE_LEGACY_TYPES);

/**
 * Series produced by exporters outside this repo. Nothing here can scan them,
 * so each carries the exporter it comes from — an entry without a reason is a
 * hole, and the shape of this map is asserted below.
 */
const EXTERNAL: Record<string, string> = {
    up: "Prometheus' own per-target scrape-health series.",
    kube_deployment_status_replicas: "kube-state-metrics",
    kube_pod_status_phase: "kube-state-metrics",
    knext_nextapp_condition:
        "kube-state-metrics CustomResourceStateMetrics over NextApp .status.conditions (config/observability/kube-state-metrics-crd-config.yaml)",
    http_server_request_duration_seconds:
        "k6 / OpenTelemetry HTTP semantic conventions, emitted by the load generator — not by the app",
};
const EXTERNAL_SERIES = new Set<string>();
for (const name of Object.keys(EXTERNAL)) {
    for (const s of expandFamily(name, "histogram")) EXTERNAL_SERIES.add(s);
}

const EMITTERS = {
    bunexec: BUNEXEC,
    operator: OPERATOR_EMITTED,
    "node-legacy": NODE_LEGACY,
    external: EXTERNAL_SERIES,
} as const;
type EmitterId = keyof typeof EMITTERS;

function allowed(ids: readonly EmitterId[]): Set<string> {
    const out = new Set<string>();
    for (const id of ids) for (const n of EMITTERS[id]) out.add(n);
    return out;
}

// ── The querying side: classification (ALLOWLIST, FAILS CLOSED) ─────────────

/**
 * Which emitters each alert group may depend on, and why.
 *
 * `knext.app` is deliberately restricted to `bunexec` + `external`: it is the
 * turnkey app-alert group, it ships to every user, and it must therefore
 * reference only series the shipped PodMonitor actually scrapes. That
 * restriction is the whole point — it is what would have caught this defect.
 */
const RULE_GROUPS: Record<
    string,
    { emitters: readonly EmitterId[]; why: string }
> = {
    "knext.operator": {
        emitters: ["operator"],
        why: "the Go controller's own registry",
    },
    "knext.nextapp": {
        emitters: ["external"],
        why: "kube-state-metrics over the NextApp CR's conditions",
    },
    "knext.app.staleness": {
        emitters: ["bunexec", "external"],
        why: "the meta-alerts: `up` plus the bun-exec series whose absence they detect",
    },
    "knext.app": {
        emitters: ["bunexec", "external"],
        why: "turnkey app alerts — MUST reference only what the shipped :9464 PodMonitor scrapes",
    },
    "knext.app.node-legacy": {
        emitters: ["node-legacy", "external"],
        why: "opt-in: applies only to apps that still serve a prom-client /api/metrics route and scrape it themselves",
    },
};

/**
 * Which emitters each dashboard may depend on, and why. Same fail-closed rule:
 * a new dashboard file reds this test until it is classified.
 */
const DASHBOARDS: Record<
    string,
    { emitters: readonly EmitterId[]; why: string }
> = {
    "red-overview.json": {
        emitters: ["bunexec"],
        why: "RED golden signals straight off the scraped :9464 endpoint",
    },
    "scale-to-zero.json": {
        emitters: ["bunexec", "external", "node-legacy"],
        why: "cold start + replicas are bunexec/KSM; the DB-wake panels are node-legacy (scale-zero-pg wake instrumentation is registered by the app, not by the runtime contract)",
    },
    "loadtesting.json": {
        emitters: ["bunexec", "external"],
        why: "k6/OTel series from the load generator, KSM pod phase, plus the runtime's own saturation gauge",
    },
};

// ── Assertions ──────────────────────────────────────────────────────────────

describe("emitted-metric scanners", () => {
    it("scans the bun-exec runtime contract's exposition", () => {
        expect(BUNEXEC.size).toBeGreaterThan(0);
        expect(BUNEXEC).toContain("knext_bunexec_http_requests_total");
    });

    it("scans the operator's Go registry", () => {
        expect(OPERATOR_EMITTED).toContain(
            "knext_nextapp_reconcile_errors_total",
        );
        // a histogram must contribute its derived series
        expect(OPERATOR_EMITTED).toContain(
            "knext_nextapp_reconcile_duration_seconds_bucket",
        );
    });

    it("scans the node-legacy prom-client registries", () => {
        expect(NODE_LEGACY).toContain(
            "kn_next_startup_duration_seconds_bucket",
        );
        expect(NODE_LEGACY).toContain("knext_deep_health_state");
    });

    it("gives every external series a named exporter", () => {
        for (const [name, why] of Object.entries(EXTERNAL)) {
            expect(
                why.length,
                `${name} has no exporter reason`,
            ).toBeGreaterThan(10);
        }
    });
});

describe("the shipped runtime emits an SLO-computable RED contract (#792 / D14)", () => {
    const families = scanBunexecMetrics(read(BUNEXEC_TEMPLATE));

    it("labels the request counter by status_class so an error rate is computable", () => {
        const body = read(BUNEXEC_TEMPLATE);
        expect(families.get("knext_bunexec_http_requests_total")).toBe(
            "counter",
        );
        // The label must be EMITTED, not merely mentioned: assert a rendered
        // sample line carrying it.
        expect(body).toMatch(
            /knext_bunexec_http_requests_total\{status_class="/,
        );
    });

    it("bounds status_class cardinality to the five HTTP classes", () => {
        const body = read(BUNEXEC_TEMPLATE);
        const classes = [
            ...new Set(
                [...body.matchAll(/'([1-5]xx)'/g)].map((m) => m[1] as string),
            ),
        ];
        expect(classes.sort()).toEqual(["1xx", "2xx", "3xx", "4xx", "5xx"]);
        // No per-path/per-route label may appear on the counter — an unbounded
        // path label is the classic way a scale-to-zero fleet's TSDB explodes.
        expect(body).not.toMatch(
            /knext_bunexec_http_requests_total\{[^}]*\b(route|path|url|method)=/,
        );
    });

    /** The bucket boundaries a contract copy declares, in source order. */
    const bucketsOf = (path: string): number[] =>
        (
            read(path).match(
                /REQUEST_DURATION_BUCKETS\s*=\s*\[([^\]]*)\]/,
            )?.[1] ?? ""
        )
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map(Number);

    it("emits a duration histogram with sub-100ms resolution", () => {
        expect(
            families.get("knext_bunexec_http_request_duration_seconds"),
        ).toBe("histogram");
        const buckets = bucketsOf(BUNEXEC_TEMPLATE);
        expect(buckets.length).toBeGreaterThan(0);
        // Cold starts are measured in tens of ms; a histogram whose finest
        // bucket is 100ms cannot see them.
        expect(buckets.filter((b) => b < 0.1).length).toBeGreaterThanOrEqual(4);
        expect(buckets).toEqual([...buckets].sort((a, b) => a - b));
        // Bounded: buckets are the dominant series multiplier.
        expect(buckets.length).toBeLessThanOrEqual(16);
    });

    it("every copy declares the SAME bucket boundaries, not just the same series", () => {
        // FOUND BY MUTATION (#908's prover, sprint 2 lane G). The drift check
        // below compares series NAMES, and a histogram's names are
        // `_bucket`/`_sum`/`_count` — which do not change when the boundaries
        // do. So `examples/bun-exec`'s copy could declare [0.5, 1, 2, 5] while
        // the template declared sub-100ms resolution, and every assertion in
        // this file would stay green.
        //
        // That copy is the one the container e2e BOOTS. The consequence is not
        // cosmetic: a `le="0.05"` bucket that exists in the template and not in
        // the artifact under test makes the cold-start SLO uncomputable from the
        // only binary anyone measures, while the metric keeps reporting.
        const canonical = bucketsOf(BUNEXEC_TEMPLATE);
        expect(
            canonical.length,
            "the template declares no buckets — the comparison below would be vacuous",
        ).toBeGreaterThan(0);
        for (const copy of CONTRACT_COPIES) {
            expect(
                bucketsOf(copy),
                `${copy} declares different histogram buckets from the template`,
            ).toEqual(canonical);
        }
    });

    it("emits a startup duration so the cold-start SLO is computable", () => {
        expect(families.has("knext_bunexec_startup_duration_seconds")).toBe(
            true,
        );
    });

    it("keeps every checked-in copy of the contract on the same metric set", () => {
        const canonical = [...BUNEXEC].sort();
        for (const copy of CONTRACT_COPIES) {
            const set = [...seriesNames(scanBunexecMetrics(read(copy)))].sort();
            expect(
                set,
                `${copy} drifted from the template's metric set`,
            ).toEqual(canonical);
        }
    });
});

describe("every alert queries a series something actually emits (#792)", () => {
    const yaml = read(RULE_FILE);
    const rules = parsePrometheusRules(yaml);

    it("parses every alert in the manifest (parser fails closed)", () => {
        const declared = (yaml.match(/^\s*-\s+alert:/gm) ?? []).length;
        expect(rules.length).toBe(declared);
        expect(rules.length).toBeGreaterThan(0);
        for (const r of rules) expect(r.expr.length).toBeGreaterThan(0);
    });

    it("classifies every rule group (fails closed on a new one)", () => {
        const groups = [...new Set(rules.map((r) => r.group))].sort();
        for (const g of groups) {
            expect(
                RULE_GROUPS[g],
                `rule group "${g}" is unclassified — declare which emitters it may depend on`,
            ).toBeDefined();
        }
    });

    it("resolves every metric name in every alert expression", () => {
        const dangling: string[] = [];
        for (const rule of rules) {
            const spec = RULE_GROUPS[rule.group];
            if (!spec) continue; // reported by the test above
            const ok = allowed(spec.emitters);
            for (const name of extractMetricNames(rule.expr)) {
                if (!ok.has(name)) {
                    dangling.push(
                        `${rule.group}/${rule.alert}: "${name}" is emitted by no ${spec.emitters.join("+")} emitter`,
                    );
                }
            }
        }
        expect(dangling.join("\n")).toBe("");
    });

    it("alerts on its own blindness — a scraped app with no knext series", () => {
        // D13: the guard goes in BEFORE the thing it guards. Without this, the
        // next name drift is silent all over again.
        const staleness = rules.filter(
            (r) => r.group === "knext.app.staleness",
        );
        expect(staleness.length).toBeGreaterThanOrEqual(2);
        const exprs = staleness.map((r) => r.expr).join(" ");
        // up == 0 catches a target that is discovered but unscrapeable.
        expect(exprs).toMatch(/\bup\{[^}]*\}\s*==\s*0/);
        // `unless` against the core runtime series catches the #792 shape:
        // the scrape SUCCEEDS and returns nothing we recognise.
        expect(exprs).toMatch(/unless/);
        expect(exprs).toContain("knext_bunexec_process_uptime_seconds");
    });
});

describe("every dashboard panel queries a series something emits (#792)", () => {
    const files = readdirSync(DASHBOARD_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();

    it("classifies every shipped dashboard (fails closed on a new one)", () => {
        for (const f of files) {
            expect(
                DASHBOARDS[f],
                `dashboard "${f}" is unclassified — declare which emitters it may depend on`,
            ).toBeDefined();
        }
        // And the reverse: a classification with no file is stale.
        expect(Object.keys(DASHBOARDS).sort()).toEqual(files);
    });

    it.each(files)("%s resolves every metric name", (file) => {
        const spec = DASHBOARDS[file];
        expect(spec, `${file} unclassified`).toBeDefined();
        const ok = allowed(
            (spec as { emitters: readonly EmitterId[] }).emitters,
        );
        const model = JSON.parse(read(join(DASHBOARD_DIR, file)));
        const dangling: string[] = [];
        for (const expr of dashboardExprs(model)) {
            for (const name of extractMetricNames(expr)) {
                if (!ok.has(name)) dangling.push(`"${name}" in: ${expr}`);
            }
        }
        expect(dangling.join("\n")).toBe("");
    });
});

describe("extractor guards (fail-first)", () => {
    it("flags a made-up series", () => {
        expect(
            extractMetricNames("sum(rate(knext_totally_made_up_total[5m]))"),
        ).toEqual(["knext_totally_made_up_total"]);
    });

    it("does not mistake label matchers or functions for metrics", () => {
        expect(
            extractMetricNames(
                'histogram_quantile(0.95, sum by (le, app) (rate(knext_x_seconds_bucket{app=~"$app", status_class="5xx"}[$__rate_interval])))',
            ),
        ).toEqual(["knext_x_seconds_bucket"]);
    });

    it("expands a histogram family into its derived series", () => {
        expect(expandFamily("k_seconds", "histogram")).toEqual([
            "k_seconds",
            "k_seconds_bucket",
            "k_seconds_sum",
            "k_seconds_count",
        ]);
        expect(expandFamily("k_total", "counter")).toEqual(["k_total"]);
    });

    it("parses inline and folded-block alert expressions alike", () => {
        const parsed = parsePrometheusRules(
            [
                "spec:",
                "  groups:",
                "    - name: g1",
                "      rules:",
                "        - alert: Inline",
                "          expr: up == 0",
                "          for: 5m",
                "        - alert: Folded",
                "          expr: >-",
                "            sum(rate(a_total[5m]))",
                "              > 1",
                "          for: 5m",
            ].join("\n"),
        );
        expect(parsed).toEqual([
            { group: "g1", alert: "Inline", expr: "up == 0" },
            {
                group: "g1",
                alert: "Folded",
                expr: "sum(rate(a_total[5m])) > 1",
            },
        ]);
    });
});

// ── The DOCS side (S5): prose is the third consumer of the contract ─────────

/**
 * #792 closed alerts-vs-emitters and dashboards-vs-emitters. The docs were
 * swept BY HAND, which is the mechanism that fails silently: renaming an
 * emitted metric moves the set, every alert and panel reds — and every prose
 * reference to the old name keeps reading perfectly correct. One of these files
 * is PUBLISHED and user-facing.
 *
 * So the same scan runs over the docs. Discovered by walking the tracked tree,
 * never enumerated: a new doc naming a metric is covered the day it lands,
 * which an enumerated list is exactly how to miss.
 *
 * SCOPE IS EVERY TRACKED `.md`/`.mdx`, deliberately. The first version of this
 * scanned `docs/ + apps/docs/content/ + README.md`, which SOUNDS exhaustive and
 * is not: it missed `apps/file-manager/README.md` (`knext_coldstart_*`) and
 * `apps/file-manager/docs/bytecode-cache-reuse-runbook.md`
 * (`kn_next_bytecode_cache_files_total`). A directory allowlist is the same
 * enumeration failure as a file list, one level up — so there is no allowlist.
 * Measured when widening: 291 tracked docs, 60 tokens (up from 22), all resolve.
 */
const DOC_FILES = execFileSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
})
    .split("\n")
    .filter((f) => /\.mdx?$/.test(f));

const ALL_EMITTED = allowed(["bunexec", "operator", "node-legacy", "external"]);

describe("every metric a DOC names is one something emits (S5)", () => {
    it("finds doc files at all — a vacuous scan would pass everything", () => {
        expect(DOC_FILES.length).toBeGreaterThan(50);
        expect(DOC_FILES).toContain("apps/docs/content/docs/observability.mdx");
        expect(DOC_FILES).toContain("docs/observability/metrics.md");
        expect(DOC_FILES).toContain("docs/security/threat-model.md");
        // The two the directory-scoped version missed. Asserted by name because
        // they are the evidence that the scope had to widen — not because the
        // scan needs a list.
        expect(DOC_FILES).toContain("apps/file-manager/README.md");
        expect(DOC_FILES).toContain(
            "apps/file-manager/docs/bytecode-cache-reuse-runbook.md",
        );
    });

    it("resolves every backticked knext metric name in every doc", () => {
        const dead: string[] = [];
        let checked = 0;
        for (const file of DOC_FILES) {
            for (const token of extractDocMetricTokens(
                read(join(REPO_ROOT, file)),
            )) {
                checked += 1;
                if (!docTokenResolves(token, ALL_EMITTED)) {
                    dead.push(`${file}: ${token}`);
                }
            }
        }
        // The floor is the anti-vacuity half: an extractor that silently stopped
        // matching would otherwise report zero dead names and pass. Raised from
        // 20 to 50 when the scope widened — 60 tokens measured, so a floor of 20
        // would no longer notice the scan losing two thirds of its subjects.
        expect(checked).toBeGreaterThan(50);
        expect(
            dead,
            "these docs name metrics NOTHING emits — a rename landed without the prose:\n" +
                dead.join("\n"),
        ).toEqual([]);
    });
});

/**
 * The security-relevant half. `docs/security/threat-model.md` enumerates what a
 * cross-namespace scraper can read off `:9464`, and since ADR-0048 the compiled
 * binary — not the retired node supervisor — is what serves that port. A section
 * that lists node-legacy series as `:9464` disclosure OVERSTATES the exposure,
 * which the document itself says erodes it as surely as understating one.
 *
 * So the fenced section may name ONLY series the bun-exec runtime emits, and a
 * missing fence is a failure, never a skip.
 */
describe("the threat model's :9464 disclosure list is the bunexec set (S5)", () => {
    const THREAT_MODEL = read(join(REPO_ROOT, "docs/security/threat-model.md"));

    it("the fenced section exists — a reflow cannot silently unhook the check", () => {
        expect(
            fencedDocSection(THREAT_MODEL, "9091-disclosure"),
            "the <!-- metric-contract:9091-disclosure --> fence is gone from the threat model",
        ).not.toBeNull();
    });

    it("a MISSING fence reads as null, never as an empty section", () => {
        // The other half, and the one that matters: `""` is not `null`, so a
        // reader that degraded to an empty string would satisfy the case above
        // while every assertion below silently ran over nothing. Caught by the
        // prover — this case did not exist and the mutation survived.
        expect(
            fencedDocSection("no fence anywhere in here", "9091-disclosure"),
        ).toBeNull();
        // Half a fence is worse than none: it looks deliberate.
        expect(
            fencedDocSection(
                "<!-- metric-contract:9091-disclosure start -->\nbut never closed",
                "9091-disclosure",
            ),
        ).toBeNull();
        // ...and the real document must not answer for a DIFFERENT id.
        expect(
            fencedDocSection(THREAT_MODEL, "not-a-real-fence-id"),
        ).toBeNull();
    });

    it("names only series the compiled binary actually emits on :9464", () => {
        const section = fencedDocSection(THREAT_MODEL, "9091-disclosure");
        const tokens = extractDocMetricTokens(section ?? "");
        expect(
            tokens.length,
            "the fenced section names no metrics at all",
        ).toBeGreaterThan(1);
        const notOnPort = tokens.filter((t) => !docTokenResolves(t, BUNEXEC));
        expect(
            notOnPort,
            "the threat model claims :9464 discloses series the bun-exec runtime does not emit:\n" +
                notOnPort.join("\n"),
        ).toEqual([]);
    });

    /**
     * THE OTHER DIRECTION, which the subset check above cannot give.
     *
     * "documented ⊆ emitted" catches the section OVERSTATING the exposure — the
     * defect that was actually there. It says nothing about UNDERSTATING it, and
     * the section makes a closed claim: "**Six series, and no more.**" A new
     * series added to the runtime contract satisfies every assertion above while
     * silently falsifying that sentence, in a security document, on the exact
     * axis it is read for.
     *
     * So: emitted ⊆ documented as well. Adding a `:9464` series now reds until
     * the disclosure list is updated — which is the review this repo wants to
     * force, since a new series on that port IS new cross-tenant disclosure.
     *
     * Compared on FAMILY names, not series names: Prometheus derives
     * `_bucket`/`_sum`/`_count` from a histogram, and a threat model listing
     * those separately would be noise rather than precision.
     */
    it("documents EVERY series :9464 emits — the 'and no more' claim is closed", () => {
        const section = fencedDocSection(THREAT_MODEL, "9091-disclosure") ?? "";
        const documented = new Set(extractDocMetricTokens(section));
        const emittedFamilies = [
            ...scanBunexecMetrics(read(BUNEXEC_TEMPLATE)).keys(),
        ].sort();

        expect(
            emittedFamilies.length,
            "the bunexec scan found no families — this check would pass vacuously",
        ).toBeGreaterThan(1);

        const undocumented = emittedFamilies.filter((family) => {
            if (documented.has(family)) return false;
            // A `prefix_*` glob in the prose legitimately covers the family.
            for (const token of documented) {
                if (
                    token.endsWith("*") &&
                    family.startsWith(token.slice(0, -1))
                ) {
                    return false;
                }
            }
            return true;
        });

        expect(
            undocumented,
            "the threat model says :9464 exposes these series 'and no more', but the runtime now " +
                "emits others. A NEW series on that port is new cross-tenant disclosure and has to " +
                "be reviewed, not silently shipped:\n" +
                undocumented.join("\n"),
        ).toEqual([]);
    });
});
