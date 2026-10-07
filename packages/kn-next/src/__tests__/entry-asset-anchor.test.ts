/**
 * Pure unit tests for entry-asset-anchor.mjs (cluster C4). The integration
 * proof that this actually fixes `next/og`'s ImageResponse inside the
 * compiled single executable lives in vinext-compile-og-exec.test.ts; the
 * any-package proof (a synthetic package, binary moved away from its build
 * dir) lives in vinext-compile-asset-anchor-any-package.test.ts; the
 * containment/size-cap proof (real filesystem, real `resolveAssetAnchor`)
 * lives in vinext-compile-asset-anchor-containment.test.ts. This file is the
 * fast, no-fs, no-bun-compile guard on the rewrite logic and its scoping:
 * a module must belong to SOME package (never the compiled entry), and an
 * anchor is rewritten only when the URL FEEDS a filesystem read — never a
 * `new Worker`, `fetch`, dynamic `import()`, comment or string.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { analyzeAssetAnchors } from "../adapters/asset-anchor-analyze.mjs";
import {
    assetAnchorPackageRoot,
    findAssetAnchors,
    hasAssetAnchorCandidate,
    rewriteAssetAnchors,
    rewriteEntryHarfbuzzAnchors,
    rewriteVinextHarfbuzzAnchors,
} from "../adapters/entry-asset-anchor.mjs";

/** `rewriteAssetAnchors` with the real consumer analysis injected (in-process here). */
const rewrite = (
    src: string,
    modulePath: string,
    resolveLiteral: (literal: string) => string | undefined,
    resolveLocateFile?: (name: string) => string | undefined,
) =>
    rewriteAssetAnchors(
        src,
        modulePath,
        resolveLiteral,
        resolveLocateFile,
        analyzeAssetAnchors,
    );

const OG_PATH = "/app/node_modules/@vercel/og/dist/index.node.js";
const OG_SIDECAR_PATH =
    "/app/.output/server/node_modules/@vercel/og/dist/index.node.js";
const OTHER_PATH = "/app/node_modules/some-other-pkg/dist/worker-entry.js";
const ACME_PATH =
    "/app/.output/server/node_modules/@acme/wasm-reader/dist/index.js";
const ENTRY_PATH = "/app/.output/server/index.mjs";

const REWRITTEN = (id: number) =>
    `require("node:url").pathToFileURL(__knextAssetAnchor${id})`;

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

    it("finds the anchor even inside `new Worker(...)` — the detector is UNSCOPED on purpose; scoping is the consumer analysis's job", () => {
        const src = 'new Worker(new URL("./w.js", import.meta.url))';
        expect(findAssetAnchors(src)).toEqual([{ literal: "./w.js" }]);
    });
});

describe("assetAnchorPackageRoot — any package, never the entry", () => {
    it("gives a real install of @vercel/og its own root", () => {
        expect(assetAnchorPackageRoot(OG_PATH)).toBe(
            "/app/node_modules/@vercel/og",
        );
    });

    it("gives nitro's staged SIDECAR copy its own root, not only a real install", () => {
        expect(assetAnchorPackageRoot(OG_SIDECAR_PATH)).toBe(
            "/app/.output/server/node_modules/@vercel/og",
        );
    });

    it("covers ANY package — no allowlist (scoped and unscoped)", () => {
        expect(assetAnchorPackageRoot(OTHER_PATH)).toBe(
            "/app/node_modules/some-other-pkg",
        );
        expect(assetAnchorPackageRoot(ACME_PATH)).toBe(
            "/app/.output/server/node_modules/@acme/wasm-reader",
        );
    });

    it("uses the INNERMOST node_modules package for a nested install", () => {
        expect(
            assetAnchorPackageRoot(
                "/app/node_modules/a/node_modules/b/lib/x.js",
            ),
        ).toBe("/app/node_modules/a/node_modules/b");
    });

    it("has no root for the compiled ENTRY or any path outside node_modules", () => {
        expect(assetAnchorPackageRoot(ENTRY_PATH)).toBeUndefined();
        expect(assetAnchorPackageRoot("/app/src/index.ts")).toBeUndefined();
    });

    it("has no root for a bare node_modules dir or a lone scope segment", () => {
        expect(assetAnchorPackageRoot("/app/node_modules")).toBeUndefined();
        expect(
            assetAnchorPackageRoot("/app/node_modules/@scope"),
        ).toBeUndefined();
    });
});

describe("analyzeAssetAnchors — what the URL feeds", () => {
    const consumers = (src: string) =>
        analyzeAssetAnchors(src).anchors.map((a) => a.consumer);

    it.each([
        [
            "readFileSync(fileURLToPath(...))",
            'fs.readFileSync(fileURLToPath(new URL("./a.wasm", import.meta.url)))',
        ],
        [
            "readFileSync(url) directly",
            'readFileSync(new URL("./a.wasm", import.meta.url))',
        ],
        [
            "fs.readFile with a callback",
            'fs.readFile(new URL("./a.wasm", import.meta.url), cb)',
        ],
        [
            "fs.promises.readFile",
            'await fs.promises.readFile(new URL("./a.wasm", import.meta.url))',
        ],
        [
            "a CJS-interop `(0, x.fileURLToPath)` wrapper",
            '(0, import_fs.readFileSync)((0, import_url.fileURLToPath)(new URL("./a.wasm", import.meta.url)))',
        ],
        [
            "a backtick literal",
            "readFileSync(new URL(`./a.wasm`, import.meta.url))",
        ],
        [
            "WebAssembly.instantiate from a read",
            'await WebAssembly.instantiate(readFileSync(new URL("./a.wasm", import.meta.url)))',
        ],
        [
            "new WebAssembly.Module from a minified read alias",
            'new WebAssembly.Module(f(new URL("./a.wasm", import.meta.url)))',
        ],
        [
            "WebAssembly.compile from a minified read alias",
            "WebAssembly.compile(r(new URL(`../a.wasm`,import.meta.url)))",
        ],
        [
            "a const binding, then a read",
            'const p = fileURLToPath(new URL("./a.wasm", import.meta.url));\nexport const m = readFileSync(p, "utf8");',
        ],
        [
            "two const hops, then a read",
            'const u = new URL("./a.wasm", import.meta.url);\nconst p = fileURLToPath(u);\nreadFileSync(p);',
        ],
        [
            "`.pathname` then a read",
            'readFileSync(new URL("./a.wasm", import.meta.url).pathname)',
        ],
    ])("classifies %s as a read", (_name, src) => {
        expect(consumers(src)).toEqual(["read"]);
    });

    it.each([
        ["new Worker", 'new Worker(new URL("./w.js", import.meta.url))'],
        [
            "new Worker with options",
            'new Worker(new URL("./w.js", import.meta.url), { type: "module" })',
        ],
        [
            "new SharedWorker",
            'new SharedWorker(new URL("./w.js", import.meta.url))',
        ],
        [
            "worker_threads.Worker",
            'new wt.Worker(fileURLToPath(new URL("./w.js", import.meta.url)))',
        ],
        ["fetch", 'await fetch(new URL("./data.json", import.meta.url))'],
        [
            "dynamic import of .href",
            'await import(new URL("./mod.js", import.meta.url).href)',
        ],
        [
            "dynamic import of the URL",
            'await import(new URL("./mod.js", import.meta.url))',
        ],
        [
            "a const binding fed to a Worker",
            'const u = new URL("./w.js", import.meta.url);\nnew Worker(u);',
        ],
    ])("classifies %s as excluded", (_name, src) => {
        expect(consumers(src)).toEqual(["excluded"]);
    });

    it("excludes a binding used by BOTH a read and a Worker (never rewrite code a Worker loads)", () => {
        const src =
            'const u = new URL("./w.js", import.meta.url);\nreadFileSync(u);\nnew Worker(u);';
        expect(consumers(src)).toEqual(["excluded"]);
    });

    it.each([
        ["a bare anchor", 'const u = new URL("./a.wasm", import.meta.url);'],
        [
            "a URL handed to an unknown function",
            'initWasm(new URL("./a.wasm", import.meta.url))',
        ],
        [
            "fileURLToPath with no read",
            'export const p = fileURLToPath(new URL("./a.wasm", import.meta.url));',
        ],
        [
            "a template interpolation",
            'const s = `${new URL("./a.wasm", import.meta.url)}`;',
        ],
    ])("classifies %s as unknown (left alone)", (_name, src) => {
        expect(consumers(src)).toEqual(["unknown"]);
    });

    it("sees NO anchor inside comments, strings or a template's literal part", () => {
        const src = [
            '// readFileSync(new URL("./a.wasm", import.meta.url))',
            '/* readFileSync(new URL("./b.wasm", import.meta.url)) */',
            "const s = 'readFileSync(new URL(\"./c.wasm\", import.meta.url))';",
            'const t = `readFileSync(new URL("./d.wasm", import.meta.url))`;',
        ].join("\n");
        expect(analyzeAssetAnchors(src).anchors).toEqual([]);
    });

    it("still finds a real read after a regex literal holding a quote (the case a simple lexer mis-reads)", () => {
        const src =
            'const re = /"/g; const b = readFileSync(new URL("./a.wasm", import.meta.url));';
        expect(consumers(src)).toEqual(["read"]);
    });

    it("reports a parse error instead of guessing", () => {
        const result = analyzeAssetAnchors(
            'readFileSync(new URL("./a.wasm", import.meta.url)); +++ {',
        );
        expect(result.anchors).toEqual([]);
        expect(typeof result.parseError).toBe("string");
    });
});

describe("rewriteAssetAnchors — any package, read consumers only", () => {
    it("rewrites a sibling .wasm read in a NON-og package", () => {
        const src =
            'export const bytes = readFileSync(new URL("./x.wasm", import.meta.url));';
        const { contents, assets } = rewrite(src, ACME_PATH, (lit) =>
            lit === "./x.wasm" ? "/abs/x.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/x.wasm" },
        ]);
        expect(contents).toBe(
            `export const bytes = readFileSync(${REWRITTEN(0)});`,
        );
    });

    it("rewrites @vercel/og's real shape (fs2.readFileSync(fileURLToPath(new URL(...))))", () => {
        const src =
            'var resvg_wasm = fs2.readFileSync(\n  fileURLToPath(new URL("./resvg.wasm", import.meta.url))\n);';
        const { contents, assets } = rewrite(src, OG_PATH, (lit) =>
            lit === "./resvg.wasm" ? "/abs/resvg.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/resvg.wasm" },
        ]);
        expect(contents).toBe(
            `var resvg_wasm = fs2.readFileSync(\n  fileURLToPath(${REWRITTEN(0)})\n);`,
        );
    });

    it.each([
        ["new Worker", 'new Worker(new URL("./w.js", import.meta.url))'],
        ["fetch", 'fetch(new URL("./d.json", import.meta.url))'],
        ["dynamic import", 'import(new URL("./m.js", import.meta.url).href)'],
        [
            "a line comment",
            '// readFileSync(new URL("./x.wasm", import.meta.url))\nconst x = 1;',
        ],
        [
            "a string literal",
            "const s = 'readFileSync(new URL(\"./x.wasm\", import.meta.url))';",
        ],
        [
            "an unknown consumer",
            'initWasm(new URL("./x.wasm", import.meta.url))',
        ],
    ])("leaves a %s anchor untouched and never asks the resolver", (_name, src) => {
        let calls = 0;
        const { contents, assets } = rewrite(src, ACME_PATH, () => {
            calls++;
            return "/abs/would-embed"; // would answer yes if ever asked
        });
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
        expect(calls, "the resolver must not run for a non-read anchor").toBe(
            0,
        );
    });

    it("leaves the compiled ENTRY's own read untouched, even with a resolvable sibling", () => {
        const src =
            'readFileSync(fileURLToPath(new URL("./sibling.txt", import.meta.url)))';
        let calls = 0;
        const { contents, assets } = rewrite(src, ENTRY_PATH, () => {
            calls++;
            return "/abs/sibling.txt";
        });
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
        expect(calls).toBe(0);
    });

    it("leaves source untouched when the resolver finds nothing", () => {
        const src = 'readFileSync(new URL("./x.wasm", import.meta.url))';
        const { contents, assets } = rewrite(src, OG_PATH, () => undefined);
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("rewrites only the READ anchor in a module that also holds a Worker anchor and a commented-out one", () => {
        const src =
            '// new URL("./old.wasm", import.meta.url)\n' +
            'const w = () => new Worker(new URL("./w.js", import.meta.url));\n' +
            'const resvg = fs.readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url)));';
        const { contents, assets } = rewrite(
            src,
            OG_PATH,
            (lit) => `/abs/${lit.slice(2)}`,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/resvg.wasm" },
        ]);
        expect(contents).toBe(
            '// new URL("./old.wasm", import.meta.url)\n' +
                'const w = () => new Worker(new URL("./w.js", import.meta.url));\n' +
                `const resvg = fs.readFileSync(fileURLToPath(${REWRITTEN(0)}));`,
        );
    });

    it("rewrites the anchor inside a const binding the read consumes", () => {
        const src =
            'const p = fileURLToPath(new URL("./ok.wasm", import.meta.url));\nexport const marker = readFileSync(p, "utf8");';
        const { contents, assets } = rewrite(
            src,
            ACME_PATH,
            () => "/abs/ok.wasm",
        );
        expect(assets).toHaveLength(1);
        expect(contents).toBe(
            `const p = fileURLToPath(${REWRITTEN(0)});\nexport const marker = readFileSync(p, "utf8");`,
        );
    });

    it("returns the parse error and the source unchanged when the module does not parse", () => {
        const src = 'readFileSync(new URL("./x.wasm", import.meta.url)); +++ {';
        const result = rewrite(src, ACME_PATH, () => "/abs/x.wasm");
        expect(result.contents).toBe(src);
        expect(result.assets).toEqual([]);
        expect(typeof result.parseError).toBe("string");
    });
});

describe("rewriteAssetAnchors — the injected analysis", () => {
    const READ_SRC = 'readFileSync(new URL("./x.wasm", import.meta.url))';

    it("rewrites NO `new URL` anchor when no analysis is injected (never guess)", () => {
        const { contents, assets } = rewriteAssetAnchors(
            READ_SRC,
            ACME_PATH,
            () => "/abs/x.wasm",
        );
        expect(contents).toBe(READ_SRC);
        expect(assets).toEqual([]);
    });

    it("never runs the analysis for the entry, or for a module with no textual anchor", () => {
        let calls = 0;
        const analyze = (src: string) => {
            calls++;
            return analyzeAssetAnchors(src);
        };
        rewriteAssetAnchors(
            READ_SRC,
            ENTRY_PATH,
            () => "/abs/x",
            undefined,
            analyze,
        );
        rewriteAssetAnchors(
            'readFileSync(join(__dirname, "x.wasm"))',
            ACME_PATH,
            () => "/abs/x",
            undefined,
            analyze,
        );
        expect(calls).toBe(0);
        expect(hasAssetAnchorCandidate(READ_SRC)).toBe(true);
        rewriteAssetAnchors(
            READ_SRC,
            ACME_PATH,
            () => "/abs/x",
            undefined,
            analyze,
        );
        expect(calls).toBe(1);
    });

    it("script mode: the analyzer run as its own bun process prints the same analysis as JSON", () => {
        const src =
            'const w = () => new Worker(new URL("./w.js", import.meta.url));\n' +
            'export const b = readFileSync(new URL("./x.wasm", import.meta.url));';
        const child = spawnSync(
            process.execPath,
            [resolve(import.meta.dir, "../adapters/asset-anchor-analyze.mjs")],
            { input: src, encoding: "utf8" },
        );
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual(analyzeAssetAnchors(src));
        expect(
            JSON.parse(child.stdout).anchors.map(
                (a: { consumer: string }) => a.consumer,
            ),
        ).toEqual(["excluded", "read"]);
    });
});

describe("rewriteAssetAnchors — dedup and pass-through", () => {
    it("gives two DISTINCT anchors two distinct ids, in first-seen order", () => {
        const src =
            'readFileSync(new URL("./a.wasm", import.meta.url));\n' +
            'readFileSync(new URL("./b.ttf", import.meta.url));';
        const map: Record<string, string> = {
            "./a.wasm": "/abs/a.wasm",
            "./b.ttf": "/abs/b.ttf",
        };
        const { assets } = rewrite(src, OG_PATH, (lit) => map[lit]);
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/a.wasm" },
            { id: "__knextAssetAnchor1", absPath: "/abs/b.ttf" },
        ]);
    });

    it("gives the SAME absolute path the SAME id when the anchor repeats", () => {
        const src =
            'readFileSync(new URL("./x.wasm", import.meta.url));\n' +
            'readFileSync(new URL("./x.wasm", import.meta.url));';
        const { contents, assets } = rewrite(src, OG_PATH, () => "/abs/x.wasm");
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/x.wasm" },
        ]);
        expect(contents).toBe(
            `readFileSync(${REWRITTEN(0)});\nreadFileSync(${REWRITTEN(0)});`,
        );
    });

    it("rewrites only the anchors the resolver answers for, leaving the rest", () => {
        const src =
            'readFileSync(new URL("./known.wasm", import.meta.url));\n' +
            'readFileSync(new URL("./unknown.wasm", import.meta.url));';
        const { contents, assets } = rewrite(src, OG_PATH, (lit) =>
            lit === "./known.wasm" ? "/abs/known.wasm" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/known.wasm" },
        ]);
        expect(contents).toBe(
            `readFileSync(${REWRITTEN(0)});\n` +
                'readFileSync(new URL("./unknown.wasm", import.meta.url));',
        );
    });

    it("passes the resolver the literal exactly as written, unresolved", () => {
        const src =
            'readFileSync(new URL("./nested/dir/x.wasm", import.meta.url))';
        let seen: string | undefined;
        rewrite(src, OG_PATH, (lit) => {
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

    it('replaces locateFile("hb.wasm") in an @vercel/og module with the embedded asset path', () => {
        const { contents, assets } = rewrite(
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
        const src = `readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url))); ${GLUE}`;
        const { contents, assets } = rewrite(
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

    it("never consults the locateFile resolver for any package other than @vercel/og (its hb.wasm fallback is og-specific)", () => {
        let calls = 0;
        const { contents, assets } = rewrite(
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
        const { contents, assets } = rewrite(
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
        const { contents, assets } = rewrite(
            src,
            OG_PATH,
            () => undefined,
            () => "/abs/hb.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("is a no-op when no locateFile resolver is passed (the pre-#1872 three-argument call)", () => {
        const { contents, assets } = rewrite(GLUE, OG_PATH, () => undefined);
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

    it("also matches vinext's shape with quoted literals and an og-assets hashed asset name", () => {
        const src =
            "function a(){return new WebAssembly.Module(r(new URL(\"./hb.wasm\", import.meta.url)))} function b(){return new WebAssembly.Module( x.readFileSync( new URL('../_next/static/hb-Ab12_c.wasm', import.meta.url) ) )}";
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            src,
            () => "/abs/hb.wasm",
        );
        expect(assets).toHaveLength(1);
        expect(contents).not.toContain("import.meta.url");
    });

    it("leaves a USER's own hb.wasm URL alone — only vinext's WebAssembly.Module(read(new URL(...))) shape is rewritten", () => {
        // The nitro entry inlines user code too; a user loading their own
        // hb.wasm must keep their own file, never get vinext's pinned one.
        const src =
            'const mine = readFileSync(new URL("./hb.wasm", import.meta.url)); const m2 = new URL(`../../hb.wasm`, import.meta.url); const w = await WebAssembly.compile(readFileSync(new URL("../../hb.wasm", import.meta.url)));';
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            src,
            () => "/abs/hb.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("leaves a string literal that merely mentions the URL alone", () => {
        const src =
            "const doc = 'load it via new URL(\"../../hb.wasm\", import.meta.url)';";
        const { contents, assets } = rewriteEntryHarfbuzzAnchors(
            src,
            () => "/abs/hb.wasm",
        );
        expect(contents).toBe(src);
        expect(assets).toEqual([]);
    });

    it("leaves every other wasm (resvg.wasm, yoga.wasm) alone", () => {
        const src =
            'new WebAssembly.Module(f(new URL("./resvg.wasm", import.meta.url))); new WebAssembly.Module(f(new URL(`../../yoga.wasm`, import.meta.url)))';
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

describe("rewriteVinextHarfbuzzAnchors — the node-preset rewrite (#1872)", () => {
    it("re-points vinext's anchor at a sibling hb.wasm and counts it", () => {
        const src =
            "function py(){return new WebAssembly.Module(f(new URL(`../../hb.wasm`,import.meta.url)))}";
        const { contents, count } = rewriteVinextHarfbuzzAnchors(
            src,
            'new URL("./hb.wasm", import.meta.url)',
        );
        expect(count).toBe(1);
        expect(contents).toBe(
            'function py(){return new WebAssembly.Module(f(new URL("./hb.wasm", import.meta.url)))}',
        );
    });

    it("counts zero and changes nothing on a user's own anchor", () => {
        const src = 'readFileSync(new URL("../../hb.wasm", import.meta.url))';
        const { contents, count } = rewriteVinextHarfbuzzAnchors(
            src,
            'new URL("./hb.wasm", import.meta.url)',
        );
        expect(count).toBe(0);
        expect(contents).toBe(src);
    });
});

describe("rewriteAssetAnchors — three-argument back-compat (#1872)", () => {
    const GLUE = 'function findWasmBinary(){return locateFile("hb.wasm")}';
    it("is a no-op for locateFile when no resolver is passed", () => {
        const { contents, assets } = rewrite(GLUE, OG_PATH, () => undefined);
        expect(contents).toBe(GLUE);
        expect(assets).toEqual([]);
    });
});

describe("unknown anchors carry a reason, and the rewrite reports what it skipped", () => {
    const reasonOf = (src: string) =>
        analyzeAssetAnchors(src).anchors.map((a) => a.reason);

    it.each([
        [
            "createReadStream",
            'createReadStream(new URL("./a.bin", import.meta.url))',
            /passed to createReadStream\(\)/,
        ],
        [
            "openSync",
            'fs.openSync(new URL("./a.bin", import.meta.url))',
            /passed to openSync\(\)/,
        ],
        [
            "an object property",
            'const o = { u: new URL("./a.bin", import.meta.url) };',
            /object property/,
        ],
        [
            "a later function argument",
            'f(x, new URL("./a.bin", import.meta.url))',
            /not the first argument of f\(\)/,
        ],
        [
            "assign-after-declare",
            'let u; u = new URL("./a.bin", import.meta.url);',
            /assigned to an existing variable/,
        ],
        [
            "an unused binding",
            'const u = new URL("./a.bin", import.meta.url);',
            /bound to `u`, which is never used/,
        ],
    ])("%s", (_name, src, why) => {
        const [reason] = reasonOf(src);
        expect(reason).toMatch(why);
    });

    it("a read or excluded anchor has no reason", () => {
        expect(
            reasonOf(
                'readFileSync(new URL("./a.bin", import.meta.url)); new Worker(new URL("./w.js", import.meta.url));',
            ),
        ).toEqual([undefined, undefined]);
    });

    it("lists unknown anchors and reads of a missing file in `skipped`, never Worker/fetch/import ones", () => {
        const src = [
            'createReadStream(new URL("./a.bin", import.meta.url));',
            'readFileSync(new URL("./missing.bin", import.meta.url));',
            'readFileSync(new URL("./ok.bin", import.meta.url));',
            'new Worker(new URL("./w.js", import.meta.url));',
        ].join("\n");
        const { assets, skipped } = rewrite(src, ACME_PATH, (lit) =>
            lit === "./ok.bin" ? "/abs/ok.bin" : undefined,
        );
        expect(assets).toEqual([
            { id: "__knextAssetAnchor0", absPath: "/abs/ok.bin" },
        ]);
        expect(skipped.map((s) => s.literal)).toEqual([
            "./a.bin",
            "./missing.bin",
        ]);
        expect(skipped[0].reason).toMatch(/createReadStream/);
        expect(skipped[1].reason).toMatch(
            /no such file exists beside the module/,
        );
    });
});
