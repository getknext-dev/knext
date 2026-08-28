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

import { describe, expect, it } from "vitest";
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
    it("carries --compile AND --bytecode AND --minify", () => {
        const argv = compileArgv(
            "linux-arm64",
            ".output/server/index.mjs",
            "out",
        );

        expect(argv).toContain("--compile");
        expect(argv).toContain("--bytecode");
        expect(argv).toContain("--minify");
    });

    it("maps each supported arch to a musl/darwin target triple", () => {
        expect(compileArgv("linux-x64", "e", "o")).toContain(
            "--target=bun-linux-x64-musl",
        );
        expect(compileArgv("linux-arm64", "e", "o")).toContain(
            "--target=bun-linux-arm64-musl",
        );
        expect(compileArgv("darwin-arm64", "e", "o")).toContain(
            "--target=bun-darwin-arm64",
        );
    });

    it("compiles the nitro entry, into the named outfile", () => {
        const argv = compileArgv(
            "linux-x64",
            ".output/server/index.mjs",
            "app",
        );

        expect(argv).toContain(".output/server/index.mjs");
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
