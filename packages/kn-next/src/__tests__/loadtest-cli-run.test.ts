/**
 * loadtest.ts — runLoadTestCli success + failure exit-code contract (#30, v3-P6a).
 * The success path loads the config and applies the k6 Job (child_process mocked
 * so no kubectl runs); a config-load failure must leave a stderr breadcrumb and
 * return a NON-ZERO code — never a silent exit(0).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileSync = (() => mock(() => Buffer.from("")))();
const __knextReal1 = { ...(await import("node:child_process")) };
const __knextRealShared = { ...(await import("../cli/shared")) };

mock.module("node:child_process", async () => {
    const actual = __knextReal1;
    const o = { ...actual, execFileSync };
    return {
        ...o,
        default: { ...(actual as { default?: object }).default, execFileSync },
    };
});

const loadConfig = (() => mock())();
// Only loadConfig is faked; handleConfigNotFound stays REAL so this file still
// exercises the true "is this the expected no-config state?" discrimination
// (it must answer no for the generic error below, and let the breadcrumb run).
const __knextReal2 = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    // bun replaces a mocked module WHOLESALE — no partial mock, no
    // automock — so a factory listing only what the test drives drops
    // every other export and the importer dies naming the CONSUMER, not
    // this factory. Spreading keeps it honest as `../cli/shared` grows.
    ...__knextRealShared,
    ...__knextReal2,
    loadConfig,
}));

import { runLoadTestCli } from "../cli/loadtest";

let dir: string;
const savedCwd = process.cwd();

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-lt-cli-"));
    process.chdir(dir);
    execFileSync.mockClear();
    loadConfig.mockReset();
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

describe("runLoadTestCli", () => {
    it("returns 1 with a stderr hint when --url is missing", async () => {
        const stderr = mock();
        expect(await runLoadTestCli([], { stderr })).toBe(1);
        expect(stderr).toHaveBeenCalledWith(
            expect.stringMatching(/--url .* is required/),
        );
    });

    it("returns 1 with a stderr hint for an invalid --type", async () => {
        const stderr = mock();
        expect(
            await runLoadTestCli(["--url", "https://x", "--type", "bogus"], {
                stderr,
            }),
        ).toBe(1);
        expect(stderr).toHaveBeenCalledWith(
            expect.stringMatching(/--type must be one of/),
        );
    });

    it("loads config and applies the Job on the happy path (returns 0)", async () => {
        loadConfig.mockResolvedValue({
            name: "my-app",
            observability: { enabled: true },
        });
        const code = await runLoadTestCli(
            ["--url", "https://app.example.com", "--type", "smoke"],
            { stderr: mock() },
        );
        expect(code).toBe(0);
        expect(execFileSync).toHaveBeenCalledWith(
            "kubectl",
            expect.arrayContaining(["apply", "-f"]),
            expect.anything(),
        );
    });

    it("returns 1 and writes a breadcrumb when config load fails (never silent exit)", async () => {
        loadConfig.mockRejectedValue(new Error("no kn-next.config.ts"));
        const stderr = mock();
        const code = await runLoadTestCli(
            ["--url", "https://app.example.com", "--type", "smoke"],
            { stderr },
        );
        expect(code).toBe(1);
        expect(stderr).toHaveBeenCalledWith(
            expect.stringMatching(
                /failed to start load test: .*kn-next\.config/,
            ),
        );
    });
});
