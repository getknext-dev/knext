/**
 * The CDN metrics seam: how the CDN counters reach the app's metrics port.
 *
 * The counters live in the Next server process (the header preload and the
 * cache handler, on `globalThis`). On the standalone path the metrics port is
 * served by a SEPARATE supervisor process, which already merges the server
 * process's loopback metrics listener (the deep-health-lite listener with
 * tracing off, `startChildMetricsServer` with tracing on). So the preload
 * publishes ONE render function on `globalThis` under a namespaced
 * `Symbol.for` key (ADR-0027), and each listener in the server process
 * appends what it renders. The compiled self-contained runtime serves the
 * metrics port in-process and appends it the same way.
 *
 * With CDN mode off the seam is never published and every body is unchanged.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "prom-client";
import { startDeepHealthLite } from "../adapters/deep-health-lite";
import { startChildMetricsServer } from "../adapters/metrics";
import { CDN_ENV, get, type Running, startServer } from "./cdn-test-harness";

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = resolve(here, "../adapters");

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const edge: any = require(join(ADAPTERS, "cdn-edge.cjs"));
/**
 * Requiring the self-contained supervisor runs its preload side effect, which
 * wraps the REAL `http.createServer` and would bind 0.0.0.0:9464 on the first
 * server this test creates. Its own install guard is set for the require, so
 * only its functions load.
 */
function requireSelfContainedInert() {
    // biome-ignore lint/suspicious/noExplicitAny: marking the real node:http module
    const http: any = require("node:http");
    const INSTALLED = Symbol.for("knext.selfContainedSupervisor.installed");
    const was = http[INSTALLED];
    http[INSTALLED] = true;
    try {
        return require(
            join(ADAPTERS, "standalone-self-contained-supervisor.cjs"),
        );
    } finally {
        if (was === undefined) delete http[INSTALLED];
        else http[INSTALLED] = was;
    }
}
// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const selfContained: any = requireSelfContainedInert();

const SEAM = Symbol.for("knext.core.cdn.renderMetrics");
const PURGE_REGISTRY = Symbol.for("knext.core.cdn.metrics");
const g = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
    delete g[SEAM];
    delete g[PURGE_REGISTRY];
    delete g[edge.DECISIONS_KEY];
    delete g[Symbol.for("knext.core.cdn.foreignEdgeStrips")];
});

describe("cdn-edge publishes one render function for every CDN counter", () => {
    it("exports the seam key under the namespaced Symbol.for name", () => {
        expect(edge.CDN_METRICS_SEAM_KEY).toBe(SEAM);
    });

    it("renders the decision counter, the strip counter and the purge counter", async () => {
        edge.countDecision("edge", "allowed");
        edge.countDecision("not_edge", "middleware_matched");
        edge.countForeignEdgeStrip();
        const { defaultMetricsRegistry } = await import(
            "../adapters/cdn-purge/metrics.js"
        );
        defaultMetricsRegistry().inc("knext_cdn_purge_total", {
            provider: "cloudflare",
            result: "ok",
        });
        const text = edge.renderCdnMetrics();
        expect(text).toContain(
            'knext_cdn_edge_decision_total{result="edge",reason="allowed"} 1',
        );
        expect(text).toContain(
            'knext_cdn_edge_decision_total{result="not_edge",reason="middleware_matched"} 1',
        );
        expect(text).toContain("knext_cdn_foreign_edge_strip_total 1");
        expect(text).toContain(
            'knext_cdn_purge_total{provider="cloudflare",result="ok"} 1',
        );
        expect(text.endsWith("\n")).toBe(true);
    });

    it("leaves the purge family out until the purge registry exists", () => {
        const text = edge.renderCdnMetrics();
        expect(text).toContain("# TYPE knext_cdn_edge_decision_total counter");
        expect(text).not.toContain("knext_cdn_purge_total");
    });

    it("publishMetricsSeam puts renderCdnMetrics on globalThis", () => {
        expect(g[SEAM]).toBeUndefined();
        edge.publishMetricsSeam();
        expect(g[SEAM]).toBe(edge.renderCdnMetrics);
    });
});

describe("readCdnMetrics (the reading half) fails open", () => {
    it("returns an empty string when no seam is published", async () => {
        const { readCdnMetrics } = await import("../adapters/deep-health-lite");
        expect(readCdnMetrics()).toBe("");
    });

    it("returns an empty string when the render function throws", async () => {
        const { readCdnMetrics } = await import("../adapters/deep-health-lite");
        g[SEAM] = () => {
            throw new Error("boom");
        };
        expect(readCdnMetrics()).toBe("");
    });

    it("returns an empty string when the seam is not a function", async () => {
        const { readCdnMetrics } = await import("../adapters/deep-health-lite");
        g[SEAM] = "knext_cdn_edge_decision_total 1\n";
        expect(readCdnMetrics()).toBe("");
    });
});

/** Every sample line (non-comment, non-blank) in an exposition. */
const samples = (body: string) =>
    body.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"));

describe("the server process's loopback listeners append the seam", () => {
    const servers: Array<{ close: (cb: () => void) => void }> = [];
    afterEach(async () => {
        for (const s of servers.splice(0)) {
            await new Promise<void>((r) => s.close(() => r()));
        }
    });

    async function scrape(server: {
        once: (e: string, cb: () => void) => void;
        listening: boolean;
        address: () => unknown;
    }): Promise<string> {
        if (!server.listening) {
            await new Promise<void>((r) => server.once("listening", r));
        }
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(res.status).toBe(200);
        return await res.text();
    }

    const idleLite = () =>
        startDeepHealthLite({
            port: 0,
            env: {},
            app: "a",
            // The DB gate is closed: lite itself renders nothing.
            readActivityAt: () => undefined,
            loadHealth: async () => {
                throw new Error("must not probe an idle app");
            },
        });

    it("deep-health-lite (tracing off) serves the CDN counters when the seam is published", async () => {
        edge.countDecision("edge", "allowed");
        edge.publishMetricsSeam();
        const server = idleLite();
        servers.push(server);
        const body = await scrape(server);
        expect(body).toContain(
            'knext_cdn_edge_decision_total{result="edge",reason="allowed"} 1',
        );
        expect(body).toContain("knext_cdn_foreign_edge_strip_total 0");
    });

    it("deep-health-lite is byte-identical without the seam (CDN mode off)", async () => {
        const server = idleLite();
        servers.push(server);
        expect(await scrape(server)).toBe("");
    });

    it("startChildMetricsServer (tracing on) appends the CDN counters to its registry", async () => {
        edge.countForeignEdgeStrip();
        edge.publishMetricsSeam();
        const registry = new Registry();
        const server = startChildMetricsServer(registry, 0);
        servers.push(server);
        const body = await scrape(server);
        expect(body).toContain("knext_cdn_foreign_edge_strip_total 1");
        expect(body).toContain("# TYPE knext_cdn_edge_decision_total counter");
    });

    it("startChildMetricsServer is unchanged without the seam", async () => {
        const registry = new Registry();
        const server = startChildMetricsServer(registry, 0);
        servers.push(server);
        expect(await scrape(server)).toBe(await registry.metrics());
    });

    it("the self-contained runtime's in-process metrics port appends the seam", async () => {
        edge.countDecision("not_edge", "set_cookie");
        edge.publishMetricsSeam();
        const http = await import("node:http");
        // The module binds 0.0.0.0 on METRICS_PORT; the shim rebinds loopback
        // on an ephemeral port so the test never takes a real port.
        const fixed = selfContained.startMetricsServer({
            env: {},
            isDraining: () => false,
            http: {
                createServer: (
                    handler: Parameters<typeof http.createServer>[0],
                ) => {
                    const s = http.createServer(handler as never);
                    const listen = s.listen.bind(s);
                    // biome-ignore lint/suspicious/noExplicitAny: test shim over listen's overloads
                    (s as any).listen = () => listen(0, "127.0.0.1");
                    return s;
                },
            },
        });
        servers.push(fixed);
        const body = await scrape(fixed);
        expect(body).toContain("knext_up 1");
        expect(body).toContain(
            'knext_cdn_edge_decision_total{result="not_edge",reason="set_cookie"} 1',
        );
        // Each family is declared once: the in-process body is a single exposition.
        expect(
            body.match(/# TYPE knext_cdn_edge_decision_total /g)?.length,
        ).toBe(1);
    });

    it("the self-contained body is unchanged without the seam", () => {
        const body = selfContained.metricsBody({
            uptimeSeconds: 1,
            draining: false,
        });
        expect(samples(body)).toEqual([
            "knext_up 1",
            "knext_self_contained_process_uptime_seconds 1",
        ]);
    });
});

describe("the preload publishes the seam only in CDN mode (Node and Bun)", () => {
    const running: Running[] = [];
    afterEach(() => {
        for (const r of running.splice(0)) r.stop();
    });

    for (const runtime of ["node", "bun"] as const) {
        it(`${runtime}: CDN mode on — the seam renders the counters after a decision`, async () => {
            const s = await startServer({ runtime, env: CDN_ENV });
            running.push(s);
            await get(s.port, "/x", { cc: "private, no-store" });
            const r = await get(s.port, "/", {}, {}, "seam");
            const out = JSON.parse(r.body);
            expect(out.type, s.output()).toBe("function");
            expect(out.text).toMatch(
                /^knext_cdn_edge_decision_total\{result="[a-z_]+",reason="[a-z_]+"\} 1$/m,
            );
            expect(out.text).toContain("knext_cdn_foreign_edge_strip_total 0");
        }, 30_000);

        it(`${runtime}: CDN mode off — nothing is published`, async () => {
            const s = await startServer({ runtime });
            running.push(s);
            await get(s.port, "/x", { cc: "private, no-store" });
            const r = await get(s.port, "/", {}, {}, "seam");
            expect(JSON.parse(r.body).type).toBe("undefined");
        }, 30_000);
    }
});

describe("every reader names the seam with the same Symbol.for key", () => {
    // The key is duplicated by literal on purpose: the readers are
    // dependency-free and may not import cdn-edge.cjs. A drift between them is
    // silent (the reader sees no seam and serves nothing), so it is pinned here.
    const LITERAL = "Symbol.for('knext.core.cdn.renderMetrics')";
    const LITERAL_DQ = 'Symbol.for("knext.core.cdn.renderMetrics")';
    const count = (src: string) =>
        src.split(LITERAL).length - 1 + (src.split(LITERAL_DQ).length - 1);

    it.each([
        "cdn-edge.cjs",
        "deep-health-lite.ts",
        "standalone-self-contained-supervisor.cjs",
    ])("%s names the key exactly once", (file) => {
        expect(count(readFileSync(join(ADAPTERS, file), "utf8"))).toBe(1);
    });
});
