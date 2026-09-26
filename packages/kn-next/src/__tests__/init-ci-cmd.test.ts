/**
 * `initCiMain` (`packages/kn-next/src/cli/ci/init-ci.ts`'s CLI verb wrapper,
 * `init-ci-cmd.ts`) had NO test coverage at all — `initCi` itself (the pure
 * generator) is well covered by `ci-init-ci.test.ts`, but nothing exercised
 * the verb entry that parses argv, prints `--help`/usage, and enforces
 * `--namespace` before calling it. Pinned hermetically here: real argv
 * parsing and a real `initCi` run against a tmp cwd, with only the output
 * streams captured.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RBAC_PATH, WORKFLOW_PATH } from "../cli/ci/init-ci";
import { initCiMain } from "../cli/ci/init-ci-cmd";

let dir: string;
const savedCwd = process.cwd();

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-init-ci-cmd-"));
    process.chdir(dir);
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
});
