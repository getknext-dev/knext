/**
 * rollback.ts — rollbackMain + the rollback() body (issue #92). Complements
 * rollback-cr.test.ts (runRollback / parseRollbackArgs) by driving the full
 * entry with the side-effecting seams mocked (./exec runQuiet, ./shared
 * loadConfig): help path, pin/canary/clear confirmations, and app-name
 * resolution from config when no positional is given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQuiet = vi.hoisted(() => vi.fn());
vi.mock("../cli/exec", () => ({ runQuiet }));

const loadConfig = vi.hoisted(() =>
    vi.fn(async () => ({ name: "cfg-app", storage: {}, registry: "r" })),
);
vi.mock("../cli/shared", () => ({ loadConfig }));

import { rollbackMain } from "../cli/rollback";

beforeEach(() => {
    runQuiet.mockClear();
    loadConfig.mockClear();
});

afterEach(() => vi.restoreAllMocks());

function patchOf(): Record<string, unknown> {
    const argv = runQuiet.mock.calls.at(-1)?.[0] as string[];
    return JSON.parse(argv[argv.indexOf("-p") + 1]);
}

describe("rollbackMain", () => {
    it("returns 0 for --help without patching", async () => {
        expect(await rollbackMain(["--help"])).toBe(0);
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("pins to a revision via one kubectl patch (app from positional)", async () => {
        expect(await rollbackMain(["my-app", "--to", "my-app-00002"])).toBe(0);
        expect(runQuiet).toHaveBeenCalledTimes(1);
        expect(loadConfig).not.toHaveBeenCalled();
        expect(patchOf()).toEqual({
            spec: { traffic: { revisionName: "my-app-00002" } },
        });
    });

    it("pins with a canary split", async () => {
        await rollbackMain(["my-app", "--to", "rev1", "--canary", "20"]);
        expect(patchOf()).toEqual({
            spec: { traffic: { revisionName: "rev1", canaryPercent: 20 } },
        });
    });

    it("clears the pin (no --to) → spec.traffic: null", async () => {
        await rollbackMain(["my-app"]);
        expect(patchOf()).toEqual({ spec: { traffic: null } });
    });

    it("resolves the app name from config when no positional is given", async () => {
        await rollbackMain(["--to", "rev9"]);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        const argv = runQuiet.mock.calls.at(-1)?.[0] as string[];
        expect(argv).toContain("cfg-app");
    });
});
