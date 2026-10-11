/**
 * Version drift in `knext build` / `knext vinext-patches`.
 *
 * With a vinext other than the one the bundled fixes were validated against,
 * every fix is skipped. The message must say exactly what the user loses and
 * how to fix it, and `KNEXT_VINEXT_PATCHES=strict` must turn the skip into an
 * error for teams that want the build to fail closed. The default stays a
 * warning: a newer vinext may already include the fixes, and failing every
 * existing build on upgrade would be a breaking default change.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectBuild } from "../cli/project-build";
import {
    describeEnsureResult,
    ensureVinextPatches,
    loadVinextPatchManifest,
    VINEXT_PATCHES_ENV,
    VinextVersionMismatchError,
    vinextPatchesDisabled,
    vinextPatchesMain,
} from "../cli/vinext-patches";

const manifest = loadVinextPatchManifest();
const apps: string[] = [];

function appWithVinext(version: string): string {
    const app = mkdtempSync(join(tmpdir(), "knext-vp-drift-"));
    apps.push(app);
    writeFileSync(
        join(app, "package.json"),
        JSON.stringify({ name: "a", type: "module" }),
    );
    const dir = join(app, "node_modules", "vinext");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "vinext", version }),
    );
    return app;
}

const savedEnv = process.env[VINEXT_PATCHES_ENV];
afterEach(() => {
    for (const a of apps.splice(0)) rmSync(a, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[VINEXT_PATCHES_ENV];
    else process.env[VINEXT_PATCHES_ENV] = savedEnv;
});

describe("the version-mismatch build message", () => {
    const lines = () => {
        const app = appWithVinext("1.0.1");
        return describeEnsureResult(ensureVinextPatches(app, { env: {} }));
    };

    it("says that NO fix was applied and how many were skipped", () => {
        const text = lines().join("\n");
        expect(text).toContain("vinext 1.0.1 is installed");
        expect(text).toContain(String(manifest.patches.length));
        expect(text).toMatch(/none of them were applied/i);
    });

    it("names what the user loses", () => {
        const text = lines().join("\n");
        expect(text).toMatch(/image optimizer/i);
        expect(text).toMatch(/compatib/i);
    });

    it("names the fix, and the opt-in strict mode", () => {
        const text = lines().join("\n");
        expect(text).toContain(`vinext@${manifest.vinext}`);
        expect(text).toContain(`${VINEXT_PATCHES_ENV}=strict`);
    });

    it("is a warning line, so it stands out in build output", () => {
        expect(lines()[0]).toMatch(/warning/i);
    });
});

describe("KNEXT_VINEXT_PATCHES=strict", () => {
    it("is not one of the values that disable the fixes", () => {
        expect(vinextPatchesDisabled({ [VINEXT_PATCHES_ENV]: "strict" })).toBe(
            false,
        );
    });

    it("makes ensureVinextPatches throw on a version mismatch, naming the fix", () => {
        const app = appWithVinext("1.0.1");
        let caught: unknown;
        try {
            ensureVinextPatches(app, {
                env: { [VINEXT_PATCHES_ENV]: "strict" },
            });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(VinextVersionMismatchError);
        const msg = (caught as Error).message;
        expect(msg).toContain("1.0.1");
        expect(msg).toContain(`vinext@${manifest.vinext}`);
    });

    it("is case-insensitive and tolerates surrounding whitespace", () => {
        const app = appWithVinext("1.0.1");
        expect(() =>
            ensureVinextPatches(app, {
                env: { [VINEXT_PATCHES_ENV]: " STRICT " },
            }),
        ).toThrow(VinextVersionMismatchError);
    });

    it("does not throw without it (the default stays a warning)", () => {
        const app = appWithVinext("1.0.1");
        expect(ensureVinextPatches(app, { env: {} }).kind).toBe(
            "version-mismatch",
        );
    });

    it("does not throw when there is no vinext", () => {
        const app = mkdtempSync(join(tmpdir(), "knext-vp-drift-"));
        apps.push(app);
        expect(
            ensureVinextPatches(app, {
                env: { [VINEXT_PATCHES_ENV]: "strict" },
            }).kind,
        ).toBe("no-vinext");
    });

    it("`knext build` on the vinext target fails before building", () => {
        const app = appWithVinext("1.0.1");
        process.env[VINEXT_PATCHES_ENV] = "strict";
        let built = false;
        expect(() =>
            runProjectBuild({
                requireEsm: true,
                cwd: app,
                run: () => {
                    built = true;
                },
            }),
        ).toThrow(VinextVersionMismatchError);
        expect(built).toBe(false);
    });

    it("`knext vinext-patches` exits 1 and prints the cause", async () => {
        const app = appWithVinext("1.0.1");
        const err: string[] = [];
        const code = await vinextPatchesMain([], {
            cwd: app,
            env: { [VINEXT_PATCHES_ENV]: "strict" },
            stdout: () => {},
            stderr: (t: string) => err.push(t),
        });
        expect(code).toBe(1);
        expect(err.join("")).toContain(`vinext@${manifest.vinext}`);
    });

    it("`knext build` without it still builds, printing the warning", () => {
        const app = appWithVinext("1.0.1");
        delete process.env[VINEXT_PATCHES_ENV];
        let built = false;
        runProjectBuild({
            requireEsm: true,
            cwd: app,
            run: () => {
                built = true;
            },
        });
        expect(built).toBe(true);
    });
});
