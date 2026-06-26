import { afterEach, describe, expect, it, vi } from "vitest";
import {
    clearShutdownDrains,
    gracefulShutdown,
    registerShutdownDrain,
} from "../adapters/shutdown";

// Minimal child-process double: records signal forwarding + lets the test fire "exit".
function makeChild() {
    const handlers: Record<string, () => void> = {};
    return {
        kill: vi.fn(),
        once: vi.fn((ev: string, cb: () => void) => {
            handlers[ev] = cb;
        }),
        emitExit: () => handlers.exit?.(),
    };
}

describe("gracefulShutdown (A5 — drain on SIGTERM, no dropped requests)", () => {
    it("closes servers and FORWARDS SIGTERM to the child (so Next drains in-flight + runs after())", () => {
        const child = makeChild();
        const closable = { close: vi.fn() };
        const exit = vi.fn();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [closable],
            graceMs: 1000,
            exit,
        });
        expect(closable.close).toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        // Must NOT exit immediately — it waits for the child to finish draining.
        expect(exit).not.toHaveBeenCalled();
    });

    it("exits 0 as soon as the child exits (drain complete) — before the grace cap", () => {
        const child = makeChild();
        const exit = vi.fn();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 10_000,
            exit,
        });
        child.emitExit();
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("force-exits at the grace cap if the child never drains", () => {
        vi.useFakeTimers();
        const child = makeChild();
        const exit = vi.fn();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 5_000,
            exit,
        });
        expect(exit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5_000);
        expect(exit).toHaveBeenCalledWith(0);
        vi.useRealTimers();
    });

    it("exits exactly once (child-exit and the cap timer never double-exit)", () => {
        vi.useFakeTimers();
        const child = makeChild();
        const exit = vi.fn();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 5_000,
            exit,
        });
        child.emitExit();
        vi.advanceTimersByTime(5_000);
        expect(exit).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});

describe("gracefulShutdown — DB drain on SIGTERM (PGS-1)", () => {
    afterEach(() => {
        clearShutdownDrains();
    });

    it("invokes AND awaits a registered DB-drain hook before process exit", async () => {
        const order: string[] = [];
        let resolveDrain: () => void = () => {};
        const drainDone = new Promise<void>((r) => {
            resolveDrain = r;
        });

        // A drain hook that completes asynchronously (e.g. pool.end()).
        registerShutdownDrain(async () => {
            order.push("drain:start");
            await drainDone;
            order.push("drain:end");
        });

        const child = makeChild();
        const exit = vi.fn(() => {
            order.push("exit");
        });

        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 10_000,
            exit,
        });

        // Child finishes draining HTTP — but exit must wait for the DB drain.
        child.emitExit();
        // Let the drain hook start but not finish.
        await Promise.resolve();
        expect(order).toContain("drain:start");
        expect(exit).not.toHaveBeenCalled();

        // Complete the drain; only now may the process exit.
        resolveDrain();
        await drainDone;
        await new Promise((r) => setTimeout(r, 0));

        expect(exit).toHaveBeenCalledWith(0);
        expect(order).toEqual(["drain:start", "drain:end", "exit"]);
    });

    it("does not delay exit past the grace cap if the drain hook hangs", async () => {
        // A drain hook that never resolves.
        registerShutdownDrain(() => new Promise<void>(() => {}));

        const child = makeChild();
        const exit = vi.fn();
        const timers: Array<{ fn: () => void; ms: number }> = [];

        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 5_000,
            exit,
            setTimeoutFn: (fn, ms) => {
                timers.push({ fn, ms });
                return { unref() {} };
            },
        });

        child.emitExit();
        await Promise.resolve();
        // Drain is hanging — must not have exited yet.
        expect(exit).not.toHaveBeenCalled();

        // Fire the grace-cap timer: forced exit despite the hung drain.
        const capTimer = timers.find((t) => t.ms === 5_000);
        expect(capTimer).toBeDefined();
        capTimer?.fn();

        expect(exit).toHaveBeenCalledWith(0);
    });

    it("still exits when no drain hook is registered (backwards compatible)", async () => {
        const child = makeChild();
        const exit = vi.fn();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 10_000,
            exit,
        });
        child.emitExit();
        await new Promise((r) => setTimeout(r, 0));
        expect(exit).toHaveBeenCalledWith(0);
    });
});
