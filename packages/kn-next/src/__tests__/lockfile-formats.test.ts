/**
 * #2360 — pnpm and yarn lockfiles as a source of the image's sharp pin.
 *
 * The standalone build now adds the image platform's sharp addon
 * (`@img/sharp-linuxmusl-*` + `@img/sharp-libvips-linuxmusl-*`) beside the
 * traced sharp, fetching it at the lockfile-pinned version when the build
 * host's install does not have it. Before this, only `bun.lock` and
 * `package-lock.json` were readable, so a pnpm or yarn app built on a glibc
 * host or a Mac failed the build. These fixtures are the shapes each installer
 * actually writes: pnpm lockfile v6 (`/name@version` keys), v9 (`name@version`
 * keys, a `snapshots:` section, and pnpm 10's leading env document), yarn
 * classic v1 (its own non-YAML format) and yarn berry (YAML, `__metadata`,
 * `checksum` of yarn's own cache archive rather than the registry tarball).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLockfile, readLockfilePackages } from "../cli/native-integrity";
import { UsageError } from "../cli/shared";
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

function lockDir(name: string, text: string): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-2360-lock-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, name), text);
    return join(dir, name);
}

describe("findLockfile — pnpm and yarn lockfiles are found (#2360)", () => {
    it("finds pnpm-lock.yaml", () => {
        const lock = lockDir("pnpm-lock.yaml", PNPM_V9);
        expect(findLockfile(join(lock, ".."))).toBe(lock);
    });

    it("finds yarn.lock", () => {
        const lock = lockDir("yarn.lock", YARN_CLASSIC);
        expect(findLockfile(join(lock, ".."))).toBe(lock);
    });

    it("finds a lockfile in a workspace root above the app", () => {
        const lock = lockDir("pnpm-lock.yaml", PNPM_V6);
        const app = join(lock, "..", "apps", "web");
        mkdirSync(app, { recursive: true });
        expect(findLockfile(app)).toBe(lock);
    });
});

describe("readLockfilePackages — pnpm-lock.yaml (#2360)", () => {
    it("v6: reads /name@version keys with their sha512 integrity", () => {
        const pkgs = readLockfilePackages(lockDir("pnpm-lock.yaml", PNPM_V6));
        expect(pkgs.get("@img/sharp-linuxmusl-x64")).toEqual([
            { version: "0.33.5", integrity: sri("musl-0.33.5") },
        ]);
        expect(pkgs.get("@img/sharp-libvips-linuxmusl-x64")).toEqual([
            { version: "1.0.4", integrity: sri("libvips-musl-1.0.4") },
        ]);
        expect(pkgs.get("sharp")?.[0]?.version).toBe("0.33.5");
        // The peer suffix is not part of the version.
        expect(pkgs.get("next")).toEqual([
            { version: "15.0.0", integrity: sri("next-15") },
        ]);
    });

    it("v9: reads quoted name@version keys, every version of a package, across both documents", () => {
        const pkgs = readLockfilePackages(lockDir("pnpm-lock.yaml", PNPM_V9));
        expect(pkgs.get("@img/sharp-linuxmusl-x64")).toEqual([
            { version: "0.34.5", integrity: sri("musl-0.34.5") },
            { version: "0.35.5", integrity: sri("musl-0.35.5") },
        ]);
        expect(
            pkgs.get("@img/sharp-libvips-linuxmusl-x64")?.map((v) => v.version),
        ).toEqual(["1.2.4", "1.3.4"]);
        expect(pkgs.get("sharp")?.map((v) => v.version)).toEqual([
            "0.34.5",
            "0.35.5",
        ]);
        // pnpm 10's env document is read too, and a non-registry entry has
        // no integrity rather than a made-up one.
        expect(pkgs.get("pnpm")?.[0]?.version).toBe("10.18.0");
        expect(pkgs.get("local-pkg")?.[0]?.integrity ?? null).toBeNull();
    });

    it("fails closed on an unparseable pnpm-lock.yaml", () => {
        const lock = lockDir(
            "pnpm-lock.yaml",
            "lockfileVersion: '9.0'\npackages:\n  'a@1':\n    resolution: {integrity: [\n",
        );
        expect(() => readLockfilePackages(lock)).toThrow(UsageError);
        expect(() => readLockfilePackages(lock)).toThrow(/pnpm-lock\.yaml/);
    });
});

describe("readLockfilePackages — yarn.lock (#2360)", () => {
    it("classic v1: reads every descriptor header, version and sha512 integrity", () => {
        const pkgs = readLockfilePackages(lockDir("yarn.lock", YARN_CLASSIC));
        expect(pkgs.get("@img/sharp-linuxmusl-x64")).toEqual([
            { version: "0.33.5", integrity: sri("musl-0.33.5") },
        ]);
        expect(pkgs.get("@img/sharp-libvips-linuxmusl-x64")).toEqual([
            { version: "1.0.4", integrity: sri("libvips-musl-1.0.4") },
        ]);
        expect(pkgs.get("sharp")).toEqual([
            { version: "0.33.5", integrity: sri("sharp-0.33.5") },
        ]);
        // An aliased header keys by the installed (alias) name.
        expect(pkgs.get("string-width-cjs")?.[0]?.version).toBe("4.2.3");
        expect(pkgs.get("string-width")?.[0]?.version).toBe("4.2.3");
    });

    it("classic v1: a multi-hash integrity yields its sha512, a sha1-only one stays non-sha512", () => {
        const pkgs = readLockfilePackages(lockDir("yarn.lock", YARN_CLASSIC));
        expect(pkgs.get("@img/sharp-win32-x64")?.[0]?.integrity).toBe(
            sri("win32-0.33.5"),
        );
        const legacy = pkgs.get("legacy-only")?.[0]?.integrity;
        expect(legacy?.startsWith("sha512-") ?? false).toBe(false);
    });

    it("berry: reads name and version from each entry, and records NO tarball integrity", () => {
        const pkgs = readLockfilePackages(lockDir("yarn.lock", YARN_BERRY));
        // berry's `checksum` hashes yarn's own cache archive, not the
        // registry tarball, so it is never offered as the tarball's sha512.
        expect(pkgs.get("@img/sharp-linuxmusl-x64")).toEqual([
            { version: "0.34.5", integrity: null },
        ]);
        expect(pkgs.get("@img/sharp-libvips-linuxmusl-x64")).toEqual([
            { version: "1.2.4", integrity: null },
        ]);
        expect(pkgs.get("sharp")).toEqual([
            { version: "0.34.5", integrity: null },
        ]);
        // Versions are read as text, never coerced to numbers ("1.0" != 1).
        expect(pkgs.get("tiny")?.[0]?.version).toBe("1.0");
        expect(pkgs.has("__metadata")).toBe(false);
    });
});
