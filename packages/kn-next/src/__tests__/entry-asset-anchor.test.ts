/**
 * Pure unit tests for entry-asset-anchor.mjs (cluster C4). The integration
 * proof that this actually fixes `next/og`'s ImageResponse inside the
 * compiled single executable lives in vinext-compile-og-exec.test.ts and
 * vinext-compile-entry-asset-anchor.test.ts; this file is the fast, no-fs,
 * no-bun-compile guard on the rewrite logic itself.
 */
import { describe, expect, it } from "bun:test";
import {
    findAssetAnchors,
    rewriteAssetAnchors,
} from "../adapters/entry-asset-anchor.mjs";

describe("findAssetAnchors", () => {
    it('finds a `new URL("./x", import.meta.url)` anchor', () => {
        const src = 'const p = new URL("./resvg.wasm", import.meta.url);';
        expect(findAssetAnchors(src)).toEqual([{ literal: "./resvg.wasm" }]);
    });

    it("finds a `../` anchor and single-quoted literals", () => {
        const src = "const p = new URL('../assets/font.ttf', import.meta.url);";
        expect(findAssetAnchors(src)).toEqual([
            { literal: "../assets/font.ttf" },
        ]);
    });

    it("finds every anchor, in source order", () => {
        const src =
            'a(new URL("./a.wasm", import.meta.url));\n' +
            'b(new URL("./b.ttf", import.meta.url));';
        expect(findAssetAnchors(src)).toEqual([
            { literal: "./a.wasm" },
            { literal: "./b.ttf" },
        ]);
    });

    it("does NOT match a bare specifier (no leading ./ or ../)", () => {
        const src = 'new URL("resvg.wasm", import.meta.url)';
        expect(findAssetAnchors(src)).toEqual([]);
    });

    it("does NOT match `new URL(x, something.else)`", () => {
        const src = 'new URL("./x.wasm", someOtherBase)';
        expect(findAssetAnchors(src)).toEqual([]);
    });

    it("tolerates whitespace between tokens", () => {
        const src = 'new URL(\n  "./x.wasm" ,\n  import.meta.url\n)';
        expect(findAssetAnchors(src)).toEqual([{ literal: "./x.wasm" }]);
    });
});

describe("rewriteAssetAnchors", () => {
    it("leaves source untouched when the resolver finds nothing", () => {
        const src = 'new URL("./x.wasm", import.meta.url)';
        const { contents, assets } = rewriteAssetAnchors(src, () => undefined);
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("rewrites a resolved anchor to pathToFileURL(<embedded id>)", () => {
        const src = 'fileURLToPath(new URL("./resvg.wasm", import.meta.url))';
        const { contents, assets } = rewriteAssetAnchors(src, (lit) =>
            lit === "./resvg.wasm" ? "/abs/resvg.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/resvg.wasm" },
        ]);
        expect(contents).toBe(
            'fileURLToPath(require("node:url").pathToFileURL(__knextAssetAnchor0))',
        );
    });

    it("gives two DISTINCT anchors two distinct ids, in first-seen order", () => {
        const src =
            'a(new URL("./a.wasm", import.meta.url));\n' +
            'b(new URL("./b.ttf", import.meta.url));';
        const map: Record<string, string> = {
            "./a.wasm": "/abs/a.wasm",
            "./b.ttf": "/abs/b.ttf",
        };
        const { assets } = rewriteAssetAnchors(src, (lit) => map[lit]);
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/a.wasm" },
            { id: "__knextAssetAnchor1", absPath: "/abs/b.ttf" },
        ]);
    });

    it("gives the SAME absolute path the SAME id when the anchor repeats", () => {
        const src =
            'a(new URL("./x.wasm", import.meta.url));\n' +
            'b(new URL("./x.wasm", import.meta.url));';
        const { contents, assets } = rewriteAssetAnchors(
            src,
            () => "/abs/x.wasm",
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/x.wasm" },
        ]);
        expect(contents).toBe(
            'a(require("node:url").pathToFileURL(__knextAssetAnchor0));\n' +
                'b(require("node:url").pathToFileURL(__knextAssetAnchor0));',
        );
    });

    it("rewrites only the anchors the resolver answers for, leaving the rest", () => {
        const src =
            'a(new URL("./known.wasm", import.meta.url));\n' +
            'b(new URL("./unknown.wasm", import.meta.url));';
        const { contents, assets } = rewriteAssetAnchors(src, (lit) =>
            lit === "./known.wasm" ? "/abs/known.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/known.wasm" },
        ]);
        expect(contents).toBe(
            'a(require("node:url").pathToFileURL(__knextAssetAnchor0));\n' +
                'b(new URL("./unknown.wasm", import.meta.url));',
        );
    });

    it("passes the resolver the literal exactly as written, unresolved", () => {
        const src = 'new URL("./nested/dir/x.wasm", import.meta.url)';
        let seen: string | undefined;
        rewriteAssetAnchors(src, (lit) => {
            seen = lit;
            return undefined;
        });
        expect(seen).toBe("./nested/dir/x.wasm");
    });
});
