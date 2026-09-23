/**
 * `preview.ts`'s `isEntrypoint(import.meta.url)` self-entry dispatcher
 * (around line 514, #1279 — following #1235/#1276's `build.ts` precedent).
 *
 * Unlike `deploy.ts`, `preview.ts`'s dispatcher does NOT route verbs — it is
 * a SANCTIONED directly-runnable entry (its own tsup entry) that always calls
 * ONE function, `preview()`, and the SAME error-handling tail as
 * `build.ts`/`deploy.ts`: `handleConfigNotFound` → exit 1,
 * `handleUsageError` → exit 1, else `log.fatal` + exit 1. Structurally it is
 * closest to `build.ts`'s dispatcher — the difference worth noting is that
 * `preview()`'s SUCCESS path never calls `process.exit` at all (the process
 * just exits naturally at 0), unlike `build.ts`'s success path.
 *
 * Same technique as `build-entrypoint-dispatch.test.ts`: set `process.argv[1]`
 * to the real path of `preview.ts`, mock `process.exit` to THROW a sentinel
 * (never return), and cache-bust a dynamic `import("../cli/preview?bust=N")`
 * so the top-level `if (isEntrypoint(...))` block re-runs on every import.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";

requireIsolatedProcess("preview-entrypoint-dispatch.test.ts");

/**
 * Thrown by the mocked `process.exit` — real `process.exit` never returns.
 * See `build-entrypoint-dispatch.test.ts` for the full rationale.
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
// real module is spread and only `runQuiet` (the default exec boundary
// `runPreviewDestroy` shells out through) is replaced.
const runQuiet = (() => mock((_argv: readonly string[]) => {}))();
const __realExec = { ...(await import("../cli/exec")) };
mock.module("../cli/exec", () => ({
    ...__realExec,
    runQuiet,
}));

const fatal = (() => mock())();
const warn = (() => mock())();
const info = (() => mock())();
mock.module("../utils/logger", () => ({
    createLogger: () => ({ info, warn, error: mock(), debug: mock(), fatal }),
}));

/** Real path of `preview.ts` itself — what `isEntrypoint` must match. */
const PREVIEW_TS_PATH = realpathSync(
    fileURLToPath(new URL("../cli/preview.ts", import.meta.url)),
);

let dir: string;
const savedCwd = process.cwd();
const savedArgv = process.argv;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-preview-entry-"));
    process.chdir(dir);
    capturedWrites = [];
    handleConfigNotFoundCalls.length = 0;
    handleUsageErrorCalls.length = 0;
    loadConfig.mockReset();
    runQuiet.mockReset();
    runQuiet.mockImplementation((_argv: readonly string[]) => {});
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
 * cache-busting importing `preview.ts` fresh, and report the code the
 * (sentinel-throwing) `process.exit` was called with. Every ERROR path calls
 * `process.exit(1)`.
 */
async function runEntrypointExpectingExit(
    flags: readonly string[],
): Promise<{ exitCode: number }> {
    process.argv = [process.argv[0] ?? "node", PREVIEW_TS_PATH, ...flags];
    const originalExit = process.exit;
    let captured: number | undefined;
    process.exit = ((code?: number) => {
        captured = code ?? 0;
        throw new ExitSentinel(captured);
    }) as typeof process.exit;
    try {
        cacheBust += 1;
        await import(`../cli/preview?bust=${cacheBust}`);
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

/**
 * For the SUCCESS path only: `preview()`'s success return never calls
 * `process.exit` (unlike `build.ts`'s dispatcher), so the module import just
 * resolves normally and this asserts `process.exit` was never reached.
 */
async function runEntrypointExpectingNoExit(
    flags: readonly string[],
): Promise<void> {
    process.argv = [process.argv[0] ?? "node", PREVIEW_TS_PATH, ...flags];
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = ((code?: number) => {
        exitCalled = true;
        throw new ExitSentinel(code ?? 0);
    }) as typeof process.exit;
    try {
        cacheBust += 1;
        await import(`../cli/preview?bust=${cacheBust}`);
    } finally {
        process.exit = originalExit;
    }
    if (exitCalled) {
        throw new Error(
            "process.exit was called on the success path — preview()'s success return never calls it",
        );
    }
}

describe("#1279 preview.ts's isEntrypoint dispatcher — the success path", () => {
    it("runs 'preview destroy --pr <n>' end to end without calling process.exit", async () => {
        loadConfig.mockResolvedValue({ name: "my-app", registry: "reg" });

        await runEntrypointExpectingNoExit([
            "destroy",
            "--pr",
            "42",
            "--namespace",
            "previews",
        ]);

        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(runQuiet).toHaveBeenCalledTimes(1);
        const argv = runQuiet.mock.calls[0]?.[0] as string[];
        expect(argv).toEqual([
            "kubectl",
            "delete",
            "nextapp",
            "my-app-pr-42",
            "-n",
            "previews",
            "--ignore-not-found",
        ]);
        // Neither error handler fired, and nothing was logged FATAL.
        expect(handleConfigNotFoundCalls).toEqual([]);
        expect(handleUsageErrorCalls).toEqual([]);
        expect(fatal).not.toHaveBeenCalled();
    });
});

describe("#1279 preview.ts's isEntrypoint dispatcher — the usage-error path", () => {
    it("exits 1 and renders the missing --pr guidance, never reaching loadConfig", async () => {
        const { exitCode } = await runEntrypointExpectingExit(["destroy"]);

        expect(exitCode).toBe(1);
        expect(loadConfig).not.toHaveBeenCalled();
        expect(handleUsageErrorCalls).toHaveLength(1);
        // Called unconditionally FIRST in the catch block — correctly reports
        // false, since a UsageError does not carry a ConfigNotFoundError code.
        expect(handleConfigNotFoundCalls).toHaveLength(1);
        expect(fatal).not.toHaveBeenCalled();
        expect(capturedWrites.join("")).toContain("--pr <n> is required");
    });

    it("exits 1 and renders the missing --branch guidance for 'preview deploy', after loadConfig has run once", async () => {
        loadConfig.mockResolvedValue({ name: "my-app", registry: "reg" });

        const { exitCode } = await runEntrypointExpectingExit([
            "deploy",
            "--pr",
            "42",
        ]);

        expect(exitCode).toBe(1);
        // loadConfig() DOES run before the --branch check (it sits after the
        // config load in preview()), unlike the --pr check above.
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(handleUsageErrorCalls).toHaveLength(1);
        expect(capturedWrites.join("")).toContain("--branch <ref> is required");
    });
});

describe("#1279 preview.ts's isEntrypoint dispatcher — the missing-config path", () => {
    it("exits 1 and renders the missing-config guidance, never reaching log.fatal", async () => {
        loadConfig.mockRejectedValue(
            new ConfigNotFoundError(join(dir, "kn-next.config.ts"), dir),
        );

        const { exitCode } = await runEntrypointExpectingExit([
            "destroy",
            "--pr",
            "42",
        ]);

        expect(exitCode).toBe(1);
        expect(handleConfigNotFoundCalls).toHaveLength(1);
        // process.exit(1) inside the handleConfigNotFound branch halts the
        // dispatcher before handleUsageError is ever reached.
        expect(handleUsageErrorCalls).toHaveLength(0);
        expect(fatal).not.toHaveBeenCalled();
        expect(capturedWrites.join("")).toContain("No kn-next.config.ts found");
    });
});

describe("#1279 preview.ts's isEntrypoint dispatcher — the fatal fallback", () => {
    it('logs FATAL with the "Preview failed" label and exits 1 for a genuine failure neither handler recognises', async () => {
        loadConfig.mockRejectedValue(new Error("disk on fire"));

        const { exitCode } = await runEntrypointExpectingExit([
            "destroy",
            "--pr",
            "42",
        ]);

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
        expect(String(message)).toBe("Preview failed");
        expect((meta.err as Error).message).toBe("disk on fire");
    });

    it("also reaches the fatal fallback when the underlying exec (runQuiet) throws mid-destroy", async () => {
        loadConfig.mockResolvedValue({ name: "my-app", registry: "reg" });
        runQuiet.mockImplementation(() => {
            throw new Error("kubectl: connection refused");
        });

        const { exitCode } = await runEntrypointExpectingExit([
            "destroy",
            "--pr",
            "42",
        ]);

        expect(exitCode).toBe(1);
        expect(fatal).toHaveBeenCalledTimes(1);
        const [meta, message] = fatal.mock.calls[0] as [
            { err: unknown },
            string,
        ];
        expect(String(message)).toBe("Preview failed");
        expect((meta.err as Error).message).toBe("kubectl: connection refused");
    });
});
