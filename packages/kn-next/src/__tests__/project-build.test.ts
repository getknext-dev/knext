/**
 * UX ledger row 4 (4c) — `next: command not found` becomes a plain message.
 *
 * The #810 friendly-error contract covered USAGE mistakes; a deploy-path
 * environment failure (deps not installed, so npm's shell exits 127 on
 * `next build`) still rendered as FATAL + serialized Error. The persona
 * answer is one sentence: run `npm install` first.
 *
 * runProjectBuild is the ONE seam both deploy and build call for the
 * project's build script, so the 127 translation cannot drift between them.
 */

import { describe, expect, it, mock } from "bun:test";
import { runProjectBuild } from "../cli/project-build";
import { handleUsageError, USAGE_ERROR_CODE } from "../cli/shared";

/** What execFileSync throws when the spawned script exits non-zero. */
function exitError(status: number): Error & { status: number } {
    return Object.assign(new Error(`Command failed: npm run build`), {
        status,
    });
}

describe("runProjectBuild", () => {
    it("runs the project's npm build script through the injected runner", () => {
        const run = mock();
        runProjectBuild(run);
        expect(run).toHaveBeenCalledWith(["npm", "run", "build"]);
    });

    it("translates exit 127 (command not found) into plain npm-install guidance", () => {
        const run = mock(() => {
            throw exitError(127);
        });
        let caught: unknown;
        try {
            runProjectBuild(run);
        } catch (err) {
            caught = err;
        }
        expect(caught).toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("npm install"),
        });
        expect((caught as Error).message.toLowerCase()).toContain(
            "not installed",
        );
        // both-streams contract: routed through the same handler every entry
        // already calls, it renders as a message — never a serialized Error.
        const chunks: string[] = [];
        expect(handleUsageError(caught, (t) => chunks.push(t))).toBe(true);
        const out = chunks.join("");
        expect(out).toContain("npm install");
        expect(out).not.toContain("FATAL");
        expect(out).not.toMatch(/\n\s+at\s/);
    });

    it("any other build failure is rethrown untouched (mutation half)", () => {
        const original = exitError(1);
        const run = mock(() => {
            throw original;
        });
        expect(() => runProjectBuild(run)).toThrow(original);
        // and it is NOT dressed up as a usage error
        expect(handleUsageError(original, () => {})).toBe(false);
    });
});

describe("deploy and build both go through the seam (scan, not enumeration)", () => {
    it("no CLI module calls the raw npm build script around the seam", async () => {
        const { readFileSync, readdirSync } = await import("node:fs");
        const { dirname, join, resolve } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const cliDir = join(
            resolve(dirname(fileURLToPath(import.meta.url)), ".."),
            "cli",
        );
        const offenders: string[] = [];
        for (const file of readdirSync(cliDir)) {
            if (!file.endsWith(".ts") || file === "project-build.ts") {
                continue;
            }
            const src = readFileSync(join(cliDir, file), "utf8");
            // quote-style-proof: the formatter may flip string quote style
            if (
                /\[\s*['"]npm['"],\s*['"]run['"],\s*['"]build['"]\s*\]/.test(
                    src,
                )
            ) {
                offenders.push(file);
            }
        }
        expect(
            offenders,
            "call runProjectBuild instead — it owns the exit-127 translation",
        ).toEqual([]);
    });

    it("deploy.ts and build.ts import the seam", async () => {
        const { readFileSync } = await import("node:fs");
        const { dirname, join, resolve } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const cliDir = join(
            resolve(dirname(fileURLToPath(import.meta.url)), ".."),
            "cli",
        );
        for (const file of ["deploy.ts", "build.ts"]) {
            expect(
                readFileSync(join(cliDir, file), "utf8"),
                `${file} must build through runProjectBuild`,
            ).toContain("runProjectBuild(");
        }
    });
});
