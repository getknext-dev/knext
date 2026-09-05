/**
 * metrics-port-lockstep — observability guard (#153 system-design review gap,
 * widened for #951).
 *
 * The app's metrics port is a PLATFORM CONTRACT with more than two parties:
 *
 *   1. the node runtime default        node-server.ts        `METRICS_PORT ?? <N>`
 *   2. the compiled-entry default      templates/app/knext-bun-entry.mjs.hbs
 *                                      (the canonical template; every checked-in
 *                                      copy is pinned to it byte-for-byte by
 *                                      scripts/lib/runtime-entry-copies.mjs)
 *   3. the operator scrape annotation  nextapp_controller.go `prometheus.io/port`
 *   4. the operator NetworkPolicy      nextapp_controller.go `appMetricsPort`
 *      (the metrics-scrape grants — same-namespace and the label-gated
 *      cross-namespace rule)
 *   5. the shipped PodMonitor          config/prometheus/app-podmonitor.yaml
 *
 * In production the operator does NOT inject a METRICS_PORT env, so the runtime
 * defaults and the operator's three port literals MUST be the same number. If
 * someone changes one without the others, Prometheus scrapes the wrong port, or
 * the NetworkPolicy blocks the scrape, and app metrics go dark silently.
 * This is AC2 of #951: annotation, NetworkPolicy grant, and entry bind port
 * cannot silently disagree.
 *
 * #951 adds a second invariant: the shared port must NOT be a port Knative's
 * queue-proxy sidecar owns inside the same pod network namespace. knext's old
 * default 9091 was literally Knative's UserQueueMetricsPort — the port
 * queue-proxy itself binds for its user-metrics server whenever serving's
 * `metrics.request-metrics-backend-destination` is active, which is the stock
 * install default. App and sidecar raced for the port, the app lost with
 * EADDRINUSE, and every scaffolded app crash-looped on a default Knative
 * cluster (S3-V Finding C-2). The default is now 9464 (the conventional
 * OpenTelemetry Prometheus-exporter port, unclaimed by queue-proxy).
 *
 * This is a pure cross-file guard: it reads the source files as text, extracts
 * each number, and asserts they are equal and non-colliding. It changes no
 * file. If any value cannot be located the test FAILS loudly (rather than
 * soft-skipping) so the guard can never silently no-op after a refactor.
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
const ENTRY_TEMPLATE_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next",
    "templates",
    "app",
    "knext-bun-entry.mjs.hbs",
);
const OPERATOR_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next-operator",
    "internal",
    "controller",
    "nextapp_controller.go",
);
const PODMONITOR_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next-operator",
    "config",
    "prometheus",
    "app-podmonitor.yaml",
);

/**
 * Ports Knative serving's queue-proxy sidecar (or its data path) owns on every
 * revision pod, so the app's metrics listener must never default to any of
 * them (#951):
 *   8012 queue-proxy HTTP1, 8013 h2c, 8112 HTTPS, 8022 admin/drain,
 *   9090 autoscaling metrics, 9091 user metrics (bound whenever
 *   `metrics.request-metrics-backend-destination` is active — the stock
 *   config-observability default; the S3-V C-2 crash-loop).
 */
const QUEUE_PROXY_OWNED_PORTS = new Set([8012, 8013, 8022, 8112, 9090, 9091]);

/**
 * Runtime default: `process.env.METRICS_PORT ?? <N>`.
 * Tolerant of whitespace and numeric separators (e.g. 9_464).
 */
function extractMetricsPortDefault(src: string, file: string): number {
    const m = src.match(/process\.env\.METRICS_PORT\s*\?\?\s*([0-9][0-9_]*)/);
    if (!m) {
        throw new Error(
            `Could not find the METRICS_PORT default (process.env.METRICS_PORT ?? <N>) ` +
                `in ${file}. The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    return Number(m[1].replace(/_/g, ""));
}

/**
 * Operator scrape target: the Go assignment of the `prometheus.io/port` annotation
 * to a quoted numeric string, e.g.  annotations["prometheus.io/port"] = "9464".
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

/**
 * Operator NetworkPolicy grant: the `appMetricsPort` literal that feeds every
 * metrics-scrape ingress rule. Two accepted spellings:
 *   appMetricsPort = int32(9464)                                 (a literal)
 *   appMetricsPort = int32(knativenetworking.UserQueueMetricsPort) (the OLD,
 *     colliding alias — resolved to 9091 so the collision assertion below
 *     reports the REAL defect instead of an extraction failure)
 */
function extractNetworkPolicyMetricsPort(src: string): number {
    const literal = src.match(/appMetricsPort\s*=\s*int32\(([0-9][0-9_]*)\)/);
    if (literal) return Number(literal[1].replace(/_/g, ""));
    const alias = src.match(
        /appMetricsPort\s*=\s*int32\(knativenetworking\.UserQueueMetricsPort\)/,
    );
    if (alias) return 9091;
    throw new Error(
        `Could not find the appMetricsPort assignment (appMetricsPort = int32(<N>)) ` +
            `in ${OPERATOR_FILE}. The lockstep guard cannot run — fix the regex or the source.`,
    );
}

/** Shipped PodMonitor endpoint: `targetPort: <N>`. */
function extractPodMonitorTargetPort(src: string): number {
    const m = src.match(/targetPort:\s*([0-9]+)/);
    if (!m) {
        throw new Error(
            `Could not find the PodMonitor targetPort (targetPort: <N>) in ${PODMONITOR_FILE}. ` +
                `The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    return Number(m[1]);
}

function allSurfaces(): Record<string, number> {
    return {
        "node-server.ts METRICS_PORT default": extractMetricsPortDefault(
            readFileSync(RUNTIME_FILE, "utf8"),
            RUNTIME_FILE,
        ),
        "knext-bun-entry.mjs.hbs METRICS_PORT default":
            extractMetricsPortDefault(
                readFileSync(ENTRY_TEMPLATE_FILE, "utf8"),
                ENTRY_TEMPLATE_FILE,
            ),
        "operator prometheus.io/port annotation": extractOperatorScrapePort(
            readFileSync(OPERATOR_FILE, "utf8"),
        ),
        "operator NetworkPolicy appMetricsPort":
            extractNetworkPolicyMetricsPort(
                readFileSync(OPERATOR_FILE, "utf8"),
            ),
        "PodMonitor targetPort": extractPodMonitorTargetPort(
            readFileSync(PODMONITOR_FILE, "utf8"),
        ),
    };
}

describe("metrics-port lockstep (runtime defaults ↔ operator annotation ↔ NetworkPolicy ↔ PodMonitor)", () => {
    it("locates every value (fails loudly rather than silently no-op'ing)", () => {
        for (const [surface, port] of Object.entries(allSurfaces())) {
            expect(
                Number.isInteger(port),
                `${surface} did not parse to an integer`,
            ).toBe(true);
            expect(
                port,
                `${surface} parsed to a non-positive port`,
            ).toBeGreaterThan(0);
        }
    });

    it("every surface agrees on ONE metrics port (#951 AC2)", () => {
        const surfaces = allSurfaces();
        const ports = new Set(Object.values(surfaces));
        expect(
            ports.size,
            `Metrics-port drift across the platform contract — these must all be the same ` +
                `number or scraping/NetworkPolicy/the entry bind silently disagree:\n` +
                Object.entries(surfaces)
                    .map(([k, v]) => `  ${v}  ${k}`)
                    .join("\n"),
        ).toBe(1);
    });

    it("the shared port is NOT a queue-proxy-owned port (#951 — EADDRINUSE crash-loop on stock Knative)", () => {
        const surfaces = allSurfaces();
        for (const [surface, port] of Object.entries(surfaces)) {
            expect(
                QUEUE_PROXY_OWNED_PORTS.has(port),
                `${surface} is ${port}, which Knative's queue-proxy owns inside the pod. ` +
                    `On a stock serving install (default config-observability) queue-proxy binds ` +
                    `:9091 for its user-metrics server, the app loses the race, exits EADDRINUSE, ` +
                    `and the revision crash-loops (issue #951, S3-V Finding C-2). Pick a port ` +
                    `outside {8012, 8013, 8022, 8112, 9090, 9091}.`,
            ).toBe(false);
        }
    });

    // Self-test of the extraction logic so the guard can't drift into a no-op:
    // proves a hypothetical divergence WOULD be caught.
    it("self-test: detects a divergence in any extracted value", () => {
        expect(
            extractMetricsPortDefault(
                "const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9464);",
                "inline",
            ),
        ).toBe(9464);
        expect(
            extractOperatorScrapePort(
                'annotations["prometheus.io/port"] = "9464"',
            ),
        ).toBe(9464);
        expect(
            extractNetworkPolicyMetricsPort(
                "appMetricsPort        = int32(9464)",
            ),
        ).toBe(9464);
        // The OLD colliding alias resolves to 9091 so the collision assertion
        // fires on it instead of the extractor throwing.
        expect(
            extractNetworkPolicyMetricsPort(
                "appMetricsPort        = int32(knativenetworking.UserQueueMetricsPort)",
            ),
        ).toBe(9091);
        expect(extractPodMonitorTargetPort("    - targetPort: 9464")).toBe(
            9464,
        );
        // A drifted operator value would surface as 9464 !== 9099 above.
        const drifted = extractOperatorScrapePort(
            'annotations["prometheus.io/port"] = "9099"',
        );
        expect(drifted).not.toBe(9464);
    });
});
