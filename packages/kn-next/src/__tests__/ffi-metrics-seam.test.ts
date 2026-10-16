/**
 * The in-process Rust slow-call seam: how the counters the GENERATED ffi module
 * keeps (app code, emitted by the optional ffi package) reach the app's metrics
 * port.
 *
 * The generated module counts calls slower than its threshold, and reports its
 * first load, into a registry on `globalThis`, then publishes ONE render
 * function under `Symbol.for('knext.ffi.renderMetrics')` once the library has
 * loaded. Core's loopback metrics listeners in the server process
 * (deep-health-lite with tracing off, `startChildMetricsServer` with tracing on)
 * append what it renders, and the standalone supervisor merges that onto the
 * metrics port, the same way as the CDN and 'use cache' seams.
 *
 * Core never imports the ffi package (the boundary guard in ffi-dispatch.test.ts):
 * the key is duplicated by literal and pinned here against the generator's source.
 * Without the opt-in nothing publishes the seam, so every body is unchanged.
 *
 * The self-contained runtime's in-process port does not read this seam: that
 * mode refuses in-process Rust at build time, so no such process can hold it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "prom-client";
import {
    readFfiMetrics,
    readSeamMetrics,
    startDeepHealthLite,
} from "../adapters/deep-health-lite";
import { startChildMetricsServer } from "../adapters/metrics";

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = resolve(here, "../adapters");
const FFI_RENDER = resolve(here, "../../../ffi/src/render.ts");

const SEAM = Symbol.for("knext.ffi.renderMetrics");
const USE_CACHE_SEAM = Symbol.for("knext.core.useCache.renderMetrics");
const g = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
    delete g[SEAM];
    delete g[USE_CACHE_SEAM];
});

/** What the generated module renders after two slow calls to `stretch`. */
const FFI_TEXT = [
    "# HELP knext_ffi_slow_calls_total h",
    "# TYPE knext_ffi_slow_calls_total counter",
    'knext_ffi_slow_calls_total{fn="greet"} 0',
    'knext_ffi_slow_calls_total{fn="stretch"} 2',
    "# HELP knext_ffi_load_seconds h",
    "# TYPE knext_ffi_load_seconds gauge",
    'knext_ffi_load_seconds{lib="zone"} 0.0021',
    "",
].join("\n");

describe("readFfiMetrics (the reading half) fails open", () => {
    it("returns an empty string when no seam is published (an app without in-process Rust)", () => {
        expect(readFfiMetrics()).toBe("");
    });

    it("returns what the published render function returns", () => {
        g[SEAM] = () => FFI_TEXT;
        expect(readFfiMetrics()).toBe(FFI_TEXT);
    });

    it("returns an empty string when the render function throws", () => {
        g[SEAM] = () => {
            throw new Error("boom");
        };
        expect(readFfiMetrics()).toBe("");
    });

    it("returns an empty string when the seam is not a function", () => {
        g[SEAM] = FFI_TEXT;
        expect(readFfiMetrics()).toBe("");
    });

    it("readSeamMetrics appends it after the other seams, on exactly one newline", () => {
        g[USE_CACHE_SEAM] = () =>
            "# TYPE knext_use_cache_events_total counter\n";
        g[SEAM] = () => FFI_TEXT;
        const body = readSeamMetrics();
        expect(body).toBe(
            `# TYPE knext_use_cache_events_total counter\n${FFI_TEXT}`,
        );
        expect(body).not.toContain("\n\n");
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

    it("deep-health-lite (tracing off) serves the slow-call counters", async () => {
        g[SEAM] = () => FFI_TEXT;
        const server = idleLite();
        servers.push(server);
        expect(await scrape(server)).toBe(FFI_TEXT);
    });

    it("deep-health-lite is byte-identical without the seam", async () => {
        const server = idleLite();
        servers.push(server);
        expect(await scrape(server)).toBe("");
    });

    it("startChildMetricsServer (tracing on) appends the slow-call counters to its registry", async () => {
        g[SEAM] = () => FFI_TEXT;
        const registry = new Registry();
        const server = startChildMetricsServer(registry, 0);
        servers.push(server);
        const body = await scrape(server);
        expect(body).toContain('knext_ffi_slow_calls_total{fn="stretch"} 2');
        expect(
            body.match(/^# TYPE knext_ffi_slow_calls_total /gm),
        ).toHaveLength(1);
    });

    it("startChildMetricsServer is unchanged without the seam", async () => {
        const registry = new Registry();
        const server = startChildMetricsServer(registry, 0);
        servers.push(server);
        expect(await scrape(server)).toBe(await registry.metrics());
    });
});

describe("the reader and the generator name the seam with the same Symbol.for key", () => {
    // A drift is silent -- the reader sees no seam and serves nothing -- so the
    // literal is pinned on both sides. Core reads the generator's SOURCE as text;
    // it never imports the ffi package.
    const SQ = "Symbol.for('knext.ffi.renderMetrics')";
    const DQ = 'Symbol.for("knext.ffi.renderMetrics")';
    const count = (src: string) =>
        src.split(SQ).length - 1 + (src.split(DQ).length - 1);

    it("deep-health-lite.ts names the key exactly once", () => {
        expect(
            count(readFileSync(join(ADAPTERS, "deep-health-lite.ts"), "utf8")),
        ).toBe(1);
    });

    it("the ffi generator emits the key exactly once", () => {
        expect(count(readFileSync(FFI_RENDER, "utf8"))).toBe(1);
    });
});
