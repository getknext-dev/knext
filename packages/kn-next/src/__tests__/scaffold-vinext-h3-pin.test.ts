/**
 * nitro@3.0.260610-beta pins h3@2.0.1-rc.22, whose H3Event constructor runs a
 * bare decodeURI() before any handler (and whose serveStatic has another), so a
 * malformed path such as `/%2/` escapes as an uncaught URIError / 500. h3 2.0.2
 * fixes it. The vinext scaffold must force h3 >= 2.0.2 under every package
 * manager's override mechanism, and must not leak it into other builders.
 * Retire when nitro's own pinned h3 is past 2.0.2.
 */
import { describe, expect, it } from "bun:test";
import { renderScaffold } from "../cli/create";

const PINNED = "2.0.2";

function pkg(builder: "default" | "vinext", runtime: "bun" | "node") {
    const text = renderScaffold({
        name: "h3-app",
        version: "1.2.3",
        builder,
        runtime,
    }).get("package.json");
    if (text === undefined) throw new Error("no package.json rendered");
    return JSON.parse(text);
}

describe("vinext scaffold pins h3", () => {
    for (const runtime of ["bun", "node"] as const) {
        it(`vinext/${runtime}: npm+bun overrides pin h3`, () => {
            expect(pkg("vinext", runtime).overrides.h3).toBe(PINNED);
        });
        it(`vinext/${runtime}: pnpm.overrides pins h3`, () => {
            expect(pkg("vinext", runtime).pnpm?.overrides?.h3).toBe(PINNED);
        });
        it(`vinext/${runtime}: yarn resolutions pins h3`, () => {
            expect(pkg("vinext", runtime).resolutions?.h3).toBe(PINNED);
        });
        it(`default/${runtime}: no h3 pin`, () => {
            const json = pkg("default", runtime);
            expect(json.overrides?.h3).toBeUndefined();
            expect(json.pnpm?.overrides?.h3).toBeUndefined();
            expect(json.resolutions?.h3).toBeUndefined();
        });
    }
});
