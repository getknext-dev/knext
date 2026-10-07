/**
 * The compiled standalone-on-Bun build step (`knext build` with
 * `build: 'turbopack'` + `runtime: 'bun'`).
 *
 * What is asserted, and why each is a real regression rather than a style:
 *
 *   - the compile targets the MUSL triple for the shipped arch — a glibc binary
 *     cannot run in the alpine image at all;
 *   - the Bun floor is enforced (1.3.x cannot serve a standalone tree);
 *   - the produced executable is re-checked for bytecode BY THE CLI, independent
 *     of the compile script: the CLI hands the script a marker and scans the
 *     artifact for it. A script that silently dropped `--bytecode` would ship a
 *     binary that boots and is merely slow — this is the fail-closed guard;
 *   - a missing server.js fails loudly before anything is compiled.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildStandaloneExecutable,
    STANDALONE_EXEC_BASENAME,
    standaloneCompileArgv,
    standaloneCompileScriptPath,
    standaloneExecFileName,
} from "../cli/standalone-exec-build";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function appWithStandalone(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-standalone-exec-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
    writeFileSync(join(dir, ".next", "standalone", "server.js"), "// server\n");
    return dir;
}

/** Fake artifact bytes: what a bytecode compile leaves (see bytecode-exec-verify). */
function bytecodeArtifact(marker: string): Buffer {
    return Buffer.from(
        `ELF…pool:${marker}…// @bun @bytecode @bun-cjs\n(function(){globalThis.m="${marker}";})`,
        "latin1",
    );
}
function plainArtifact(marker: string): Buffer {
    return Buffer.from(
        `ELF…// @bun @bun-cjs\n(function(){globalThis.m="${marker}";})`,
        "latin1",
    );
}

describe("standaloneExecFileName", () => {
    it("names the binary per arch, never after a runtime", () => {
        expect(standaloneExecFileName("linux-x64")).toBe(
            `${STANDALONE_EXEC_BASENAME}-linux-x64`,
        );
        expect(STANDALONE_EXEC_BASENAME).not.toMatch(/\b(bun|node)\b/);
    });

    it("is NOT swallowed by the standalone build context's `knext-exec*` ignore", () => {
        expect(
            standaloneExecFileName("linux-x64").startsWith("knext-exec"),
        ).toBe(false);
    });
});

describe("standaloneCompileArgv", () => {
    const argv = standaloneCompileArgv({
        arch: "linux-x64",
        server: "/a/.next/standalone/server.js",
        root: "/a/.next/standalone",
        outFile: "/a/out",
        marker: "knext-standalone-exec:0123456789abcdef",
    });

    it("runs the shipped compile script under bun", () => {
        expect(argv.slice(0, 3)).toEqual([
            "bun",
            "run",
            standaloneCompileScriptPath(),
        ]);
        // Source tree here (the .mjs); dist resolves the tsup-built .js.
        expect(standaloneCompileScriptPath()).toMatch(
            /adapters[\\/]standalone-compile\.m?js$/,
        );
        expect(existsSync(standaloneCompileScriptPath())).toBe(true);
    });

    it("targets the MUSL triple for the shipped linux arch", () => {
        expect(argv[argv.indexOf("--target") + 1]).toBe("bun-linux-x64-musl");
    });

    it("passes server, root, outfile and the CLI's marker through", () => {
        expect(argv[argv.indexOf("--server") + 1]).toBe(
            "/a/.next/standalone/server.js",
        );
        expect(argv[argv.indexOf("--root") + 1]).toBe("/a/.next/standalone");
        expect(argv[argv.indexOf("--outfile") + 1]).toBe("/a/out");
        expect(argv[argv.indexOf("--marker") + 1]).toBe(
            "knext-standalone-exec:0123456789abcdef",
        );
    });

    it("rejects an unknown arch rather than guessing a triple", () => {
        expect(() =>
            standaloneCompileArgv({
                arch: "sparc",
                server: "s",
                root: "r",
                outFile: "o",
                marker: "m".repeat(20),
            }),
        ).toThrow(/Unknown build arch/);
    });
});

describe("buildStandaloneExecutable", () => {
    it("refuses a Bun below the floor", () => {
        const cwd = appWithStandalone();
        expect(() =>
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.3.5",
                run: () => {},
            }),
        ).toThrow(/requires Bun 1\.4\.0 or newer/);
    });

    it("fails before compiling when the standalone server.js is missing", () => {
        const cwd = mkdtempSync(
            join(tmpdir(), "knext-standalone-exec-missing-"),
        );
        tempDirs.push(cwd);
        const ran: string[][] = [];
        expect(() =>
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run: (a) => ran.push([...a]),
            }),
        ).toThrow(/server\.js/);
        expect(ran).toHaveLength(0);
    });

    it("a nested standalone layout names the workspace root and the fix instead of blaming output: standalone", () => {
        const made = mkdtempSync(join(tmpdir(), "knext-standalone-nested-"));
        tempDirs.push(made);
        const base = realpathSync(made);
        writeFileSync(join(base, "package-lock.json"), "{}");
        const cwd = join(base, "my-app");
        mkdirSync(join(cwd, ".next", "standalone", "my-app"), {
            recursive: true,
        });
        writeFileSync(
            join(cwd, ".next", "standalone", "my-app", "server.js"),
            "// nested\n",
        );
        const ran: string[][] = [];
        let message = "";
        try {
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run: (a) => ran.push([...a]),
            });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain(base);
        expect(message).toContain("package-lock.json");
        expect(message).toContain("outputFileTracingRoot");
        expect(ran).toHaveLength(0);
    });

    it("compiles, then VERIFIES the artifact carries bytecode for the CLI's marker", () => {
        const cwd = appWithStandalone();
        let marker = "";
        const out = buildStandaloneExecutable({
            cwd,
            arch: "linux-x64",
            bunVersion: "1.4.2",
            run: (a) => {
                marker = a[a.indexOf("--marker") + 1];
            },
            readArtifact: () => bytecodeArtifact(marker),
        });
        expect(out).toBe(join(cwd, standaloneExecFileName("linux-x64")));
        expect(marker).toMatch(/^knext-standalone-exec:[0-9a-f]{24}$/);
    });

    it("FAILS the build when the artifact was compiled without bytecode", () => {
        const cwd = appWithStandalone();
        let marker = "";
        expect(() =>
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run: (a) => {
                    marker = a[a.indexOf("--marker") + 1];
                },
                readArtifact: () => plainArtifact(marker),
            }),
        ).toThrow(/bytecode/);
    });

    it("FAILS the build when the artifact is not the one this build compiled (stale marker)", () => {
        const cwd = appWithStandalone();
        expect(() =>
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run: () => {},
                readArtifact: () =>
                    bytecodeArtifact(
                        "knext-standalone-exec:stale00000000000000000000",
                    ),
            }),
        ).toThrow(/marker/);
    });

    it("uses a fresh marker per build", () => {
        const markers: string[] = [];
        for (let i = 0; i < 2; i++) {
            const cwd = appWithStandalone();
            let marker = "";
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run: (a) => {
                    marker = a[a.indexOf("--marker") + 1];
                },
                readArtifact: () => bytecodeArtifact(marker),
            });
            markers.push(marker);
        }
        expect(markers[0]).not.toBe(markers[1]);
    });
});

describe("self-contained mode (#1456)", () => {
    const args = {
        arch: "linux-x64",
        server: "/a/server.js",
        root: "/a",
        outFile: "/a/x",
        marker: "m",
    };

    it("the compile argv gains --self-contained 1 only when on; disk mode's argv is unchanged", () => {
        const disk = standaloneCompileArgv(args);
        expect(disk).not.toContain("--self-contained");
        expect(
            standaloneCompileArgv({ ...args, selfContained: false }),
        ).toEqual(disk);
        expect(standaloneCompileArgv({ ...args, selfContained: true })).toEqual(
            [...disk, "--self-contained", "1"],
        );
    });

    it("verifies a self-contained artifact with the embedded proof (route chunk 0 must carry bytecode)", () => {
        const cwd = appWithStandalone();
        let marker = "";
        const run = (argv: readonly string[]) => {
            marker = argv[argv.indexOf("--marker") + 1] as string;
        };
        const withRoute = (m: string) =>
            Buffer.from(
                `ELF\0pool:${m}\0${m}:route:0:\0// @bun @bytecode @bun-cjs\n(function(){globalThis.m="${m}";globalThis.r="${m}:route:0:";})`,
                "latin1",
            );
        expect(
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run,
                selfContained: true,
                readArtifact: () => withRoute(marker),
            }),
        ).toBe(join(cwd, standaloneExecFileName("linux-x64")));
        // the disk-mode artifact shape carries no route chunk: refused in self-contained mode
        expect(() =>
            buildStandaloneExecutable({
                cwd,
                arch: "linux-x64",
                bunVersion: "1.4.2",
                run,
                selfContained: true,
                readArtifact: () => bytecodeArtifact(marker),
            }),
        ).toThrow(/route chunk 0/);
    });
});
