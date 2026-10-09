/**
 * `compile.include` in knext.config.ts → the vinext compile argv.
 * (The compile script's own behaviour is vinext-compile-include.test.ts.)
 */

import { describe, expect, it } from "bun:test";
import {
    compileIncludeGlobs,
    validateCompileConfig,
} from "../cli/compile-config";
import { compileArgv, includeArgv } from "../cli/vinext-build";

const vinext = { build: "vinext" };

describe("validateCompileConfig", () => {
    it("absent compile is fine on every target", () => {
        expect(validateCompileConfig({})).toEqual([]);
        expect(validateCompileConfig({ build: "turbopack" })).toEqual([]);
    });

    it("accepts include on the compiled vinext executable (runtime bun, explicit or default)", () => {
        expect(
            validateCompileConfig({
                ...vinext,
                compile: { include: ["./plugins/*.js"] },
            }),
        ).toEqual([]);
        expect(
            validateCompileConfig({
                ...vinext,
                runtime: "bun",
                compile: { include: ["plugins/**/*.ts"] },
            }),
        ).toEqual([]);
    });

    it.each([
        ["default (turbopack) build", {}],
        ["webpack", { build: "webpack" }],
        [
            "vinext on node (no compile step)",
            { build: "vinext", runtime: "node" },
        ],
    ])("rejects include on %s", (_n, target) => {
        const errs = validateCompileConfig({
            ...target,
            compile: { include: ["./p/*.js"] },
        });
        expect(errs.join("\n")).toContain(
            "supported only on the compiled vinext executable",
        );
    });

    it.each([
        ["a string", "./p/*.js"],
        ["an empty array", []],
        ["a non-string entry", [1]],
        ["a blank entry", ["  "]],
    ])("rejects include as %s", (_n, include) => {
        expect(
            validateCompileConfig({ ...vinext, compile: { include } }).join(
                "\n",
            ),
        ).toContain(
            "'compile.include' must be a non-empty array of glob strings",
        );
    });

    it("rejects a non-object compile and an unknown key", () => {
        expect(validateCompileConfig({ compile: "x" }).join("\n")).toContain(
            "'compile' must be an object",
        );
        expect(
            validateCompileConfig({
                ...vinext,
                compile: { assets: ["x"] },
            }).join("\n"),
        ).toContain("'compile.assets' is not a known option");
    });
});

describe("compileIncludeGlobs + argv", () => {
    it("reads the globs, [] when absent", () => {
        expect(compileIncludeGlobs({})).toEqual([]);
        expect(
            compileIncludeGlobs({ compile: { include: ["a/*.js"] } }),
        ).toEqual(["a/*.js"]);
    });

    it("default compile argv is unchanged (no --include-json)", () => {
        const argv = compileArgv("linux-x64", "e.mjs", "out");
        expect(argv).not.toContain("--include-json");
        expect(compileArgv("linux-x64", "e.mjs", "out", [])).toEqual(argv);
    });

    it("include globs reach the compile script as one --include-json", () => {
        const argv = compileArgv("linux-x64", "e.mjs", "out", [
            "a/*.js",
            "b/x.ts",
        ]);
        expect(argv.slice(-2)).toEqual([
            "--include-json",
            '["a/*.js","b/x.ts"]',
        ]);
        expect(includeArgv([])).toEqual([]);
    });
});
