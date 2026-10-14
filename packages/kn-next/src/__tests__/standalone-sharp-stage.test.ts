/**
 * #2360 — the standalone image ships the BUILD HOST's sharp addon.
 *
 * `next build` traces sharp into `.next/standalone/node_modules` together with
 * the `@img/sharp-<platform>` pair the build host installed. The standalone
 * images (`Dockerfile.standalone.hbs`, both runtimes) are alpine, i.e.
 * `linuxmusl`, and copy that tree verbatim. Measured on a GitHub runner (diag
 * run 38515418989): the tree held only `@img/sharp-linux-x64` (glibc), and
 * `require('sharp')` inside the shipped image failed with "Could not load the
 * sharp module using the linuxmusl-x64 runtime". Next's optimizer catches that
 * and serves the original image, so nothing crashes and nothing optimizes.
 *
 * `stageSharpForStandalone` adds the IMAGE platform's pair beside the traced
 * sharp (host install first, the lockfile-pinned fetch otherwise — the same
 * sources `stageSharpNative` and `stageSharpForVinextNode` use). It keeps the
 * host's pair: sharp picks its addon by the runtime platform, and the
 * host-arch smoke binary on the build machine needs the host's one.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "../cli/shared";
import { stageSharpForStandalone } from "../cli/vinext-build";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SHARP_V = "0.35.5";
const VIPS_V = "1.3.4";

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

/** bun.lock's JSONC shape (trailing commas), as bun writes it. */
function lockText(entries: Record<string, string>): string {
    const lines = Object.entries(entries).map(
        ([name, v]) =>
            `    ${JSON.stringify(name)}: [${JSON.stringify(`${name}@${v}`)}, "", {}, "sha512-pin/${name.length}=="],`,
    );
    return `{\n  "lockfileVersion": 1,\n  "packages": {\n${lines.join("\n")}\n  }\n}\n`;
}

const MUSL_LOCK = {
    sharp: SHARP_V,
    "@img/sharp-linux-x64": SHARP_V,
    "@img/sharp-libvips-linux-x64": VIPS_V,
    "@img/sharp-linuxmusl-x64": SHARP_V,
    "@img/sharp-libvips-linuxmusl-x64": VIPS_V,
};

function imgPackage(dir: string, name: string, payload: string): void {
    write(
        join(dir, "package.json"),
        JSON.stringify({
            name,
            version: name.includes("libvips") ? VIPS_V : SHARP_V,
        }),
    );
    write(join(dir, "lib", "payload"), payload);
}

/**
 * What a glibc build host leaves: its own install (the glibc pair only), a
 * lockfile pinning every platform, and the traced standalone tree with sharp
 * and the same glibc pair. `sharpAt` is where Next traced sharp, relative to
 * `.next/standalone` (`node_modules` flat, or nested under next).
 */
function glibcHostBuild(
    opts: {
        lock?: Record<string, string>;
        sharpAt?: string;
        traceSharp?: boolean;
        hostPairs?: string[];
        tracedPairs?: string[];
    } = {},
): { cwd: string; tracedModules: string } {
    const cwd = mkdtempSync(join(tmpdir(), "knext-2360-stage-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "bun.lock"), lockText(opts.lock ?? MUSL_LOCK));
    write(
        join(cwd, "package.json"),
        JSON.stringify({ dependencies: { next: "16.4.0" } }),
    );
    for (const pair of opts.hostPairs ?? ["linux-x64"]) {
        imgPackage(
            join(cwd, "node_modules", "@img", `sharp-${pair}`),
            `@img/sharp-${pair}`,
            `host ${pair} addon`,
        );
        imgPackage(
            join(cwd, "node_modules", "@img", `sharp-libvips-${pair}`),
            `@img/sharp-libvips-${pair}`,
            `host ${pair} libvips`,
        );
    }

    const s = join(cwd, ".next", "standalone");
    write(join(s, "server.js"), "// next standalone server");
    write(
        join(s, "node_modules", "next", "package.json"),
        JSON.stringify({ name: "next", version: "16.4.0" }),
    );
    write(
        join(s, "node_modules", "next", "dist", "server", "image-optimizer.js"),
        "",
    );
    const tracedModules = join(s, opts.sharpAt ?? "node_modules");
    if (opts.traceSharp !== false) {
        write(
            join(tracedModules, "sharp", "package.json"),
            JSON.stringify({
                name: "sharp",
                version: SHARP_V,
                optionalDependencies: {
                    "@img/sharp-linuxmusl-x64": SHARP_V,
                    "@img/sharp-libvips-linuxmusl-x64": VIPS_V,
                },
            }),
        );
        write(join(tracedModules, "sharp", "dist", "index.cjs"), "");
        for (const pair of opts.tracedPairs ?? ["linux-x64"]) {
            imgPackage(
                join(tracedModules, "@img", `sharp-${pair}`),
                `@img/sharp-${pair}`,
                `traced ${pair} addon`,
            );
            imgPackage(
                join(tracedModules, "@img", `sharp-libvips-${pair}`),
                `@img/sharp-libvips-${pair}`,
                `traced ${pair} libvips`,
            );
        }
    }
    return { cwd, tracedModules };
}

type Fetched = { name: string; version: string; integrity: string | null };
function recordingFetch(): {
    fetched: Fetched[];
    fetchPackage: (pkg: Fetched, destDir: string) => void;
} {
    const fetched: Fetched[] = [];
    return {
        fetched,
        fetchPackage: (pkg, destDir) => {
            fetched.push(pkg);
            imgPackage(destDir, pkg.name, `fetched ${pkg.name}@${pkg.version}`);
        },
    };
}

describe("stageSharpForStandalone — the image platform's sharp addon goes beside the traced sharp (#2360)", () => {
    it("on a glibc host, fetches the lockfile-pinned linuxmusl pair into the traced tree and keeps the host pair", () => {
        const { cwd, tracedModules } = glibcHostBuild();
        const { fetched, fetchPackage } = recordingFetch();
        const result = stageSharpForStandalone(cwd, {
            arch: "linux-x64",
            fetchPackage,
        });
        expect(result.staged).toEqual([
            "@img/sharp-linuxmusl-x64",
            "@img/sharp-libvips-linuxmusl-x64",
        ]);
        expect(fetched.map((f) => `${f.name}@${f.version}`)).toEqual([
            `@img/sharp-linuxmusl-x64@${SHARP_V}`,
            `@img/sharp-libvips-linuxmusl-x64@${VIPS_V}`,
        ]);
        // The lockfile's pin travels with the fetch (it verifies the tarball).
        expect(fetched.every((f) => f.integrity?.startsWith("sha512-"))).toBe(
            true,
        );
        expect(
            readFileSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-linuxmusl-x64",
                    "lib",
                    "payload",
                ),
                "utf8",
            ),
        ).toBe(`fetched @img/sharp-linuxmusl-x64@${SHARP_V}`);
        expect(
            existsSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-libvips-linuxmusl-x64",
                    "package.json",
                ),
            ),
        ).toBe(true);
        // The host-arch smoke binary on this machine still needs these.
        expect(
            readFileSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-linux-x64",
                    "lib",
                    "payload",
                ),
                "utf8",
            ),
        ).toBe("traced linux-x64 addon");
    });

    it("copies the pair from the host install when the host has it, without fetching", () => {
        const { cwd, tracedModules } = glibcHostBuild({
            hostPairs: ["linux-x64", "linuxmusl-x64"],
        });
        const { fetched, fetchPackage } = recordingFetch();
        stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage });
        expect(fetched).toEqual([]);
        expect(
            readFileSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-linuxmusl-x64",
                    "lib",
                    "payload",
                ),
                "utf8",
            ),
        ).toBe("host linuxmusl-x64 addon");
    });

    it("stages nothing when Next already traced the image platform's pair (a musl build host)", () => {
        const { cwd, tracedModules } = glibcHostBuild({
            tracedPairs: ["linuxmusl-x64"],
        });
        const { fetched, fetchPackage } = recordingFetch();
        const result = stageSharpForStandalone(cwd, {
            arch: "linux-x64",
            fetchPackage,
        });
        expect(result.staged).toEqual([]);
        expect(fetched).toEqual([]);
        expect(
            readFileSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-linuxmusl-x64",
                    "lib",
                    "payload",
                ),
                "utf8",
            ),
        ).toBe("traced linuxmusl-x64 addon");
    });

    it("stages beside WHEREVER Next traced sharp, not at a fixed path", () => {
        const { cwd, tracedModules } = glibcHostBuild({
            sharpAt: join("node_modules", "next", "node_modules"),
        });
        const { fetchPackage } = recordingFetch();
        stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage });
        expect(
            existsSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-linuxmusl-x64",
                    "package.json",
                ),
            ),
        ).toBe(true);
        expect(
            existsSync(
                join(
                    cwd,
                    ".next",
                    "standalone",
                    "node_modules",
                    "@img",
                    "sharp-linuxmusl-x64",
                ),
            ),
        ).toBe(false);
    });

    it("is a no-op for an app whose traced tree has no sharp", () => {
        const { cwd } = glibcHostBuild({ traceSharp: false, lock: {} });
        const { fetched, fetchPackage } = recordingFetch();
        const result = stageSharpForStandalone(cwd, {
            arch: "linux-x64",
            fetchPackage,
        });
        expect(result.staged).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it("fails the build NAMING the addon when neither the host nor the lockfile has it", () => {
        const { cwd } = glibcHostBuild({
            lock: {
                sharp: SHARP_V,
                "@img/sharp-linux-x64": SHARP_V,
                "@img/sharp-libvips-linux-x64": VIPS_V,
            },
        });
        const { fetchPackage } = recordingFetch();
        let thrown: unknown;
        try {
            stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(UsageError);
        expect(String((thrown as Error).message)).toContain(
            "@img/sharp-linuxmusl-x64",
        );
    });

    it("targets the arch it is given (linux-arm64 -> linuxmusl-arm64)", () => {
        const { cwd, tracedModules } = glibcHostBuild({
            lock: {
                ...MUSL_LOCK,
                "@img/sharp-linuxmusl-arm64": SHARP_V,
                "@img/sharp-libvips-linuxmusl-arm64": VIPS_V,
            },
        });
        const { fetched, fetchPackage } = recordingFetch();
        stageSharpForStandalone(cwd, { arch: "linux-arm64", fetchPackage });
        expect(fetched.map((f) => f.name)).toEqual([
            "@img/sharp-linuxmusl-arm64",
            "@img/sharp-libvips-linuxmusl-arm64",
        ]);
        expect(
            existsSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-linuxmusl-arm64",
                    "package.json",
                ),
            ),
        ).toBe(true);
    });
});
