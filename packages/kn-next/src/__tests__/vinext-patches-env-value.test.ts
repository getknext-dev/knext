/**
 * An unrecognised `KNEXT_VINEXT_PATCHES` value (a typo such as `stric`) is
 * treated like the default warn mode, exactly as before, but it must not do so
 * silently: the user has to be told the value was not understood and which
 * values are accepted. Recognised values, blank and unset print nothing extra.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    describeEnsureResult,
    ensureVinextPatches,
    VINEXT_PATCHES_ENV,
    vinextPatchesMain,
} from "../cli/vinext-patches";

const apps: string[] = [];

function appWithVinext(version: string): string {
    const app = mkdtempSync(join(tmpdir(), "knext-vp-env-value-"));
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

afterEach(() => {
    for (const a of apps.splice(0)) rmSync(a, { recursive: true, force: true });
});

const UNRECOGNISED = /not a recognised/i;

describe("an unrecognised KNEXT_VINEXT_PATCHES value", () => {
    const env = { [VINEXT_PATCHES_ENV]: "stric" };
    const text = () => {
        const app = appWithVinext("1.0.1");
        return describeEnsureResult(ensureVinextPatches(app, { env }), {
            env,
        }).join("\n");
    };

    it("prints a warning that names the bad value", () => {
        expect(text()).toMatch(UNRECOGNISED);
        expect(text()).toContain(`${VINEXT_PATCHES_ENV}=stric`);
    });

    it("lists the accepted values: 0, strict, and unset", () => {
        const warning = text()
            .split("\n")
            .find((l) => UNRECOGNISED.test(l));
        expect(warning).toBeDefined();
        expect(warning).toMatch(/Accepted values: 0 \(/);
        expect(warning).toContain("strict (");
        expect(warning).toMatch(/unset/);
    });

    it("keeps the default warn behaviour: no throw, and the mismatch warning still prints", () => {
        const app = appWithVinext("1.0.1");
        const res = ensureVinextPatches(app, { env });
        expect(res.kind).toBe("version-mismatch");
        expect(text()).toMatch(/none of them were applied/i);
    });

    it("warns even when there is no vinext to patch", () => {
        const lines = describeEnsureResult({ kind: "no-vinext" }, { env });
        expect(lines.join("\n")).toMatch(UNRECOGNISED);
    });

    it("`knext vinext-patches` prints the warning on stdout", async () => {
        const app = appWithVinext("1.0.1");
        const out: string[] = [];
        await vinextPatchesMain([], {
            cwd: app,
            env,
            stdout: (t: string) => out.push(t),
            stderr: () => {},
        });
        expect(out.join("")).toMatch(UNRECOGNISED);
    });

    it("prints nothing extra for unset, blank, or recognised values", () => {
        const cases: Record<string, string | undefined>[] = [
            {},
            { [VINEXT_PATCHES_ENV]: "   " },
            { [VINEXT_PATCHES_ENV]: "0" },
            { [VINEXT_PATCHES_ENV]: " OFF " },
            { [VINEXT_PATCHES_ENV]: "No" },
            { [VINEXT_PATCHES_ENV]: "false" },
            { [VINEXT_PATCHES_ENV]: "STRICT" },
        ];
        for (const c of cases) {
            const lines = describeEnsureResult(
                { kind: "no-vinext" },
                { env: c },
            );
            expect(lines.join("\n")).not.toMatch(UNRECOGNISED);
        }
    });
});
