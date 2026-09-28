/**
 * `initCiMain --provider gitlab` (#1534). Mirrors `init-ci-cmd.test.ts`'s
 * hermetic style (real argv parsing, real `initCi` run against a tmp cwd,
 * only the output streams captured) for the provider flag specifically:
 * the file it writes, the default staying byte-for-byte `github`, and
 * `--provider` validation.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RBAC_PATH, WORKFLOW_PATH } from "../cli/ci/init-ci";
import { GITLAB_CI_PATH } from "../cli/ci/init-ci-gitlab";

let dir: string;
const savedCwd = process.cwd();

async function withTmpCwd<T>(fn: () => Promise<T>): Promise<T> {
    dir = mkdtempSync(join(tmpdir(), "knext-init-ci-gitlab-cmd-"));
    process.chdir(dir);
    try {
        return await fn();
    } finally {
        process.chdir(savedCwd);
        rmSync(dir, { recursive: true, force: true });
    }
}

async function runInitCi(argv: string[]) {
    const { initCiMain } = await import("../cli/ci/init-ci-cmd");
    const outSpy = spyOn(process.stdout, "write").mockImplementation(
        () => true,
    );
    const errSpy = spyOn(process.stderr, "write").mockImplementation(
        () => true,
    );
    try {
        const code = await initCiMain(argv);
        const stdout = outSpy.mock.calls.map((c) => String(c[0])).join("");
        const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
        return { code, stdout, stderr };
    } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
    }
}

describe("initCiMain --provider gitlab", () => {
    it("writes .gitlab-ci.yml and the RBAC manifest, not the GitHub workflow", async () => {
        await withTmpCwd(async () => {
            const r = await runInitCi([
                "--namespace",
                "acme",
                "--provider",
                "gitlab",
            ]);
            expect(r.code).toBe(0);
            expect(existsSync(join(dir, GITLAB_CI_PATH))).toBe(true);
            expect(existsSync(join(dir, RBAC_PATH))).toBe(true);
            expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(false);
        });
    });

    it("mentions glab and CI/CD variables in the printed next steps, not gh/repo secrets", async () => {
        await withTmpCwd(async () => {
            const r = await runInitCi([
                "--namespace",
                "acme",
                "--provider",
                "gitlab",
            ]);
            expect(r.stdout).toContain("glab variable set");
            expect(r.stdout).toContain("CI/CD variable");
        });
    });

    it("an unknown --provider is a usage error, exit 1, no files written", async () => {
        await withTmpCwd(async () => {
            const r = await runInitCi([
                "--namespace",
                "acme",
                "--provider",
                "bitbucket",
            ]);
            expect(r.code).toBe(1);
            expect(existsSync(join(dir, GITLAB_CI_PATH))).toBe(false);
            expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(false);
        });
    });

    it("omitting --provider still defaults to github (backward compatible)", async () => {
        await withTmpCwd(async () => {
            const r = await runInitCi(["--namespace", "acme"]);
            expect(r.code).toBe(0);
            expect(existsSync(join(dir, WORKFLOW_PATH))).toBe(true);
            expect(existsSync(join(dir, GITLAB_CI_PATH))).toBe(false);
        });
    });
});
