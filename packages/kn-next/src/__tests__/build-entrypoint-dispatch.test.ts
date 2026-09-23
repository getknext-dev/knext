/**
 * `build.ts`'s `isEntrypoint(import.meta.url)` self-entry dispatcher
 * (lines 455-471, #1235 coverage batch B4 review round 2).
 *
 * This block was previously left deliberately untested, on the assumption
 * that a self-entry dispatcher is only reachable by actually spawning the
 * built bin (`cli-node-runtime.test.ts`'s territory) — the same claim made
 * about `deploy.ts`'s dispatcher. That assumption was wrong: `isEntrypoint`
 * only compares `realpathSync(process.argv[1])` against
 * `realpathSync(fileURLToPath(import.meta.url))`, both of which a test can
 * set. Combined with a CACHE-BUSTING dynamic import (`?search` — a distinct
 * module specifier bun never memoises, so the top-level `if` block runs
 * again on every import) and a `process.exit` spy that THROWS a sentinel
 * (never returns — without the throw, control would fall out of the
 * `handleUsageError`/`handleConfigNotFound` branches into `log.fatal`, which
 * is exactly the bug a bare mock() would hide), the whole block runs
 * in-process. See #1236 for applying the same technique to `deploy.ts`
 * (975-1063) and `preview.ts`'s dispatchers — deliberately NOT touched here
 * (#1271 owns `deploy.ts`, #1273 is in flight on `preview.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";

requireIsolatedProcess("build-entrypoint-dispatch.test.ts");

/**
 * Thrown by the mocked `process.exit` — real `process.exit` never returns.
 *
 * Defined before the `../cli/shared` mock below because it must be checked
 * THERE too: `process.exit(await buildMain(…))` sits INSIDE the
 * dispatcher's own `try`, so when the mocked `process.exit` throws for a
 * SUCCESSFUL run, that throw lands in the dispatcher's own `catch (err)` —
 * not in this test's outer catch — and would otherwise be misread as a
 * build failure (`handleConfigNotFound`/`handleUsageError` called with an
 * `ExitSentinel`, then `log.fatal`). The wrapped handlers below re-throw an
 * `ExitSentinel` immediately instead of touching it, so it escapes the
 * dispatcher's `catch` exactly as a real, unreachable-after `process.exit`
 * would.
 */
class ExitSentinel extends Error {
    constructor(readonly code: number) {
        super(`process.exit(${code})`);
    }
}

const loadConfig = (() => mock())();
const __realShared = { ...(await import("../cli/shared")) };
const { ConfigNotFoundError } = __realShared;

/** Every write `handleConfigNotFound`/`handleUsageError` would have made. */
let capturedWrites: string[];
const handleConfigNotFoundCalls: unknown[] = [];
const handleUsageErrorCalls: unknown[] = [];

/**
 * Wrap the REAL `handleConfigNotFound`/`handleUsageError` rather than
 * replace their logic: the classification (`err.code === …`) and the
 * rendered message stay real, only the `write` sink is redirected — the
 * same injection point `cli-usage-surface.test.ts` uses directly. This is
 * necessary because their DEFAULT sink is `fs.writeSync(2, …)`, which does
 * NOT route through `process.stderr.write` (verified: spying on
 * `process.stderr.write` never sees it) — so it cannot be observed any
 * other way without a heavier `node:fs` mock.
 */
function wrapHandleConfigNotFound(err: unknown): boolean {
    if (err instanceof ExitSentinel) throw err;
    handleConfigNotFoundCalls.push(err);
    return __realShared.handleConfigNotFound(err, (text) => {
        capturedWrites.push(text);
    });
}
function wrapHandleUsageError(err: unknown): boolean {
    if (err instanceof ExitSentinel) throw err;
    handleUsageErrorCalls.push(err);
    return __realShared.handleUsageError(err, (text) => {
        capturedWrites.push(text);
    });
}

mock.module("../cli/shared", () => ({
    ...__realShared,
    loadConfig,
    handleConfigNotFound: wrapHandleConfigNotFound,
    handleUsageError: wrapHandleUsageError,
}));

// `isEntrypoint` MUST stay real — it is the very thing under test — so the
// real module is spread and only `runQuiet` (the project-build shell-out) is
// replaced.
const runQuiet = (() => mock())();
const __realExec = { ...(await import("../cli/exec")) };
mock.module("../cli/exec", () => ({
    ...__realExec,
    runQuiet,
}));

const healBunExportTargets = (() =>
    mock(() => ({ copied: [], skipped: [] })))();
mock.module("../adapters/standalone-bun-exports", () => ({
    healBunExportTargets,
}));

const buildVinextExecutable = (() => mock(() => "knext-exec-linux-x64"))();
const __realVinextBuild = { ...(await import("../cli/vinext-build")) };
mock.module("../cli/vinext-build", () => ({
    ...__realVinextBuild,
    buildVinextExecutable,
}));

const buildStandaloneExecutable = (() =>
    mock(() => "knext-standalone-exec-linux-x64"))();
const __realStandaloneExec = {
    ...(await import("../cli/standalone-exec-build")),
};
mock.module("../cli/standalone-exec-build", () => ({
    ...__realStandaloneExec,
    buildStandaloneExecutable,
}));

const runPostCompileSmoke = (() =>
    mock(async () => ({
        appPort: 1,
        metricsPort: 2,
        healthStatus: 200,
        metricsStatus: 200,
        exitCode: 0,
        bootMs: 1,
        termMs: 1,
    })))();
const __realSmoke = { ...(await import("../cli/postcompile-smoke")) };
mock.module("../cli/postcompile-smoke", () => ({
    ...__realSmoke,
    runPostCompileSmoke,
}));

const fatal = (() => mock())();
const warn = (() => mock())();
const info = (() => mock())();
mock.module("../utils/logger", () => ({
    createLogger: () => ({ info, warn, error: mock(), debug: mock(), fatal }),
}));

/** Real path of `build.ts` itself — what `isEntrypoint` must match. */
const BUILD_TS_PATH = realpathSync(
    fileURLToPath(new URL("../cli/build.ts", import.meta.url)),
);

let dir: string;
const savedCwd = process.cwd();
const savedArgv = process.argv;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-build-entry-"));
    process.chdir(dir);
    capturedWrites = [];
    handleConfigNotFoundCalls.length = 0;
    handleUsageErrorCalls.length = 0;
    loadConfig.mockReset();
    runQuiet.mockReset();
    healBunExportTargets.mockReset();
    healBunExportTargets.mockReturnValue({ copied: [], skipped: [] });
    buildVinextExecutable.mockReset();
    buildVinextExecutable.mockReturnValue("knext-exec-linux-x64");
    buildStandaloneExecutable.mockReset();
    runPostCompileSmoke.mockReset();
    fatal.mockClear();
    warn.mockClear();
    info.mockClear();
});

afterEach(() => {
    process.chdir(savedCwd);
    process.argv = savedArgv;
    rmSync(dir, { recursive: true, force: true });
});

let cacheBust = 0;

/**
 * Set up argv so `isEntrypoint` reads true, run the dispatcher block by
 * cache-busting importing `build.ts` fresh, and report the code the
 * (sentinel-throwing) `process.exit` was called with.
 */
async function runEntrypoint(
    flags: readonly string[],
): Promise<{ exitCode: number }> {
    process.argv = [process.argv[0] ?? "node", BUILD_TS_PATH, ...flags];
    const originalExit = process.exit;
    let captured: number | undefined;
    process.exit = ((code?: number) => {
        captured = code ?? 0;
        throw new ExitSentinel(captured);
    }) as typeof process.exit;
    try {
        cacheBust += 1;
        await import(`../cli/build?bust=${cacheBust}`);
        throw new Error(
            "the dispatcher must call process.exit — it never returned",
        );
    } catch (err) {
        if (!(err instanceof ExitSentinel)) throw err;
    } finally {
        process.exit = originalExit;
    }
    if (captured === undefined) {
        throw new Error("process.exit was never called");
    }
    return { exitCode: captured };
}

describe("#1235 build.ts's isEntrypoint dispatcher — the success path", () => {
    it("exits 0 and runs the default (vinext) build end to end", async () => {
        loadConfig.mockResolvedValue({ name: "my-app", registry: "reg" });

        const { exitCode } = await runEntrypoint([
            "--skip-next",
            "--skip-smoke",
        ]);

        expect(exitCode).toBe(0);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        // The default (vinext) shape compiles the single executable.
        expect(buildVinextExecutable).toHaveBeenCalledTimes(1);
        // Neither error handler fired on a clean run.
        expect(handleConfigNotFoundCalls).toEqual([]);
        expect(handleUsageErrorCalls).toEqual([]);
        expect(fatal).not.toHaveBeenCalled();
    });
});

describe("#1235 build.ts's isEntrypoint dispatcher — the usage-error path", () => {
    it("exits 1 and renders the unknown-flag message, never reaching loadConfig", async () => {
        const { exitCode } = await runEntrypoint(["--bogus"]);

        expect(exitCode).toBe(1);
        expect(loadConfig).not.toHaveBeenCalled();
        expect(handleUsageErrorCalls).toHaveLength(1);
        // Called unconditionally FIRST in the catch block — and correctly
        // reports false, since a UsageError does not carry its code.
        expect(handleConfigNotFoundCalls).toHaveLength(1);
        expect(fatal).not.toHaveBeenCalled();
        expect(capturedWrites.join("")).toContain('unknown flag "--bogus"');
    });
});

describe("#1235 build.ts's isEntrypoint dispatcher — the missing-config path", () => {
    it("exits 1 and renders the missing-config guidance, never reaching log.fatal", async () => {
        loadConfig.mockRejectedValue(
            new ConfigNotFoundError(join(dir, "kn-next.config.ts"), dir),
        );

        const { exitCode } = await runEntrypoint([]);

        expect(exitCode).toBe(1);
        expect(handleConfigNotFoundCalls).toHaveLength(1);
        // process.exit(1) inside the `handleConfigNotFound` branch halts the
        // dispatcher before `handleUsageError` is ever reached.
        expect(handleUsageErrorCalls).toHaveLength(0);
        expect(fatal).not.toHaveBeenCalled();
        expect(capturedWrites.join("")).toContain("No kn-next.config.ts found");
    });
});

describe("#1235 build.ts's isEntrypoint dispatcher — the fatal fallback", () => {
    it("logs FATAL and exits 1 for a genuine failure neither handler recognises", async () => {
        loadConfig.mockRejectedValue(new Error("disk on fire"));

        const { exitCode } = await runEntrypoint([]);

        expect(exitCode).toBe(1);
        expect(handleConfigNotFoundCalls).toHaveLength(1);
        expect(handleUsageErrorCalls).toHaveLength(1);
        // Neither handler recognised it, so nothing was written via their sink.
        expect(capturedWrites).toEqual([]);
        expect(fatal).toHaveBeenCalledTimes(1);
        const [meta, message] = fatal.mock.calls[0] as [
            { err: unknown },
            string,
        ];
        expect(String(message)).toBe("Build failed");
        expect((meta.err as Error).message).toBe("disk on fire");
    });
});
