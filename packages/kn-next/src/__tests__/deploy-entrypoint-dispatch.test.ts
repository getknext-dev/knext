/**
 * `deploy.ts`'s `isEntrypoint(import.meta.url)` self-entry dispatcher
 * (lines 971-1067, #1279 — following #1235/#1276's `build.ts` precedent).
 *
 * This is the ONLY sanctioned `isEntrypoint(import.meta.url)` entry for
 * bin-dispatched modules (see the SELF-ENTRY HAZARD note atop the block in
 * `deploy.ts`), and it does more than `build.ts`'s dispatcher: it ROUTES many
 * verbs (create, init-ci, doctor, status, db, rollback, gc, build, cleanup,
 * validate) via dynamic import + `process.exit(await verbMain(argv))`, plus
 * the historical default deploy flow, plus an ADR-0046 unknown-first-token
 * rejection that happens BEFORE the dispatcher's own try/catch.
 *
 * Same technique as `build-entrypoint-dispatch.test.ts`: set `process.argv[1]`
 * to the real path of `deploy.ts`, mock `process.exit` to THROW a sentinel
 * (never return), and cache-bust a dynamic `import("../cli/deploy?bust=N")` so
 * the top-level `if (isEntrypoint(...))` block re-runs on every import. The
 * same hazard applies: `process.exit(await verbMain(...))` sits INSIDE the
 * dispatcher's own `try`, so a THROWN sentinel for a SUCCESSFUL run lands in
 * the dispatcher's own `catch (err)` unless the wrapped
 * `handleConfigNotFound`/`handleUsageError` mocks re-throw it immediately.
 *
 * Scope: this file tests the DISPATCHER's own control flow — verb routing,
 * the unknown-command / usage-error / config-not-found / fatal-fallback exit
 * contract, and the per-verb `label` selection in the fatal fallback. It does
 * NOT test each verb module's own internals (those have their own test files)
 * or the full `deploy()` success flow (covered by `deploy-orchestrator.test.ts`
 * and friends calling `deploy()` directly) — every verb main below is a full
 * replacement mock, not a spy on real behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";

requireIsolatedProcess("deploy-entrypoint-dispatch.test.ts");

// biome-ignore lint/suspicious/noExplicitAny: mock helper type only
type AnyMock = ReturnType<typeof mock<(...args: any[]) => any>>;

/**
 * Thrown by the mocked `process.exit` — real `process.exit` never returns.
 * See `build-entrypoint-dispatch.test.ts` for the full rationale; the same
 * hazard applies here for every verb whose main is wrapped in
 * `process.exit(await xMain(...))`.
 */
class ExitSentinel extends Error {
    constructor(readonly code: number) {
        super(`process.exit(${code})`);
    }
}

// Real `node:fs`, grabbed via `createRequire` BEFORE `mock.module("node:fs", …)`
// below — a static `import … from "node:fs"` in a file that also mocks
// "node:fs" can bind to the mock instead of the real module (the same hazard
// `deploy-cli-args.test.ts` / `deploy-overrides.test.ts` document).
const { createRequire } = await import("node:module");
const realFs = createRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");
const { mkdtempSync, rmSync, realpathSync } = realFs;

/**
 * Every `fs.writeSync` call the dispatcher makes — specifically the
 * ADR-0046 unknown-command message, written directly to fd 2 (not through
 * `handleConfigNotFound`/`handleUsageError`'s sink).
 */
const writeSyncCalls: Array<[number, string]> = [];
const writeSyncSpy = mock((fd: number, buf: unknown) => {
    writeSyncCalls.push([fd, String(buf)]);
    return String(buf).length;
});
mock.module("node:fs", () => {
    const overrides = {
        writeSync: (...a: unknown[]) =>
            writeSyncSpy(a[0] as number, a[1] as unknown),
    };
    return {
        ...realFs,
        ...overrides,
        default: {
            ...(realFs as unknown as { default?: object }).default,
            ...overrides,
        },
    };
});

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

const fatal = (() => mock())();
const warn = (() => mock())();
const info = (() => mock())();
mock.module("../utils/logger", () => ({
    createLogger: () => ({ info, warn, error: mock(), debug: mock(), fatal }),
}));

// Every dynamically-imported verb module, replaced wholesale — this file
// tests the DISPATCHER's routing, not each verb's own behaviour.
// `create.ts` is ALSO statically imported by `runtime-image.ts` (itself
// statically imported by `deploy.ts`) for `packageRoot` — spread the real
// module so that binding stays real, only `createMain` is replaced.
const createMain: AnyMock = mock(async () => 0);
const __realCreate = { ...(await import("../cli/create")) };
mock.module("../cli/create", () => ({ ...__realCreate, createMain }));

const initCiMain: AnyMock = mock(async () => 0);
mock.module("../cli/ci/init-ci-cmd", () => ({ initCiMain }));

const doctorMain: AnyMock = mock(async () => 0);
mock.module("../cli/doctor", () => ({ doctorMain }));

const statusMain: AnyMock = mock(async () => 0);
mock.module("../cli/status", () => ({ statusMain }));

const dbMain: AnyMock = mock(async () => undefined);
mock.module("../cli/db-bind", () => ({ dbMain }));

const rollbackMain: AnyMock = mock(async () => 0);
mock.module("../cli/rollback", () => ({ rollbackMain }));

// `gc.ts` is ALSO statically imported at the top of `deploy.ts` for
// `runAssetGC` (deploy's own end-of-run retention GC) — spread the real
// module so that binding stays real, only `gcMain` is replaced.
const gcMain: AnyMock = mock(async () => 0);
const __realGc = { ...(await import("../cli/gc")) };
mock.module("../cli/gc", () => ({ ...__realGc, gcMain }));

const buildMain: AnyMock = mock(async () => 0);
mock.module("../cli/build", () => ({ buildMain }));

const cleanupMain: AnyMock = mock(async () => 0);
mock.module("../cli/cleanup", () => ({ cleanupMain }));

const validateMain: AnyMock = mock(async () => 0);
mock.module("../cli/validate-cmd", () => ({ validateMain }));

/** Real path of `deploy.ts` itself — what `isEntrypoint` must match. */
const DEPLOY_TS_PATH = realpathSync(
    fileURLToPath(new URL("../cli/deploy.ts", import.meta.url)),
);

let dir: string;
const savedCwd = process.cwd();
const savedArgv = process.argv;

const ALL_VERB_MOCKS: AnyMock[] = [
    createMain,
    initCiMain,
    doctorMain,
    statusMain,
    dbMain,
    rollbackMain,
    gcMain,
    buildMain,
    cleanupMain,
    validateMain,
];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-deploy-entry-"));
    process.chdir(dir);
    capturedWrites = [];
    writeSyncCalls.length = 0;
    handleConfigNotFoundCalls.length = 0;
    handleUsageErrorCalls.length = 0;
    loadConfig.mockReset();
    fatal.mockClear();
    warn.mockClear();
    info.mockClear();
    for (const m of ALL_VERB_MOCKS) {
        m.mockReset();
        m.mockResolvedValue(m === dbMain ? undefined : 0);
    }
});

afterEach(() => {
    process.chdir(savedCwd);
    process.argv = savedArgv;
    rmSync(dir, { recursive: true, force: true });
});

let cacheBust = 0;

/**
 * Set up argv so `isEntrypoint` reads true, run the dispatcher block by
 * cache-busting importing `deploy.ts` fresh, and report the code the
 * (sentinel-throwing) `process.exit` was called with. For verbs that DO call
 * `process.exit` (every one except `db`) and for the default deploy flow's
 * error paths (all of which call `process.exit(1)`).
 */
async function runEntrypoint(
    argvTail: readonly string[],
): Promise<{ exitCode: number }> {
    process.argv = [process.argv[0] ?? "node", DEPLOY_TS_PATH, ...argvTail];
    const originalExit = process.exit;
    let captured: number | undefined;
    process.exit = ((code?: number) => {
        captured = code ?? 0;
        throw new ExitSentinel(captured);
    }) as typeof process.exit;
    try {
        cacheBust += 1;
        await import(`../cli/deploy?bust=${cacheBust}`);
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
 * For the `db` verb ONLY: `await dbMain(...)` is NOT wrapped in
 * `process.exit(...)` (see deploy.ts:999-1001) — the dispatcher just returns
 * and the process exits naturally. Asserts `process.exit` was never reached.
 */
async function runEntrypointNoExit(argvTail: readonly string[]): Promise<void> {
    process.argv = [process.argv[0] ?? "node", DEPLOY_TS_PATH, ...argvTail];
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = ((code?: number) => {
        exitCalled = true;
        throw new ExitSentinel(code ?? 0);
    }) as typeof process.exit;
    try {
        cacheBust += 1;
        await import(`../cli/deploy?bust=${cacheBust}`);
    } finally {
        process.exit = originalExit;
    }
    if (exitCalled) {
        throw new Error(
            "process.exit was called for the 'db' verb — the dispatcher does not wrap dbMain in process.exit",
        );
    }
}

interface VerbCase {
    verb: string;
    mockFn: AnyMock;
    exitValue: number;
    label: string;
}

/**
 * Every routed verb, its mocked module export, a DISTINCT exit code (proves
 * `process.exit(await xMain(...))` threads the REAL return value rather than
 * a hardcoded `process.exit(0)`), and the fatal-fallback `label` the dispatcher
 * selects for that `sub` — used by both the routing suite and the label suite
 * below.
 */
const VERB_CASES: VerbCase[] = [
    {
        verb: "create",
        mockFn: createMain,
        exitValue: 11,
        label: "create failed",
    },
    {
        verb: "doctor",
        mockFn: doctorMain,
        exitValue: 12,
        label: "doctor failed",
    },
    {
        verb: "status",
        mockFn: statusMain,
        exitValue: 13,
        label: "status failed",
    },
    {
        verb: "rollback",
        mockFn: rollbackMain,
        exitValue: 14,
        label: "rollback failed",
    },
    { verb: "gc", mockFn: gcMain, exitValue: 15, label: "gc failed" },
    { verb: "build", mockFn: buildMain, exitValue: 16, label: "build failed" },
    {
        verb: "cleanup",
        mockFn: cleanupMain,
        exitValue: 17,
        label: "cleanup failed",
    },
    {
        verb: "validate",
        mockFn: validateMain,
        exitValue: 18,
        label: "validate failed",
    },
];

describe("#1279 deploy.ts's isEntrypoint dispatcher — verb routing (success paths)", () => {
    for (const { verb, mockFn, exitValue } of VERB_CASES) {
        it(`routes '${verb}' to its own module with argv.slice(3) and exits with ITS return code (${exitValue})`, async () => {
            mockFn.mockResolvedValue(exitValue);

            const { exitCode } = await runEntrypoint([verb, "--flag", "value"]);

            expect(exitCode).toBe(exitValue);
            expect(mockFn).toHaveBeenCalledTimes(1);
            expect(mockFn.mock.calls[0]?.[0]).toEqual(["--flag", "value"]);
            // No sibling verb — including 'db', which is dispatched differently —
            // fired for this invocation.
            for (const other of ALL_VERB_MOCKS) {
                if (other !== mockFn) expect(other).not.toHaveBeenCalled();
            }
            // Verb dispatch happens BEFORE any deploy-flow work.
            expect(loadConfig).not.toHaveBeenCalled();
            expect(fatal).not.toHaveBeenCalled();
            expect(handleConfigNotFoundCalls).toEqual([]);
            expect(handleUsageErrorCalls).toEqual([]);
        });
    }

    it("routes 'init-ci' to ci/init-ci-cmd's initCiMain with argv.slice(3) and exits with its return code", async () => {
        initCiMain.mockResolvedValue(19);

        const { exitCode } = await runEntrypoint([
            "init-ci",
            "--provider",
            "github",
        ]);

        expect(exitCode).toBe(19);
        expect(initCiMain).toHaveBeenCalledTimes(1);
        expect(initCiMain.mock.calls[0]?.[0]).toEqual(["--provider", "github"]);
        for (const other of ALL_VERB_MOCKS) {
            if (other !== initCiMain) expect(other).not.toHaveBeenCalled();
        }
    });

    it("routes a bare 'deploy' verb through the SAME path as no subcommand at all (both hit the default deploy flow)", async () => {
        // No storage-layer / cluster mocking is wired here, so the real deploy()
        // flow reaches loadConfig() (mocked to reject) almost immediately — this
        // proves 'deploy' does NOT get treated as an unknown/routed verb.
        loadConfig.mockRejectedValue(
            new ConfigNotFoundError(join(dir, "kn-next.config.ts"), dir),
        );

        const { exitCode } = await runEntrypoint(["deploy"]);

        expect(exitCode).toBe(1);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        for (const m of ALL_VERB_MOCKS) expect(m).not.toHaveBeenCalled();
    });
});

describe("#1279 deploy.ts's isEntrypoint dispatcher — 'db' verb (the one exception to the process.exit(await xMain(...)) shape)", () => {
    it("calls dbMain with argv.slice(3) and returns WITHOUT calling process.exit", async () => {
        dbMain.mockResolvedValue(undefined);

        await runEntrypointNoExit(["db", "bind", "--secret", "s"]);

        expect(dbMain).toHaveBeenCalledTimes(1);
        expect(dbMain.mock.calls[0]?.[0]).toEqual(["bind", "--secret", "s"]);
        for (const other of ALL_VERB_MOCKS) {
            if (other !== dbMain) expect(other).not.toHaveBeenCalled();
        }
    });
});

describe("#1279 deploy.ts's isEntrypoint dispatcher — unknown first token (ADR-0046)", () => {
    it("writes the unknown-command message to stderr and exits 1 WITHOUT loading config or dispatching any verb", async () => {
        const { exitCode } = await runEntrypoint(["frobnicate"]);

        expect(exitCode).toBe(1);
        expect(loadConfig).not.toHaveBeenCalled();
        for (const m of ALL_VERB_MOCKS) expect(m).not.toHaveBeenCalled();
        // This exit happens BEFORE the dispatcher's own try/catch — neither
        // handler is invoked, and log.fatal never fires.
        expect(handleConfigNotFoundCalls).toEqual([]);
        expect(handleUsageErrorCalls).toEqual([]);
        expect(fatal).not.toHaveBeenCalled();

        const stderrText = writeSyncCalls
            .filter(([fd]) => fd === 2)
            .map(([, text]) => text)
            .join("");
        expect(stderrText).toContain("unknown command: frobnicate");
    });
});

describe("#1279 deploy.ts's isEntrypoint dispatcher — the usage-error path (default deploy flow)", () => {
    it("exits 1 and renders the unknown-flag message, never reaching loadConfig", async () => {
        const { exitCode } = await runEntrypoint(["--bogus"]);

        expect(exitCode).toBe(1);
        expect(loadConfig).not.toHaveBeenCalled();
        expect(handleUsageErrorCalls).toHaveLength(1);
        // Called unconditionally FIRST in the catch block — correctly reports
        // false, since a UsageError does not carry a ConfigNotFoundError code.
        expect(handleConfigNotFoundCalls).toHaveLength(1);
        expect(fatal).not.toHaveBeenCalled();
        expect(capturedWrites.join("")).toContain("--bogus");
        expect(capturedWrites.join("")).toContain("kn-next --help");
    });
});

describe("#1279 deploy.ts's isEntrypoint dispatcher — the missing-config path (default deploy flow)", () => {
    it("exits 1 and renders the missing-config guidance, never reaching log.fatal", async () => {
        loadConfig.mockRejectedValue(
            new ConfigNotFoundError(join(dir, "kn-next.config.ts"), dir),
        );

        const { exitCode } = await runEntrypoint([]);

        expect(exitCode).toBe(1);
        expect(handleConfigNotFoundCalls).toHaveLength(1);
        // process.exit(1) inside the handleConfigNotFound branch halts the
        // dispatcher before handleUsageError is ever reached.
        expect(handleUsageErrorCalls).toHaveLength(0);
        expect(fatal).not.toHaveBeenCalled();
        expect(capturedWrites.join("")).toContain("No kn-next.config.ts found");
    });
});

describe("#1279 deploy.ts's isEntrypoint dispatcher — the fatal fallback, default deploy flow", () => {
    it('logs FATAL with the "Deployment failed" label and exits 1 for a genuine failure neither handler recognises', async () => {
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
        expect(String(message)).toBe("Deployment failed");
        expect((meta.err as Error).message).toBe("disk on fire");
    });
});

describe("#1279 deploy.ts's isEntrypoint dispatcher — fatal-fallback label selection per verb (mutation coverage of the label ternary)", () => {
    for (const { verb, mockFn, label } of VERB_CASES) {
        it(`labels a '${verb}' failure "${label}"`, async () => {
            mockFn.mockRejectedValue(new Error("boom"));

            const { exitCode } = await runEntrypoint([verb]);

            expect(exitCode).toBe(1);
            expect(fatal).toHaveBeenCalledTimes(1);
            const [meta, message] = fatal.mock.calls[0] as [
                { err: unknown },
                string,
            ];
            expect(String(message)).toBe(label);
            expect((meta.err as Error).message).toBe("boom");
        });
    }

    it("labels a 'db' failure \"db command failed\"", async () => {
        dbMain.mockRejectedValue(new Error("boom"));

        const { exitCode } = await runEntrypoint(["db"]);

        expect(exitCode).toBe(1);
        expect(fatal).toHaveBeenCalledTimes(1);
        const [, message] = fatal.mock.calls[0] as [unknown, string];
        expect(String(message)).toBe("db command failed");
    });

    it("labels an 'init-ci' failure with the DEFAULT \"Deployment failed\" — the ternary has no dedicated branch for it", async () => {
        initCiMain.mockRejectedValue(new Error("boom"));

        const { exitCode } = await runEntrypoint(["init-ci"]);

        expect(exitCode).toBe(1);
        expect(fatal).toHaveBeenCalledTimes(1);
        const [, message] = fatal.mock.calls[0] as [unknown, string];
        expect(String(message)).toBe("Deployment failed");
    });
});

/**
 * Coverage-accounting anchor (#1279). bun's lcov reporter falls back to
 * reporting EVERY line of a file — interface fields and type declarations
 * included — as coverable when no function in that file executed under the
 * canonical module instance. The `?bust=N` instances above are separate module
 * instances, so on their own they leave the canonical `deploy.ts` with FNH=0
 * and inflate the RAW denominator by ~325 non-executable lines (524 -> 849).
 * Calling the exported `deploy()` once through the canonical import is also a
 * real behavioural check: a config-load failure must propagate, not be
 * swallowed, when `deploy()` is called directly (not via the dispatcher).
 */
describe("#1279 deploy() via the canonical import", () => {
    it("propagates a loadConfig failure to its caller", async () => {
        loadConfig.mockRejectedValue(new Error("config exploded"));

        const { deploy } = await import("../cli/deploy");

        await expect(deploy()).rejects.toThrow("config exploded");
        expect(loadConfig).toHaveBeenCalledTimes(1);
    });
});
