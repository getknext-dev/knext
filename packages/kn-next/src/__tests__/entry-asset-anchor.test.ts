/**
 * Pure unit tests for entry-asset-anchor.mjs (cluster C4). The integration
 * proof that this actually fixes `next/og`'s ImageResponse inside the
 * compiled single executable lives in vinext-compile-og-exec.test.ts; the
 * containment/size-cap proof (real filesystem, real `resolveAssetAnchor`)
 * lives in vinext-compile-asset-anchor-containment.test.ts. This file is the
 * fast, no-fs, no-bun-compile guard on the rewrite logic and its TWO scoping
 * layers (package allowlist, code-vs-comment/string position) in isolation.
 */
import { describe, expect, it } from "bun:test";
import {
    allowlistedPackageRoot,
    findAssetAnchors,
    isAllowlistedAssetAnchorModule,
    rewriteAssetAnchors,
    rewriteEntryHarfbuzzAnchors,
} from "../adapters/entry-asset-anchor.mjs";

const OG_PATH = "/app/node_modules/@vercel/og/dist/index.node.js";
const OG_SIDECAR_PATH =
    "/app/.output/server/node_modules/@vercel/og/dist/index.node.js";
const OTHER_PATH = "/app/node_modules/some-other-pkg/dist/worker-entry.js";
const ENTRY_PATH = "/app/.output/server/index.mjs";

describe("findAssetAnchors (unscoped detector)", () => {
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

    it("finds the anchor even inside `new Worker(...)` — the detector is UNSCOPED on purpose; scoping is rewriteAssetAnchors's job", () => {
        const src = 'new Worker(new URL("./w.js", import.meta.url))';
        expect(findAssetAnchors(src)).toEqual([{ literal: "./w.js" }]);
    });
});

describe("isAllowlistedAssetAnchorModule / allowlistedPackageRoot", () => {
    it("allowlists a real install of @vercel/og", () => {
        expect(isAllowlistedAssetAnchorModule(OG_PATH)).toBe(true);
        expect(allowlistedPackageRoot(OG_PATH)).toBe(
            "/app/node_modules/@vercel/og",
        );
    });

    it("allowlists nitro's staged SIDECAR copy of @vercel/og, not only a real install", () => {
        expect(isAllowlistedAssetAnchorModule(OG_SIDECAR_PATH)).toBe(true);
        expect(allowlistedPackageRoot(OG_SIDECAR_PATH)).toBe(
            "/app/.output/server/node_modules/@vercel/og",
        );
    });

    it("rejects an unrelated package", () => {
        expect(isAllowlistedAssetAnchorModule(OTHER_PATH)).toBe(false);
        expect(allowlistedPackageRoot(OTHER_PATH)).toBeUndefined();
    });

    it("rejects the compiled ENTRY (never one of the allowlisted packages)", () => {
        expect(isAllowlistedAssetAnchorModule(ENTRY_PATH)).toBe(false);
        expect(allowlistedPackageRoot(ENTRY_PATH)).toBeUndefined();
    });

    it("rejects a path with no node_modules segment at all", () => {
        expect(isAllowlistedAssetAnchorModule("/app/src/index.ts")).toBe(false);
    });

    it("does not allowlist an UNSCOPED package merely sharing @vercel/og's final segment", () => {
        expect(
            isAllowlistedAssetAnchorModule(
                "/app/node_modules/og/dist/index.js",
            ),
        ).toBe(false);
    });
});

describe("rewriteAssetAnchors — package allowlist scope", () => {
    it("rewrites a resolved anchor in an ALLOWLISTED module", () => {
        const src = 'fileURLToPath(new URL("./resvg.wasm", import.meta.url))';
        const { contents, assets } = rewriteAssetAnchors(src, OG_PATH, (lit) =>
            lit === "./resvg.wasm" ? "/abs/resvg.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/resvg.wasm" },
        ]);
        expect(contents).toBe(
            'fileURLToPath(require("node:url").pathToFileURL(__knextAssetAnchor0))',
        );
    });

    it("leaves a NON-ALLOWLISTED module's `new Worker(new URL(...))` anchor completely untouched", () => {
        const src = 'new Worker(new URL("./w.js", import.meta.url))';
        let resolverCalls = 0;
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OTHER_PATH,
            () => {
                resolverCalls++;
                return "/abs/w.js"; // would answer yes if ever asked
            },
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
        expect(
            resolverCalls,
            "the resolver must never run for a non-allowlisted module",
        ).toBe(0);
    });

    it("leaves the compiled ENTRY's own anchor untouched, even with a resolvable sibling", () => {
        const src =
            'readFileSync(fileURLToPath(new URL("./sibling.txt", import.meta.url)))';
        const { contents, assets } = rewriteAssetAnchors(
            src,
            ENTRY_PATH,
            () => "/abs/sibling.txt",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("leaves source untouched when the resolver finds nothing, even in an allowlisted module", () => {
        const src = 'new URL("./x.wasm", import.meta.url)';
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OG_PATH,
            () => undefined,
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });
});

describe("rewriteAssetAnchors — code-position scope (comments and string literals)", () => {
    it("leaves an anchor inside a `//` line comment untouched", () => {
        const src =
            '// new URL("./resvg.wasm", import.meta.url) — old approach, kept for reference\nconst x = 1;';
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OG_PATH,
            () => "/abs/resvg.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("leaves an anchor inside a `/* */` block comment untouched", () => {
        const src =
            '/* new URL("./resvg.wasm", import.meta.url) */\nconst x = 1;';
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OG_PATH,
            () => "/abs/resvg.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("leaves an anchor inside a single-quoted STRING LITERAL untouched (the outer quote, not the inner one, is what matters)", () => {
        const src =
            "const warning = 'new URL(\"./resvg.wasm\", import.meta.url) is unsupported here';";
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OG_PATH,
            () => "/abs/resvg.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("leaves an anchor inside a template-literal LITERAL part untouched, but still rewrites one inside a `${...}` interpolation", () => {
        const src =
            'const doc = `see new URL("./resvg.wasm", import.meta.url) in the docs`;\n' +
            'const live = `${new URL("./resvg.wasm", import.meta.url)}`;';
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OG_PATH,
            () => "/abs/resvg.wasm",
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/resvg.wasm" },
        ]);
        expect(contents).toBe(
            'const doc = `see new URL("./resvg.wasm", import.meta.url) in the docs`;\n' +
                'const live = `${require("node:url").pathToFileURL(__knextAssetAnchor0)}`;',
        );
    });

    it("still rewrites a REAL (code-position) anchor elsewhere in the same allowlisted module that also has a commented-out one", () => {
        const src =
            '// new URL("./old.wasm", import.meta.url)\n' +
            'const resvg = fs.readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url)));';
        const { contents, assets } = rewriteAssetAnchors(src, OG_PATH, (lit) =>
            lit === "./resvg.wasm" ? "/abs/resvg.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/resvg.wasm" },
        ]);
        expect(contents).toBe(
            '// new URL("./old.wasm", import.meta.url)\n' +
                'const resvg = fs.readFileSync(fileURLToPath(require("node:url").pathToFileURL(__knextAssetAnchor0)));',
        );
    });
});

describe("rewriteAssetAnchors — dedup and pass-through", () => {
    it("gives two DISTINCT anchors two distinct ids, in first-seen order", () => {
        const src =
            'a(new URL("./a.wasm", import.meta.url));\n' +
            'b(new URL("./b.ttf", import.meta.url));';
        const map: Record<string, string> = {
            "./a.wasm": "/abs/a.wasm",
            "./b.ttf": "/abs/b.ttf",
        };
        const { assets } = rewriteAssetAnchors(src, OG_PATH, (lit) => map[lit]);
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
            OG_PATH,
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
        const { contents, assets } = rewriteAssetAnchors(src, OG_PATH, (lit) =>
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
        rewriteAssetAnchors(src, OG_PATH, (lit) => {
            seen = lit;
            return undefined;
        });
        expect(seen).toBe("./nested/dir/x.wasm");
    });
});

// #1872: @vercel/og 1.x inlines harfbuzzjs's Emscripten glue, which reads its
// WASM through `locateFile("hb.wasm")` (= `__dirname + "/hb.wasm"`) rather than
// a `new URL(lit, import.meta.url)` anchor — and 1.0.3 does not even ship that
// file. The optional fourth argument resolves such a name to an embeddable
// file; the call is replaced by the embedded asset's runtime path.
describe("rewriteAssetAnchors — Emscripten locateFile(<name>.wasm) (#1872)", () => {
    const GLUE =
        'var scriptDirectory = __dirname + "/"; function locateFile(path){return scriptDirectory+path} function findWasmBinary(){return locateFile("hb.wasm")}';

    it('replaces locateFile("hb.wasm") in an ALLOWLISTED module with the embedded asset path', () => {
        const { contents, assets } = rewriteAssetAnchors(
            GLUE,
            OG_SIDECAR_PATH,
            () => undefined,
            (name) =>
                name === "hb.wasm" ? "/abs/harfbuzzjs/hb.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/harfbuzzjs/hb.wasm" },
        ]);
        expect(contents).toContain(
            "function findWasmBinary(){return (__knextAssetAnchor0)}",
        );
        // the locateFile DEFINITION (non-literal argument) is left alone
        expect(contents).toContain(
            "function locateFile(path){return scriptDirectory+path}",
        );
    });

    it("shares ids with the import.meta.url anchors (no __knextAssetAnchor collision)", () => {
        const src = `fileURLToPath(new URL("./resvg.wasm", import.meta.url)); ${GLUE}`;
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OG_PATH,
            () => "/abs/resvg.wasm",
            () => "/abs/hb.wasm",
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/resvg.wasm" },
            { id: "__knextAssetAnchor1", absPath: "/abs/hb.wasm" },
        ]);
        expect(contents).toContain("return (__knextAssetAnchor1)");
    });

    it("never consults the locateFile resolver for a NON-ALLOWLISTED module", () => {
        let calls = 0;
        const { contents, assets } = rewriteAssetAnchors(
            GLUE,
            OTHER_PATH,
            () => undefined,
            () => {
                calls++;
                return "/abs/hb.wasm";
            },
        );
        expect(contents).toBe(GLUE);
        expect(assets).toEqual([]);
        expect(calls).toBe(0);
    });

    it('leaves locateFile("hb.wasm") untouched when the resolver finds nothing', () => {
        const { contents, assets } = rewriteAssetAnchors(
            GLUE,
            OG_PATH,
            () => undefined,
            () => undefined,
        );
        expect(contents).toBe(GLUE);
        expect(assets).toEqual([]);
    });

    it('skips a locateFile("hb.wasm") that sits inside a comment or string literal', () => {
        const src =
            '// locateFile("hb.wasm")\nconst s = \'locateFile("hb.wasm")\';';
        const { contents, assets } = rewriteAssetAnchors(
            src,
            OG_PATH,
            () => undefined,
            () => "/abs/hb.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("is a no-op when no locateFile resolver is passed (the pre-#1872 three-argument call)", () => {
        const { contents, assets } = rewriteAssetAnchors(
            GLUE,
            OG_PATH,
            () => undefined,
        );
        expect(contents).toBe(GLUE);
        expect(assets).toEqual([]);
    });
});

// #1872, app router / middleware: with the RSC environment bundling its deps
// under nitro, vinext's og-harfbuzz + og-assets plugins rewrite the glue to
// `readFileSync(new URL(`../../hb.wasm`, import.meta.url))` — relative to an
// intermediate RSC output dir nitro never ships. Once nitro inlines that chunk
// into the server entry the URL points at a file that exists nowhere.
describe("rewriteEntryHarfbuzzAnchors (#1872)", () => {
    const VINEXT_RSC =
        "function py(){return new WebAssembly.Module(f(new URL(`../../hb.wasm`,import.meta.url)))}";

    it("replaces a backtick-quoted relative hb.wasm URL with the embedded asset", () => {
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            VINEXT_RSC,
            () => "/abs/harfbuzzjs/hb.wasm",
        );
        expect(assets).toEqual([
            { id: "__knextHarfbuzzWasm0", absPath: "/abs/harfbuzzjs/hb.wasm" },
        ]);
        expect(contents).toBe(
            'function py(){return new WebAssembly.Module(f(require("node:url").pathToFileURL(__knextHarfbuzzWasm0)))}',
        );
    });

    it("also matches quoted literals and an og-assets hashed asset name", () => {
        const src =
            "a(new URL(\"./hb.wasm\", import.meta.url)); b(new URL('../_next/static/hb-Ab12_c.wasm', import.meta.url))";
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            src,
            () => "/abs/hb.wasm",
        );
        expect(assets).toHaveLength(1);
        expect(contents).not.toContain("import.meta.url");
    });

    it("leaves every other wasm (resvg.wasm, yoga.wasm) alone", () => {
        const src =
            'new URL("./resvg.wasm", import.meta.url); new URL(`../../yoga.wasm`, import.meta.url)';
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            src,
            () => "/abs/hb.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("leaves the source untouched when the resolver finds nothing", () => {
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            VINEXT_RSC,
            () => undefined,
        );
        expect(contents).toBe(VINEXT_RSC);
        expect(assets).toEqual([]);
    });

    it("still rewrites after a regex literal holding a quote (minified entries defeat a simple lexer)", () => {
        // Measured on a real nitro entry: a comment/string mask derived from
        // a simple forward scan treats everything after `/"/` as string data
        // and silently skipped the real anchor. This rewrite is unmasked on
        // purpose — its pattern is HarfBuzz's anchor and nothing else.
        const src = `const re = /"/g; ${VINEXT_RSC}`;
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            src,
            () => "/abs/hb.wasm",
        );
        expect(assets).toHaveLength(1);
        expect(contents).not.toContain("hb.wasm`");
    });
});

describe("rewriteAssetAnchors — three-argument back-compat (#1872)", () => {
    const GLUE = 'function findWasmBinary(){return locateFile("hb.wasm")}';
    it("is a no-op for locateFile when no resolver is passed", () => {
        const { contents, assets } = rewriteAssetAnchors(
            GLUE,
            OG_PATH,
            () => undefined,
        );
        expect(contents).toBe(GLUE);
        expect(assets).toEqual([]);
    });
});
