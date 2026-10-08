/**
 * The vinext scaffold pins `@vercel/og` to a release whose `ImageResponse`
 * renders in knext's vinext + Nitro build. Nitro keeps `@vercel/og` external
 * there, which bypasses vinext's own fix for the 1.x line, so vinext's default
 * (1.0.3) answers every `next/og` route with a 500 — compiled or not. The pin
 * must reach a new app on BOTH runtimes, and must not leak into the builders
 * that never install vinext.
 */
import { describe, expect, it } from "bun:test";
import { renderScaffold } from "../cli/create";

const PINNED = "0.11.1";

function pkg(builder: "default" | "vinext", runtime: "bun" | "node") {
    const text = renderScaffold({
        name: "og-app",
        version: "1.2.3",
        builder,
        runtime,
    }).get("package.json");
    if (text === undefined) throw new Error("no package.json rendered");
    return JSON.parse(text);
}

describe("vinext scaffold pins @vercel/og", () => {
    for (const runtime of ["bun", "node"] as const) {
        it(`builder vinext, runtime ${runtime} → overrides pin @vercel/og to ${PINNED}`, () => {
            expect(pkg("vinext", runtime).overrides["@vercel/og"]).toBe(PINNED);
        });

        it(`builder default, runtime ${runtime} → no @vercel/og override`, () => {
            const json = pkg("default", runtime);
            expect(json.overrides?.["@vercel/og"]).toBeUndefined();
        });
    }

    it("the pin is an exact version, not a range a later release can satisfy", () => {
        expect(pkg("vinext", "bun").overrides["@vercel/og"]).toMatch(
            /^\d+\.\d+\.\d+$/,
        );
    });
});
