/**
 * #1298 — vinext × node ships no sharp for the deployed image.
 *
 * `stageSharpForVinextNode` fixes two independent defects in what nitro's own
 * node-file-trace leaves in `.output/server/node_modules` for a `node-server`
 * preset build:
 *
 *   1. The `sharp` JS package it copies is INCOMPLETE — traced from the ESM
 *      entry point only, missing the CJS binding loader (`dist/index.cjs`)
 *      sharp's own `require()` chain resolves to. `require('sharp')` from the
 *      deployed tree throws even though the trace logs success.
 *   2. The `@img/sharp-<platform>` / `@img/sharp-libvips-<platform>` pair it
 *      copies is the BUILD HOST's platform, not the image's — the same class
 *      of bug #949 fixed for the compiled target.
 *
 * Both were reproduced locally (no docker): a real `vite build` of a
 * node-preset vinext app traces `sharp/dist/*.mjs` only (no `.cjs`) and
 * `@img/sharp-darwin-arm64` on a darwin host, and `require('sharp')` from
 * `.output/server` with that tree throws `Cannot find module
 * '.../sharp/dist/index.cjs'`.
 */

import { describe, expect, it } from "bun:test";
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
import { join } from "node:path";
import { UsageError } from "../cli/shared";
import { stageSharpForVinextNode } from "../cli/vinext-build";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

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
};

/**
 * Simulates what a real `vite build` (node preset) + a darwin host's `bun
 * install` leaves behind: a host-platform `@img` install, a lockfile pinning
 * every platform, a FULL local `node_modules/sharp` (the host install, always
 * complete), and — mirroring the measured nitro trace — an INCOMPLETE,
 * host-platform copy already sitting in `.output/server/node_modules`.
 */
function darwinNodeBuildTree(
    lock: Record<string, string | undefined> = FULL_LOCK,
): string {
    const cwd = tempDir("knext-1298-node-stage-");

    // Host's full sharp install (dependencies checked out for `vite build`).
    const sharpHost = join(cwd, "node_modules", "sharp");
    mkdirSync(join(sharpHost, "dist"), { recursive: true });
    writeFileSync(
        join(sharpHost, "package.json"),
        JSON.stringify({ name: "sharp", version: SHARP_V }),
    );
    writeFileSync(join(sharpHost, "dist", "index.mjs"), "export default {}");
    // The file nitro's trace measurably misses.
    writeFileSync(join(sharpHost, "dist", "index.cjs"), "module.exports = {}");

    // Host's @img addon (darwin only — what a mac install has).
    const imgHost = join(cwd, "node_modules", "@img", "sharp-darwin-arm64");
    mkdirSync(join(imgHost, "lib"), { recursive: true });
    writeFileSync(
        join(imgHost, "package.json"),
        JSON.stringify({ name: "@img/sharp-darwin-arm64", version: SHARP_V }),
    );
    writeFileSync(join(imgHost, "lib", "addon.node"), "darwin BYTES");

    writeFileSync(join(cwd, "bun.lock"), lockText(lock));
    writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({ dependencies: { sharp: `^${SHARP_V}` } }),
    );

    // What nitro's own trace leaves in .output/server/node_modules: the SAME
    // host-platform addon, and an sharp copy missing dist/index.cjs.
    const outServerModules = join(cwd, ".output", "server", "node_modules");
    const tracedSharp = join(outServerModules, "sharp", "dist");
    mkdirSync(tracedSharp, { recursive: true });
    writeFileSync(join(tracedSharp, "index.mjs"), "export default {}");
    writeFileSync(
        join(outServerModules, "sharp", "package.json"),
        JSON.stringify({ name: "sharp", version: SHARP_V }),
    );
    const tracedImg = join(
        outServerModules,
        "@img",
        "sharp-darwin-arm64",
        "lib",
    );
    mkdirSync(tracedImg, { recursive: true });
    writeFileSync(join(tracedImg, "addon.node"), "darwin BYTES");
    // A sibling dependency nitro also traced (semver, detect-libc, ...) that
    // must never be touched by this staging.
    const untouched = join(outServerModules, "semver");
    mkdirSync(untouched, { recursive: true });
    writeFileSync(join(untouched, "package.json"), "{}");

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

describe("#1298 stageSharpForVinextNode", () => {
    it("no-ops when the app has no sharp signal at all", () => {
        const cwd = tempDir("knext-1298-nosharp-");
        mkdirSync(join(cwd, ".output", "server"), { recursive: true });
        writeFileSync(join(cwd, "package.json"), JSON.stringify({}));
        const result = stageSharpForVinextNode(cwd, { arch: "linux-x64" });
        expect(result.staged).toBe(false);
        expect(existsSync(join(cwd, ".output", "server", "node_modules"))).toBe(
            false,
        );
    });

    it("refuses an unknown arch", () => {
        const cwd = tempDir("knext-1298-badarch-");
        expect(() =>
            stageSharpForVinextNode(cwd, { arch: "solaris-sparc" }),
        ).toThrow(/Unknown build arch/);
    });

    it("refuses when .output/server does not exist (build did not run yet)", () => {
        const cwd = tempDir("knext-1298-nooutput-");
        writeFileSync(
            join(cwd, "package.json"),
            JSON.stringify({ dependencies: { sharp: "^0.35.2" } }),
        );
        expect(() =>
            stageSharpForVinextNode(cwd, { arch: "linux-x64" }),
        ).toThrow(/vite build/);
    });

    it("replaces the traced sharp with the FULL host package (dist/index.cjs present)", () => {
        const cwd = darwinNodeBuildTree();
        const { fetch } = recordingFetch();

        const result = stageSharpForVinextNode(cwd, {
            arch: "linux-x64",
            fetchPackage: fetch,
        });

        expect(result.staged).toBe(true);
        const sharpDist = join(
            cwd,
            ".output",
            "server",
            "node_modules",
            "sharp",
            "dist",
        );
        // The file the traced copy measurably lacked.
        expect(existsSync(join(sharpDist, "index.cjs"))).toBe(true);
        expect(readFileSync(join(sharpDist, "index.cjs"), "utf8")).toContain(
            "module.exports",
        );
    });

    it("stages the IMAGE target's @img pair (fetched), not the host's darwin addon", () => {
        const cwd = darwinNodeBuildTree();
        const { calls, fetch } = recordingFetch();

        stageSharpForVinextNode(cwd, {
            arch: "linux-x64",
            fetchPackage: fetch,
        });

        const imgDir = join(cwd, ".output", "server", "node_modules", "@img");
        const staged = readdirSync(imgDir).sort();
        expect(staged).toContain("sharp-linuxmusl-x64");
        expect(staged).toContain("sharp-libvips-linuxmusl-x64");
        // The host's darwin addon nitro traced must be GONE, not merely
        // supplemented — an image carrying both is a crash-loop waiting to
        // pick the wrong one.
        expect(staged).not.toContain("sharp-darwin-arm64");

        expect(calls.map((c) => `${c.name}@${c.version}`).sort()).toEqual([
            "@img/sharp-libvips-linuxmusl-x64@1.3.3",
            "@img/sharp-linuxmusl-x64@0.35.4",
        ]);
    });

    it("never touches sibling deps nitro traced alongside sharp (e.g. semver)", () => {
        const cwd = darwinNodeBuildTree();
        const { fetch } = recordingFetch();

        stageSharpForVinextNode(cwd, {
            arch: "linux-x64",
            fetchPackage: fetch,
        });

        expect(
            existsSync(
                join(
                    cwd,
                    ".output",
                    "server",
                    "node_modules",
                    "semver",
                    "package.json",
                ),
            ),
        ).toBe(true);
    });

    it("when the host already has the target platform's addon, copies it directly (no fetch)", () => {
        const cwd = darwinNodeBuildTree();
        // Give this host BOTH darwin (default) and the linuxmusl target too.
        const linuxImg = join(
            cwd,
            "node_modules",
            "@img",
            "sharp-linuxmusl-x64",
            "lib",
        );
        mkdirSync(linuxImg, { recursive: true });
        writeFileSync(join(linuxImg, "addon.node"), "linuxmusl BYTES");
        writeFileSync(
            join(
                cwd,
                "node_modules",
                "@img",
                "sharp-linuxmusl-x64",
                "package.json",
            ),
            JSON.stringify({
                name: "@img/sharp-linuxmusl-x64",
                version: SHARP_V,
            }),
        );
        const linuxVips = join(
            cwd,
            "node_modules",
            "@img",
            "sharp-libvips-linuxmusl-x64",
            "lib",
        );
        mkdirSync(linuxVips, { recursive: true });
        writeFileSync(join(linuxVips, "addon.node"), "linuxmusl vips BYTES");
        writeFileSync(
            join(
                cwd,
                "node_modules",
                "@img",
                "sharp-libvips-linuxmusl-x64",
                "package.json",
            ),
            JSON.stringify({
                name: "@img/sharp-libvips-linuxmusl-x64",
                version: VIPS_V,
            }),
        );

        const { calls, fetch } = recordingFetch();
        stageSharpForVinextNode(cwd, {
            arch: "linux-x64",
            fetchPackage: fetch,
        });

        expect(calls).toHaveLength(0);
        const staged = readFileSync(
            join(
                cwd,
                ".output",
                "server",
                "node_modules",
                "@img",
                "sharp-linuxmusl-x64",
                "lib",
                "addon.node",
            ),
            "utf8",
        );
        expect(staged).toBe("linuxmusl BYTES");
    });

    it("fails loud (no lockfile) rather than shipping an image missing the addon", () => {
        const cwd = darwinNodeBuildTree({});
        rmSync(join(cwd, "bun.lock"), { force: true });
        expect(() =>
            stageSharpForVinextNode(cwd, { arch: "linux-x64" }),
        ).toThrow(UsageError);
        expect(() =>
            stageSharpForVinextNode(cwd, { arch: "linux-x64" }),
        ).toThrow(/no bun\.lock/);
    });

    it("fails loud when the lockfile has no entry for the target platform", () => {
        const cwd = darwinNodeBuildTree({
            "@img/sharp-darwin-arm64": SHARP_V,
        });
        expect(() =>
            stageSharpForVinextNode(cwd, { arch: "linux-x64" }),
        ).toThrow(/neither this host's install nor/);
    });

    it("fails loud when no local sharp package can be found to stage", () => {
        const cwd = tempDir("knext-1298-nolocal-sharp-");
        mkdirSync(join(cwd, ".output", "server"), { recursive: true });
        writeFileSync(
            join(cwd, "package.json"),
            JSON.stringify({ dependencies: { sharp: "^0.35.2" } }),
        );
        expect(() =>
            stageSharpForVinextNode(cwd, { arch: "linux-x64" }),
        ).toThrow(/no installed 'sharp' package was found/);
    });
});
