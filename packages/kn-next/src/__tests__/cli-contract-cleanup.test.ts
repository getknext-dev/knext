/**
 * 1.0 contract: `cleanup`'s flags, in its OWN isolated process.
 *
 * `cleanup`'s only non-help flag (`--context`) gates a real `kubectl delete`
 * (ADR-0001: the CLI's one sanctioned cluster write for teardown), so proving
 * it is still ACCEPTED (not rejected as "unknown flag") requires mocking the
 * exec + config seams the same way `gc-main.test.ts` does — kept in its own
 * file so those `mock.module` calls never share a process with
 * `cli-contract.test.ts`'s unmocked imports (the cross-file mock-pollution
 * hazard `require-isolated-process.ts` guards against).
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import { CLI_CONTRACT } from "../cli/contract";

const runQuiet = (() => mock(() => ""))();
mock.module("../cli/exec", () => ({ runQuiet, isEntrypoint: () => false }));

const loadConfig = (() => mock())();
const __knextRealShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig,
}));

import { cleanupMain } from "../cli/cleanup";

const cfg = { name: "my-app", registry: "r" };

beforeEach(() => {
    runQuiet.mockClear();
    loadConfig.mockClear();
});
afterEach(() => jest.restoreAllMocks());

function contractFlags(): string[] {
    const c = CLI_CONTRACT.find((v) => v.verb === "cleanup");
    if (!c) throw new Error('no contract entry for "cleanup"');
    return c.flags.filter((f) => f !== "-h" && f !== "--help");
}

describe("1.0 contract: cleanup flags", () => {
    it("--help returns 0 without loading config or deleting anything", async () => {
        loadConfig.mockResolvedValue(cfg);
        expect(await cleanupMain(["--help"])).toBe(0);
        expect(loadConfig).not.toHaveBeenCalled();
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("every non-help contract flag is accepted (mocked exec, no real kubectl call)", async () => {
        loadConfig.mockResolvedValue(cfg);
        for (const f of contractFlags()) {
            runQuiet.mockClear();
            loadConfig.mockClear();
            const argv = f === "--context" ? [f, "some-context"] : [f];
            expect(await cleanupMain(argv)).toBe(0);
            expect(runQuiet).toHaveBeenCalledTimes(1);
        }
    });

    it("an unknown flag is rejected before any config load or cluster write", async () => {
        await expect(cleanupMain(["--totally-bogus-flag"])).rejects.toThrow(
            /unknown flag/,
        );
        expect(loadConfig).not.toHaveBeenCalled();
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("the contract lists exactly --context beyond help (cleanup's ONE non-destructive-bypassing flag)", () => {
        expect(contractFlags()).toEqual(["--context"]);
    });
});
