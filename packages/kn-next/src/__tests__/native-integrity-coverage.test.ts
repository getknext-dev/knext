/**
 * C2 integrity-pinning — the fail-closed parse/read branches the behavioural
 * suite (`native-integrity.test.ts`) does not exercise.
 *
 * Each of these is a "refuse rather than guess" path: an @img package whose
 * `package.json` cannot be read, or a `bun.lock` that cannot be parsed, must
 * fail the build NAMING the problem rather than silently pinning nothing — the
 * whole point of the manifest is that the bytes dlopened in the image are the
 * bytes the lockfile resolved. A pure-fs test, no spawn, no network.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    findLockfile,
    readImgPackageVersions,
    readLockfilePackages,
} from "../cli/native-integrity";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

describe("readImgPackageVersions fails closed on an unreadable package.json", () => {
    it("throws NAMING the staged package rather than pinning it blind", () => {
        // A staged @img directory whose package.json is not valid JSON. Its
        // provenance cannot be established, so the build must refuse — an
        // unreadable manifest is exactly the injected-dependency shape the pin
        // exists to catch, not something to skip past.
        const nativeDir = tempDir("knext-nic-badpkg-");
        const pkgDir = join(nativeDir, "sharp-linuxmusl-x64");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), "{ this is not json");

        expect(() => readImgPackageVersions(nativeDir)).toThrow(
            /unreadable package\.json/,
        );
    });

    it("skips a directory that has no package.json at all", () => {
        // Not every subdirectory is a package (libvips ships loose files); one
        // without a package.json is simply not enumerated, not an error.
        const nativeDir = tempDir("knext-nic-nopkg-");
        mkdirSync(join(nativeDir, "loose"), { recursive: true });
        writeFileSync(join(nativeDir, "loose", "data.bin"), "x");

        expect(readImgPackageVersions(nativeDir)).toEqual([]);
    });

    it("returns [] for a native/ that does not exist, rather than throwing", () => {
        // The empty-tree path: `stageSharpNative` reads versions before it has
        // created anything, so an absent directory must read as "nothing
        // staged", not as an error that aborts the manifest write.
        const missing = join(tempDir("knext-nic-absent-"), "never-created");
        expect(readImgPackageVersions(missing)).toEqual([]);
    });
});

describe("readLockfilePackages fails closed on an unparseable lockfile", () => {
    it("throws pointing at the lockfile, not a bare JSON error", () => {
        // A bun.lock that is neither JSON nor the JSONC bun writes. Pinning
        // provenance against it is impossible, so the failure names the file.
        const dir = tempDir("knext-nic-badlock-");
        const lock = join(dir, "bun.lock");
        writeFileSync(lock, "<<< not a lockfile >>>");

        expect(() => readLockfilePackages(lock)).toThrow(
            new RegExp(
                `Could not parse.*${lock.replace(/[/\\]/g, "\\$&")}`,
                "s",
            ),
        );
    });

    it("parses an integrity string containing an escaped quote intact", () => {
        // bun.lock is JSONC and the trailing-comma stripper is string-AWARE: it
        // must not treat a quote INSIDE a string value as the string's end, or a
        // subsequent comma would be mis-stripped and the integrity corrupted.
        // An escaped `\"` inside the integrity slot exercises that escape branch.
        const dir = tempDir("knext-nic-escape-");
        const lock = join(dir, "bun.lock");
        writeFileSync(
            lock,
            '{\n  "packages": {\n' +
                '    "@img/sharp-linuxmusl-x64": ["@img/sharp-linuxmusl-x64@0.35.4", "", {}, "sha512-ab\\"cd=="],\n' +
                "  }\n}\n",
        );

        const pkgs = readLockfilePackages(lock);
        // #954 made this a Map<name, LockedPackage[]> (two versions of one
        // package can be legitimately pinned); the single entry is [0].
        const entry = pkgs.get("@img/sharp-linuxmusl-x64")?.[0];
        expect(entry?.version).toBe("0.35.4");
        // The escaped quote survived the JSONC pass — the integrity is intact.
        expect(entry?.integrity).toBe('sha512-ab"cd==');
    });
});

/**
 * #1864 — npm's `package-lock.json` is a readable lockfile source, not just
 * bun's `bun.lock`.
 *
 * `knext create`'s own `partingLine()` tells every scaffold, `--runtime node`
 * included, to run `npm install` — so an app whose sharp staging falls back to
 * the lockfile-pinned fetch (any build host that is not itself musl, which is
 * every CI runner and every dev machine) had NO readable pin at all for an
 * npm-installed app, before this. `findLockfile`/`readLockfilePackages` are the
 * SHIPPED functions `stageSharpNative`/`stageSharpForVinextNode` call; these
 * tests exercise them directly, offline, matching the convention above.
 */
describe("#1864 npm's package-lock.json is a readable lockfile", () => {
    /**
     * npm's real `packages` shape (lockfileVersion 2/3): keyed by install
     * PATH (not bun's `name@version` descriptor), one entry per resolved
     * package including platform-mismatched `optionalDependencies` npm never
     * downloaded to this host — measured against a real `npm install`
     * (2026-10-04, darwin-arm64): the lockfile still carries a full
     * `node_modules/@img/sharp-linuxmusl-x64` entry, version + sha512
     * integrity, even though nothing of that name ever reached
     * `node_modules/@img` on that host.
     */
    function npmLockText(
        entries: Record<string, { version: string; integrity?: string }>,
    ): string {
        const packages: Record<string, unknown> = { "": { name: "app" } };
        for (const [key, v] of Object.entries(entries)) {
            packages[key] = {
                version: v.version,
                resolved: `https://registry.npmjs.org/${key.replace("node_modules/", "")}/-/x.tgz`,
                integrity: v.integrity ?? `sha512-pin${v.version.length}==`,
            };
        }
        return JSON.stringify(
            { name: "app", lockfileVersion: 3, packages },
            null,
            2,
        );
    }

    it("findLockfile returns package-lock.json when no bun.lock exists", () => {
        const dir = tempDir("knext-1864-findlock-");
        writeFileSync(join(dir, "package-lock.json"), npmLockText({}));
        expect(findLockfile(dir)).toBe(join(dir, "package-lock.json"));
    });

    it("findLockfile prefers bun.lock over package-lock.json when both exist", () => {
        const dir = tempDir("knext-1864-findlock-both-");
        writeFileSync(join(dir, "package-lock.json"), npmLockText({}));
        writeFileSync(join(dir, "bun.lock"), '{\n  "packages": {}\n}\n');
        expect(findLockfile(dir)).toBe(join(dir, "bun.lock"));
    });

    it("reads a scoped platform package pinned at the top level", () => {
        const dir = tempDir("knext-1864-npmlock-scoped-");
        const lock = join(dir, "package-lock.json");
        writeFileSync(
            lock,
            npmLockText({
                "node_modules/@img/sharp-linuxmusl-x64": {
                    version: "0.35.5",
                    integrity: "sha512-realpin==",
                },
            }),
        );
        const pkgs = readLockfilePackages(lock);
        const entry = pkgs.get("@img/sharp-linuxmusl-x64")?.[0];
        expect(entry?.version).toBe("0.35.5");
        expect(entry?.integrity).toBe("sha512-realpin==");
    });

    it("resolves the package name from a NESTED (non-hoisted) install path", () => {
        const dir = tempDir("knext-1864-npmlock-nested-");
        const lock = join(dir, "package-lock.json");
        writeFileSync(
            lock,
            npmLockText({
                "node_modules/next/node_modules/@img/sharp-linuxmusl-x64": {
                    version: "0.34.9",
                },
            }),
        );
        const pkgs = readLockfilePackages(lock);
        const entries = pkgs.get("@img/sharp-linuxmusl-x64");
        expect(entries).toHaveLength(1);
        expect(entries?.[0].version).toBe("0.34.9");
    });

    it("puts the canonical (top-level) resolution first when both exist", () => {
        const dir = tempDir("knext-1864-npmlock-canon-");
        const lock = join(dir, "package-lock.json");
        writeFileSync(
            lock,
            npmLockText({
                "node_modules/some-dep/node_modules/@img/sharp-linuxmusl-x64": {
                    version: "0.34.9",
                },
                "node_modules/@img/sharp-linuxmusl-x64": { version: "0.35.5" },
            }),
        );
        const pkgs = readLockfilePackages(lock);
        const entries = pkgs.get("@img/sharp-linuxmusl-x64") ?? [];
        expect(entries.map((e) => e.version)).toEqual(["0.35.5", "0.34.9"]);
    });

    it('skips the root entry (key "") rather than mis-naming it a package', () => {
        const dir = tempDir("knext-1864-npmlock-root-");
        const lock = join(dir, "package-lock.json");
        writeFileSync(
            lock,
            npmLockText({
                "node_modules/sharp": { version: "0.35.5" },
            }),
        );
        const pkgs = readLockfilePackages(lock);
        expect(pkgs.has("")).toBe(false);
        expect(pkgs.get("sharp")?.[0].version).toBe("0.35.5");
    });

    it("throws naming the file on an unparseable package-lock.json", () => {
        const dir = tempDir("knext-1864-npmlock-badjson-");
        const lock = join(dir, "package-lock.json");
        writeFileSync(lock, "<<< not json >>>");
        expect(() => readLockfilePackages(lock)).toThrow(
            new RegExp(
                `Could not parse.*${lock.replace(/[/\\]/g, "\\$&")}`,
                "s",
            ),
        );
    });
});
