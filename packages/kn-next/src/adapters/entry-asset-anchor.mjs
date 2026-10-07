/**
 * Make a bundled package's own sibling-asset reads survive
 * `bun build --compile --bytecode` (cluster C4 of the 2026-10-03 vinext × bun
 * compat triage — og-api, og-routes-custom-font, metadata-dynamic-routes*,
 * metadata-edge, metadata-font, app-esm-js: every `next/og` `ImageResponse`
 * fixture, 500ing with ENOENT).
 *
 * ## Root cause
 *
 * A package that reads a file shipped beside its own module uses the standard
 * "asset next to this file" idiom — `@vercel/og`'s `dist/index.node.js` reads
 * its WASM renderer and fallback font exactly this way:
 *
 *     fs.readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url)))
 *
 * nitro traces such a package as a server-external and copies it — JS and
 * sibling files together — into `.output/server/node_modules/<pkg>/`
 * (`SIDECAR_NODE_MODULES` in vinext-compile.mjs). But an ESM package's code
 * stays BUNDLED into the executable (`entry-external-sidecar.mjs`'s redirect
 * only covers CommonJS entries), and once bundled, `import.meta.url` is no
 * longer the module's own real file location. Measured on Bun 1.4.2
 * (darwin-arm64), a `--bytecode` compile does NOT point a non-entry bundled
 * module's `import.meta.url` at `$bunfs/root` the way a plain compile does —
 * it bakes the BUILD MACHINE's literal absolute path in as a string constant
 * (oven-sh/bun#44068). That path exists only on the build host: the moment the
 * binary runs anywhere else, `new URL("./resvg.wasm", import.meta.url)`
 * resolves to a path that was never shipped and the read throws ENOENT.
 * (Full write-up: `.claude/research/bun-import-meta-url-bytecode-repro.md`.)
 * `vinext-compile-asset-root.test.ts` guards the SAME class of bug for the
 * entry's own `import.meta.url`.
 *
 * ## Fix — decided by what the URL FEEDS, in any package
 *
 * The first version of this fix was scoped to a one-package allowlist
 * (`@vercel/og`), because a blanket rewrite of every
 * `new URL(<relative literal>, import.meta.url)` is too wide: it would also
 * touch `new Worker(new URL("./w.js", import.meta.url))` (a module-loading
 * anchor — rewriting it changes WHICH code runs, not just where an asset
 * comes from), a `fetch()`/dynamic-`import()` anchor, and a `new URL(...)`
 * that merely appears inside a comment or string. The allowlist meant the
 * next package with the same idiom would hit the same ENOENT until someone
 * measured it and added it by hand.
 *
 * This version parses the module (acorn, in `asset-anchor-analyze.mjs`) and
 * follows each anchor to its CONSUMER: only an anchor that FEEDS A FILE READ
 * (`readFileSync`/`readFile`, directly or through `fileURLToPath`/a binding,
 * or bytes compiled as WebAssembly) is rewritten; `new Worker`, `fetch`,
 * `require` and dynamic `import()` anchors never are, and neither is anything
 * the analysis cannot place. Comments and strings are not code, so the parser
 * never reports an anchor inside them. See that module for the exact rules,
 * and for why `vinext-compile.mjs` runs it as a separate process: this module
 * stays dependency-free and takes the analysis as an injected function.
 *
 * Scope by location: only a module inside SOME package's own
 * `node_modules/<pkg>/` directory (`assetAnchorPackageRoot` — at any nesting
 * depth, so nitro's staged sidecar copy matches too) is considered. The
 * compiled entry (nitro's own `index.mjs`) and the server output's chunks are
 * never inside a package and are left untouched.
 *
 * A **read** anchor is then resolved against the MODULE'S OWN real file
 * location at BUILD time (the caller does this — this module stays pure), and
 * if a real file exists there it is EMBEDDED as a Bun file asset
 * (`import x from <path> with { type: "file" }` — the mechanism
 * `vinext-compile.mjs`'s self-contained mode already uses for `.output/public`
 * and sharp's native tree). The anchor is rewritten to resolve through that
 * binding instead of `import.meta.url`:
 *
 *     new URL("./resvg.wasm", import.meta.url)
 *     -> require("node:url").pathToFileURL(__knextAssetAnchor0)
 *
 * `pathToFileURL`/`fileURLToPath` round-trip back to the asset's own runtime
 * path (Bun's `fs` accepts `with { type: "file" }`'s `/$bunfs/...` path
 * directly), so the read gets exactly the asset's bytes, embedded in the
 * binary, portable to wherever it runs.
 *
 * Containment (no `..` escape out of the package, no symlink pointing outside
 * it) and a size cap are the CALLER's job (`vinext-compile.mjs`'s
 * `resolveAssetAnchor`), because both need the real filesystem. This module
 * takes yes/no resolvers instead, so the analysis stays unit-testable without
 * a real filesystem.
 *
 * ## Upstream
 *
 * This is a knext-side fix for a Bun gap: `bun build --compile` does not embed
 * a file read via `new URL("./x", import.meta.url)` (oven-sh/bun#44695 — it
 * fails with and without `--bytecode`; oven-sh/bun#39715 fixes only the
 * build-path baking under `--bytecode`). Retire this rewrite once Bun embeds
 * such files itself in a released version.
 */

/**
 * The package root (the absolute path through and including
 * `node_modules/<pkg>`, or `node_modules/@scope/<pkg>`) of `modulePath`, using
 * the LAST `node_modules` segment — or `undefined` when `modulePath` is not
 * inside any package (the compiled entry, a server-output chunk). Separator-
 * agnostic (`/` or `\`). Pure string arithmetic: the CALLER `realpathSync`s
 * both this and a resolved sibling before trusting either as a containment
 * boundary.
 *
 * @param {string} modulePath
 * @returns {string | undefined}
 */
export function assetAnchorPackageRoot(modulePath) {
    const parts = modulePath.split(/[\\/]+/);
    const idx = parts.lastIndexOf("node_modules");
    if (idx === -1 || idx + 1 >= parts.length) return undefined;
    const first = parts[idx + 1];
    if (first.startsWith("@")) {
        if (idx + 2 >= parts.length) return undefined;
        return parts.slice(0, idx + 3).join("/");
    }
    return parts.slice(0, idx + 2).join("/");
}

/** The bare package name of `modulePath` (scoped or not), or `undefined`. */
function packageNameOf(modulePath) {
    const root = assetAnchorPackageRoot(modulePath);
    if (root === undefined) return undefined;
    const parts = root.split("/");
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    return prev.startsWith("@") ? `${prev}/${last}` : last;
}

/**
 * `new URL("./relative/or/../relative", import.meta.url)`, captured literal in
 * group 2 — any quote, backtick included (minifiers emit those). Only a cheap
 * PREFILTER: a module with no textual match is never parsed.
 */
const ASSET_ANCHOR_RE =
    /new\s+URL\(\s*(["'`])((?:\.\/|\.\.\/)[^"'`()]+?)\1\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Every `new URL(<relative literal>, import.meta.url)` anchor in `src`, in
 * source order — a TEXTUAL match (no consumer analysis, no comment/string
 * awareness): the prefilter run before any module is parsed.
 *
 * @param {string} src
 * @returns {{ literal: string }[]}
 */
export function findAssetAnchors(src) {
    return [...src.matchAll(ASSET_ANCHOR_RE)].map((m) => ({ literal: m[2] }));
}

/**
 * Whether `src` holds at least one textual anchor — the cheap gate in front of
 * the (out-of-process) parse: a module that fails it is never analysed.
 *
 * @param {string} src
 * @returns {boolean}
 */
export function hasAssetAnchorCandidate(src) {
    ASSET_ANCHOR_RE.lastIndex = 0;
    return ASSET_ANCHOR_RE.test(src);
}

/**
 * Used ONLY by the `locateFile("<name>.wasm")` pass below — the `new URL`
 * anchors are found by the parser, which needs no mask.
 *
 * For every index of `src`, whether it sits in ordinary code (`1`) or inside
 * a `//` line comment, a `/* *\/` block comment, a `'...'`/`"..."` string, or
 * the literal (non-interpolated) part of a template string (`0`). One
 * forward scan; a template literal's `${...}` substitutions are marked CODE
 * again (brace-depth balanced), so an anchor written inside an interpolation
 * is still seen — only text that is actually DATA, never evaluated, is
 * excluded. Deliberately simple (no nested-string-inside-`${}` tracking,
 * same "bail rather than fully lex" trade-off `entry-require-staticize.mjs`
 * documents for its own scanning): over-marking a rare nested case as CODE
 * costs nothing here, because the literal still has to resolve to a real
 * file before anything changes.
 *
 * @param {string} src
 * @returns {Uint8Array}
 */
function codeMask(src) {
    const mask = new Uint8Array(src.length);
    const n = src.length;
    let i = 0;
    while (i < n) {
        const c = src[i];
        if (c === "/" && src[i + 1] === "/") {
            while (i < n && src[i] !== "\n") i++;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            i += 2;
            while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
            i = Math.min(i + 2, n);
            continue;
        }
        if (c === '"' || c === "'") {
            const quote = c;
            i++;
            while (i < n && src[i] !== quote) {
                i += src[i] === "\\" ? 2 : 1;
            }
            i++;
            continue;
        }
        if (c === "`") {
            i++;
            while (i < n && src[i] !== "`") {
                if (src[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (src[i] === "$" && src[i + 1] === "{") {
                    i += 2;
                    let depth = 1;
                    while (i < n && depth > 0) {
                        if (src[i] === "{") depth++;
                        else if (src[i] === "}") depth--;
                        if (depth > 0) mask[i] = 1;
                        i++;
                    }
                    continue;
                }
                i++;
            }
            i++;
            continue;
        }
        mask[i] = 1;
        i++;
    }
    return mask;
}

/**
 * `locateFile("<name>.wasm")` — the call Emscripten glue makes to find its
 * WASM binary, resolving it as `scriptDirectory + name` where
 * `scriptDirectory` is `__dirname + "/"` on Node (#1872). `@vercel/og` 1.x
 * inlines harfbuzzjs's glue and reads `hb.wasm` this way, NOT through a
 * `new URL(lit, import.meta.url)` anchor — and 1.0.3 does not even ship that
 * file beside itself (vercel/satori#801). Captured name in group 2. Only a
 * literal argument matches, so the glue's own `function locateFile(path)`
 * definition is never touched.
 */
const LOCATE_FILE_RE = /\blocateFile\(\s*(["'])([\w.-]+\.wasm)\1\s*\)/g;

/**
 * vinext's OWN HarfBuzz loader, exactly as its `vinext:og-harfbuzz` plugin
 * emits it (`function __vi_hb_module() { return new WebAssembly.Module(
 * __vi_hb_readFileSync(new URL("./hb.wasm", import.meta.url))); }`), after
 * `vinext:og-assets` re-pointed the path and the bundler minified the names —
 * measured on a real nitro entry:
 *
 *     new WebAssembly.Module(f(new URL(`../../hb.wasm`,import.meta.url)))
 *
 * The `new WebAssembly.Module(<read>(new URL(...)))` wrapper is part of the
 * pattern on purpose: the nitro entry inlines USER code too, and a user's own
 * `new URL("./hb.wasm", import.meta.url)` (read, fetched, compiled some other
 * way) must keep the user's file. Group 2 is the URL literal (relative path to
 * `hb.wasm`, or og-assets' hashed `hb-<hash>.wasm` asset), group 1 its quote.
 */
const VINEXT_HB_RE =
    /(?<=new\s+WebAssembly\.Module\(\s*[\w$.]+\(\s*)new\s+URL\(\s*(["'`])((?:\.\.?\/)+(?:[\w.-]+\/)*hb(?:-[\w-]+)?\.wasm)\1\s*,\s*import\.meta\.url\s*\)(?=\s*\)\s*\))/g;

/**
 * Replace the `new URL(...)` inside every vinext HarfBuzz loader in `src` with
 * `urlExpr` (an expression evaluating to the binary's URL). Pure; see
 * `VINEXT_HB_RE` for exactly what matches — never a user's own anchor.
 *
 * Deliberately NOT run through `codeMask`: measured on a real nitro entry, the
 * simple forward scan reads a minified regex literal holding a quote (`/"/`)
 * as the start of a string and masked the real anchor out. The pattern is the
 * scope instead: a string or comment would have to contain vinext's whole
 * `new WebAssembly.Module(read(new URL(...)))` loader verbatim to match.
 *
 * @param {string} src
 * @param {string} urlExpr
 * @returns {{ contents: string, count: number }}
 */
export function rewriteVinextHarfbuzzAnchors(src, urlExpr) {
    let count = 0;
    const contents = src.replace(VINEXT_HB_RE, () => {
        count++;
        return urlExpr;
    });
    return { contents, count };
}

/**
 * The app-router half of #1872 for the COMPILED executable. With the RSC
 * environment bundling its deps under nitro (the bundled vinext fix for
 * cloudflare/vinext#3424), vite bundles `@vercel/og` into the RSC chunk and
 * vinext's og plugins rewrite the HarfBuzz read relative to the intermediate
 * RSC output dir, where og-assets copied the binary. nitro then inlines that
 * chunk into `.output/server/index.mjs` and ships no `hb.wasm`, so the URL
 * resolves to a file that exists nowhere (measured: `<app root>/hb.wasm`).
 *
 * Rewrites vinext's loader (only — see `VINEXT_HB_RE`) to an embedded copy of
 * the binary `resolve` returns. `resolve` runs only when a loader is present,
 * at most once; undefined leaves the source untouched.
 *
 * @param {string} src
 * @param {() => string | undefined} resolve absolute path of the hb.wasm to embed
 * @returns {{ contents: string, assets: { id: string, absPath: string }[] }}
 */
export function rewriteEntryHarfbuzzAnchors(src, resolve) {
    VINEXT_HB_RE.lastIndex = 0;
    if (!VINEXT_HB_RE.test(src)) return { contents: src, assets: [] };
    VINEXT_HB_RE.lastIndex = 0;
    const absPath = resolve();
    if (absPath === undefined) return { contents: src, assets: [] };
    const { contents } = rewriteVinextHarfbuzzAnchors(
        src,
        'require("node:url").pathToFileURL(__knextHarfbuzzWasm0)',
    );
    return { contents, assets: [{ id: "__knextHarfbuzzWasm0", absPath }] };
}

/**
 * Splice the compiled entry's CODE-position `import.meta` uses (as
 * asset-anchor-analyze.mjs's `findImportMetaUses` reports them) with the
 * expressions that rebuild them inside the binary, so `--bytecode`'s CommonJS
 * output can hold the entry. Pure.
 *
 * Only reported uses are touched: the text `import.meta.url` inside a string,
 * template text or comment is data and stays byte-for-byte (the previous
 * textual `replaceAll` rewrote it too and broke the quoting — e.g. an MDX docs
 * page whose code sample mentions `import.meta.url`).
 *
 * @param {string} src
 * @param {{ start: number, end: number, prop: string | null }[]} uses
 * @param {{ url: string, filename: string, dirname: string }} exprs
 * @returns {{ contents: string, count: number, survived: string[] }}
 *   `survived`: the uses it cannot rewrite (`import.meta.<other>`)
 */
export function rewriteImportMetaUses(src, uses, exprs) {
    let contents = "";
    let at = 0;
    let count = 0;
    const survived = [];
    for (const use of uses) {
        // A bare `import.meta` (rolldown's per-module merge emits `var t =
        // import.meta` and reads `t.url` through a getter) becomes an inline
        // object carrying all three, valid wherever import.meta was.
        const expr =
            use.prop === null
                ? `({url:${exprs.url},filename:${exprs.filename},dirname:${exprs.dirname}})`
                : Object.hasOwn(exprs, use.prop)
                  ? exprs[use.prop]
                  : undefined;
        if (expr === undefined) {
            survived.push(use.prop === null ? "import.meta" : `import.meta.${use.prop}`);
            continue;
        }
        contents += src.slice(at, use.start) + expr;
        at = use.end;
        count++;
    }
    contents += src.slice(at);
    return { contents, count, survived };
}

/**
 * The package whose Emscripten `locateFile("<name>.wasm")` calls are rewritten.
 * Not an anchor allowlist: `locateFile` is not a `new URL` anchor, and its
 * `hb.wasm` fallback (`resolveEmscriptenWasm` in vinext-compile.mjs) resolves
 * a binary through `@vercel/og`'s own exact-pinned `satori` → `harfbuzzjs`
 * chain, which means nothing for any other package.
 */
const LOCATE_FILE_PACKAGE = "@vercel/og";

/**
 * Rewrite every READ asset anchor in `src` (as `analyze` reports it — see
 * asset-anchor-analyze.mjs's `analyzeAssetAnchors`) into a
 * reference to an embedded file asset, when `modulePath` is inside a package
 * (`assetAnchorPackageRoot`) and `resolve` answers with a file. Everything
 * else is returned exactly as written — Worker / fetch / dynamic-import
 * anchors, unknown consumers, comments and strings — and `resolve` is never
 * even called for them, nor for a module outside every package (the compiled
 * entry).
 *
 * With `resolveLocateFile`, an Emscripten `locateFile("<name>.wasm")` call in
 * an `@vercel/og` module is ALSO replaced — by the embedded asset's runtime
 * path (a plain path, which is what the glue's `fs.readFileSync` reads) — when
 * the resolver answers with a file to embed (#1872). Same id space, same
 * "never guess" rule.
 *
 * @param {string} src
 * @param {string} modulePath absolute path of the module `src` came from
 * @param {(literal: string) => string | undefined} resolve literal -> an
 *   absolute on-disk path to embed, or undefined to leave this anchor alone
 *   (the caller decides existence/containment/size; this function never
 *   touches the filesystem)
 * @param {(name: string) => string | undefined} [resolveLocateFile] wasm
 *   file name (e.g. `"hb.wasm"`) -> an absolute on-disk path to embed, or
 *   undefined to leave that `locateFile(...)` call alone
 * @param {(src: string) => { anchors: { literal: string, start: number, end: number, consumer: string }[], parseError?: string }} [analyze]
 *   the consumer analysis. Called at most once, and only for a module inside
 *   a package whose text holds a candidate anchor (`hasAssetAnchorCandidate`)
 *   — never for the entry or an anchor-free module. Without it, no `new URL`
 *   anchor is rewritten (never guess).
 * @returns {{ contents: string, assets: { id: string, absPath: string }[], skipped: { literal: string, reason: string }[], parseError?: string }}
 *   `assets`: one entry per DISTINCT resolved path, in first-seen order. The
 *   caller prepends `import <id> from <JSON.stringify(absPath)> with { type:
 *   "file" };` for each, ahead of `contents`. `skipped`: every anchor NOT
 *   embedded for a reason a user may want to know (an unrecognised use, or a
 *   read of a file that does not exist) — Worker/fetch/import anchors are
 *   deliberate and not listed. `parseError`: the module did not parse, so no
 *   anchor in it was rewritten.
 */
export function rewriteAssetAnchors(src, modulePath, resolve, resolveLocateFile, analyze) {
    if (assetAnchorPackageRoot(modulePath) === undefined) {
        return { contents: src, assets: [], skipped: [] };
    }
    const assets = [];
    const idByPath = new Map();
    const idFor = (absPath) => {
        let id = idByPath.get(absPath);
        if (id === undefined) {
            id = `__knextAssetAnchor${assets.length}`;
            idByPath.set(absPath, id);
            assets.push({ id, absPath });
        }
        return id;
    };
    const { anchors, parseError } =
        analyze !== undefined && hasAssetAnchorCandidate(src) ? analyze(src) : { anchors: [] };
    const skipped = [];
    let contents = "";
    let at = 0;
    for (const anchor of anchors) {
        if (anchor.consumer === "unknown") {
            skipped.push({
                literal: anchor.literal,
                reason: anchor.reason ?? "its use is not recognised",
            });
        }
        if (anchor.consumer !== "read") continue;
        const absPath = resolve(anchor.literal);
        if (absPath === undefined) {
            skipped.push({
                literal: anchor.literal,
                reason: "it is read, but no such file exists beside the module",
            });
            continue;
        }
        contents += `${src.slice(at, anchor.start)}require("node:url").pathToFileURL(${idFor(absPath)})`;
        at = anchor.end;
    }
    contents += src.slice(at);
    if (resolveLocateFile !== undefined && packageNameOf(modulePath) === LOCATE_FILE_PACKAGE) {
        const mask = codeMask(contents);
        contents = contents.replace(LOCATE_FILE_RE, (whole, _quote, name, offset) => {
            if (mask[offset] !== 1) return whole;
            const absPath = resolveLocateFile(name);
            if (absPath === undefined) return whole;
            return `(${idFor(absPath)})`;
        });
    }
    return parseError === undefined
        ? { contents, assets, skipped }
        : { contents, assets, skipped, parseError };
}
