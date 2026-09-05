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

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    buildVinextExecutable,
    bunMeetsFloor,
    compileArgv,
    extractVerifiedTarball,
    fetchImgPackage,
    parseBunVersion,
    SHARP_PLATFORM_IDS,
    stageSharpNative,
} from "../cli/vinext-build";

/** Every temp dir this file creates, drained after the run (D9, #880). */
const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

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

/**
 * #949 — the S3-V finding C-1a: `stageSharpNative` copied whatever the BUILD
 * HOST's install held under `node_modules/@img`. On a mac that is the darwin
 * addon set, the alpine image shipped with no linuxmusl addon at all, and every
 * macOS-built deploy crash-looped at import. Staging must follow the IMAGE
 * TARGET, fetching the pinned target packages when the host install lacks them.
 */
describe("#949 stageSharpNative stages the image target's platform, not the host's", () => {
    const SHARP_V = "0.35.4";
    const VIPS_V = "1.3.3";

    /** bun.lock's real JSONC shape (trailing commas), as bun writes it. */
    function lockText(entries: Record<string, string | undefined>): string {
        const lines = Object.entries(entries)
            .filter(([, v]) => v !== undefined)
            .map(
                ([name, v]) =>
                    `    ${JSON.stringify(name)}: [${JSON.stringify(`${name}@${v}`)}, "", {}, "sha512-pin/${name.length}=="],`,
            );
        return `{\n  "lockfileVersion": 1,\n  "packages": {\n${lines.join("\n")}\n  }\n}\n`;
    }

    const FULL_LOCK: Record<string, string> = {
        "@img/sharp-darwin-arm64": SHARP_V,
        "@img/sharp-libvips-darwin-arm64": VIPS_V,
        "@img/sharp-linuxmusl-x64": SHARP_V,
        "@img/sharp-libvips-linuxmusl-x64": VIPS_V,
        "@img/sharp-wasm32": SHARP_V,
    };

    /** An app tree as a darwin host's `bun install` leaves it. */
    function darwinAppTree(
        lock: Record<string, string | undefined> = FULL_LOCK,
        hostPkgs: Record<string, string> = {
            "sharp-darwin-arm64": SHARP_V,
            "sharp-libvips-darwin-arm64": VIPS_V,
            "sharp-wasm32": SHARP_V,
        },
    ): string {
        const cwd = tempDir("knext-949-stage-");
        for (const [dir, version] of Object.entries(hostPkgs)) {
            const pkgDir = join(cwd, "node_modules", "@img", dir);
            mkdirSync(join(pkgDir, "lib"), { recursive: true });
            writeFileSync(
                join(pkgDir, "package.json"),
                JSON.stringify({ name: `@img/${dir}`, version }),
            );
            writeFileSync(join(pkgDir, "lib", `${dir}.node`), `${dir} BYTES`);
        }
        writeFileSync(join(cwd, "bun.lock"), lockText(lock));
        return cwd;
    }

    /** A fetch stub that stages a plausible extracted package, and records. */
    function recordingFetch(): {
        calls: { name: string; version: string; integrity: string | null }[];
        fetch: (
            pkg: { name: string; version: string; integrity: string | null },
            destDir: string,
        ) => void;
    } {
        const calls: {
            name: string;
            version: string;
            integrity: string | null;
        }[] = [];
        return {
            calls,
            fetch: (pkg, destDir) => {
                calls.push({ ...pkg });
                mkdirSync(join(destDir, "lib"), { recursive: true });
                writeFileSync(
                    join(destDir, "package.json"),
                    JSON.stringify({ name: pkg.name, version: pkg.version }),
                );
                writeFileSync(
                    join(destDir, "lib", "addon.node"),
                    `${pkg.name} FETCHED`,
                );
            },
        };
    }

    it("fetches the linuxmusl set a darwin host lacks, and EXCLUDES the host's own addons", () => {
        const cwd = darwinAppTree();
        const { calls, fetch } = recordingFetch();

        stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch });

        const staged = readdirSync(join(cwd, "native")).sort();
        expect(staged).toContain("sharp-linuxmusl-x64");
        expect(staged).toContain("sharp-libvips-linuxmusl-x64");
        // The host's platform must NOT ship: darwin sorts before linuxmusl, and
        // an image carrying both is one shim bug away from `Exec format error`.
        expect(staged).not.toContain("sharp-darwin-arm64");
        expect(staged).not.toContain("sharp-libvips-darwin-arm64");
        expect(staged).not.toContain("sharp-wasm32");

        // Fetched at the exact versions the lockfile pins — never `latest`.
        expect(calls.map((c) => `${c.name}@${c.version}`).sort()).toEqual([
            `@img/sharp-libvips-linuxmusl-x64@${VIPS_V}`,
            `@img/sharp-linuxmusl-x64@${SHARP_V}`,
        ]);
        for (const c of calls) expect(c.integrity).toMatch(/^sha512-/);

        // And the staged tree still gets its integrity manifest, covering the
        // fetched files.
        const manifest = JSON.parse(
            readFileSync(join(cwd, "native", ".integrity.json"), "utf8"),
        );
        expect(Object.keys(manifest.packages).sort()).toEqual([
            "@img/sharp-libvips-linuxmusl-x64",
            "@img/sharp-linuxmusl-x64",
        ]);
        expect(
            manifest.files["sharp-linuxmusl-x64/lib/addon.node"],
        ).toBeDefined();
    });

    /**
     * The reproduced #954 reality (S3-V Finding B-3): bun hoisted NEXT's
     * sharp 0.34 pin to the bare keys, and the app's own ^0.35 resolution
     * lives under nested keys. This fixture deliberately matches the
     * native-integrity.test.ts one — the bare key is next's pin, NOT the
     * app's — because which version wins the hoist is bun's choice, which is
     * exactly why the fetch path cannot trust any single lockfile entry.
     */
    function twoVersionLock(): string {
        return (
            `{\n  "lockfileVersion": 1,\n  "packages": {\n` +
            `    "@img/sharp-linuxmusl-x64": ["@img/sharp-linuxmusl-x64@0.34.5", "", {}, "sha512-imgnext=="],\n` +
            `    "@img/sharp-libvips-linuxmusl-x64": ["@img/sharp-libvips-linuxmusl-x64@1.2.9", "", {}, "sha512-vnext=="],\n` +
            `    "myapp/@img/sharp-linuxmusl-x64": ["@img/sharp-linuxmusl-x64@${SHARP_V}", "", {}, "sha512-imgapp=="],\n` +
            `    "myapp/@img/sharp-libvips-linuxmusl-x64": ["@img/sharp-libvips-linuxmusl-x64@${VIPS_V}", "", {}, "sha512-vapp=="],\n` +
            `  }\n}\n`
        );
    }

    /** The app's RESOLVED sharp install — what its bundle actually loads. */
    function writeSharpManifest(
        cwd: string,
        version: string,
        imgPins: Record<string, string>,
    ): void {
        const dir = join(cwd, "node_modules", "sharp");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name: "sharp",
                version,
                optionalDependencies: imgPins,
            }),
        );
    }

    it("fetches the version the app's sharp RESOLVED, not whichever lockfile entry is first (#954)", () => {
        // The silent-mismatch shape both reviewers flagged: with two pins in
        // the lock, ANY fetched version passes the integrity manifest (it IS
        // in the lock) — so fetching the wrong one ships @img 0.34.5 beside a
        // bundled sharp 0.35.4 without a single red gate. The app's resolved
        // sharp manifest is the disambiguator: its optionalDependencies pin
        // the exact @img versions its loader expects.
        const cwd = tempDir("knext-954-fetch-");
        writeFileSync(join(cwd, "bun.lock"), twoVersionLock());
        writeSharpManifest(cwd, SHARP_V, {
            "@img/sharp-linuxmusl-x64": SHARP_V,
            "@img/sharp-libvips-linuxmusl-x64": VIPS_V,
        });
        const { calls, fetch } = recordingFetch();

        stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch });

        expect(calls.map((c) => `${c.name}@${c.version}`).sort()).toEqual([
            `@img/sharp-libvips-linuxmusl-x64@${VIPS_V}`,
            `@img/sharp-linuxmusl-x64@${SHARP_V}`,
        ]);
        // The MATCHED entries' integrity strings travelled with the fetch —
        // not the bare-key entries'.
        expect(calls.map((c) => c.integrity).sort()).toEqual([
            "sha512-imgapp==",
            "sha512-vapp==",
        ]);
    });

    it("FAILS namedly when the app's sharp pins a version the lockfile does not hold", () => {
        // Knowing the app's resolution and NOT finding it in the lock is the
        // store-vs-lockfile disagreement — fetching some other version instead
        // would be the exact silent mismatch this path exists to prevent.
        const cwd = tempDir("knext-954-mismatch-");
        writeFileSync(join(cwd, "bun.lock"), twoVersionLock());
        writeSharpManifest(cwd, "0.36.0", {
            "@img/sharp-linuxmusl-x64": "0.36.0",
            "@img/sharp-libvips-linuxmusl-x64": "1.4.0",
        });
        const { fetch } = recordingFetch();

        expect(() =>
            stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch }),
        ).toThrow(/0\.36\.0/);
        expect(() =>
            stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch }),
        ).toThrow(/0\.34\.5.*0\.35\.4|0\.35\.4.*0\.34\.5/s);
    });

    it("falls back to the first lockfile entry WITH A WARNING when no resolved sharp manifest is findable", () => {
        // A pnpm `.pnpm` store hides node_modules/sharp from the candidate
        // walk. With nothing to disambiguate by, [0] (the bare-key resolution
        // when present) is the documented fallback — taken loudly, never
        // silently, because it is a guess between two legitimate pins.
        const cwd = tempDir("knext-954-fallback-");
        writeFileSync(join(cwd, "bun.lock"), twoVersionLock());
        const { calls, fetch } = recordingFetch();

        const writes: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        try {
            stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch });
        } finally {
            process.stderr.write = original;
        }

        // Bare keys hold 0.34.5 / 1.2.9 in this fixture, and they are [0].
        expect(calls.map((c) => `${c.name}@${c.version}`).sort()).toEqual([
            "@img/sharp-libvips-linuxmusl-x64@1.2.9",
            "@img/sharp-linuxmusl-x64@0.34.5",
        ]);
        expect(writes.join("")).toMatch(/two versions|multiple versions/i);
    });

    it("copies the target set from the host install when it IS there — no fetch", () => {
        // A linux-x64 host building the default image: bun installed the musl
        // packages, so staging is a local copy exactly as before.
        const cwd = darwinAppTree(FULL_LOCK, {
            "sharp-linuxmusl-x64": SHARP_V,
            "sharp-libvips-linuxmusl-x64": VIPS_V,
            "sharp-darwin-arm64": SHARP_V,
            "sharp-libvips-darwin-arm64": VIPS_V,
        });

        stageSharpNative(cwd, {
            arch: "linux-x64",
            fetchPackage: () => {
                throw new Error(
                    "must not fetch — the host install has the target set",
                );
            },
        });

        const staged = readdirSync(join(cwd, "native")).sort();
        expect(staged).toContain("sharp-linuxmusl-x64");
        expect(staged).toContain("sharp-libvips-linuxmusl-x64");
        expect(staged).not.toContain("sharp-darwin-arm64");
        expect(
            readFileSync(
                join(
                    cwd,
                    "native",
                    "sharp-linuxmusl-x64",
                    "lib",
                    "sharp-linuxmusl-x64.node",
                ),
                "utf8",
            ),
        ).toBe("sharp-linuxmusl-x64 BYTES");
    });

    /** What a previous `kn-next build` leaves behind: tree + manifest. */
    function stagePreviousBuild(
        cwd: string,
        files: Record<string, string>,
    ): void {
        for (const [rel, bytes] of Object.entries(files)) {
            const abs = join(cwd, "native", ...rel.split("/"));
            mkdirSync(join(abs, ".."), { recursive: true });
            writeFileSync(abs, bytes);
        }
        writeFileSync(
            join(cwd, "native", ".integrity.json"),
            JSON.stringify({
                version: 1,
                algorithm: "sha256",
                packages: {},
                files: Object.fromEntries(
                    Object.keys(files).map((rel) => [rel, "previous-hash"]),
                ),
            }),
        );
    }

    it("a rebuild CLEARS a previous build's foreign addons out of native/", () => {
        // The upgrade path: an app tree that still carries a darwin-staged
        // native/ from an old CLI. mkdir+copy would leave the darwin dirs
        // beside the new ones — shipped dead weight at best, and the multi-
        // platform tree the shim bug needed at worst.
        const cwd = darwinAppTree(FULL_LOCK, {
            "sharp-linuxmusl-x64": SHARP_V,
            "sharp-libvips-linuxmusl-x64": VIPS_V,
        });
        stagePreviousBuild(cwd, {
            "sharp-darwin-arm64/lib/sharp-darwin-arm64.node": "STALE",
        });

        stageSharpNative(cwd, { arch: "linux-x64" });

        expect(existsSync(join(cwd, "native", "sharp-darwin-arm64"))).toBe(
            false,
        );
        expect(existsSync(join(cwd, "native", "sharp-linuxmusl-x64"))).toBe(
            true,
        );
    });

    it("REFUSES to clear a native/ that knext did not stage — never deletes user files", () => {
        // `native/` is a standard N-API convention, and the scaffold ships no
        // .gitignore claiming the name for knext. A hand-written native/ has
        // no `.integrity.json`; deleting it because a build ran would be data
        // loss. The refusal names the marker so the message is actionable.
        const cwd = darwinAppTree(FULL_LOCK, {
            "sharp-linuxmusl-x64": SHARP_V,
            "sharp-libvips-linuxmusl-x64": VIPS_V,
        });
        mkdirSync(join(cwd, "native"), { recursive: true });
        writeFileSync(join(cwd, "native", "my-addon.node"), "USER BYTES");

        expect(() => stageSharpNative(cwd, { arch: "linux-x64" })).toThrow(
            /\.integrity\.json/,
        );
        // And nothing was deleted on the way to the refusal.
        expect(readFileSync(join(cwd, "native", "my-addon.node"), "utf8")).toBe(
            "USER BYTES",
        );
    });

    it("prunes ONLY what the previous manifest lists — a user extra beside it survives", () => {
        const cwd = darwinAppTree(FULL_LOCK, {
            "sharp-linuxmusl-x64": SHARP_V,
            "sharp-libvips-linuxmusl-x64": VIPS_V,
        });
        stagePreviousBuild(cwd, {
            "sharp-darwin-arm64/lib/sharp-darwin-arm64.node": "STALE",
        });
        // A file the previous manifest does not list is not knext's to delete.
        writeFileSync(join(cwd, "native", "NOTES.txt"), "USER NOTES");

        stageSharpNative(cwd, { arch: "linux-x64" });

        expect(existsSync(join(cwd, "native", "sharp-darwin-arm64"))).toBe(
            false,
        );
        expect(readFileSync(join(cwd, "native", "NOTES.txt"), "utf8")).toBe(
            "USER NOTES",
        );
    });

    it("a FAILED staging unwinds its own writes — the next build is not wedged", () => {
        // Review round 3, I1: a mid-loop throw (second fetch fails) used to
        // leave native/ holding the first package and no manifest, and the
        // NEXT build's ownership refusal then blamed the user for knext's own
        // residue — permanently, since every retry hit the same refusal.
        const cwd = darwinAppTree();
        const good = recordingFetch();
        let fetches = 0;
        expect(() =>
            stageSharpNative(cwd, {
                arch: "linux-x64",
                fetchPackage: (pkg, destDir) => {
                    fetches++;
                    if (fetches > 1) throw new Error("registry down");
                    good.fetch(pkg, destDir);
                },
            }),
        ).toThrow(/registry down/);
        // No half-staged residue: the run removed what it wrote.
        expect(readdirSync(join(cwd, "native"))).toEqual([]);

        // And the retry — the thing the wedge made impossible — succeeds.
        const retry = recordingFetch();
        stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: retry.fetch });
        expect(existsSync(join(cwd, "native", ".integrity.json"))).toBe(true);
        expect(existsSync(join(cwd, "native", "sharp-linuxmusl-x64"))).toBe(
            true,
        );
    });

    it("#949-class: sharp DECLARED but not findable → NAMED failure, never an empty native/", () => {
        // The pnpm layout: `@img` lives under `.pnpm`, none of the walked
        // node_modules candidates match, and inferring "no sharp" from that
        // absence ships an empty native/ — the silent crash-loop this issue
        // exists to close. The signal must come from the app's own manifest.
        const cwd = tempDir("knext-949-declared-");
        writeFileSync(
            join(cwd, "package.json"),
            JSON.stringify({
                name: "app",
                dependencies: { sharp: "^0.35.2" },
            }),
        );
        const { calls, fetch } = recordingFetch();

        expect(() =>
            stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch }),
        ).toThrow(/@img\/sharp-linuxmusl-x64|bun\.lock/);
        expect(calls).toEqual([]);
        // The failure mode being replaced: an empty-but-manifested native/.
        expect(
            existsSync(join(cwd, "native", ".integrity.json")),
            "the build must fail before writing a manifest that blesses an empty tree",
        ).toBe(false);
    });

    it("fetches from the lockfile pin when the install layout hides @img entirely", () => {
        // bun.lock pins the packages but no node_modules/@img candidate
        // exists (isolated stores, hoisting differences). The lockfile is the
        // signal AND the pin — the fetch path covers the layout, named
        // failure covers everything else.
        const cwd = tempDir("knext-949-hidden-");
        writeFileSync(join(cwd, "bun.lock"), lockText(FULL_LOCK));
        const { calls, fetch } = recordingFetch();

        stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch });

        expect(calls.map((c) => c.name).sort()).toEqual([
            "@img/sharp-libvips-linuxmusl-x64",
            "@img/sharp-linuxmusl-x64",
        ]);
        expect(existsSync(join(cwd, "native", "sharp-linuxmusl-x64"))).toBe(
            true,
        );
    });

    it("FAILS naming the missing target addon when the lockfile does not pin it", () => {
        // No fetchable pin means the image WOULD ship unable to load sharp —
        // the acceptance criterion is a named build failure, never that image.
        const cwd = darwinAppTree({
            "@img/sharp-darwin-arm64": SHARP_V,
            "@img/sharp-libvips-darwin-arm64": VIPS_V,
        });
        const { calls, fetch } = recordingFetch();

        expect(() =>
            stageSharpNative(cwd, { arch: "linux-x64", fetchPackage: fetch }),
        ).toThrow(/@img\/sharp-linuxmusl-x64/);
        expect(calls).toEqual([]);
    });

    it("an app with no sharp still stages an empty manifest, and never fetches", () => {
        // "No sharp" means NO signal says otherwise: not the app's
        // package.json, not a lockfile, not an installed @img tree. Absence of
        // one install layout is NOT absence of sharp — that inference is the
        // #949-class bug the two tests above pin from the other side.
        const cwd = tempDir("knext-949-nosharp-");
        stageSharpNative(cwd, {
            arch: "linux-x64",
            fetchPackage: () => {
                throw new Error("must not fetch for an app without sharp");
            },
        });
        const manifest = JSON.parse(
            readFileSync(join(cwd, "native", ".integrity.json"), "utf8"),
        );
        expect(manifest.files).toEqual({});
    });

    it("maps EVERY compile arch to a sharp platform id, musl matching the -musl triples", () => {
        // Scanned, not enumerated: the known-arch list is read out of
        // compileArgv's own refusal, so an arch added to one map but not the
        // other fails here instead of at a user's build.
        let known: string[] = [];
        try {
            compileArgv("__not_an_arch__", "e", "o");
        } catch (e) {
            known =
                /Known: (.*)\.$/.exec((e as Error).message)?.[1]?.split(", ") ??
                [];
        }
        expect(known.length).toBeGreaterThan(0);
        expect(Object.keys(SHARP_PLATFORM_IDS).sort()).toEqual(known.sort());

        // The default image is alpine and the linux triples are `-musl`: the
        // staged sharp set must match the runtime libc, one-word `linuxmusl`
        // (the spelling this repo has already guessed wrong once).
        for (const [arch, id] of Object.entries(SHARP_PLATFORM_IDS)) {
            if (arch.startsWith("linux-")) {
                expect(id).toBe(`linuxmusl-${arch.slice("linux-".length)}`);
            } else {
                expect(id).toBe(arch);
            }
        }
    });
});

describe("#949 the registry fetch is verified against the lockfile pin", () => {
    /** A real tgz in bun.lock's shape: the payload under `package/`. */
    function packTarball(): { tgz: string; integrity: string } {
        const dir = tempDir("knext-949-tgz-");
        const pkg = join(dir, "package");
        mkdirSync(join(pkg, "lib"), { recursive: true });
        writeFileSync(
            join(pkg, "package.json"),
            JSON.stringify({
                name: "@img/sharp-linuxmusl-x64",
                version: "0.35.4",
            }),
        );
        writeFileSync(join(pkg, "lib", "addon.node"), "REAL ADDON BYTES");
        const tgz = join(dir, "pkg.tgz");
        execFileSync("tar", ["-czf", tgz, "-C", dir, "package"]);
        const integrity = `sha512-${createHash("sha512")
            .update(readFileSync(tgz))
            .digest("base64")}`;
        return { tgz, integrity };
    }

    it("extracts a tarball whose sha512 matches the lockfile integrity", () => {
        const { tgz, integrity } = packTarball();
        const dest = join(tempDir("knext-949-x-"), "out");

        extractVerifiedTarball(
            tgz,
            { name: "@img/sharp-linuxmusl-x64", version: "0.35.4", integrity },
            dest,
        );

        expect(readFileSync(join(dest, "lib", "addon.node"), "utf8")).toBe(
            "REAL ADDON BYTES",
        );
    });

    it("REFUSES a tarball that does not match the pin, naming both hashes", () => {
        // The fetch path bypasses the package manager, so the lockfile pin is
        // the only thing standing between the registry and native-code
        // privilege in the image. A mismatch is a hard failure, not a warning.
        const { tgz } = packTarball();
        const dest = join(tempDir("knext-949-bad-"), "out");

        expect(() =>
            extractVerifiedTarball(
                tgz,
                {
                    name: "@img/sharp-linuxmusl-x64",
                    version: "0.35.4",
                    integrity: "sha512-notTheRealHash==",
                },
                dest,
            ),
        ).toThrow(/sha512-notTheRealHash==/);
        expect(existsSync(join(dest, "lib", "addon.node"))).toBe(false);
    });

    it("REFUSES to fetch at all without a usable lockfile integrity", () => {
        // Reached before any network call: an unverifiable fetch would ship
        // whatever the registry answered, which is the hole, not the fix.
        expect(() =>
            fetchImgPackage(
                {
                    name: "@img/sharp-linuxmusl-x64",
                    version: "0.35.4",
                    integrity: null,
                },
                join(tmpdir(), "knext-949-nofetch"),
            ),
        ).toThrow(/integrity/);
    });
});
