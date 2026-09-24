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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    checkTurbopackAdapterStandaloneRegression,
    runProjectBuild,
} from "../cli/project-build";
import { handleUsageError, USAGE_ERROR_CODE } from "../cli/shared";

/** What execFileSync throws when the spawned script exits non-zero. */
function exitError(status: number): Error & { status: number } {
    return Object.assign(new Error(`Command failed: npm run build`), {
        status,
    });
}

/** Make a throwaway app dir under os.tmpdir() with the given package.json body. */
function tmpAppDir(pkgJson: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-projbuild-"));
    if (pkgJson !== null) {
        writeFileSync(join(dir, "package.json"), pkgJson);
    }
    return dir;
}

describe("runProjectBuild", () => {
    it("runs the project's npm build script through the injected runner", () => {
        const run = mock();
        runProjectBuild({ requireEsm: false, run });
        expect(run).toHaveBeenCalledWith(["npm", "run", "build"]);
    });

    it("translates exit 127 (command not found) into plain npm-install guidance", () => {
        const run = mock(() => {
            throw exitError(127);
        });
        let caught: unknown;
        try {
            runProjectBuild({ requireEsm: false, run });
        } catch (err) {
            caught = err;
        }
        // The message is read BEFORE `toMatchObject`, and the asymmetric
        // matcher is gone from it.
        //
        // bun's `toMatchObject` MUTATES the received object: a property checked
        // with `expect.stringContaining(...)` is replaced by the matcher
        // instance itself. Reproduced in isolation — `typeof err.message` goes
        // from "string" to "object" across the call — so every later assertion
        // on that object is meaningless, and here it failed with
        // "message.toLowerCase is not a function" pointing at the code rather
        // than at the assertion that broke it.
        const message = (caught as Error).message;
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect(message).toContain("npm install");
        expect(message.toLowerCase()).toContain("not installed");
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
        expect(() => runProjectBuild({ requireEsm: false, run })).toThrow(
            original,
        );
        // and it is NOT dressed up as a usage error
        expect(handleUsageError(original, () => {})).toBe(false);
    });
});

describe("runProjectBuild ESM preflight (vinext target only)", () => {
    it("requireEsm: true + no `type:module` → throws before the build runs", () => {
        const run = mock();
        const dir = tmpAppDir(JSON.stringify({ name: "app" }));
        try {
            let caught: unknown;
            try {
                runProjectBuild({ requireEsm: true, cwd: dir, run });
            } catch (err) {
                caught = err;
            }
            expect((caught as Error)?.message).toContain('"type": "module"');
            expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
            // fail-fast: the build never spawned
            expect(run).not.toHaveBeenCalledWith(["npm", "run", "build"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("requireEsm: true + `type:commonjs` → throws before the build runs", () => {
        const run = mock();
        const dir = tmpAppDir(JSON.stringify({ type: "commonjs" }));
        try {
            expect(() =>
                runProjectBuild({ requireEsm: true, cwd: dir, run }),
            ).toThrow(/"type": "module"/);
            expect(run).not.toHaveBeenCalledWith(["npm", "run", "build"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("requireEsm: true + `type:module` → passes preflight, runs the build", () => {
        const run = mock();
        const dir = tmpAppDir(JSON.stringify({ type: "module" }));
        try {
            runProjectBuild({ requireEsm: true, cwd: dir, run });
            expect(run).toHaveBeenCalledWith(["npm", "run", "build"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("requireEsm: false (node target) + non-module pkg → does NOT preflight, runs the build", () => {
        const run = mock();
        const dir = tmpAppDir(JSON.stringify({ type: "commonjs" }));
        try {
            runProjectBuild({ requireEsm: false, cwd: dir, run });
            expect(run).toHaveBeenCalledWith(["npm", "run", "build"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("requireEsm: true + `null` package.json → clean UsageError, not a TypeError", () => {
        const run = mock();
        const dir = tmpAppDir("null");
        try {
            let caught: unknown;
            try {
                runProjectBuild({ requireEsm: true, cwd: dir, run });
            } catch (err) {
                caught = err;
            }
            expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
            expect((caught as Error).constructor.name).not.toBe("TypeError");
            expect(run).not.toHaveBeenCalledWith(["npm", "run", "build"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** A throwaway app dir with a package.json AND an installed-looking next version. */
function tmpAppWithNext(
    buildScript: string,
    nextVersion: string | undefined,
): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-turbo-regr-"));
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { build: buildScript } }),
    );
    if (nextVersion !== undefined) {
        mkdirSync(join(dir, "node_modules", "next"), { recursive: true });
        writeFileSync(
            join(dir, "node_modules", "next", "package.json"),
            JSON.stringify({ version: nextVersion }),
        );
    }
    return dir;
}

describe("checkTurbopackAdapterStandaloneRegression (#1372)", () => {
    it("next@16.3.0 + turbopack + a bare `next build` script throws, naming the fix", () => {
        const dir = tmpAppWithNext("next build", "16.3.0");
        try {
            let caught: unknown;
            try {
                checkTurbopackAdapterStandaloneRegression(dir, "turbopack");
            } catch (err) {
                caught = err;
            }
            expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
            const message = (caught as Error).message;
            expect(message).toContain("16.3.0");
            expect(message).toContain("--webpack");
            expect(message).toContain("1372");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("next@16.2.0 (confirmed good) does NOT throw", () => {
        const dir = tmpAppWithNext("next build", "16.2.0");
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "turbopack"),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("next@17.0.0 (future major) also throws — the affected range is open-ended", () => {
        const dir = tmpAppWithNext("next build", "17.0.0");
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "turbopack"),
            ).toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("the webpack builder is never gated, even on an affected next version", () => {
        const dir = tmpAppWithNext("next build --webpack", "16.3.3");
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "webpack"),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("the vinext builder is never gated, even on an affected next version", () => {
        const dir = tmpAppWithNext("vite build", "16.3.3");
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "vinext"),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("an app whose OWN build script already passes --webpack is never blocked (escape hatch 1)", () => {
        const dir = tmpAppWithNext("next build --webpack", "16.3.3");
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "turbopack"),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("an app whose OWN build script already passes --turbopack (explicit) is never blocked", () => {
        const dir = tmpAppWithNext("next build --turbopack", "16.3.3");
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "turbopack"),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a missing node_modules/next (not installed yet) does not throw — best-effort, not a guard failure", () => {
        const dir = tmpAppWithNext("next build", undefined);
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "turbopack"),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a missing package.json does not throw — best-effort, not a guard failure", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-turbo-regr-nopkg-"));
        try {
            expect(() =>
                checkTurbopackAdapterStandaloneRegression(dir, "turbopack"),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("runProjectBuild wires the check in and fails BEFORE the build runs (mutation half)", () => {
        const dir = tmpAppWithNext("next build", "16.3.3");
        const run = mock();
        try {
            expect(() =>
                runProjectBuild({
                    requireEsm: false,
                    cwd: dir,
                    run,
                    builderId: "turbopack",
                }),
            ).toThrow();
            expect(run).not.toHaveBeenCalled();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("runProjectBuild with no builderId skips the check entirely (opt-in, not silently mandatory)", () => {
        const dir = tmpAppWithNext("next build", "16.3.3");
        const run = mock();
        try {
            runProjectBuild({ requireEsm: false, cwd: dir, run });
            expect(run).toHaveBeenCalledWith(["npm", "run", "build"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("every runProjectBuild caller computes requireEsm (scan, not enumeration)", () => {
    it("no CLI runProjectBuild( call omits the requireEsm argument", async () => {
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
            // Match every runProjectBuild( invocation and its argument list up to
            // the balancing close. A call with no `requireEsm` in it is an
            // offender — a future caller cannot silently skip the target gate.
            const calls = src.matchAll(/runProjectBuild\(([\s\S]*?)\)/g);
            for (const m of calls) {
                if (!/requireEsm/.test(m[1])) {
                    offenders.push(`${file}: ${m[0].slice(0, 40)}`);
                }
            }
        }
        expect(
            offenders,
            "pass requireEsm: (config.build ?? 'vinext') === 'vinext'",
        ).toEqual([]);
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
