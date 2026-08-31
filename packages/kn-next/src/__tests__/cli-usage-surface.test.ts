/**
 * Source-level cover for the ADR-0046 usage surface.
 *
 * The behaviour these functions implement is proved end-to-end against the
 * BUILT bin in cli-node-runtime.test.ts — that is the layer that caught the
 * `cleanup --help` deletion and the six FATAL dumps, and it stays the primary
 * guard. But a dist-bin spawn is opaque to V8 coverage: the source files show
 * as uncovered even though every line ran in the child process. These tests
 * exercise the same contracts IN-PROCESS so the coverage number reflects what
 * is actually tested, and so a regression is reported against a line rather
 * than a subprocess exit code.
 *
 * Every assertion here is on observable output — the rendered message, the
 * return code, the argv handed to kubectl — never a bare call that touches a
 * line without checking what it did.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
    spyOn,
} from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfig = (() => mock())();
const __knextReal1 = { ...(await import("../cli/shared")) };
const __knextRealShared = { ...(await import("../cli/shared")) };

mock.module("../cli/shared", () => ({
    // bun replaces a mocked module WHOLESALE — no partial mock, no
    // automock — so a factory listing only what the test drives drops
    // every other export and the importer dies naming the CONSUMER, not
    // this factory. Spreading keeps it honest as `../cli/shared` grows.
    ...__knextRealShared,
    ...__knextReal1,
    loadConfig,
}));

const runQuiet = (() => mock())();
const runCapture = (() => mock(() => ""))();
const kubectlMock = (() =>
    mock(() => ({ ok: false, stdout: "", stderr: "" })),
)();
const __knextReal2 = { ...(await import("../cli/doctor")) };
mock.module("../cli/doctor", () => ({
    ...__knextReal2,
    // statusMain wires kubectl from ./doctor's kubectlRunner (a REAL spawnSync),
    // NOT from ../cli/exec's runCapture — mocking only the latter left this
    // suite spawning real kubectl in CI, where a slow connection-refused dial
    // grazed the 5s timeout (2 flakes in 4 runs). Hermetic now: no child
    // processes, deterministic fast failure past the usage stage.
    kubectlRunner: kubectlMock,
}));
mock.module("../cli/exec", () => ({
    runQuiet,
    runCapture,
    runInherit: mock(),
    isEntrypoint: () => false,
}));

const uploadAssets = (() => mock(async () => undefined))();
const __knextReal3 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    ...__knextReal3,
    uploadAssets,
}));

import { buildMain } from "../cli/build";
import { cleanup, cleanupMain } from "../cli/cleanup";
import { createMain } from "../cli/create";
import {
    formatStrayPositional,
    formatUnknownCommand,
    KNOWN_VERBS,
    resolveInvocation,
    suggestVerb,
} from "../cli/dispatch";
import { parsePreviewArgs } from "../cli/preview";
import { parseRollbackArgs } from "../cli/rollback";
import { handleUsageError, USAGE_ERROR_CODE, UsageError } from "../cli/shared";
import { statusMain } from "../cli/status";

/** Capture what a *Main writes to fd 1 without polluting the test output. */
function captureStdout(): { text: () => string; restore: () => void } {
    const chunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
    });
    return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

const cfg = {
    name: "demo-app",
    registry: "registry.example.com/demo",
    storage: { provider: "gcs" as const, bucket: "demo-assets" },
};

beforeEach(() => {
    loadConfig.mockReset();
    loadConfig.mockResolvedValue(cfg);
    runQuiet.mockReset();
    uploadAssets.mockReset();
    uploadAssets.mockResolvedValue(undefined);
});

describe("cleanupMain — a destructive verb that must not act on a flag", () => {
    it("prints its help and issues NO cluster write", async () => {
        const out = captureStdout();
        try {
            // writeSync(1) bypasses the spy, so assert the effect that matters
            // most (no kubectl) plus the exit code; the help TEXT is asserted
            // against the real bin in cli-node-runtime.test.ts.
            expect(await cleanupMain(["--help"])).toBe(0);
        } finally {
            out.restore();
        }
        expect(runQuiet).not.toHaveBeenCalled();
        expect(loadConfig).not.toHaveBeenCalled();
    });

    it("rejects an unknown flag as a UsageError, without deleting anything", async () => {
        await expect(cleanupMain(["-v"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining('unknown flag "-v"'),
        });
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("rejects a stray positional and says where the app name comes from", async () => {
        await expect(cleanupMain(["myapp"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("kn-next.config.ts"),
        });
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("with no arguments, deletes exactly one NextApp CR and nothing else", async () => {
        expect(await cleanupMain([])).toBe(0);
        expect(runQuiet).toHaveBeenCalledTimes(1);
        expect(runQuiet).toHaveBeenCalledWith([
            "kubectl",
            "delete",
            "nextapp",
            "demo-app",
            "--ignore-not-found",
        ]);
    });
});

describe("cleanup() — ADR-0001: the CR is the only cluster write", () => {
    it("issues the single delete for the configured app", async () => {
        await cleanup();
        expect(runQuiet.mock.calls.map((c) => c[0])).toEqual([
            ["kubectl", "delete", "nextapp", "demo-app", "--ignore-not-found"],
        ]);
    });
});

describe("buildMain — parses its own argv", () => {
    it("prints help and runs no build", async () => {
        expect(await buildMain(["-h"])).toBe(0);
        expect(runQuiet).not.toHaveBeenCalled();
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("rejects an unknown flag before running anything", async () => {
        await expect(buildMain(["--bogus"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining('unknown flag "--bogus"'),
        });
        expect(runQuiet).not.toHaveBeenCalled();
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("rejects a positional — build takes none", async () => {
        await expect(buildMain(["myapp"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("unexpected positional"),
        });
        expect(uploadAssets).not.toHaveBeenCalled();
    });
});

describe("formatStrayPositional — three shapes of the same mistake", () => {
    it("leads with word order when the swallowed token IS a command", () => {
        const text = formatStrayPositional("cleanup");
        expect(text).toContain("unexpected argument: cleanup");
        expect(text).toContain("`cleanup` is a command");
        expect(text).toContain("kn-next cleanup [options]");
        expect(text).toContain("--help");
    });

    it("suggests the nearest command when the token is a near-miss", () => {
        const text = formatStrayPositional("celanup");
        expect(text).toContain("unexpected argument: celanup");
        expect(text).toContain("Did you mean the `cleanup` command?");
        expect(text).toContain("kn-next cleanup [options]");
    });

    it("explains where the app comes from when the token resembles nothing", () => {
        const text = formatStrayPositional("xyzzy");
        expect(text).toContain("unexpected argument: xyzzy");
        expect(text).not.toContain("Did you mean");
        expect(text).toContain("kn-next.config.ts");
    });

    it("quotes a token that would otherwise render as blank", () => {
        expect(formatStrayPositional("")).toContain('unexpected argument: ""');
        expect(formatStrayPositional("two words")).toContain(
            'unexpected argument: "two words"',
        );
    });

    it("never carries a stack frame", () => {
        for (const token of ["cleanup", "celanup", "xyzzy", ""]) {
            expect(formatStrayPositional(token)).not.toMatch(/\n\s+at\s/);
        }
    });
});

describe("suggestVerb / formatUnknownCommand edges", () => {
    it("offers nothing for a one-character token (every verb is 'close')", () => {
        expect(suggestVerb("d")).toBeUndefined();
        expect(suggestVerb("")).toBeUndefined();
    });

    it("holds short tokens to a tighter tolerance than long ones", () => {
        // 4 chars or fewer allow ONE edit: "xd" is two substitutions from
        // "gc", the nearest verb, so nothing is offered.
        expect(suggestVerb("xd")).toBeUndefined();
        expect(suggestVerb("gd")).toBe("gc");
        // Longer tokens allow two: "rollbcak" is a transposition of "rollback".
        expect(suggestVerb("rollbcak")).toBe("rollback");
    });

    it("quotes an empty command in the unknown-command message", () => {
        expect(formatUnknownCommand("")).toContain('unknown command: ""');
    });

    it("routes every known verb without suggesting anything", () => {
        for (const verb of KNOWN_VERBS) {
            expect(suggestVerb(verb)).toBe(verb);
            expect(resolveInvocation(verb).kind).not.toBe("unknown");
        }
    });
});

describe("handleUsageError — the pointer branch and the writer default", () => {
    it("appends a help pointer only when the message carries none", () => {
        const withPointer: string[] = [];
        handleUsageError(
            new UsageError('unknown flag "-q" (see kn-next gc --help)'),
            (t) => withPointer.push(t),
        );
        expect(withPointer.join("")).not.toContain("Run `kn-next --help`");

        const without: string[] = [];
        handleUsageError(new UsageError("app name required"), (t) =>
            without.push(t),
        );
        expect(without.join("")).toContain(
            "Run `kn-next --help` to see the available commands.",
        );
    });

    it("tolerates a code-carrying object with no message", () => {
        const out: string[] = [];
        expect(
            handleUsageError({ code: USAGE_ERROR_CODE }, (t) => out.push(t)),
        ).toBe(true);
        expect(out.join("")).toContain("Run `kn-next --help`");
    });

    it("declines a plain Error, an Error with another code, and a non-object", () => {
        const out: string[] = [];
        const write = (t: string) => out.push(t);
        expect(handleUsageError(new Error("boom"), write)).toBe(false);
        expect(
            handleUsageError(
                Object.assign(new Error("nope"), { code: "ERR_OTHER" }),
                write,
            ),
        ).toBe(false);
        expect(handleUsageError(undefined, write)).toBe(false);
        expect(out).toEqual([]);
    });
});

describe("createMain — usage rejections are messages, real failures still log", () => {
    const savedCwd = process.cwd();
    afterEach(() => process.chdir(savedCwd));

    function captureStderr(): { text: () => string; restore: () => void } {
        const chunks: string[] = [];
        const spy = spyOn(process.stderr, "write").mockImplementation(
            (chunk) => {
                chunks.push(String(chunk));
                return true;
            },
        );
        return {
            text: () => chunks.join(""),
            restore: () => spy.mockRestore(),
        };
    }

    it("rejects an extra positional rather than scaffolding somewhere unintended", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-create-extra-"));
        process.chdir(dir);
        const err = captureStderr();
        const out = captureStdout();
        try {
            expect(await createMain([dir, "extra"])).toBe(1);
        } finally {
            out.restore();
            err.restore();
        }
        expect(err.text()).toContain("unexpected extra argument(s): extra");
    });

    it("renders an invalid app name as a plain message with no serialised Error", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-create-badname-"));
        process.chdir(dir);
        const err = captureStderr();
        const out = captureStdout();
        try {
            expect(await createMain([dir, "--name", "Not_A_Label"])).toBe(1);
        } finally {
            out.restore();
            err.restore();
        }
        const text = err.text();
        expect(text).toContain("invalid app name");
        expect(text).toContain("RFC1123");
        // The UsageError branch returns BEFORE `log.error({ err })`, so no
        // stack frame reaches the user (ADR-0046).
        expect(text).not.toMatch(/\n\s+at\s/);
    });
});

describe("statusMain / parseRollbackArgs / parsePreviewArgs usage rejections", () => {
    const savedCwd = process.cwd();
    afterEach(() => process.chdir(savedCwd));

    it("statusMain refuses when there is no app name and no config", async () => {
        process.chdir(mkdtempSync(join(tmpdir(), "knext-status-noapp-")));
        await expect(statusMain([])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("app name required"),
        });
    });

    it("statusMain refuses --json with --watch (concatenated JSON is not JSON)", async () => {
        await expect(statusMain(["--json", "--watch"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("--json cannot be combined"),
        });
    });

    it("statusMain takes the app from kn-next.config.ts when the positional is absent", async () => {
        // Proves the loadConfig branch is reached, without a cluster: the
        // resolved name is what runStatus would query for, and kubectlRunner
        // (./doctor — the dep statusMain actually wires) is mocked to fail
        // fast, so it gets past the usage stage without spawning anything.
        const dir = mkdtempSync(join(tmpdir(), "knext-status-config-"));
        writeFileSync(join(dir, "kn-next.config.ts"), "export default {};\n");
        process.chdir(dir);
        runCapture.mockReturnValue("");
        await expect(statusMain([])).rejects.not.toMatchObject({
            code: USAGE_ERROR_CODE,
        });
        expect(loadConfig).toHaveBeenCalledTimes(1);
    });

    it("parseRollbackArgs rejects an out-of-range canary", () => {
        expect(() => parseRollbackArgs(["--canary", "500"])).toThrow(
            /--canary must be an integer between 1 and 99/,
        );
        try {
            parseRollbackArgs(["--canary", "500"]);
        } catch (err) {
            expect((err as { code?: string }).code).toBe(USAGE_ERROR_CODE);
        }
    });

    it("parseRollbackArgs rejects --canary without --to", () => {
        try {
            parseRollbackArgs(["--canary", "50"]);
            throw new Error("expected a rejection");
        } catch (err) {
            expect((err as { code?: string }).code).toBe(USAGE_ERROR_CODE);
            expect((err as Error).message).toContain("--canary requires --to");
        }
    });

    it("parsePreviewArgs rejects a missing or unknown subcommand", () => {
        for (const argv of [[], ["frobnicate"]]) {
            try {
                parsePreviewArgs(argv);
                throw new Error(`expected a rejection for ${argv.join(" ")}`);
            } catch (err) {
                expect((err as { code?: string }).code).toBe(USAGE_ERROR_CODE);
                expect((err as Error).message).toContain(
                    'expected subcommand "deploy" or "destroy"',
                );
            }
        }
    });

    it("parsePreviewArgs accepts the two real subcommands", () => {
        expect(parsePreviewArgs(["deploy", "--pr", "42"])).toEqual({
            command: "deploy",
            prId: "42",
            branch: undefined,
            namespace: "default",
        });
        expect(
            parsePreviewArgs(["destroy", "--pr", "7", "-n", "previews"]),
        ).toEqual({
            command: "destroy",
            prId: "7",
            branch: undefined,
            namespace: "previews",
        });
    });
});
