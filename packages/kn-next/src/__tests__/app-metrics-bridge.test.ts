/**
 * app-metrics-bridge.test.ts — the deep-health gauge reaches :9464.
 *
 * THE DEFECT. `knext_deep_health_state` is registered by the APP (instrumentation)
 * into a prom-client registry that serves on a loopback child port (9092). The
 * shipped PodMonitor scrapes :9464 only, and the default runtimes (the node and
 * bun vinext entries, which share `runtime-contract.mjs`) render :9464 from
 * their own dependency-free exposition with no bridge. So the series existed in
 * the process and on no port anything scrapes, and the alerts keyed on it
 * (`KnextDeepHealthStuckWaking`, `KnextDeepHealthDown`) could never fire.
 *
 * THE FIX UNDER TEST. The contract's `renderScrape` appends the child's
 * `knext_deep_health_state` family — and ONLY that family. The allowlist is the
 * security half: ADR-0044 gave cross-namespace scrapers a grant on :9464 and
 * the threat model lists the exposed series as a closed set, so a bridge that
 * forwarded the whole child registry (which also carries `knext_http_*` with a
 * `method` label) would widen disclosure silently.
 *
 * Behavioural, against every importable copy of the contract (the scaffolder
 * templates and the checked-in apps), plus a scan that both entries actually
 * call the bridge — a bridge nobody calls is the same defect with more code.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");

/** Every copy of the contract. `.hbs` has no template syntax and loads as `.mjs`. */
const COPIES = [
    "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
    "turbo/generators/templates/zone/runtime-contract.mjs.hbs",
    "apps/file-manager/runtime-contract.mjs",
    "apps/docs/runtime-contract.mjs",
    "examples/bun-exec/runtime-contract.mjs",
];

const ENTRIES = [
    "packages/kn-next/templates/app/knext-bun-entry.mjs.hbs",
    "turbo/generators/templates/zone/knext-bun-entry.mjs.hbs",
    "apps/file-manager/knext-bun-entry.mjs",
    "apps/docs/knext-bun-entry.mjs",
    "examples/bun-exec/knext-bun-entry.mjs",
];

const tmpDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers
            .splice(0)
            .map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    for (const d of tmpDirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: dynamic ESM import of an untyped .mjs
type Contract = Record<string, any>;

async function load(rel: string): Promise<Contract> {
    const src = join(REPO_ROOT, rel);
    let target = src;
    if (!src.endsWith(".mjs")) {
        const dir = mkdtempSync(join(tmpdir(), "knext-bridge-"));
        tmpDirs.push(dir);
        target = join(dir, "runtime-contract.mjs");
        copyFileSync(src, target);
    }
    return import(`${pathToFileURL(target).href}?t=${Math.random()}`);
}

const DEEP_HEALTH = [
    "# HELP knext_deep_health_state Deep health state",
    "# TYPE knext_deep_health_state gauge",
    'knext_deep_health_state{app="a",dependency="overall",state="down"} 1',
    'knext_deep_health_state{app="a",dependency="overall",state="ok"} 0',
    "",
].join("\n");

/** Everything ELSE a real child registry carries — must never cross the bridge. */
const OTHER_FAMILIES = [
    "# HELP knext_http_requests_total Requests",
    "# TYPE knext_http_requests_total counter",
    'knext_http_requests_total{app="a",method="GET",status_class="2xx"} 7',
    "# HELP knext_deep_health_state_extra A lookalike family name",
    "# TYPE knext_deep_health_state_extra gauge",
    "knext_deep_health_state_extra 1",
    "",
].join("\n");

async function fakeChild(
    handler: (url: string) => { status: number; body: string },
): Promise<number> {
    const server = createServer((req, res) => {
        const { status, body } = handler(req.url ?? "/");
        res.writeHead(status).end(body);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
}

describe.each(COPIES)("runtime contract bridge: %s", (copy) => {
    it("appends knext_deep_health_state from the child registry to the :9464 body", async () => {
        const c = await load(copy);
        const port = await fakeChild(() => ({
            status: 200,
            body: DEEP_HEALTH,
        }));
        const state = c.createMetricsState();
        const body: string = await c.renderScrape(state, {
            KN_CHILD_METRICS_PORT: String(port),
        });
        expect(body).toContain("knext_bunexec_process_uptime_seconds");
        expect(body).toContain(
            'knext_deep_health_state{app="a",dependency="overall",state="down"} 1',
        );
        expect(body).toContain("# TYPE knext_deep_health_state gauge");
    });

    it("forwards ONLY the allowlisted family — never the rest of the child registry", async () => {
        const c = await load(copy);
        const port = await fakeChild(() => ({
            status: 200,
            body: DEEP_HEALTH + OTHER_FAMILIES,
        }));
        const body: string = await c.renderScrape(c.createMetricsState(), {
            KN_CHILD_METRICS_PORT: String(port),
        });
        expect(body).toContain("knext_deep_health_state{");
        expect(body).not.toContain("knext_http_requests_total");
        expect(body).not.toContain("knext_deep_health_state_extra");
    });

    it("serves the base exposition unchanged when the child is not there (refused)", async () => {
        const c = await load(copy);
        // Port 1 is never listening; the connection is refused at once.
        const state = c.createMetricsState();
        const body: string = await c.renderScrape(state, {
            KN_CHILD_METRICS_PORT: "1",
        });
        expect(body).toContain("knext_bunexec_process_uptime_seconds");
        expect(body).not.toContain("knext_deep_health_state");
    });

    it("serves the base exposition when the child answers non-200 or hangs", async () => {
        const c = await load(copy);
        const bad = await fakeChild(() => ({ status: 500, body: DEEP_HEALTH }));
        const b1: string = await c.renderScrape(c.createMetricsState(), {
            KN_CHILD_METRICS_PORT: String(bad),
        });
        expect(b1).not.toContain("knext_deep_health_state");

        const hang = createServer(() => {
            /* never answers */
        });
        servers.push(hang);
        await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
        const hp = (hang.address() as AddressInfo).port;
        const t0 = Date.now();
        const b2: string = await c.renderScrape(
            c.createMetricsState(),
            { KN_CHILD_METRICS_PORT: String(hp) },
            100,
        );
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(b2).toContain("knext_bunexec_process_uptime_seconds");
        expect(b2).not.toContain("knext_deep_health_state");
        hang.closeAllConnections?.();
    });

    it("defaults to the same child port the app registers on (9092)", async () => {
        const c = await load(copy);
        expect(c.appMetricsPort({})).toBe(9092);
        expect(c.appMetricsPort({ KN_CHILD_METRICS_PORT: "9100" })).toBe(9100);
        // A garbage value must not become NaN and a connect to port NaN.
        expect(c.appMetricsPort({ KN_CHILD_METRICS_PORT: "nope" })).toBe(9092);
    });

    it("the node:http :9464 listener serves the bridged series end to end", async () => {
        const c = await load(copy);
        const child = await fakeChild(() => ({
            status: 200,
            body: DEEP_HEALTH + OTHER_FAMILIES,
        }));
        const saved = process.env.KN_CHILD_METRICS_PORT;
        process.env.KN_CHILD_METRICS_PORT = String(child);
        try {
            const state = c.createMetricsState();
            const metrics = createServer(c.metricsRequestListener(state));
            servers.push(metrics);
            await new Promise<void>((r) => metrics.listen(0, "127.0.0.1", r));
            const port = (metrics.address() as AddressInfo).port;
            const res = await fetch(`http://127.0.0.1:${port}/metrics`);
            expect(res.status).toBe(200);
            const text = await res.text();
            expect(text).toContain("knext_bunexec_process_uptime_seconds");
            expect(text).toContain("knext_deep_health_state{");
            expect(text).not.toContain("knext_http_requests_total");
            const nf = await fetch(`http://127.0.0.1:${port}/other`);
            expect(nf.status).toBe(404);
        } finally {
            if (saved === undefined) delete process.env.KN_CHILD_METRICS_PORT;
            else process.env.KN_CHILD_METRICS_PORT = saved;
        }
    });
});

describe("filterExposition", () => {
    it("keeps HELP/TYPE/samples of the named family and nothing that merely shares a prefix", async () => {
        const c = await load(COPIES[0] as string);
        const out: string = c.filterExposition(DEEP_HEALTH + OTHER_FAMILIES, [
            "knext_deep_health_state",
        ]);
        expect(out).toContain("# HELP knext_deep_health_state ");
        expect(out).toContain("# TYPE knext_deep_health_state gauge");
        expect(out).toContain('state="down"} 1');
        expect(out).not.toContain("_extra");
        expect(out).not.toContain("knext_http");
        expect(c.filterExposition("", ["knext_deep_health_state"])).toBe("");
    });
});

describe("the entries actually call the bridge", () => {
    it.each(
        ENTRIES,
    )("%s renders :9464 through renderScrape, not renderMetrics", (entry) => {
        const src = readFileSync(join(REPO_ROOT, entry), "utf8");
        expect(src, "the metrics listener must serve the bridged body").toMatch(
            /await renderScrape\(metrics\)/,
        );
        expect(src).not.toMatch(/new Response\(renderMetrics\(metrics\)/);
    });

    it("the node entry serves :9464 through metricsRequestListener, which bridges", () => {
        const node = readFileSync(
            join(
                REPO_ROOT,
                "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
            ),
            "utf8",
        );
        expect(node).toContain("metricsRequestListener(metrics)");
        const contract = readFileSync(
            join(REPO_ROOT, COPIES[0] as string),
            "utf8",
        );
        const listener = contract.slice(
            contract.indexOf("export function metricsRequestListener"),
        );
        expect(listener).toMatch(/await renderScrape\(state\)/);
    });
});
