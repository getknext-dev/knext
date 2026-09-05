/**
 * #949 — coverage for the sharp-staging build path's remaining branches.
 *
 * The sibling `vinext-build.test.ts` proves the staging BEHAVIOUR (which
 * platform's addons ship, the unwind, the ownership refusal). This file closes
 * the paths that file leaves unexercised, each with a real assertion rather than
 * a bare call:
 *
 *   - `buildVinextExecutable`'s SUCCESS tail — every earlier test uses a fake
 *     cwd that fails the `.output` existence check, so the compile + stage steps
 *     past it were never run;
 *   - `detectBunVersion`, the seam that shells out to `bun --version` — the
 *     ambient-detection path, asserted against whatever version this host's Bun
 *     actually reports (≥1.4 → the build proceeds; <1.4 → it refuses NAMING that
 *     version), so the assertion is self-consistent under any co-installed Bun;
 *   - `extractVerifiedTarball`'s "not an npm tarball" branch — a payload with no
 *     `package/` directory, verified pin and all;
 *   - `detectLinuxLibc` called directly;
 *   - `stageSharpNative`'s unknown-arch refusal.
 *
 * Nothing here reaches the network, and nothing depends on injecting a fake
 * `npm`/`bun` onto PATH: Bun's per-process executable-resolution cache makes
 * PATH-prepend injection version-dependent (a co-installed Bun 1.3.x ignores a
 * runtime PATH-prepend for child resolution), so the registry FETCH body is left
 * to the alpine e2e, while its guarantee — the sha512 pin — is proved offline by
 * `extractVerifiedTarball` here and in `vinext-build.test.ts`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildVinextExecutable,
    bunMeetsFloor,
    detectLinuxLibc,
    extractVerifiedTarball,
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

/** An app tree with a real `.output/server/index.mjs`, ready to compile. */
function appWithOutput(prefix: string): string {
    const cwd = tempDir(prefix);
    mkdirSync(join(cwd, ".output", "server"), { recursive: true });
    writeFileSync(
        join(cwd, ".output", "server", "index.mjs"),
        "export default {};\n",
    );
    return cwd;
}

describe("#ADR-0048 buildVinextExecutable runs the compile + stage tail", () => {
    it("compiles the nitro entry and stages native/, returning the binary path", () => {
        // The .output exists, so control reaches PAST the existence check the
        // other tests stop at: the compile runs and native/ is staged. The app
        // has no sharp, so staging writes an empty-but-present manifest.
        const cwd = appWithOutput("knext-vbc-ok-");
        const calls: string[][] = [];

        const out = buildVinextExecutable({
            cwd,
            arch: "linux-x64",
            bunVersion: "1.4.0",
            skipViteBuild: true,
            run: (argv) => calls.push([...argv]),
        });

        // Default output name for the arch — never a runtime word.
        expect(out).toBe("knext-exec-linux-x64");
        // The compile step ran, once, against the nitro entry.
        expect(calls.length).toBe(1);
        expect(calls[0]?.slice(0, 2)).toEqual(["bun", "run"]);
        expect(calls[0]).toContain(".output/server/index.mjs");
        // And native/ was staged with its integrity manifest (empty here).
        const manifest = JSON.parse(
            readFileSync(join(cwd, "native", ".integrity.json"), "utf8"),
        );
        expect(manifest.files).toEqual({});
    });

    it("honours an explicit outFile, still staging native/", () => {
        const cwd = appWithOutput("knext-vbc-outfile-");

        const out = buildVinextExecutable({
            cwd,
            arch: "darwin-arm64",
            outFile: "my-binary",
            bunVersion: "1.4.0",
            skipViteBuild: true,
            run: () => {},
        });

        expect(out).toBe("my-binary");
        expect(existsSync(join(cwd, "native", ".integrity.json"))).toBe(true);
    });

    it("detects the ambient Bun when no version is injected, and reacts to it", () => {
        // Omitting `bunVersion` exercises detectBunVersion's happy path: it
        // shells out to the ambient `bun --version` and buildVinextExecutable
        // then applies the floor to whatever it read. The assertion is pinned to
        // the ambient version this seam actually returns rather than assuming
        // one, so it proves the detected value is what the build acted on:
        //   - ambient ≥ 1.4 → the build proceeds to a returned binary path;
        //   - ambient < 1.4 → the build refuses, NAMING the detected version.
        const cwd = appWithOutput("knext-vbc-detect-");
        const ambient = execFileSync("bun", ["--version"], {
            encoding: "utf8",
        }).trim();

        const run = (): string =>
            buildVinextExecutable({
                cwd,
                arch: "linux-x64",
                skipViteBuild: true,
                run: () => {},
            });

        if (bunMeetsFloor(ambient)) {
            expect(run()).toBe("knext-exec-linux-x64");
        } else {
            expect(run).toThrow(new RegExp(ambient.replace(/\./g, "\\.")));
        }
    });
});

describe("#949 extractVerifiedTarball rejects a non-npm tarball", () => {
    it("throws when the verified tarball has no package/ payload", () => {
        // A tarball whose sha512 MATCHES the pin but whose contents are not an
        // npm layout (no top-level `package/`). Verification passes, extraction
        // runs, and the missing payload is a named failure — never a silent
        // empty stage.
        const dir = tempDir("knext-vbc-nopayload-");
        mkdirSync(join(dir, "notpackage"), { recursive: true });
        writeFileSync(join(dir, "notpackage", "x.txt"), "stray");
        const tgz = join(dir, "pkg.tgz");
        execFileSync("tar", ["-czf", tgz, "-C", dir, "notpackage"]);
        const integrity = `sha512-${createHash("sha512")
            .update(readFileSync(tgz))
            .digest("base64")}`;
        const dest = join(tempDir("knext-vbc-nopayload-out-"), "out");

        expect(() =>
            extractVerifiedTarball(
                tgz,
                {
                    name: "@img/sharp-linuxmusl-x64",
                    version: "0.35.4",
                    integrity,
                },
                dest,
            ),
        ).toThrow(/package\/|payload|npm registry tarball/);
        expect(existsSync(dest)).toBe(false);
    });
});

describe("#949 stageSharpNative refuses an unknown arch", () => {
    it("names the arch rather than staging a guessed platform", () => {
        const cwd = tempDir("knext-vbc-badarch-");
        expect(() => stageSharpNative(cwd, { arch: "solaris-sparc" })).toThrow(
            /solaris-sparc/,
        );
    });
});

describe("#894 detectLinuxLibc reports a concrete libc", () => {
    it("returns one of gnu|musl, and gnu on a non-glibc-runtime host", () => {
        const libc = detectLinuxLibc();
        expect(["gnu", "musl"]).toContain(libc);
        // The test host is darwin (no glibcVersionRuntime in process.report and
        // no musl loader on disk), so the fallback resolves to gnu.
        if (process.platform === "darwin") {
            expect(libc).toBe("gnu");
        }
    });
});
