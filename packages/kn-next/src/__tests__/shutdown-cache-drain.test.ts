import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearShutdownDrains,
    gracefulShutdown,
    registerShutdownDrain,
} from "../adapters/shutdown";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * T13, composition half — the SIGTERM path must actually AWAIT in-flight ISR
 * writes, not merely be capable of it.
 *
 * `cache-handler.js` exposes `drainCacheWrites()` and `shutdown.ts` exposes
 * `registerShutdownDrain()`; each is tested in isolation elsewhere. What is
 * load-bearing — and what nothing asserted before — is that composing them
 * delays the final `exit()` until a revalidation write that was already in
 * flight has committed.
 *
 * SCOPE, stated rather than implied: on the **node target** the supervisor
 * (`node-server.ts`, which owns this registry) and the Next.js server that loads
 * `cache-handler.js` are DIFFERENT PROCESSES, so the supervisor's registry
 * cannot see the child's cache writes. There, the guarantee against a torn write
 * is the atomic MULTI/EXEC, and the child's own drain is Next's. This
 * composition is the guarantee for a SINGLE-PROCESS target (the ADR-0036
 * `bun-exec` build target), and it is the contract `drainCacheWrites` exists to
 * satisfy. Do not read it as claiming the node supervisor drains the child's
 * cache.
 */
describe("T13 — gracefulShutdown awaits in-flight ISR writes when they are registered", () => {
    const original = { ...process.env };
    const CACHE_HANDLER: string = "../adapters/cache-handler.js";
    let fake: FakeRedis | undefined;

    beforeEach(() => {
        vi.resetModules();
        clearShutdownDrains();
        process.env.REDIS_KEY_PREFIX = "shutdown-app";
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        clearShutdownDrains();
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    const fakeChild = (): {
        kill: (signal?: NodeJS.Signals | number) => boolean;
        once: (event: "exit", listener: () => void) => void;
        emitExit: () => void;
        signals: string[];
    } => {
        const listeners: Array<() => void> = [];
        const signals: string[] = [];
        return {
            signals,
            kill: (signal?: NodeJS.Signals | number) => {
                signals.push(String(signal));
                return true;
            },
            once: (_event: "exit", listener: () => void) => {
                listeners.push(listener);
            },
            emitExit: () => {
                for (const l of listeners) l();
            },
        };
    };

    it("does not exit until the in-flight cache write has committed", async () => {
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        fake = await startFakeRedis({
            onCommand: async (cmd) => {
                if (cmd === "exec") await held;
            },
        });
        process.env.REDIS_URL = fake.url;

        const mod = await import(CACHE_HANDLER);
        const handler = new mod.default({});
        const writing = handler.set(
            "/late-revalidation",
            { kind: "PAGE" },
            { revalidate: 60, tags: ["t"] },
        );

        registerShutdownDrain(() => mod.drainCacheWrites(5000));

        const exit = vi.fn();
        const child = fakeChild();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 30_000,
            exit,
            setTimeoutFn: () => ({ unref: () => {} }),
        });

        // SIGTERM is forwarded so Next drains in-flight requests + after().
        expect(child.signals).toEqual(["SIGTERM"]);

        child.emitExit();
        await new Promise((r) => setTimeout(r, 50));

        // The HTTP side has drained, but the ISR write has not committed —
        // exiting here would abandon it.
        expect(exit).not.toHaveBeenCalled();
        expect(fake.strings.has("shutdown-app:cache:/late-revalidation")).toBe(
            false,
        );

        release?.();
        await writing;
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

        expect(fake.strings.has("shutdown-app:cache:/late-revalidation")).toBe(
            true,
        );
    });

    it("still exits at the grace cap if the cache write never commits", async () => {
        fake = await startFakeRedis({
            onCommand: async (cmd) => {
                if (cmd === "exec") await new Promise(() => {});
            },
        });
        process.env.REDIS_URL = fake.url;

        const mod = await import(CACHE_HANDLER);
        const handler = new mod.default({});
        void handler.set("/never", { kind: "PAGE" }, { revalidate: 60 });

        registerShutdownDrain(() => mod.drainCacheWrites(60_000));

        const exit = vi.fn();
        const child = fakeChild();
        let capFire: (() => void) | undefined;
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 25_000,
            exit,
            setTimeoutFn: (fn: () => void) => {
                capFire = fn;
                return { unref: () => {} };
            },
        });

        child.emitExit();
        await new Promise((r) => setTimeout(r, 20));
        expect(exit).not.toHaveBeenCalled();

        // The pod's terminationGracePeriod, not the cache, decides.
        capFire?.();
        expect(exit).toHaveBeenCalledWith(0);
    });
});
