/**
 * ADR-0048 — the vinext single-executable build path.
 *
 * The flags are asserted rather than described. Dropping `--bytecode` still
 * produces a working binary, just a slow one: 61 ms vs 121 ms measured on
 * otherwise identical source. That is precisely the regression nobody notices
 * without an assertion, because nothing fails — it just gets slower.
 *
 * The Bun floor is tested in BOTH directions. Accepting 1.3.x would ship the
 * slow artifact; rejecting 1.4+ would make the supported target unbuildable.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    buildVinextExecutable,
    bunMeetsFloor,
    compileArgv,
    parseBunVersion,
} from "../cli/vinext-build";

describe("#ADR-0048 the Bun floor", () => {
    it("accepts 1.4.0 and newer", () => {
        for (const v of ["1.4.0", "1.4.7", "1.10.0", "2.0.0"]) {
            expect(bunMeetsFloor(v), `${v} must be accepted`).toBe(true);
        }
    });

    it("REJECTS every Bun below 1.4", () => {
        // 1.3.5 compiles a binary that boots ~2x slower, and cannot serve a
        // Next standalone tree at all (HTTP 500). Both measured.
        for (const v of ["1.3.5", "1.3.14", "1.0.0", "0.8.1"]) {
            expect(bunMeetsFloor(v), `${v} must be rejected`).toBe(false);
        }
    });

    it("compares numerically, not lexically", () => {
        // "1.10.0" < "1.4.0" as strings; a string compare would reject a newer
        // Bun permanently.
        expect(bunMeetsFloor("1.10.0")).toBe(true);
        expect(bunMeetsFloor("1.3.100")).toBe(false);
    });

    it("accepts a 1.4 canary — a prerelease of a release that carries the fix", () => {
        expect(bunMeetsFloor("1.4.0-canary.20260820")).toBe(true);
    });

    it("treats an unparseable version as BELOW the floor", () => {
        // Never guess upward: refusing to build is recoverable, shipping a
        // silently slower binary is not.
        for (const v of ["", "next", "x.y.z", "1"]) {
            expect(bunMeetsFloor(v)).toBe(false);
        }
        expect(parseBunVersion("nope")).toBeUndefined();
    });
});

describe("#ADR-0048 the compile argv", () => {
    it("runs the shipped compile SCRIPT, not a bare `bun build`", () => {
        const argv = compileArgv(
            "linux-arm64",
            ".output/server/index.mjs",
            "out",
        );

        // `bun build` cannot do this job: it has no `--plugin`, and the compile
        // needs two. `--bytecode` emits CommonJS, where the nitro bundle's
        // `import.meta` is a syntax error, and sharp's addon cannot be resolved
        // from inside a compiled binary — without the shim `/_next/image`
        // silently serves unoptimized originals.
        expect(argv.slice(0, 2)).toEqual(["bun", "run"]);
        // Extension-agnostic: the source is `.mjs` and the shipped build emits
        // `.js`, and this guard runs against both.
        expect(argv.join(" ")).toMatch(/vinext-compile\.(m?js)\b/);
        expect(
            argv,
            "a bare `bun build` cannot apply the plugins",
        ).not.toContain("build");
    });

    it("still compiles WITH bytecode — asserted where the flag now lives", () => {
        // The flag moved into the script, so asserting the argv would no longer
        // catch its removal. Dropping `--bytecode` still produces a WORKING
        // binary, just a slow one, which is exactly the regression nobody
        // notices without an assertion.
        const script = readFileSync(
            resolve(
                import.meta.dirname,
                "..",
                "adapters",
                "vinext-compile.mjs",
            ),
            "utf8",
        );
        expect(script, "the compile must enable bytecode").toMatch(
            /bytecode:\s*true/,
        );
        expect(script, "and minify").toMatch(/minify:\s*true/);
        expect(script, "and wire in the sharp dlopen shim").toContain(
            "sharp-addon-dlopen",
        );
    });

    it("maps each supported arch to a musl/darwin target triple", () => {
        // `--target <triple>` as a PAIR now, rather than `--target=<triple>`:
        // the script takes flag/value arguments.
        const targetOf = (arch: string): string | undefined => {
            const argv = compileArgv(arch, "e", "o");
            return argv[argv.indexOf("--target") + 1];
        };
        expect(targetOf("linux-x64")).toBe("bun-linux-x64-musl");
        expect(targetOf("linux-arm64")).toBe("bun-linux-arm64-musl");
        expect(targetOf("darwin-arm64")).toBe("bun-darwin-arm64");
    });

    it("compiles the nitro entry, into the named outfile", () => {
        const argv = compileArgv(
            "linux-x64",
            ".output/server/index.mjs",
            "app",
        );

        expect(argv[argv.indexOf("--entry") + 1]).toBe(
            ".output/server/index.mjs",
        );
        expect(argv[argv.indexOf("--outfile") + 1]).toBe("app");
    });

    it("refuses an unknown arch rather than guessing a triple", () => {
        expect(() => compileArgv("solaris-sparc", "e", "o")).toThrow(
            /solaris-sparc/,
        );
    });
});

describe("#ADR-0048 buildVinextExecutable", () => {
    it("refuses to build under a Bun below the floor, explaining why", () => {
        expect(() =>
            buildVinextExecutable({
                cwd: "/tmp",
                bunVersion: "1.3.5",
                run: () => {
                    throw new Error("must not run the build");
                },
            }),
        ).toThrow(/requires Bun 1\.4\.0 or newer/);
    });

    it("names the measured cost, so the refusal is actionable", () => {
        // A bare "unsupported version" sends someone hunting. The number is
        // the argument.
        let message = "";
        try {
            buildVinextExecutable({
                cwd: "/tmp",
                bunVersion: "1.3.5",
                run: () => {},
            });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toMatch(/121ms|61ms/);
    });

    it("runs vite build BEFORE the compile step", () => {
        const calls: string[][] = [];
        try {
            buildVinextExecutable({
                cwd: "/nonexistent-app",
                bunVersion: "1.4.0",
                run: (argv) => calls.push([...argv]),
            });
        } catch {
            // The `.output` existence check fails on a fake cwd — expected.
            // What matters is the ORDER of what ran before it.
        }
        expect(calls[0]).toEqual(["npx", "vite", "build"]);
    });

    it("fails loudly when vite produced no nitro entry", () => {
        // The #857 shape: a build that exits 0 while emitting nothing runnable
        // must not reach the image step.
        expect(() =>
            buildVinextExecutable({
                cwd: "/nonexistent-app",
                bunVersion: "1.4.0",
                run: () => {},
            }),
        ).toThrow(/\.output.*index\.mjs.*is not there/s);
    });
});
