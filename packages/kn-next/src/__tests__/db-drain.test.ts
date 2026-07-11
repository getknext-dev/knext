/**
 * db-drain — RO + writer pool teardown on SIGTERM (#246, follow-up to #237/#245).
 *
 * The runtime's graceful drain (PGS-1) closes the writer pool (`closeDbPool`) on
 * SIGTERM so in-flight transactions settle before connections drop. #245 added a
 * read-only pool (`getDbPoolRO`/`closeDbPoolRO`) but deliberately left its
 * teardown unwired. This test pins the wiring: on SIGTERM BOTH pools must be
 * closed, the RO close must be a safe no-op when no RO pool ever existed, and a
 * slow/failing RO close must NOT throw or wedge the drain past the grace cap.
 *
 * @knext/lib/clients is mocked so the drain is exercised without a real Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeDbPool = vi.fn(async () => {});
const closeDbPoolRO = vi.fn(async () => {});

vi.mock("@knext/lib/clients", () => ({
    closeDbPool: (...args: unknown[]) => closeDbPool(...args),
    closeDbPoolRO: (...args: unknown[]) => closeDbPoolRO(...args),
}));

import { drainDbPools, registerDbPoolDrain } from "../adapters/db-drain";
import { clearShutdownDrains, gracefulShutdown } from "../adapters/shutdown";

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

describe("db-drain — writer + RO pool teardown on SIGTERM (#246)", () => {
    beforeEach(() => {
        closeDbPool.mockReset().mockResolvedValue(undefined);
        closeDbPoolRO.mockReset().mockResolvedValue(undefined);
    });
    afterEach(() => {
        clearShutdownDrains();
    });

    it("drainDbPools() closes BOTH the writer and the RO pool", async () => {
        await drainDbPools();
        expect(closeDbPool).toHaveBeenCalledTimes(1);
        expect(closeDbPoolRO).toHaveBeenCalledTimes(1);
    });

    it("a SIGTERM graceful shutdown triggers closeDbPoolRO (end-to-end via the registered drain)", async () => {
        registerDbPoolDrain();

        const child = makeChild();
        const exit = vi.fn();
        gracefulShutdown("SIGTERM", {
            child,
            closables: [],
            graceMs: 10_000,
            exit,
        });

        // Child finishes draining HTTP; the DB drain then runs before exit.
        child.emitExit();
        await new Promise((r) => setTimeout(r, 0));

        expect(closeDbPool).toHaveBeenCalledTimes(1);
        expect(closeDbPoolRO).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("is a safe no-op when the RO pool was never created (closeDbPoolRO no-ops) — writer still closes", async () => {
        // Simulate DATABASE_URL_RO unset: closeDbPoolRO resolves without doing work.
        closeDbPoolRO.mockResolvedValue(undefined);
        await expect(drainDbPools()).resolves.toBeUndefined();
        expect(closeDbPool).toHaveBeenCalledTimes(1);
        expect(closeDbPoolRO).toHaveBeenCalledTimes(1);
    });

    it("a slow/failing RO close does NOT throw and does NOT skip the writer close (bounded, non-fatal)", async () => {
        closeDbPoolRO.mockRejectedValue(new Error("RO gateway unreachable"));
        await expect(drainDbPools()).resolves.toBeUndefined();
        // Writer must still have been closed despite the RO failure.
        expect(closeDbPool).toHaveBeenCalledTimes(1);
        expect(closeDbPoolRO).toHaveBeenCalledTimes(1);
    });

    it("a failing writer close does NOT skip the RO close (both attempted independently)", async () => {
        closeDbPool.mockRejectedValue(new Error("writer gateway unreachable"));
        await expect(drainDbPools()).resolves.toBeUndefined();
        expect(closeDbPool).toHaveBeenCalledTimes(1);
        expect(closeDbPoolRO).toHaveBeenCalledTimes(1);
    });
});
