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
import {
    PNPM_V6,
    PNPM_V9,
    sri,
    YARN_BERRY,
    YARN_CLASSIC,
} from "./helpers/lockfile-fixtures";

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

function imgPackage(
    dir: string,
    name: string,
    payload: string,
    version?: string,
): void {
    write(
        join(dir, "package.json"),
        JSON.stringify({
            name,
            version: version ?? (name.includes("libvips") ? VIPS_V : SHARP_V),
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
        /** Overrides bun.lock: another installer's lockfile, or none at all. */
        lockfile?: { name: string; text: string } | null;
        /** Version a HOST `@img` package claims, by its directory name. */
        hostVersions?: Record<string, string>;
        /** The traced sharp's own `@img` pins (its optionalDependencies). */
        sharpPins?: Record<string, string>;
        /** `config.images` as `next build` resolved it (required-server-files). */
        images?: Record<string, unknown>;
    } = {},
): { cwd: string; tracedModules: string } {
    const cwd = mkdtempSync(join(tmpdir(), "knext-2360-stage-"));
    tempDirs.push(cwd);
    if (opts.lockfile === undefined) {
        writeFileSync(join(cwd, "bun.lock"), lockText(opts.lock ?? MUSL_LOCK));
    } else if (opts.lockfile !== null) {
        writeFileSync(join(cwd, opts.lockfile.name), opts.lockfile.text);
    }
    if (opts.images !== undefined) {
        write(
            join(cwd, ".next", "required-server-files.json"),
            JSON.stringify({ version: 1, config: { images: opts.images } }),
        );
    }
    write(
        join(cwd, "package.json"),
        JSON.stringify({ dependencies: { next: "16.4.0" } }),
    );
    for (const pair of opts.hostPairs ?? ["linux-x64"]) {
        imgPackage(
            join(cwd, "node_modules", "@img", `sharp-${pair}`),
            `@img/sharp-${pair}`,
            `host ${pair} addon`,
            opts.hostVersions?.[`sharp-${pair}`],
        );
        imgPackage(
            join(cwd, "node_modules", "@img", `sharp-libvips-${pair}`),
            `@img/sharp-libvips-${pair}`,
            `host ${pair} libvips`,
            opts.hostVersions?.[`sharp-libvips-${pair}`],
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
                optionalDependencies: opts.sharpPins ?? {
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

function thrownBy(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        return error as Error;
    }
    throw new Error("expected a UsageError, nothing was thrown");
}

/** The pins sharp 0.33.5 carries — what the pnpm v6 / yarn classic fixtures lock. */
const PINS_0_33 = {
    "@img/sharp-linuxmusl-x64": "0.33.5",
    "@img/sharp-libvips-linuxmusl-x64": "1.0.4",
};

describe("stageSharpForStandalone — pnpm and yarn lockfiles (#2360)", () => {
    it("pnpm-lock.yaml v6: fetches the pinned musl pair with its sha512", () => {
        const { cwd } = glibcHostBuild({
            lockfile: { name: "pnpm-lock.yaml", text: PNPM_V6 },
            sharpPins: PINS_0_33,
        });
        const { fetched, fetchPackage } = recordingFetch();
        stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage });
        expect(fetched).toEqual([
            {
                name: "@img/sharp-linuxmusl-x64",
                version: "0.33.5",
                integrity: sri("musl-0.33.5"),
            },
            {
                name: "@img/sharp-libvips-linuxmusl-x64",
                version: "1.0.4",
                integrity: sri("libvips-musl-1.0.4"),
            },
        ]);
    });

    it("pnpm-lock.yaml v9: of two pinned versions, fetches the one the traced sharp pins", () => {
        const { cwd } = glibcHostBuild({
            lockfile: { name: "pnpm-lock.yaml", text: PNPM_V9 },
        });
        const { fetched, fetchPackage } = recordingFetch();
        stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage });
        expect(fetched).toEqual([
            {
                name: "@img/sharp-linuxmusl-x64",
                version: SHARP_V,
                integrity: sri(`musl-${SHARP_V}`),
            },
            {
                name: "@img/sharp-libvips-linuxmusl-x64",
                version: VIPS_V,
                integrity: sri(`libvips-musl-${VIPS_V}`),
            },
        ]);
    });

    it("yarn.lock classic v1: fetches the pinned musl pair with its sha512", () => {
        const { cwd } = glibcHostBuild({
            lockfile: { name: "yarn.lock", text: YARN_CLASSIC },
            sharpPins: PINS_0_33,
        });
        const { fetched, fetchPackage } = recordingFetch();
        stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage });
        expect(fetched.map((f) => [f.name, f.version, f.integrity])).toEqual([
            ["@img/sharp-linuxmusl-x64", "0.33.5", sri("musl-0.33.5")],
            [
                "@img/sharp-libvips-linuxmusl-x64",
                "1.0.4",
                sri("libvips-musl-1.0.4"),
            ],
        ]);
    });

    it("yarn.lock berry: refuses, naming the lockfile and the package, and fetches nothing", () => {
        const { cwd } = glibcHostBuild({
            lockfile: { name: "yarn.lock", text: YARN_BERRY },
            sharpPins: {
                "@img/sharp-linuxmusl-x64": "0.34.5",
                "@img/sharp-libvips-linuxmusl-x64": "1.2.4",
            },
        });
        const { fetched, fetchPackage } = recordingFetch();
        const error = thrownBy(() =>
            stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage }),
        );
        expect(error.message).toContain(join(cwd, "yarn.lock"));
        expect(error.message).toContain("@img/sharp-linuxmusl-x64@0.34.5");
        expect(error.message).toContain("sha512");
        expect(fetched).toEqual([]);
    });

    it("refuses a lockfile entry whose only integrity is not sha512, naming lockfile and package", () => {
        const sha1Only = YARN_CLASSIC.replace(
            `integrity ${sri("musl-0.33.5")}`,
            "integrity sha1-u7u7u7u7u7u7u7u7u7u7u7u7u7s=",
        );
        const { cwd } = glibcHostBuild({
            lockfile: { name: "yarn.lock", text: sha1Only },
            sharpPins: PINS_0_33,
        });
        const { fetched, fetchPackage } = recordingFetch();
        const error = thrownBy(() =>
            stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage }),
        );
        expect(error.message).toContain(join(cwd, "yarn.lock"));
        expect(error.message).toContain("@img/sharp-linuxmusl-x64@0.33.5");
        expect(fetched).toEqual([]);
    });
});

describe("stageSharpForStandalone — images.unoptimized skips staging (#2360)", () => {
    it("stages and fetches nothing, and does not fail without a lockfile, when next build resolved images.unoptimized: true", () => {
        const { cwd, tracedModules } = glibcHostBuild({
            lockfile: null,
            images: { unoptimized: true },
        });
        const { fetched, fetchPackage } = recordingFetch();
        const result = stageSharpForStandalone(cwd, {
            arch: "linux-x64",
            fetchPackage,
        });
        expect(result.staged).toEqual([]);
        expect(fetched).toEqual([]);
        expect(
            existsSync(join(tracedModules, "@img", "sharp-linuxmusl-x64")),
        ).toBe(false);
    });

    it("still stages (and so still fails closed without a lockfile) when images.unoptimized is false", () => {
        const { cwd } = glibcHostBuild({
            lockfile: null,
            images: { unoptimized: false },
        });
        const { fetchPackage } = recordingFetch();
        const error = thrownBy(() =>
            stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage }),
        );
        expect(error.message).toContain("@img/sharp-linuxmusl-x64");
    });
});

describe("stageSharpForStandalone — a host pair at the wrong version is not copied (#2360)", () => {
    const OTHER = "0.34.1";
    const OTHER_VIPS = "1.2.0";
    const hostAtOther = {
        hostPairs: ["linux-x64", "linuxmusl-x64"],
        hostVersions: {
            "sharp-linuxmusl-x64": OTHER,
            "sharp-libvips-linuxmusl-x64": OTHER_VIPS,
        },
    };

    it("fetches the traced sharp's pin instead of copying a host pair at another version", () => {
        const { cwd, tracedModules } = glibcHostBuild({
            ...hostAtOther,
            // The lockfile pins both — the host's version (path-keyed) and
            // the traced sharp's (canonical).
            lockfile: {
                name: "bun.lock",
                text: lockText(MUSL_LOCK).replace(
                    '  "packages": {\n',
                    `  "packages": {\n    "nested/@img/sharp-linuxmusl-x64": ["@img/sharp-linuxmusl-x64@${OTHER}", "", {}, "sha512-other=="],\n    "nested/@img/sharp-libvips-linuxmusl-x64": ["@img/sharp-libvips-linuxmusl-x64@${OTHER_VIPS}", "", {}, "sha512-other=="],\n`,
                ),
            },
        });
        const { fetched, fetchPackage } = recordingFetch();
        const result = stageSharpForStandalone(cwd, {
            arch: "linux-x64",
            fetchPackage,
        });
        expect(fetched.map((f) => `${f.name}@${f.version}`)).toEqual([
            `@img/sharp-linuxmusl-x64@${SHARP_V}`,
            `@img/sharp-libvips-linuxmusl-x64@${VIPS_V}`,
        ]);
        expect(result.staged).toEqual([
            "@img/sharp-linuxmusl-x64",
            "@img/sharp-libvips-linuxmusl-x64",
        ]);
        expect(
            readFileSync(
                join(
                    tracedModules,
                    "@img",
                    "sharp-linuxmusl-x64",
                    "package.json",
                ),
                "utf8",
            ),
        ).toContain(`"version":"${SHARP_V}"`);
    });

    it("still copies a host pair whose version IS the traced sharp's pin", () => {
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

    it("refuses, naming both versions, when the lockfile cannot supply the pinned version either", () => {
        const { cwd, tracedModules } = glibcHostBuild({
            ...hostAtOther,
            lock: {
                sharp: SHARP_V,
                "@img/sharp-linuxmusl-x64": OTHER,
                "@img/sharp-libvips-linuxmusl-x64": OTHER_VIPS,
            },
        });
        const { fetched, fetchPackage } = recordingFetch();
        const error = thrownBy(() =>
            stageSharpForStandalone(cwd, { arch: "linux-x64", fetchPackage }),
        );
        expect(error.message).toContain("@img/sharp-linuxmusl-x64");
        expect(error.message).toContain(OTHER);
        expect(error.message).toContain(SHARP_V);
        expect(fetched).toEqual([]);
        expect(
            existsSync(join(tracedModules, "@img", "sharp-linuxmusl-x64")),
        ).toBe(false);
    });
});
