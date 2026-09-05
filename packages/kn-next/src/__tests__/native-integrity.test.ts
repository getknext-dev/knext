/**
 * Stage-time integrity pinning for the `native/` tree (sprint task C2).
 *
 * ## The defect this closes
 *
 * `stageSharpNative` used to `cpSync` whatever was under `node_modules/@img`
 * into `native/`, the Dockerfile `COPY`d it verbatim, and the compiled binary
 * `process.dlopen`d it at native-code privilege. Nothing tied the bytes that got
 * dlopened to the bytes the lockfile pinned, so a poisoned store or a poisoned
 * install cache shipped end-to-end with no gate — and PR #903's closure SBOM
 * explicitly does not cover `/app/native`, so no scanner saw it either.
 *
 * ## What the manifest can and cannot claim
 *
 * Stated precisely because the two halves have different strength:
 *
 *   - **From the lockfile:** that the staged `@img/<pkg>` directory carries the
 *     exact `name@version` `bun.lock` pinned, and that version's recorded
 *     integrity string. This is PROVENANCE. It is not a hash of what is on disk:
 *     bun records the integrity of the packed TARBALL, and what gets staged is
 *     the extracted tree, so the two are not comparable by construction.
 *   - **From knext:** a sha256 per staged file, computed here and written to
 *     `native/.integrity.json`, which the shim re-checks before dlopen. This is
 *     what actually binds the loaded bytes — it detects a tree mutated after
 *     install, which is the case the lockfile cannot see.
 *
 * Neither half is decorative and neither is sufficient alone, which is why both
 * are recorded.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    INTEGRITY_MANIFEST_NAME,
    readImgPackageVersions,
    writeNativeIntegrityManifest,
} from "../cli/native-integrity";
import { stageSharpNative } from "../cli/vinext-build";

const SHARP_VERSION = "0.35.2";
const VIPS_VERSION = "1.3.1";

/** A `bun.lock` with the two packages `stageNative` below installs. */
function lockfile(overrides: Record<string, string | undefined> = {}): string {
    const entries: Record<string, string | undefined> = {
        "@img/sharp-linux-x64": SHARP_VERSION,
        "@img/sharp-libvips-linux-x64": VIPS_VERSION,
        ...overrides,
    };
    const lines = Object.entries(entries)
        .filter(([, v]) => v !== undefined)
        .map(
            ([name, v]) =>
                `    ${JSON.stringify(name)}: [${JSON.stringify(`${name}@${v}`)}, "", {}, "sha512-deadbeef${name.length}=="],`,
        );
    // Trailing commas and the `packages` nesting are bun.lock's real shape: it
    // is JSONC, not JSON, and a plain `JSON.parse` throws on it.
    return `{\n  "lockfileVersion": 1,\n  "packages": {\n${lines.join("\n")}\n  }\n}\n`;
}

/** A staged `native/` tree in the layout the Dockerfile ships. */
function stageNative(opts: { sharpVersion?: string } = {}): {
    dir: string;
    nativeDir: string;
    addon: string;
} {
    const dir = mkdtempSync(join(tmpdir(), "knext-native-integrity-"));
    const nativeDir = join(dir, "native");

    const sharpPkg = join(nativeDir, "sharp-linux-x64");
    mkdirSync(join(sharpPkg, "lib"), { recursive: true });
    writeFileSync(
        join(sharpPkg, "package.json"),
        JSON.stringify({
            name: "@img/sharp-linux-x64",
            version: opts.sharpVersion ?? SHARP_VERSION,
        }),
    );
    const addon = join(sharpPkg, "lib", "sharp-linux-x64.node");
    writeFileSync(addon, "ADDON BYTES");

    const vipsPkg = join(nativeDir, "sharp-libvips-linux-x64");
    mkdirSync(join(vipsPkg, "lib"), { recursive: true });
    writeFileSync(
        join(vipsPkg, "package.json"),
        JSON.stringify({
            name: "@img/sharp-libvips-linux-x64",
            version: VIPS_VERSION,
        }),
    );
    writeFileSync(join(vipsPkg, "lib", "libvips-cpp.so.42"), "VIPS BYTES");

    return { dir, nativeDir, addon };
}

function writeLock(dir: string, contents: string): string {
    const path = join(dir, "bun.lock");
    writeFileSync(path, contents);
    return path;
}

function readManifest(nativeDir: string): {
    version: number;
    algorithm: string;
    packages: Record<
        string,
        { version: string; lockfileIntegrity: string | null }
    >;
    files: Record<string, string>;
} {
    return JSON.parse(
        readFileSync(join(nativeDir, INTEGRITY_MANIFEST_NAME), "utf8"),
    );
}

describe("native tree integrity manifest — staging", () => {
    it("hashes every staged file, keyed by its path relative to native/", () => {
        const { dir, nativeDir, addon } = stageNative();
        writeLock(dir, lockfile());

        writeNativeIntegrityManifest(nativeDir, writeLock(dir, lockfile()));
        const manifest = readManifest(nativeDir);

        expect(manifest.algorithm).toBe("sha256");
        // The addon is the file the shim dlopens, so it MUST be covered.
        expect(manifest.files["sharp-linux-x64/lib/sharp-linux-x64.node"]).toBe(
            createHash("sha256").update(readFileSync(addon)).digest("hex"),
        );
        // libvips is loaded transitively by the OS loader off a relative rpath —
        // swapping it never touches the addon, so covering only the addon would
        // leave the larger payload unpinned.
        expect(
            manifest.files["sharp-libvips-linux-x64/lib/libvips-cpp.so.42"],
        ).toBe(
            createHash("sha256")
                .update(Buffer.from("VIPS BYTES"))
                .digest("hex"),
        );
        // The manifest never hashes itself.
        expect(
            Object.keys(manifest.files).some((f) =>
                f.includes(INTEGRITY_MANIFEST_NAME),
            ),
        ).toBe(false);
    });

    it("a REBUILD does not fold the previous manifest into the new record", () => {
        // THE HALF THE FIRST TEST CANNOT COVER, found by mutation (#907's
        // prover, sprint 2 lane G). The assertion above — "the manifest never
        // hashes itself" — runs against a directory where `.integrity.json` does
        // not exist yet, so deleting the `rel === INTEGRITY_MANIFEST_NAME`
        // exclusion from the source is a NO-OP there and the guard stayed green.
        // The source's own comment claims both halves ("cannot hash itself, and
        // a stale one must not leak into the new record"); only the first was
        // tested.
        //
        // It matters on the path that actually happens: a rebuild in a tree that
        // already carries a manifest. Without the exclusion the new record would
        // contain a hash of the OLD manifest, so the shipped `.integrity.json`
        // describes a file that no longer exists by the time it is written —
        // and the `dlopen` verifier then refuses a tree that is perfectly fine.
        const { dir, nativeDir } = stageNative();
        const lock = writeLock(dir, lockfile());

        writeNativeIntegrityManifest(nativeDir, lock);
        const first = readManifest(nativeDir);
        // Non-vacuity: the manifest must be on disk for the second write to be
        // the rebuild case at all. Without this the test would pass against a
        // build that silently wrote nothing.
        expect(existsSync(join(nativeDir, INTEGRITY_MANIFEST_NAME))).toBe(true);

        writeNativeIntegrityManifest(nativeDir, lock);
        const second = readManifest(nativeDir);

        expect(
            Object.keys(second.files).some((f) =>
                f.includes(INTEGRITY_MANIFEST_NAME),
            ),
            "the rebuild recorded a hash of the previous manifest",
        ).toBe(false);
        // Idempotence is the observable consequence: same tree in, same record
        // out. A build whose manifest depends on what a previous build left
        // behind is not reproducible.
        expect(second).toEqual(first);
    });

    it("records each package's lockfile version and integrity string", () => {
        const { dir, nativeDir } = stageNative();
        const lock = writeLock(dir, lockfile());

        writeNativeIntegrityManifest(nativeDir, lock);
        const manifest = readManifest(nativeDir);

        expect(manifest.packages["@img/sharp-linux-x64"].version).toBe(
            SHARP_VERSION,
        );
        expect(
            manifest.packages["@img/sharp-linux-x64"].lockfileIntegrity,
        ).toMatch(/^sha512-/);
        expect(manifest.packages["@img/sharp-libvips-linux-x64"].version).toBe(
            VIPS_VERSION,
        );
    });

    it("FAILS when a staged package has no lockfile entry at all", () => {
        const { dir, nativeDir } = stageNative();
        // An `@img` package present on disk that the lockfile never pinned is
        // the injected-package case. Skipping it would make the manifest a
        // record of whatever was there, which is the defect, not the fix.
        const lock = writeLock(
            dir,
            lockfile({ "@img/sharp-linux-x64": undefined }),
        );

        expect(() => writeNativeIntegrityManifest(nativeDir, lock)).toThrow(
            /@img\/sharp-linux-x64/,
        );
    });

    it("FAILS when the staged version is not the version the lockfile pinned", () => {
        const { dir, nativeDir } = stageNative({ sharpVersion: "9.9.9" });
        const lock = writeLock(dir, lockfile());

        expect(() => writeNativeIntegrityManifest(nativeDir, lock)).toThrow(
            /9\.9\.9/,
        );
    });

    it("FAILS when there is no parseable lockfile, rather than staging blind", () => {
        const { nativeDir } = stageNative();
        expect(() =>
            writeNativeIntegrityManifest(nativeDir, undefined),
        ).toThrow(/bun\.lock/);
    });

    it("writes an empty-tree manifest without a lockfile — nothing was staged", () => {
        // The Dockerfile `COPY native` needs the directory to exist even for an
        // app with no sharp. That case has nothing to verify and must not
        // demand a lockfile it has no reason to read.
        const dir = mkdtempSync(join(tmpdir(), "knext-native-empty-"));
        const nativeDir = join(dir, "native");
        mkdirSync(nativeDir, { recursive: true });

        writeNativeIntegrityManifest(nativeDir, undefined);
        const manifest = readManifest(nativeDir);
        expect(manifest.files).toEqual({});
        expect(manifest.packages).toEqual({});
    });

    it("reads package identity from package.json, not from the directory name", () => {
        // The staged directory is `sharp-linux-x64` — the `@img/` scope segment
        // is gone, because the tree is copied from INSIDE `@img`. Deriving the
        // package name from the directory would be a guess, and this repo has
        // already shipped one wrong guess about sharp's naming (`linuxmusl`).
        const { nativeDir } = stageNative();
        const found = readImgPackageVersions(nativeDir);
        expect(found).toEqual([
            {
                name: "@img/sharp-libvips-linux-x64",
                version: VIPS_VERSION,
                dir: "sharp-libvips-linux-x64",
            },
            {
                name: "@img/sharp-linux-x64",
                version: SHARP_VERSION,
                dir: "sharp-linux-x64",
            },
        ]);
    });
});

describe("stageSharpNative pins what it stages", () => {
    /**
     * An app tree with `node_modules/@img` and a lockfile, holding the DEFAULT
     * IMAGE TARGET's packages (`linuxmusl`, #949 — staging selects by target,
     * so a fixture with only a foreign platform's packages would exercise the
     * fetch path, not the copy path this block pins).
     */
    function appTree(): string {
        const cwd = mkdtempSync(join(tmpdir(), "knext-stage-app-"));
        const img = join(
            cwd,
            "node_modules",
            "@img",
            "sharp-linuxmusl-x64",
            "lib",
        );
        mkdirSync(img, { recursive: true });
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
                version: SHARP_VERSION,
            }),
        );
        writeFileSync(join(img, "sharp-linuxmusl-x64.node"), "ADDON BYTES");
        const vips = join(
            cwd,
            "node_modules",
            "@img",
            "sharp-libvips-linuxmusl-x64",
            "lib",
        );
        mkdirSync(vips, { recursive: true });
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
                version: VIPS_VERSION,
            }),
        );
        writeFileSync(join(vips, "libvips-cpp.so.42"), "VIPS BYTES");
        writeFileSync(
            join(cwd, "bun.lock"),
            lockfile({
                "@img/sharp-linuxmusl-x64": SHARP_VERSION,
                "@img/sharp-libvips-linuxmusl-x64": VIPS_VERSION,
            }),
        );
        return cwd;
    }

    it("writes a manifest covering the copied addon", () => {
        // The end-to-end claim: nothing reaches `native/` without a hash, because
        // the hashing is inside the copy step rather than an extra call the next
        // build path can forget.
        const cwd = appTree();
        stageSharpNative(cwd);

        const manifest = readManifest(join(cwd, "native"));
        expect(
            manifest.files["sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node"],
        ).toBe(
            createHash("sha256")
                .update(Buffer.from("ADDON BYTES"))
                .digest("hex"),
        );
        expect(manifest.packages["@img/sharp-linuxmusl-x64"].version).toBe(
            SHARP_VERSION,
        );
    });

    it("still writes a manifest for an app with no sharp at all", () => {
        // The empty `native/` exists so `COPY native` does not fail. It gets a
        // manifest too, because "no manifest" is the shim's legacy-image signal
        // and an app that never had sharp must not look like a stripped tree.
        const cwd = mkdtempSync(join(tmpdir(), "knext-stage-nosharp-"));
        stageSharpNative(cwd);
        expect(readManifest(join(cwd, "native")).files).toEqual({});
    });

    it("REFUSES to stage a package the lockfile does not pin", () => {
        const cwd = appTree();
        writeFileSync(
            join(cwd, "bun.lock"),
            lockfile({
                "@img/sharp-libvips-linuxmusl-x64": VIPS_VERSION,
                "@img/sharp-linuxmusl-x64": undefined,
            }),
        );
        expect(() => stageSharpNative(cwd)).toThrow(
            /@img\/sharp-linuxmusl-x64/,
        );
    });
});

describe("the scaffold template ships the manifest with the tree", () => {
    const dockerfile = readFileSync(
        join(
            dirname(import.meta.dirname),
            "..",
            "templates",
            "app",
            "Dockerfile.hbs",
        ),
        "utf8",
    );

    it("copies the directory, which carries the manifest inside it", () => {
        expect(dockerfile).toMatch(/COPY native \/app\/native/);
    });

    it("fails the build when the manifest is absent, rather than at request time", () => {
        // Absence is only a WARN at runtime (older images must not brick), so
        // without this the scaffold path would ship unverified natives silently.
        expect(dockerfile).toContain(INTEGRITY_MANIFEST_NAME);
        expect(dockerfile).toMatch(
            /RUN test -f \/app\/native\/\.integrity\.json/,
        );
    });
});
