/**
 * #2360 — a host `@img` package is copied only at the version sharp pins.
 *
 * Every sharp staging path takes the image platform's addon pair from the
 * build host's install when it is there, and fetches it at the lockfile pin
 * otherwise. The host copy used to take the first `@img/sharp-<platform>` it
 * found, whatever its version — but sharp's loader expects exactly the
 * version its own `optionalDependencies` pins, and a hoisted pair from a
 * different sharp (an app's sharp beside next's own) is a different addon.
 * A mismatched host copy now falls back to the pinned fetch; when the
 * lockfile cannot supply the pin either, the build refuses.
 *
 * `stageSharpForStandalone` is covered in `standalone-sharp-stage.test.ts`;
 * this file covers the two vinext twins that share the pattern.
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
import { stageSharpForVinextNode, stageSharpNative } from "../cli/vinext-build";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SHARP_V = "0.35.4";
const VIPS_V = "1.3.3";
const OTHER = "0.34.1";
const OTHER_VIPS = "1.2.0";

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

/**
 * bun.lock with the canonical (bare-key) entries at `canonical`, plus
 * path-keyed entries for every `extra` package — the shape a lockfile has
 * when two sharps coexist.
 */
function lockText(
    canonical: Record<string, string>,
    extra: Record<string, string> = {},
): string {
    const line = (key: string, name: string, v: string) =>
        `    ${JSON.stringify(key)}: [${JSON.stringify(`${name}@${v}`)}, "", {}, "sha512-pin/${name.length}${v}=="],`;
    const lines = [
        ...Object.entries(canonical).map(([n, v]) => line(n, n, v)),
        ...Object.entries(extra).map(([n, v]) => line(`other/${n}`, n, v)),
    ];
    return `{\n  "lockfileVersion": 1,\n  "packages": {\n${lines.join("\n")}\n  }\n}\n`;
}

const CANONICAL = {
    sharp: SHARP_V,
    "@img/sharp-linuxmusl-x64": SHARP_V,
    "@img/sharp-libvips-linuxmusl-x64": VIPS_V,
};
const HOST_OTHER = {
    "@img/sharp-linuxmusl-x64": OTHER,
    "@img/sharp-libvips-linuxmusl-x64": OTHER_VIPS,
};

/**
 * An app whose install holds sharp@SHARP_V (pinning the musl pair at
 * SHARP_V/VIPS_V) but whose hoisted `@img` musl pair is OTHER/OTHER_VIPS.
 */
function appWithForeignHostPair(lock: string, nitroOutput = false): string {
    const cwd = mkdtempSync(join(tmpdir(), "knext-2360-hostpin-"));
    tempDirs.push(cwd);
    write(join(cwd, "bun.lock"), lock);
    write(
        join(cwd, "package.json"),
        JSON.stringify({ dependencies: { sharp: `^${SHARP_V}` } }),
    );
    write(
        join(cwd, "node_modules", "sharp", "package.json"),
        JSON.stringify({
            name: "sharp",
            version: SHARP_V,
            optionalDependencies: {
                "@img/sharp-linuxmusl-x64": SHARP_V,
                "@img/sharp-libvips-linuxmusl-x64": VIPS_V,
            },
        }),
    );
    write(join(cwd, "node_modules", "sharp", "dist", "index.cjs"), "");
    for (const [name, version] of Object.entries(HOST_OTHER)) {
        const dir = join(cwd, "node_modules", name);
        write(join(dir, "package.json"), JSON.stringify({ name, version }));
        write(join(dir, "lib", "addon.node"), `host ${name}@${version}`);
    }
    if (nitroOutput)
        mkdirSync(join(cwd, ".output", "server"), { recursive: true });
    return cwd;
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
            fetched.push({ ...pkg });
            write(
                join(destDir, "package.json"),
                JSON.stringify({ name: pkg.name, version: pkg.version }),
            );
            write(join(destDir, "lib", "addon.node"), `fetched ${pkg.name}`);
        },
    };
}

function thrownBy(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        return error as Error;
    }
    throw new Error("expected a UsageError, nothing was thrown");
}

const PINNED = [
    `@img/sharp-linuxmusl-x64@${SHARP_V}`,
    `@img/sharp-libvips-linuxmusl-x64@${VIPS_V}`,
];

describe("stageSharpForVinextNode — host pair version vs sharp's pin (#2360)", () => {
    it("fetches the pinned pair instead of copying a host pair at another version", () => {
        const cwd = appWithForeignHostPair(
            lockText(CANONICAL, HOST_OTHER),
            true,
        );
        const { fetched, fetchPackage } = recordingFetch();
        stageSharpForVinextNode(cwd, { arch: "linux-x64", fetchPackage });
        expect(fetched.map((f) => `${f.name}@${f.version}`)).toEqual(PINNED);
        const staged = join(
            cwd,
            ".output",
            "server",
            "node_modules",
            "@img",
            "sharp-linuxmusl-x64",
        );
        expect(readFileSync(join(staged, "package.json"), "utf8")).toContain(
            `"version":"${SHARP_V}"`,
        );
    });

    it("refuses, naming both versions, when the lockfile lacks the pin", () => {
        const cwd = appWithForeignHostPair(
            lockText({ sharp: SHARP_V, ...HOST_OTHER }),
            true,
        );
        const { fetched, fetchPackage } = recordingFetch();
        const error = thrownBy(() =>
            stageSharpForVinextNode(cwd, { arch: "linux-x64", fetchPackage }),
        );
        expect(error.message).toContain("@img/sharp-linuxmusl-x64");
        expect(error.message).toContain(OTHER);
        expect(error.message).toContain(SHARP_V);
        expect(fetched).toEqual([]);
    });
});

describe("stageSharpNative — host pair version vs sharp's pin (#2360)", () => {
    it("fetches the pinned pair instead of copying a host pair at another version", () => {
        const cwd = appWithForeignHostPair(lockText(CANONICAL, HOST_OTHER));
        const { fetched, fetchPackage } = recordingFetch();
        stageSharpNative(cwd, { arch: "linux-x64", fetchPackage });
        expect(fetched.map((f) => `${f.name}@${f.version}`)).toEqual(PINNED);
        const manifest = JSON.parse(
            readFileSync(join(cwd, "native", ".integrity.json"), "utf8"),
        ) as { packages: Record<string, { version: string }> };
        expect(manifest.packages["@img/sharp-linuxmusl-x64"]?.version).toBe(
            SHARP_V,
        );
    });

    it("refuses, naming both versions, when the lockfile lacks the pin, and leaves no partial staging", () => {
        const cwd = appWithForeignHostPair(
            lockText({ sharp: SHARP_V, ...HOST_OTHER }),
        );
        const { fetched, fetchPackage } = recordingFetch();
        const error = thrownBy(() =>
            stageSharpNative(cwd, { arch: "linux-x64", fetchPackage }),
        );
        expect(error.message).toContain(OTHER);
        expect(error.message).toContain(SHARP_V);
        expect(fetched).toEqual([]);
        expect(existsSync(join(cwd, "native", "sharp-linuxmusl-x64"))).toBe(
            false,
        );
    });
});
