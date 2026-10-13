/**
 * The `'use cache'` metrics seam: how the use-cache handler's counters reach the
 * app's metrics port.
 *
 * The handler counts every outcome into a process-wide bag on `globalThis`
 * (`knext.cache.useCache.counters`). It lives in the Next server process, loaded
 * by Next through `cacheHandlers`. The metrics port is served either by a
 * SEPARATE supervisor process that merges the server process's loopback
 * listener (deep-health-lite with tracing off, `startChildMetricsServer` with
 * tracing on), or in-process by the compiled self-contained runtime. Same shape
 * as the CDN seam: the handler publishes ONE render function on `globalThis`
 * under a namespaced `Symbol.for` key (ADR-0027), and each listener appends what
 * it renders.
 *
 * With no use-cache handler built (Next < 16.4, no `cacheHandlers`, the vinext
 * target) the seam is never published and every body is unchanged.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "prom-client";
import { startDeepHealthLite } from "../adapters/deep-health-lite";
import { startChildMetricsServer } from "../adapters/metrics";
import {
    createUseCacheHandler,
    renderUseCacheMetrics,
    USE_CACHE_EVENTS,
    USE_CACHE_METRIC,
    USE_CACHE_METRICS_SEAM_KEY,
} from "../adapters/use-cache-handler.js";

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = resolve(here, "../adapters");

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const edge: any = require(join(ADAPTERS, "cdn-edge.cjs"));

/** See cdn-metrics-seam.test.ts: require the supervisor without its side effect. */
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

const SEAM = Symbol.for("knext.core.useCache.renderMetrics");
const CDN_SEAM = Symbol.for("knext.core.cdn.renderMetrics");
const COUNTERS = Symbol.for("knext.cache.useCache.counters");
const g = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
    delete g[SEAM];
    delete g[CDN_SEAM];
    delete g[COUNTERS];
    delete g[edge.DECISIONS_KEY];
    delete g[Symbol.for("knext.core.cdn.foreignEdgeStrips")];
});

/** A `core` the handler is built with; nothing is called at construction. */
const inertCore = {
    ensureConnected: async () => null,
    redisCall: async <T>(fn: () => Promise<T>) => await fn(),
    command: async () => null,
    keyPrefix: () => "p",
    buildId: () => undefined,
    redisConfigured: () => false,
};

/** Sample lines of the use-cache family, as `event → value`. */
function events(body: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of body.matchAll(
        /^knext_use_cache_events_total\{event="([a-z_]+)"\} (\d+)$/gm,
    )) {
        out.set(m[1] as string, Number(m[2]));
    }
    return out;
}

describe("renderUseCacheMetrics", () => {
    it("names one counter family, declared once", () => {
        expect(USE_CACHE_METRIC).toBe("knext_use_cache_events_total");
        const text = renderUseCacheMetrics();
        expect(text).toMatch(/^# HELP knext_use_cache_events_total \S.*$/m);
        expect(
            text.match(/^# TYPE knext_use_cache_events_total counter$/gm)
                ?.length,
        ).toBe(1);
        expect(text.endsWith("\n")).toBe(true);
    });

    it("renders every event at 0 before anything is counted", () => {
        const text = renderUseCacheMetrics();
        const seen = events(text);
        expect([...seen.keys()].sort()).toEqual(
            Object.values(USE_CACHE_EVENTS).sort(),
        );
        for (const v of seen.values()) expect(v).toBe(0);
        // Every sample line is one of the family's: nothing else is rendered.
        const samples = text
            .split("\n")
            .filter((l) => l.length > 0 && !l.startsWith("#"));
        expect(samples.length).toBe(seen.size);
    });

    it("renders the bag's counts under snake_case event labels, oversize included", () => {
        g[COUNTERS] = {
            hit: 3,
            miss: 2,
            oversize: 5,
            tagsUpdated: 1,
            pruneError: 4,
        };
        const seen = events(renderUseCacheMetrics());
        expect(seen.get("hit")).toBe(3);
        expect(seen.get("miss")).toBe(2);
        expect(seen.get("oversize")).toBe(5);
        expect(seen.get("tags_updated")).toBe(1);
        expect(seen.get("prune_error")).toBe(4);
        expect(seen.get("error")).toBe(0);
    });

    it("label values are a closed, Prometheus-safe set", () => {
        for (const label of Object.values(USE_CACHE_EVENTS)) {
            expect(label).toMatch(/^[a-z][a-z_]*$/);
        }
        expect(new Set(Object.values(USE_CACHE_EVENTS)).size).toBe(
            Object.keys(USE_CACHE_EVENTS).length,
        );
    });
});

describe("every counter the handler increments is exported, and nothing else", () => {
    // SCANNED, never enumerated here: a new `count('x')` in the handler with no
    // event label would be counted and never served. Both directions.
    const SOURCE = readFileSync(join(ADAPTERS, "use-cache-handler.js"), "utf8");
    const counted = new Set(
        [...SOURCE.matchAll(/\bcount\(\s*['"]([A-Za-z]+)['"]\s*\)/g)].map(
            (m) => m[1] as string,
        ),
    );

    it("finds the handler's counters at all (an empty scan would pass vacuously)", () => {
        expect(counted.size).toBeGreaterThan(10);
        expect(counted.has("oversize")).toBe(true);
    });

    it("every count() name has an event label", () => {
        const unexported = [...counted].filter(
            (n) => !Object.hasOwn(USE_CACHE_EVENTS, n),
        );
        expect(unexported).toEqual([]);
    });

    it("every event label is a counter the handler increments", () => {
        const dead = Object.keys(USE_CACHE_EVENTS).filter(
            (n) => !counted.has(n),
        );
        expect(dead).toEqual([]);
    });

    it("count() is never called with a non-literal name the scan cannot read", () => {
        const calls = [...SOURCE.matchAll(/\bcount\(([^)]*)\)/g)].map((m) =>
            (m[1] as string).trim(),
        );
        const opaque = calls.filter(
            (a) => a !== "name" && !/^['"][A-Za-z]+['"]$/.test(a),
        );
        expect(opaque).toEqual([]);
    });
});

describe("the handler publishes the seam when it is built", () => {
    it("exports the seam key under the namespaced Symbol.for name", () => {
        expect(USE_CACHE_METRICS_SEAM_KEY).toBe(SEAM);
    });

    it("createUseCacheHandler puts renderUseCacheMetrics on globalThis", () => {
        expect(g[SEAM]).toBeUndefined();
        createUseCacheHandler({ kind: "default", core: inertCore });
        expect(g[SEAM]).toBe(renderUseCacheMetrics);
    });

    it("a counted outcome is visible through the published seam", async () => {
        const handler = createUseCacheHandler({
            kind: "default",
            core: inertCore,
        });
        // No Redis: a read is a miss.
        expect(await handler.get("k")).toBeUndefined();
        const render = g[SEAM] as () => string;
        expect(events(render()).get("miss")).toBe(1);
    });
});

describe("readUseCacheMetrics (the reading half) fails open", () => {
    it("returns an empty string when no seam is published", async () => {
        const { readUseCacheMetrics } = await import(
            "../adapters/deep-health-lite"
        );
        expect(readUseCacheMetrics()).toBe("");
    });

    it("returns an empty string when the render function throws", async () => {
        const { readUseCacheMetrics } = await import(
            "../adapters/deep-health-lite"
        );
        g[SEAM] = () => {
            throw new Error("boom");
        };
        expect(readUseCacheMetrics()).toBe("");
    });

    it("returns an empty string when the seam is not a function", async () => {
        const { readUseCacheMetrics } = await import(
            "../adapters/deep-health-lite"
        );
        g[SEAM] = "knext_use_cache_events_total 1\n";
        expect(readUseCacheMetrics()).toBe("");
    });
});

describe("the server process's listeners append the seam", () => {
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
            readActivityAt: () => undefined,
            loadHealth: async () => {
                throw new Error("must not probe an idle app");
            },
        });

    it("deep-health-lite (tracing off) serves the use-cache counters", async () => {
        createUseCacheHandler({ kind: "default", core: inertCore });
        g[COUNTERS] = { oversize: 2 };
        const server = idleLite();
        servers.push(server);
        const body = await scrape(server);
        expect(events(body).get("oversize")).toBe(2);
    });

    it("deep-health-lite is byte-identical without either seam", async () => {
        const server = idleLite();
        servers.push(server);
        expect(await scrape(server)).toBe("");
    });

    it("deep-health-lite serves the CDN and the use-cache counters together, each family declared once", async () => {
        createUseCacheHandler({ kind: "default", core: inertCore });
        edge.countDecision("edge", "allowed");
        edge.publishMetricsSeam();
        const server = idleLite();
        servers.push(server);
        const body = await scrape(server);
        expect(body).toContain(
            'knext_cdn_edge_decision_total{result="edge",reason="allowed"} 1',
        );
        expect(events(body).get("hit")).toBe(0);
        for (const family of [
            "knext_cdn_edge_decision_total",
            "knext_use_cache_events_total",
        ]) {
            expect(
                body.match(new RegExp(`^# TYPE ${family} `, "gm"))?.length,
                family,
            ).toBe(1);
        }
        // Joined on exactly one newline: no blank line, no glued lines.
        expect(body).not.toContain("\n\n");
    });

    it("startChildMetricsServer (tracing on) appends the use-cache counters to its registry", async () => {
        createUseCacheHandler({ kind: "remote", core: inertCore });
        g[COUNTERS] = { set: 7 };
        const registry = new Registry();
        const server = startChildMetricsServer(registry, 0);
        servers.push(server);
        const body = await scrape(server);
        expect(events(body).get("stored")).toBe(7);
    });

    it("startChildMetricsServer is unchanged without the seam", async () => {
        const registry = new Registry();
        const server = startChildMetricsServer(registry, 0);
        servers.push(server);
        expect(await scrape(server)).toBe(await registry.metrics());
    });

    it("the self-contained runtime's in-process metrics port appends the seam", async () => {
        createUseCacheHandler({ kind: "default", core: inertCore });
        g[COUNTERS] = { dropped: 1 };
        const http = await import("node:http");
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
        expect(events(body).get("dropped")).toBe(1);
        expect(
            body.match(/^# TYPE knext_use_cache_events_total /gm)?.length,
        ).toBe(1);
    });
});

describe("every reader names the seam with the same Symbol.for key", () => {
    // Duplicated by literal on purpose (the readers are dependency-free). A
    // drift is silent -- the reader sees no seam and serves nothing -- so it is
    // pinned here.
    const LITERAL = "Symbol.for('knext.core.useCache.renderMetrics')";
    const LITERAL_DQ = 'Symbol.for("knext.core.useCache.renderMetrics")';
    const count = (src: string) =>
        src.split(LITERAL).length - 1 + (src.split(LITERAL_DQ).length - 1);

    it.each([
        "use-cache-handler.js",
        "deep-health-lite.ts",
        "standalone-self-contained-supervisor.cjs",
    ])("%s names the key exactly once", (file) => {
        expect(count(readFileSync(join(ADAPTERS, file), "utf8"))).toBe(1);
    });
});
