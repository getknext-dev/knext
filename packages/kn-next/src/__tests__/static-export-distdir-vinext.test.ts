/**
 * The static-export refusal covers two cases the first version missed:
 *
 *  1. a custom `distDir` - the refusal looked for `.next/export-detail.json`
 *     only, so an app building into `build/` was never refused;
 *  2. the vinext target - it never writes `export-detail.json`, so an
 *     `output: 'export'` app sailed through. It is refused up front, before
 *     the slow `vite build`, from the literal `output` in next.config.
 *
 * Both run the real guard (`runProjectBuild`) against a temp fixture dir.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectBuild } from "../cli/project-build";
import { USAGE_ERROR_CODE } from "../cli/shared";

const scratchDirs: string[] = [];

afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function appDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-export-guard-"));
    scratchDirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }
    return dir;
}

const EXPORT_DETAIL = JSON.stringify({ version: 1, success: true });
const ESM_PKG = JSON.stringify({ type: "module" });

function run(dir: string, requireEsm: boolean) {
    const runner = mock();
    let caught: unknown;
    try {
        runProjectBuild({ requireEsm, cwd: dir, run: runner });
    } catch (err) {
        caught = err;
    }
    return { runner, caught };
}

function expectRefusal(caught: unknown) {
    expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
    const message = (caught as Error).message;
    expect(message).toContain("static export is not a server deployment");
    expect(message).toContain("remove `output: 'export'`");
}

describe("static-export refusal honours a custom distDir", () => {
    it("refuses when export-detail.json is in the configured distDir", () => {
        const dir = appDir({
            "next.config.mjs": "export default { distDir: 'build' };",
            "build/export-detail.json": EXPORT_DETAIL,
        });
        expectRefusal(run(dir, false).caught);
    });

    it("reads the configured distDir, not `.next`: a stray .next file does not refuse", () => {
        const dir = appDir({
            "next.config.mjs": 'export default { distDir: "build" };',
            ".next/export-detail.json": EXPORT_DETAIL,
            "build/.keep": "",
        });
        expect(run(dir, false).caught).toBeUndefined();
    });

    it("ignores a commented-out distDir", () => {
        const dir = appDir({
            "next.config.mjs": "// distDir: 'build'\nexport default {};",
            ".next/export-detail.json": EXPORT_DETAIL,
        });
        expectRefusal(run(dir, false).caught);
    });

    it("still refuses on the default `.next` with no distDir configured", () => {
        const dir = appDir({
            "next.config.mjs": "export default {};",
            ".next/export-detail.json": EXPORT_DETAIL,
        });
        expectRefusal(run(dir, false).caught);
    });

    it("fails closed when next.config exists but cannot be read", () => {
        const dir = appDir({ ".next/.keep": "" });
        // A directory named like the config: it exists, reading it throws.
        mkdirSync(join(dir, "next.config.mjs"));
        const { caught } = run(dir, false);
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect((caught as Error).message).toContain("next.config");
    });
});

describe("vinext target refuses output: 'export'", () => {
    it("refuses before the build runs, with the same actionable message", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": "export default { output: 'export' };",
        });
        const { runner, caught } = run(dir, true);
        expectRefusal(caught);
        expect(runner).not.toHaveBeenCalled();
    });

    it("detects a double-quoted and a .ts config", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.ts": 'export default { output: "export" };',
        });
        expectRefusal(run(dir, true).caught);
    });

    it("lets a normal vinext app build", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": "export default { output: 'standalone' };",
        });
        const { runner, caught } = run(dir, true);
        expect(caught).toBeUndefined();
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it("ignores a commented-out output: 'export'", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": "// output: 'export'\nexport default {};",
        });
        expect(run(dir, true).caught).toBeUndefined();
    });

    it("fails closed on an unreadable next.config", () => {
        const dir = appDir({ "package.json": ESM_PKG });
        mkdirSync(join(dir, "next.config.mjs"));
        const { runner, caught } = run(dir, true);
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect(runner).not.toHaveBeenCalled();
    });

    it("does not pre-refuse the non-vinext target (it is caught after the build)", () => {
        const dir = appDir({
            "next.config.mjs": "export default { output: 'export' };",
        });
        const { runner, caught } = run(dir, false);
        // No export-detail.json was written by the (mock) build, so the
        // node/bun target is not refused here; only vinext reads the config.
        expect(caught).toBeUndefined();
        expect(runner).toHaveBeenCalledTimes(1);
    });
});
