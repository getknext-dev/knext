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
