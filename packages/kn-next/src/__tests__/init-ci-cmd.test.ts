/**
 * `initCiMain` (`packages/kn-next/src/cli/ci/init-ci.ts`'s CLI verb wrapper,
 * `init-ci-cmd.ts`) had NO test coverage at all — `initCi` itself (the pure
 * generator) is well covered by `ci-init-ci.test.ts`, but nothing exercised
 * the verb entry that parses argv, prints `--help`/usage, and enforces
 * `--namespace` before calling it. Pinned hermetically here: real argv
 * parsing and a real `initCi` run against a tmp cwd, with only the output
 * streams captured.
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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #1535 round 2 (B2): pin `initCiMain`'s WIRING to `skippedFileMessage` —
// round 1 covered the generator's pure output (`ci-init-ci.test.ts`) but
// nothing asserted the verb entry actually LOGS it (`log.warn(f)` — the raw
// path, dropping the message entirely — survived as a mutation). Module-
// mocked for the same reason `deploy-orchestrator.test.ts` mocks the logger:
// pino writes through sonic-boom on a raw fd, so patching
// `process.stdout/stderr.write` captures nothing.
//
// `initCiMain` is imported via a top-level `await import(...)` BELOW,
// AFTER this mock is registered — a static `import { initCiMain } from
// "../cli/ci/init-ci-cmd"` at the top of the file would resolve (and cache)
// the real, unmocked `../utils/logger` first, since ES imports are hoisted
// ahead of ordinary statements (the same reason `deploy-orchestrator.test.ts`
// / `db-bind-b2-gaps.test.ts` dynamic-import their module under test).
const logWarn = mock<(...args: unknown[]) => void>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: mock(),
        warn: (...a: unknown[]) => logWarn(...a),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
}));

const { RBAC_PATH, WORKFLOW_PATH, skippedFileMessage } = await import(
    "../cli/ci/init-ci"
);
const { initCiMain } = await import("../cli/ci/init-ci-cmd");

let dir: string;
const savedCwd = process.cwd();

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-init-ci-cmd-"));
    process.chdir(dir);
    logWarn.mockClear();
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

/** Run initCiMain with stdout/stderr captured instead of hitting the real fd. */
async function runInitCi(argv: string[]) {
    const outSpy = spyOn(process.stdout, "write").mockImplementation(
        () => true,
    );
    const errSpy = spyOn(process.stderr, "write").mockImplementation(
        () => true,
    );
    try {
        const code = await initCiMain(argv);
        const stdout = outSpy.mock.calls.map((c) => String(c[0])).join("");
        return { code, stdout };
    } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
    }
}

describe("initCiMain — help and argv strictness", () => {
    it("--help prints usage to stdout and exits 0 without writing files", async () => {
        const r = await runInitCi(["--help"]);

        expect(r.code).toBe(0);
        expect(r.stdout).toContain("knext init-ci");
        expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(false);
        expect(existsSync(join(dir, RBAC_PATH))).toBe(false);
    });

    it("-h is the same as --help", async () => {
        const r = await runInitCi(["-h"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("knext init-ci");
    });

    it("missing --namespace is a usage error, exit 1, no files written", async () => {
        const r = await runInitCi([]);

        expect(r.code).toBe(1);
        expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(false);
        expect(existsSync(join(dir, RBAC_PATH))).toBe(false);
    });

    it("an unparseable flag is a usage error, exit 1", async () => {
        const r = await runInitCi(["--not-a-real-flag"]);
        expect(r.code).toBe(1);
    });
});

describe("initCiMain — success path", () => {
    it("writes both files for the given namespace and prints next steps", async () => {
        const r = await runInitCi(["--namespace", "acme"]);

        expect(r.code).toBe(0);
        expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(true);
        expect(existsSync(join(dir, RBAC_PATH))).toBe(true);
        expect(r.stdout).toContain("acme");
    });

    it("a second run without --force reports the files already exist (no crash)", async () => {
        await runInitCi(["--namespace", "acme"]);
        const r = await runInitCi(["--namespace", "acme"]);

        expect(r.code).toBe(0);
        // Both files from the first run are still there — the second run did
        // not overwrite (or fail to write) anything.
        expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(true);
        expect(existsSync(join(dir, RBAC_PATH))).toBe(true);
    });

    it("--force overwrites files left by a prior run", async () => {
        await runInitCi(["--namespace", "acme"]);
        const r = await runInitCi(["--namespace", "acme", "--force"]);

        expect(r.code).toBe(0);
        expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(true);
        expect(existsSync(join(dir, RBAC_PATH))).toBe(true);
    });

    it("#1535 round 2 — a second run without --force WARNS with the exact skippedFileMessage for each pre-existing file", async () => {
        await runInitCi(["--namespace", "acme"]);
        logWarn.mockClear();

        const r = await runInitCi(["--namespace", "acme"]);

        expect(r.code).toBe(0);
        expect(logWarn).toHaveBeenCalledWith(skippedFileMessage(WORKFLOW_PATH));
        expect(logWarn).toHaveBeenCalledWith(skippedFileMessage(RBAC_PATH));
        // Not the bare path — the mutation this pins turns
        // `log.warn(skippedFileMessage(f))` into `log.warn(f)`.
        expect(logWarn).not.toHaveBeenCalledWith(WORKFLOW_PATH);
        expect(logWarn).not.toHaveBeenCalledWith(RBAC_PATH);
    });
});
