/**
 * #1233 (coverage batch B2) — deploy.ts's `parseCliArgs` early-exit paths.
 *
 * `--help`, `--version`, and a stray positional (ADR-0046) all resolve BEFORE
 * `loadConfig()` — no cluster/exec/asset mocking is needed to reach them, only
 * a `node:fs` `writeSync` spy (the sync-flush write these paths use, #68) and a
 * `process.exit` stub that unwinds the call instead of killing the test
 * process. `getCliVersion()`'s try/catch (both the happy path reading the real
 * package.json and the fallback when `readFileSync` throws) is exercised via
 * `--version`, the only caller.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/** Set per test to control the `node:fs` `readFileSync` mock's behaviour. */
let readFileSyncImpl: ((...a: unknown[]) => string) | null = null;

const writeSyncCalls: Array<[number, string]> = [];
const writeSyncSpy = mock((fd: number, buf: unknown) => {
    writeSyncCalls.push([fd, String(buf)]);
    return String(buf).length;
});

const { createRequire } = await import("node:module");
const realFs = createRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

mock.module("node:fs", () => {
    const overrides = {
        writeSync: (...a: unknown[]) =>
            writeSyncSpy(a[0] as number, a[1] as unknown),
        readFileSync: (...a: unknown[]) =>
            readFileSyncImpl
                ? readFileSyncImpl(...a)
                : (realFs.readFileSync as (...x: unknown[]) => string)(...a),
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

/** Sentinel thrown by the `process.exit` stub so a test can assert on the code. */
class ProcessExitCalled extends Error {
    constructor(public code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

const savedArgv = process.argv;
const savedExit = process.exit;

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

beforeEach(() => {
    writeSyncCalls.length = 0;
    readFileSyncImpl = null;
    process.exit = ((code?: number) => {
        throw new ProcessExitCalled(code);
        // biome-ignore lint/suspicious/noExplicitAny: matching process.exit's overload set is not the point here
    }) as any;
});

afterEach(() => {
    process.argv = savedArgv;
    process.exit = savedExit;
});

describe("deploy — --version (getCliVersion + exit 0)", () => {
    it("prints the real package.json version to fd 1 and exits 0", async () => {
        setArgv(["deploy", "--version"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(ProcessExitCalled);

        expect(writeSyncCalls.length).toBe(1);
        const [fd, text] = writeSyncCalls[0];
        expect(fd).toBe(1);
        // A real semver-shaped version, not the "readFileSync threw" fallback.
        expect(text.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("falls back to 0.0.0 when the package.json read throws", async () => {
        readFileSyncImpl = () => {
            throw new Error("ENOENT");
        };
        setArgv(["deploy", "--version"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(ProcessExitCalled);

        expect(writeSyncCalls.length).toBe(1);
        expect(writeSyncCalls[0][1].trim()).toBe("0.0.0");
    });

    it("falls back to 0.0.0 when package.json has no version field", async () => {
        readFileSyncImpl = () => "{}";
        setArgv(["deploy", "--version"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(ProcessExitCalled);

        expect(writeSyncCalls[0][1].trim()).toBe("0.0.0");
    });
});

describe("deploy — --help (exit 0)", () => {
    it("prints the CLI help text to fd 1 and exits 0", async () => {
        setArgv(["deploy", "--help"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(ProcessExitCalled);

        expect(writeSyncCalls.length).toBe(1);
        const [fd, text] = writeSyncCalls[0];
        expect(fd).toBe(1);
        expect(text).toContain("kn-next deploy");
    });
});

describe("deploy — parseArgs' own failure on an unknown flag", () => {
    it("wraps node:util's ERR_PARSE_ARGS_UNKNOWN_OPTION as a UsageError pointing at --help", async () => {
        setArgv(["deploy", "--skip-buildd"]);
        const deploy = await importDeploy();

        let thrown: Error | undefined;
        try {
            await deploy();
        } catch (e) {
            thrown = e as Error;
        }
        // Not a ProcessExitCalled: parseArgs' own throw is wrapped and
        // propagated as a rejection, not translated into an exit here —
        // the dispatcher (isEntrypoint block) is what turns a UsageError
        // into exit(1), and it is not in play for a direct deploy() call.
        expect(thrown).toBeDefined();
        expect(thrown).not.toBeInstanceOf(ProcessExitCalled);
        expect(thrown?.message).toContain("(see kn-next --help)");
    });
});

describe("deploy — stray positional after `deploy` (ADR-0046, exit 1)", () => {
    it("rejects a trailing verb-shaped positional, writes to fd 2, exits 1", async () => {
        setArgv(["deploy", "cleanup"]);
        const deploy = await importDeploy();

        let thrown: unknown;
        try {
            await deploy();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(ProcessExitCalled);
        expect((thrown as ProcessExitCalled).code).toBe(1);

        expect(writeSyncCalls.length).toBe(1);
        const [fd, text] = writeSyncCalls[0];
        expect(fd).toBe(2);
        expect(text).toContain("cleanup");
    });

    it("still rejects the stray positional when flags precede it (--namespace prod cleanup)", async () => {
        setArgv(["deploy", "--namespace", "prod", "cleanup"]);
        const deploy = await importDeploy();

        let thrown: unknown;
        try {
            await deploy();
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(ProcessExitCalled);
        expect((thrown as ProcessExitCalled).code).toBe(1);
    });
});
