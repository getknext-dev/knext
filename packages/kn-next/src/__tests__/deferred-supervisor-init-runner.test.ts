/**
 * deferred-supervisor-init.ts — createDeferredSupervisorInit + isSupervisorInitDeferred.
 * The runner executes each deferred step exactly once, is concurrency-safe, and
 * NEVER rejects: a throwing step is logged and the rest still run (this path runs
 * after the child already serves traffic).
 */

import { describe, expect, it, mock } from "bun:test";
import {
    createDeferredSupervisorInit,
    DEFER_SUPERVISOR_INIT_ENV,
    isSupervisorInitDeferred,
} from "../adapters/deferred-supervisor-init";

describe("isSupervisorInitDeferred", () => {
    it("defaults to deferred (true) when the knob is unset", () => {
        expect(isSupervisorInitDeferred({})).toBe(true);
    });

    it("opts out only for explicit 0/false (case/space tolerant)", () => {
        expect(
            isSupervisorInitDeferred({ [DEFER_SUPERVISOR_INIT_ENV]: "0" }),
        ).toBe(false);
        expect(
            isSupervisorInitDeferred({
                [DEFER_SUPERVISOR_INIT_ENV]: " False ",
            }),
        ).toBe(false);
        expect(
            isSupervisorInitDeferred({ [DEFER_SUPERVISOR_INIT_ENV]: "1" }),
        ).toBe(true);
    });
});

describe("createDeferredSupervisorInit", () => {
    it("runs every step exactly once and reports started", async () => {
        const a = mock();
        const b = mock(async () => {});
        const init = createDeferredSupervisorInit({
            steps: [
                { name: "a", run: a },
                { name: "b", run: b },
            ],
        });
        expect(init.isStarted()).toBe(false);

        await init.ensureStarted("child-serving");
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        expect(init.isStarted()).toBe(true);

        // Idempotent: a second trigger does not re-run the steps.
        await init.ensureStarted("scrape");
        expect(a).toHaveBeenCalledTimes(1);
    });

    it("never rejects — a throwing step is logged and the rest still run", async () => {
        const warn = mock();
        const info = mock();
        const good = mock();
        const init = createDeferredSupervisorInit({
            log: { warn, info },
            steps: [
                {
                    name: "bad",
                    run: () => {
                        throw new Error("step boom");
                    },
                },
                { name: "good", run: good },
            ],
        });

        await expect(init.ensureStarted("x")).resolves.toBeUndefined();
        expect(good).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ step: "bad" }),
            expect.stringContaining("Deferred supervisor init step failed"),
        );
        expect(info).toHaveBeenCalled(); // completion log
    });

    it("concurrent triggers share the same in-flight run", async () => {
        let running = 0;
        let maxConcurrent = 0;
        const init = createDeferredSupervisorInit({
            steps: [
                {
                    name: "slow",
                    run: async () => {
                        running++;
                        maxConcurrent = Math.max(maxConcurrent, running);
                        await new Promise((r) => setTimeout(r, 5));
                        running--;
                    },
                },
            ],
        });
        await Promise.all([init.ensureStarted("a"), init.ensureStarted("b")]);
        expect(maxConcurrent).toBe(1);
    });
});
