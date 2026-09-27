/**
 * N2 (#1457): the self-contained runtime image folds the supervisor's
 * SIGTERM-drain + `:9464` metrics behaviour directly into the compiled
 * executable (jev pick: fold 0.87 vs sidecar 0.13) rather than keeping a
 * separate `knext-standalone-entry.mjs` process — the sidecar option still
 * needs pino/prom-client/@opentelemetry/api, which contradicts the "no
 * node_modules" exit criterion. This pins the dependency-free preload's pure
 * behaviour: metrics body shape, drain sequencing (close vs hardcap), and
 * idempotency.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Same convention as bun-keepalive-guard.test.ts: a plain `import` of a
// `.cjs` file with no declaration file trips TS7016, so this loads it via
// `createRequire` and keeps it untyped.
const require = createRequire(import.meta.url);
const MODULE_PATH = resolve(
    import.meta.dirname,
    "../adapters/standalone-self-contained-supervisor.cjs",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const supervisor: any = require(MODULE_PATH);
const {
    drainHardcapMs,
    metricsPort,
    metricsBody,
    startMetricsServer,
    installDrainHandler,
} = supervisor;

describe("drainHardcapMs", () => {
    it("defaults to 10000ms", () => {
        expect(drainHardcapMs({})).toBe(10_000);
    });
    it("honors KNEXT_DRAIN_HARDCAP_MS", () => {
        expect(drainHardcapMs({ KNEXT_DRAIN_HARDCAP_MS: "2500" })).toBe(2500);
    });
    it.each([
        "not-a-number",
        "-5",
        "0",
        "",
    ])("falls back to the default on an invalid value (%p)", (v) => {
        expect(drainHardcapMs({ KNEXT_DRAIN_HARDCAP_MS: v })).toBe(10_000);
    });
});

describe("metricsPort", () => {
    it("defaults to 9464", () => {
        expect(metricsPort({})).toBe(9464);
    });
    it("honors METRICS_PORT", () => {
        expect(metricsPort({ METRICS_PORT: "9999" })).toBe(9999);
    });
});

describe("metricsBody", () => {
    it("reports knext_up=1 when not draining", () => {
        const body = metricsBody({ uptimeSeconds: 3, draining: false });
        expect(body).toContain("knext_up 1");
        expect(body).toContain("knext_self_contained_process_uptime_seconds 3");
        expect(body).toMatch(/^# HELP knext_up/);
    });
    it("reports knext_up=0 while draining", () => {
        const body = metricsBody({ uptimeSeconds: 0, draining: true });
        expect(body).toContain("knext_up 0");
    });
});

describe("startMetricsServer", () => {
    it("does not start when KNEXT_SELF_CONTAINED_METRICS=0", () => {
        const fakeHttp = { createServer: mock(() => ({ listen: mock() })) };
        const result = startMetricsServer({
            env: { KNEXT_SELF_CONTAINED_METRICS: "0" },
            isDraining: () => false,
            // biome-ignore lint/suspicious/noExplicitAny: minimal fake http module
            http: fakeHttp as any,
        });
        expect(result).toBeUndefined();
        expect(fakeHttp.createServer).not.toHaveBeenCalled();
    });

    it("binds 0.0.0.0 on the resolved metrics port", () => {
        const listen = mock();
        const fakeHttp = { createServer: mock(() => ({ listen })) };
        startMetricsServer({
            env: { METRICS_PORT: "9111" },
            isDraining: () => false,
            // biome-ignore lint/suspicious/noExplicitAny: minimal fake http module
            http: fakeHttp as any,
        });
        expect(listen).toHaveBeenCalledWith(9111, "0.0.0.0");
    });
});

describe("installDrainHandler", () => {
    afterEach(() => {
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
    });

    it("exits once close()'s callback fires, before the hardcap", () => {
        let closeCb: (() => void) | undefined;
        const appServer = {
            close: mock((cb: () => void) => {
                closeCb = cb;
            }),
            closeAllConnections: mock(),
        };
        const exit = mock();
        const handlers: Record<string, () => void> = {};
        const on = mock((sig: string, fn: () => void) => {
            handlers[sig] = fn;
        });
        const { isDraining } = installDrainHandler(appServer, {
            env: {},
            exit,
            // biome-ignore lint/suspicious/noExplicitAny: process.on shape
            on: on as any,
        });
        expect(isDraining()).toBe(false);
        handlers.SIGTERM();
        expect(isDraining()).toBe(true);
        expect(appServer.close).toHaveBeenCalledTimes(1);
        closeCb?.();
        expect(exit).toHaveBeenCalledWith(0);
        expect(appServer.closeAllConnections).not.toHaveBeenCalled();
    });

    it("force-closes and exits at the hardcap when close() never calls back", () => {
        const appServer = {
            close: mock(() => {
                /* never calls back — a stuck in-flight request */
            }),
            closeAllConnections: mock(),
        };
        const exit = mock();
        const handlers: Record<string, () => void> = {};
        const on = mock((sig: string, fn: () => void) => {
            handlers[sig] = fn;
        });
        installDrainHandler(appServer, {
            env: { KNEXT_DRAIN_HARDCAP_MS: "5" },
            exit,
            // biome-ignore lint/suspicious/noExplicitAny: process.on shape
            on: on as any,
        });
        handlers.SIGTERM();
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                expect(appServer.closeAllConnections).toHaveBeenCalledTimes(1);
                expect(exit).toHaveBeenCalledWith(0);
                resolve();
            }, 20);
        });
    });

    it("a second signal is a no-op (idempotent)", () => {
        const appServer = { close: mock(), closeAllConnections: mock() };
        const handlers: Record<string, () => void> = {};
        const on = mock((sig: string, fn: () => void) => {
            handlers[sig] = fn;
        });
        installDrainHandler(appServer, {
            env: {},
            exit: mock(),
            // biome-ignore lint/suspicious/noExplicitAny: process.on shape
            on: on as any,
        });
        handlers.SIGTERM();
        handlers.SIGTERM();
        expect(appServer.close).toHaveBeenCalledTimes(1);
    });
});
