/**
 * Export-pinning contract for the PUBLIC `@knext/core/validate` subpath.
 *
 * A consumer (e.g. a docs / config-quality CI gate) imports `validateConfig`
 * from `@knext/core/validate` inside their own build/test process. That means
 * two things this test pins:
 *
 *  1. RESOLVABILITY — the subpath is declared in the exports map and resolves to
 *     real compiled JS + `.d.ts` in `dist/`. (The published 0.2.0 only exposed
 *     `./internal/cli-validate`, so a consumer using `@knext/core/validate` hit
 *     ERR_PACKAGE_PATH_NOT_EXPORTED — this locks the fix.)
 *  2. PURITY — importing the module runs NO side effects: no `process.exit`, no
 *     kubectl, no I/O. A consumer imports it into their own process; a stray
 *     side effect (e.g. an exit) would poison their CI run. We assert the public
 *     entry's source import graph is free of those escape hatches, and that a
 *     real import + call behaves as a pure function (throws on bad config,
 *     returns on good config) without terminating the process.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePkgDir = resolve(__dirname, "../..");

// biome-ignore lint/suspicious/noExplicitAny: reading arbitrary package.json shape
const corePkg: any = require(resolve(corePkgDir, "package.json"));

function jsTargetOf(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
        const v = value as Record<string, string>;
        return v.import ?? v.default;
    }
    return undefined;
}

function dtsTargetOf(value: unknown): string | undefined {
    if (value && typeof value === "object") {
        return (value as Record<string, string>).types;
    }
    return undefined;
}

describe("@knext/core/validate — public export pinning", () => {
    it("declares the ./validate subpath in the exports map", () => {
        expect(
            corePkg.exports,
            "@knext/core must publicly export ./validate",
        ).toHaveProperty("./validate");
    });

    it("resolves ./validate to real compiled JS + .d.ts in dist", () => {
        const entry = corePkg.exports["./validate"];
        const js = jsTargetOf(entry);
        const dts = dtsTargetOf(entry);
        expect(js, "./validate must declare a JS target").toBeDefined();
        expect(
            existsSync(resolve(corePkgDir, js as string)),
            `missing built JS for ./validate: ${js}`,
        ).toBe(true);
        expect(dts, "./validate must declare a .d.ts target").toBeDefined();
        expect(dts).toMatch(/\.d\.ts$/);
        expect(
            existsSync(resolve(corePkgDir, dts as string)),
            `missing types for ./validate: ${dts}`,
        ).toBe(true);
    });

    it("exports exactly validateConfig + ConfigValidationError (the result type)", async () => {
        const mod = await import("../validate-public");
        expect(typeof mod.validateConfig).toBe("function");
        expect(typeof mod.ConfigValidationError).toBe("function");
        // Nothing else leaks onto the public surface. Only the two intentional
        // named exports (no default, no kitchen-sink re-export).
        const names = Object.keys(mod).sort();
        expect(names).toEqual(["ConfigValidationError", "validateConfig"]);
    });

    it("behaves as a pure function — throws on bad config, returns on good", async () => {
        const { validateConfig, ConfigValidationError } = await import(
            "../validate-public"
        );
        // Bad config throws the typed error, does NOT exit the process.
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid config
        expect(() => validateConfig({} as any)).toThrow(ConfigValidationError);
        // A minimally-valid config returns void without throwing.
        expect(() =>
            validateConfig({
                name: "app",
                registry: "reg.example/x/y",
                storage: { provider: "gcs", bucket: "b" },
                // biome-ignore lint/suspicious/noExplicitAny: minimal valid shape
            } as any),
        ).not.toThrow();
    });

    it("the public entry's source import graph is side-effect free", () => {
        // The public module and everything it statically imports must not reach
        // for process.exit / kubectl / a shell. A consumer imports this into
        // their own process; an escape hatch here would poison their CI.
        const files = [
            resolve(corePkgDir, "src/validate-public.ts"),
            resolve(corePkgDir, "src/cli/validate.ts"),
            resolve(corePkgDir, "src/config.ts"),
        ];
        // Match actual CALL / IMPORT syntax (a paren, or an import statement), not
        // the words as they appear in prose/docstrings.
        for (const f of files) {
            const src = readFileSync(f, "utf8");
            expect(
                /process\s*\.\s*exit\s*\(/.test(src),
                `${f} must not call process.exit()`,
            ).toBe(false);
            expect(
                /\bfrom\s+["']node:child_process["']|require\(\s*["']node:child_process["']\s*\)|\b(?:execSync|execFileSync|spawnSync|spawn)\s*\(/.test(
                    src,
                ),
                `${f} must not shell out (kubectl / child_process)`,
            ).toBe(false);
        }
    });

    it("importing the public entry as a subprocess does not exit non-zero", () => {
        // Smoke: a fresh Node process that imports the built module and then
        // prints a sentinel must reach the sentinel — i.e. the import itself did
        // not terminate the process via a side effect.
        const entry = jsTargetOf(corePkg.exports["./validate"]);
        const abs = resolve(corePkgDir, entry as string);
        const out = execFileSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import(${JSON.stringify(abs)}).then((m) => { if (typeof m.validateConfig === 'function') console.log('PURE_IMPORT_OK'); });`,
            ],
            { encoding: "utf8" },
        );
        expect(out).toContain("PURE_IMPORT_OK");
    });
});
