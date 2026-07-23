import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDbPoolDrain } from "../adapters/db-drain";
import {
    clearShutdownDrains,
    gracefulShutdown,
    isShuttingDown,
    registerShutdownDrain,
} from "../adapters/shutdown";

/**
 * #449 — the supervisor's module-level `nextProc.on("exit")` handler must NOT
 * preempt the graceful-shutdown DB-pool drain.
 *
 * On a post-spawn SIGTERM, `gracefulShutdown` forwards SIGTERM to the child and
 * registers a `child.once("exit")` that runs+awaits the DB-pool drain before
 * exiting. But the module-level `nextProc.on("exit")` (registered earlier, at
 * spawn) also fires on that same child exit and, unguarded, calls `process.exit()`
 * synchronously — winning the race and severing the pools mid-drain.
 *
 * The fix: node-server.ts guards its child-exit handler with `isShuttingDown()`,
 * so during a graceful shutdown the drain owns the final exit. These tests model
 * BOTH listeners on the SAME child exit (a real EventEmitter) and assert the drain
 * runs to completion before any exit, using the exact `isShuttingDown()` the fix
 * relies on.
 */

/** A faithful child double: a real EventEmitter (fires `on` + `once`) + kill(). */
class FakeChild extends EventEmitter {
    kill = vi.fn(() => true);
}

afterEach(() => {
    clearShutdownDrains();
    vi.restoreAllMocks();
});

describe("isShuttingDown()", () => {
    it("is false before a shutdown and true once gracefulShutdown runs", () => {
        expect(isShuttingDown()).toBe(false);
        const child = new FakeChild();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 10_000,
            exit: vi.fn(),
        });
        expect(isShuttingDown()).toBe(true);
    });

    it("is reset by clearShutdownDrains (test isolation)", () => {
        gracefulShutdown("SIGTERM", {
            child: new FakeChild(),
            closables: [],
            graceMs: 10_000,
            exit: vi.fn(),
        });
        expect(isShuttingDown()).toBe(true);
        clearShutdownDrains();
        expect(isShuttingDown()).toBe(false);
    });
});

describe("child-exit does not preempt the DB-pool drain (#449)", () => {
    it("runs the drain to completion, then exits once — the module-level handler defers", async () => {
        const child = new FakeChild();

        // Async drain (a real pool.end() takes ticks) — records when it settled.
        let drainDone = false;
        const drain = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 5));
            drainDone = true;
        });
        registerShutdownDrain(drain);

        const gracefulExit = vi.fn();
        const moduleExit = vi.fn(); // stands in for process.exit() in node-server

        // The supervisor's module-level `nextProc.on("exit")` — GUARDED by the fix.
        child.on("exit", (code: number) => {
            if (isShuttingDown()) {
                return; // #449: graceful shutdown owns the exit; do not preempt.
            }
            moduleExit(code);
        });

        // SIGTERM path: forwards SIGTERM to the child, waits to drain, then exits.
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 10_000,
            exit: gracefulExit,
        });

        // The child drains its HTTP + runs after(), then exits — both listeners fire.
        child.emit("exit", 0);

        // Synchronously after the exit event: the drain is async, so NOTHING has
        // exited yet, and the module-level handler must NOT have fired.
        expect(moduleExit).not.toHaveBeenCalled();
        expect(gracefulExit).not.toHaveBeenCalled();
        expect(drainDone).toBe(false);

        // Let the async drain settle.
        await vi.waitFor(() => expect(gracefulExit).toHaveBeenCalledTimes(1));

        // The drain completed BEFORE the exit, and the module-level handler never
        // called process.exit — no preemption.
        expect(drain).toHaveBeenCalledTimes(1);
        expect(drainDone).toBe(true);
        expect(gracefulExit).toHaveBeenCalledWith(0);
        expect(moduleExit).not.toHaveBeenCalled();
    });

    it("closes BOTH Postgres pools (writer + RO) before exiting — the real db-drain wiring", async () => {
        const child = new FakeChild();

        // The real DB-pool drain (db-drain.ts) with injected pool closers, so we
        // assert the pools are actually end()'d — the exact coverage gap #449 named.
        const closeDbPool = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 5));
        });
        const closeDbPoolRO = vi.fn(async () => {});
        registerDbPoolDrain({
            loadClients: async () => ({ closeDbPool, closeDbPoolRO }),
        });

        const gracefulExit = vi.fn();
        const moduleExit = vi.fn();
        child.on("exit", (code: number) => {
            if (isShuttingDown()) {
                return;
            }
            moduleExit(code);
        });

        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 10_000,
            exit: gracefulExit,
        });
        child.emit("exit", 0);

        await vi.waitFor(() => expect(gracefulExit).toHaveBeenCalledTimes(1));

        // Both pools were closed, and the exit came only after — no preemption.
        expect(closeDbPool).toHaveBeenCalledTimes(1);
        expect(closeDbPoolRO).toHaveBeenCalledTimes(1);
        expect(moduleExit).not.toHaveBeenCalled();
        expect(gracefulExit).toHaveBeenCalledWith(0);
    });

    // Call-site regression guard: node-server.ts self-executes (spawns a child on
    // import), so it can't be unit-imported — the tests above model its handler
    // inline. This source assertion pins the ACTUAL node-server.ts:291 call site so
    // the guard can't be silently deleted there (mirrors deferred-supervisor-init's
    // source-structure checks).
    it("node-server's child-exit handler gates process.exit() behind isShuttingDown() [source guard]", () => {
        const src = readFileSync(
            resolve(__dirname, "..", "adapters", "node-server.ts"),
            "utf8",
        );
        const handler = src.match(
            /nextProc\.on\(\s*["']exit["'][\s\S]*?\n\}\);/,
        )?.[0];
        expect(handler, 'nextProc.on("exit") handler block').toBeTruthy();
        // Strip line comments — the handler's own comment mentions "process.exit()"
        // and would confuse a positional check; we assert on the CODE.
        const code = (handler as string).replace(/\/\/.*$/gm, "");
        // The guard must be present AND gate the exit: isShuttingDown() is checked
        // before the real process.exit() within the handler.
        expect(code).toMatch(/isShuttingDown\(\)/);
        expect(code).toMatch(/process\.exit/);
        expect(code.indexOf("isShuttingDown()")).toBeLessThan(
            code.indexOf("process.exit"),
        );
    });

    it("still exits via the module-level handler on an UNEXPECTED child crash (no shutdown in progress)", () => {
        const child = new FakeChild();
        const moduleExit = vi.fn();
        child.on("exit", (code: number) => {
            if (isShuttingDown()) {
                return;
            }
            moduleExit(code);
        });

        // No gracefulShutdown() → isShuttingDown() stays false → the child crashing
        // on its own must still bring the supervisor down with the child's code.
        child.emit("exit", 3);

        expect(moduleExit).toHaveBeenCalledWith(3);
    });
});

describe("gracefulShutdown re-entrancy (#494)", () => {
    it("ignores a second signal mid-shutdown — one kill, one timer, one drain, one exit", async () => {
        const child = new FakeChild();
        const drain = vi.fn(async () => {});
        registerShutdownDrain(drain);
        const exit = vi.fn();
        const setTimeoutFn = vi.fn(() => ({ unref() {} }));

        const opts = {
            child,
            closables: [],
            graceMs: 1000,
            exit,
            setTimeoutFn,
        };
        gracefulShutdown("SIGTERM", opts);
        // A second signal arrives mid-shutdown — the first invocation owns the
        // drain + exit; this one must be a no-op (no duplicate kill/timer/drain).
        gracefulShutdown("SIGINT", opts);

        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(setTimeoutFn).toHaveBeenCalledTimes(1);

        child.emit("exit", 0);
        await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
        expect(drain).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
    });
});
