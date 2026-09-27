import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import {
    clearShutdownDrains,
    graceCapWarning,
    gracefulShutdown,
    registerShutdownDrain,
} from "../adapters/shutdown";

// Reset shutdown state before EVERY test (drains + the `shuttingDown` flag). The
// A5 describe formerly relied on the flag being harmless when leaked; the #494
// re-entrancy guard makes a stale `shuttingDown` early-return, so isolation must
// be universal, not per-describe.
beforeEach(() => {
    clearShutdownDrains();
});

// Minimal child-process double: records signal forwarding + lets the test fire "exit".
function makeChild() {
    const handlers: Record<string, () => void> = {};
    return {
        kill: mock(),
        once: mock((ev: string, cb: () => void) => {
            handlers[ev] = cb;
        }),
        emitExit: () => handlers.exit?.(),
    };
}

describe("gracefulShutdown (A5 — drain on SIGTERM, no dropped requests)", () => {
    it("closes servers and FORWARDS SIGTERM to the child (so Next drains in-flight + runs after())", () => {
        const child = makeChild();
        const closable = { close: mock() };
        const exit = mock();
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
        const exit = mock();
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
        jest.useFakeTimers();
        const child = makeChild();
        const exit = mock();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 5_000,
            exit,
        });
        expect(exit).not.toHaveBeenCalled();
        jest.advanceTimersByTime(5_000);
        expect(exit).toHaveBeenCalledWith(0);
        jest.useRealTimers();
    });

    it("exits exactly once (child-exit and the cap timer never double-exit)", () => {
        jest.useFakeTimers();
        const child = makeChild();
        const exit = mock();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 5_000,
            exit,
        });
        child.emitExit();
        jest.advanceTimersByTime(5_000);
        expect(exit).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
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
        const exit = mock(() => {
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
        const exit = mock();
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
        const exit = mock();
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
// The grace cap used to exit 0 with no log at all, so a pod that dropped
// in-flight work looked exactly like a clean drain. It still exits 0 (parity
// with the self-contained supervisor), but now says what it abandoned.
describe("gracefulShutdown — the grace cap is loud, not silent", () => {
    function capturingTimer() {
        let fire: (() => void) | undefined;
        return {
            setTimeoutFn: (fn: () => void, _ms: number) => {
                fire = fn;
                return undefined;
            },
            fire: () => fire?.(),
        };
    }

    it("warns that in-flight requests are being dropped when the child never drained, then exits 0", () => {
        const child = makeChild();
        const exit = mock();
        const warn = mock();
        const t = capturingTimer();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 25_000,
            exit,
            warn,
            setTimeoutFn: t.setTimeoutFn,
        });
        t.fire();
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = String(warn.mock.calls[0][0]);
        // Round 4: security.mdx tells operators the warning text starts with
        // `[knext] shutdown` — pin that prefix on the disk-mode path too.
        expect(msg).toStartWith("[knext] shutdown grace cap reached: ");
        expect(msg).toContain("SHUTDOWN_GRACE_MS=25000ms");
        expect(msg).toContain("after SIGTERM");
        expect(msg).toMatch(
            /DROPPING an unknown number of in-flight request\(s\)/,
        );
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("names the unfinished drain hooks when the child drained but a hook hung", () => {
        registerShutdownDrain(() => new Promise<void>(() => {}));
        const child = makeChild();
        const exit = mock();
        const warn = mock();
        const t = capturingTimer();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 5_000,
            exit,
            warn,
            setTimeoutFn: t.setTimeoutFn,
        });
        child.emitExit();
        t.fire();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(
            /the 1 registered shutdown drain hook\(s\) all finished/,
        );
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("is quiet when the drain finished before the cap", () => {
        const child = makeChild();
        const warn = mock();
        const t = capturingTimer();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 5_000,
            exit: mock(),
            warn,
            setTimeoutFn: t.setTimeoutFn,
        });
        child.emitExit();
        t.fire();
        expect(warn).not.toHaveBeenCalled();
    });

    it("graceCapWarning distinguishes the two cases", () => {
        const base = { signal: "SIGINT", graceMs: 1000, pendingDrains: 2 };
        expect(graceCapWarning({ ...base, childExited: false })).toContain(
            "in-flight request(s)",
        );
        expect(graceCapWarning({ ...base, childExited: true })).toContain(
            "the 2 registered shutdown drain hook(s)",
        );
    });
});
