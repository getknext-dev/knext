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
    installExitNormalizer,
    installDrainHandler,
} = supervisor;

describe("drainHardcapMs", () => {
    // M1 (round-2 fix): the default and the env var precedence now match
    // node-server.ts's SHUTDOWN_GRACE_MS (25_000ms), not the previous
    // 10_000ms/KNEXT_DRAIN_HARDCAP_MS-only shape — the earlier default
    // shrank the drain window by 60% relative to disk mode and the documented
    // `SHUTDOWN_GRACE_MS` knob (`security.mdx:195`).
    it("defaults to 25000ms (parity with node-server.ts SHUTDOWN_GRACE_MS)", () => {
        expect(drainHardcapMs({})).toBe(25_000);
    });
    it("honors SHUTDOWN_GRACE_MS", () => {
        expect(drainHardcapMs({ SHUTDOWN_GRACE_MS: "2500" })).toBe(2500);
    });
    it("still honors KNEXT_DRAIN_HARDCAP_MS as a fallback", () => {
        expect(drainHardcapMs({ KNEXT_DRAIN_HARDCAP_MS: "3000" })).toBe(3000);
    });
    it("SHUTDOWN_GRACE_MS takes precedence over KNEXT_DRAIN_HARDCAP_MS", () => {
        expect(
            drainHardcapMs({
                SHUTDOWN_GRACE_MS: "1000",
                KNEXT_DRAIN_HARDCAP_MS: "9000",
            }),
        ).toBe(1000);
    });
    it.each([
        "not-a-number",
        "-5",
        "0",
        "",
    ])("falls back to the default on an invalid value (%p)", (v) => {
        expect(drainHardcapMs({ SHUTDOWN_GRACE_MS: v })).toBe(25_000);
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
        const fakeHttp = {
            createServer: mock(() => ({ listen, on: mock() })),
        };
        startMetricsServer({
            env: { METRICS_PORT: "9111" },
            isDraining: () => false,
            // biome-ignore lint/suspicious/noExplicitAny: minimal fake http module
            http: fakeHttp as any,
        });
        expect(listen).toHaveBeenCalledWith(9111, "0.0.0.0");
    });

    // m1 (round-2 fix): an EADDRINUSE (or any other bind failure) on :9464
    // used to have no 'error' listener at all, so it was thrown uncaught and
    // crashed the whole app — unlike node-server.ts, which warns and
    // continues (node-server.ts:317-320).
    it("registers an 'error' listener so a bind failure does not crash the app", () => {
        let errorHandler: ((err: Error) => void) | undefined;
        const fakeHttp = {
            createServer: mock(() => ({
                listen: mock(),
                on: mock((event: string, fn: (err: Error) => void) => {
                    if (event === "error") errorHandler = fn;
                }),
            })),
        };
        startMetricsServer({
            env: {},
            isDraining: () => false,
            // biome-ignore lint/suspicious/noExplicitAny: minimal fake http module
            http: fakeHttp as any,
        });
        expect(errorHandler).toBeDefined();
        // Must not throw — this IS the assertion (an unhandled 'error' event
        // with no listener is what crashes the process).
        expect(() =>
            errorHandler?.(
                Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }),
            ),
        ).not.toThrow();
    });
});

describe("installExitNormalizer (B1 round-2 fix)", () => {
    function fakeProcess(initialExit: (code?: number) => void) {
        return { exit: initialExit } as unknown as NodeJS.Process;
    }

    it("passes exit codes through untouched before a drain starts", () => {
        const calls: Array<number | undefined> = [];
        const proc = fakeProcess((code) => {
            calls.push(code);
        });
        installExitNormalizer({ process: proc });
        (proc as unknown as { exit: (c?: number) => void }).exit(143);
        expect(calls).toEqual([143]);
    });

    it("normalizes Next's signal-exit codes (143 SIGTERM, 130 SIGINT) to 0 once armed", () => {
        const calls: Array<number | undefined> = [];
        const proc = fakeProcess((code) => {
            calls.push(code);
        });
        const state = installExitNormalizer({ process: proc });
        state.normalize = true;
        (proc as unknown as { exit: (c?: number) => void }).exit(143);
        (proc as unknown as { exit: (c?: number) => void }).exit(130);
        expect(calls).toEqual([0, 0]);
    });

    it("does NOT normalize an unrelated non-zero exit code even while draining", () => {
        const calls: Array<number | undefined> = [];
        const proc = fakeProcess((code) => {
            calls.push(code);
        });
        const state = installExitNormalizer({ process: proc });
        state.normalize = true;
        (proc as unknown as { exit: (c?: number) => void }).exit(1);
        expect(calls).toEqual([1]);
    });

    it("is idempotent — wrapping the same process twice returns the same shared state", () => {
        const proc = fakeProcess(() => {});
        const first = installExitNormalizer({ process: proc });
        const second = installExitNormalizer({ process: proc });
        expect(second).toBe(first);
    });
});

describe("installDrainHandler", () => {
    afterEach(() => {
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
    });

    // B1 round-2 fix: this handler no longer calls `appServer.close()` or
    // `exit()` itself on the normal path — Next's OWN SIGTERM handler now owns
    // closing the server and draining `after()` work (this preload no longer
    // sets `NEXT_MANUAL_SIG_HANDLE`), and calling `close()`/`exit()` here too
    // would race that drain, which is exactly the bug being fixed. So the
    // normal-path assertion is "arms the exit normalizer, does NOT touch
    // appServer, does NOT exit on its own" — the hardcap test below covers the
    // backstop path, which IS allowed to call exit()/closeAllConnections().
    it("on signal: marks draining, arms the exit normalizer, and does not itself close/exit", () => {
        const appServer = { close: mock(), closeAllConnections: mock() };
        const exit = mock();
        const armExitNormalizer = mock();
        const handlers: Record<string, () => void> = {};
        const on = mock((sig: string, fn: () => void) => {
            handlers[sig] = fn;
        });
        const { isDraining } = installDrainHandler(appServer, {
            env: {},
            exit,
            armExitNormalizer,
            // biome-ignore lint/suspicious/noExplicitAny: process.on shape
            on: on as any,
        });
        expect(isDraining()).toBe(false);
        handlers.SIGTERM();
        expect(isDraining()).toBe(true);
        expect(armExitNormalizer).toHaveBeenCalledTimes(1);
        expect(appServer.close).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
    });

    it("force-closes and exits at the hardcap when nothing else has exited the process", () => {
        const appServer = { close: mock(), closeAllConnections: mock() };
        const exit = mock();
        const handlers: Record<string, () => void> = {};
        const on = mock((sig: string, fn: () => void) => {
            handlers[sig] = fn;
        });
        installDrainHandler(appServer, {
            env: { SHUTDOWN_GRACE_MS: "5" },
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

    it("a second signal is a no-op (idempotent) — the normalizer arms only once", () => {
        const appServer = { close: mock(), closeAllConnections: mock() };
        const armExitNormalizer = mock();
        const handlers: Record<string, () => void> = {};
        const on = mock((sig: string, fn: () => void) => {
            handlers[sig] = fn;
        });
        installDrainHandler(appServer, {
            env: {},
            exit: mock(),
            armExitNormalizer,
            // biome-ignore lint/suspicious/noExplicitAny: process.on shape
            on: on as any,
        });
        handlers.SIGTERM();
        handlers.SIGTERM();
        expect(armExitNormalizer).toHaveBeenCalledTimes(1);
    });

    // Integration-shaped: proves the two pieces (installDrainHandler +
    // installExitNormalizer) actually compose the way `install()` wires them —
    // arming the SAME shared state object installDrainHandler is told to arm.
    it("wired together: a signal arms the SAME exit-normalizer state that process.exit reads", () => {
        const calls: Array<number | undefined> = [];
        const proc = {
            exit: (code?: number) => calls.push(code),
        } as unknown as NodeJS.Process;
        const state = installExitNormalizer({ process: proc });
        const appServer = { close: mock(), closeAllConnections: mock() };
        const handlers: Record<string, () => void> = {};
        const on = mock((sig: string, fn: () => void) => {
            handlers[sig] = fn;
        });
        installDrainHandler(appServer, {
            env: {},
            exit: mock(),
            armExitNormalizer: () => {
                state.normalize = true;
            },
            // biome-ignore lint/suspicious/noExplicitAny: process.on shape
            on: on as any,
        });
        expect(state.normalize).toBe(false);
        handlers.SIGTERM();
        expect(state.normalize).toBe(true);
        // Simulate Next's own handler now calling process.exit(143) — the
        // wrapped process.exit must rewrite it to 0.
        (proc as unknown as { exit: (c?: number) => void }).exit(143);
        expect(calls).toEqual([0]);
    });
});
