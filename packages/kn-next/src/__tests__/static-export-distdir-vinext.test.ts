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
        runProjectBuild({
            requireEsm,
            runtimeId: "node",
            builderId: requireEsm ? "vinext" : "webpack",
            cwd: dir,
            run: runner,
        });
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

describe("vinext: a conditional or nested output: 'export' warns instead of refusing", () => {
    function runCapturingStderr(dir: string) {
        const writes: string[] = [];
        const original = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        try {
            return { ...run(dir, true), stderr: writes.join("") };
        } finally {
            process.stderr.write = original;
        }
    }

    const cases: Record<string, string> = {
        "conditional spread": `export default { ...(process.env.STATIC ? { output: "export" } : {}) };`,
        "&& spread": `export default { ...(process.env.STATIC && { output: 'export' }) };`,
        "nested in experimental": `export default { experimental: { output: 'export' } };`,
        "inside a function body": `export default () => { return { output: 'export' }; };`,
    };

    for (const [name, config] of Object.entries(cases)) {
        it(`${name}: builds and warns`, () => {
            const dir = appDir({
                "package.json": ESM_PKG,
                "next.config.mjs": config,
            });
            const { runner, caught, stderr } = runCapturingStderr(dir);
            expect(caught).toBeUndefined();
            expect(runner).toHaveBeenCalledTimes(1);
            expect(stderr).toContain("static export");
            expect(stderr).toContain("standalone");
        });
    }

    it("a ternary value is not a literal export, so it builds", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "export default { output: process.env.S ? 'export' : 'standalone' };",
        });
        expect(run(dir, true).caught).toBeUndefined();
    });

    it("an unconditional top-level property is still refused (wrapped in defineConfig too)", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "export default defineConfig({ reactStrictMode: true, output: 'export' });",
        });
        expectRefusal(run(dir, true).caught);
    });

    it("a string containing braces before the property does not confuse the depth", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "export default { basePath: '/{x', output: \"export\" };",
        });
        expectRefusal(run(dir, true).caught);
    });
});

describe("vinext: only the object that is actually exported can be refused", () => {
    const notExported: Record<string, string> = {
        "a non-exported object, export is a ternary of two":
            "const s = { output: 'export' }; const v = { output: 'standalone' }; export default process.env.STATIC ? s : v;",
        "a non-exported object next to module.exports of another":
            "const doc = { output: 'export' }; module.exports = { a: 1 };",
        "a non-exported object next to an empty export default":
            "const o = { output: 'export' }; export default {};",
    };
    for (const [name, config] of Object.entries(notExported)) {
        it(`${name}: builds`, () => {
            const dir = appDir({
                "package.json": ESM_PKG,
                "next.config.mjs": config,
            });
            const { runner, caught } = run(dir, true);
            expect(caught).toBeUndefined();
            expect(runner).toHaveBeenCalledTimes(1);
        });
    }

    const exported: Record<string, string> = {
        "export default <id> binding":
            "const nextConfig = { output: 'export' };\nexport default nextConfig;",
        "typed binding with satisfies":
            "const nextConfig: NextConfig = { output: 'export' };\nexport default nextConfig satisfies NextConfig;",
        "module.exports = <id> binding":
            "const c = { output: 'export' };\nmodule.exports = c;",
        "module.exports inline": "module.exports = { output: 'export' };",
        "arrow returning the object":
            "export default (phase) => ({ output: 'export' });",
        "a string containing a comment opener before the export":
            "export default { basePath: 'a/*b', output: 'export' }; /* c */",
    };
    for (const [name, config] of Object.entries(exported)) {
        it(`${name}: refused`, () => {
            const dir = appDir({
                "package.json": ESM_PKG,
                "next.config.mjs": config,
            });
            expectRefusal(run(dir, true).caught);
        });
    }

    it("an identifier exported through a ternary is not a binding match", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "const s = { output: 'export' };\nexport default process.env.X ? s : {};",
        });
        expect(run(dir, true).caught).toBeUndefined();
    });
});
