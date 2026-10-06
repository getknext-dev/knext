/**
 * Make a bundled module's own sibling-asset reads survive
 * `bun build --compile --bytecode` (cluster C4 of the 2026-10-03 vinext × bun
 * compat triage — og-api, og-routes-custom-font, metadata-dynamic-routes*,
 * metadata-edge, metadata-font, app-esm-js: every `next/og` `ImageResponse`
 * fixture, 500ing with ENOENT).
 *
 * ## Root cause
 *
 * `@vercel/og`'s own `dist/index.node.js` (an ESM module, `"type": "module"`)
 * reads its WASM renderer and its fallback font at module scope with the
 * standard "asset next to this file" idiom:
 *
 *     fs.readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url)))
 *
 * nitro traces `@vercel/og` as a server-external and copies it — JS, wasm and
 * font together — into `.output/server/node_modules/@vercel/og/dist/`
 * (`SIDECAR_NODE_MODULES` in vinext-compile.mjs). But `@vercel/og`'s entry is
 * ESM, and `entry-external-sidecar.mjs`'s redirect only covers CommonJS
 * entries (an ESM package's own imports cannot reach the sidecar's runtime
 * `require`), so its code stays BUNDLED into the executable either way — once
 * via `entry-require-staticize.mjs`'s embed plan (nitro's
 * `createRequire(import.meta.url)("@vercel/og")`), once via the plain ESM
 * import nitro's output also holds.
 *
 * Once bundled, `import.meta.url` is no longer this module's own real file
 * location. Measured on Bun 1.4.2 (darwin-arm64), a `--bytecode` compile does
 * NOT point a non-entry bundled module's `import.meta.url` at `$bunfs/root`
 * the way a plain (non-bytecode) compile does — it bakes the BUILD MACHINE's
 * literal absolute path in as a string constant (the CommonJS-shaped
 * `__dirname`/`__filename` inlining `compile-embed.mjs` already documents for
 * bytecode's CJS target, oven-sh/bun#44068). That path exists only on the
 * build host: the moment the binary runs anywhere else — a Docker `COPY`, a
 * different CI step, a different machine entirely — `new URL("./resvg.wasm",
 * import.meta.url)` resolves to a path that was never shipped, and
 * `fs.readFileSync` throws ENOENT. `next/og`'s `ImageResponse` answers 500.
 * (Full write-up, including why this is a Bun compiler behaviour and not a
 * vinext bug: `.claude/research/bun-import-meta-url-bytecode-repro.md`.)
 * `vinext-compile-asset-root.test.ts` guards the SAME class of bug for the
 * entry's own `import.meta.url`.
 *
 * ## Fix — scoped, not general (code-review round 2, jev `pick`)
 *
 * A blanket rewrite over every `new URL(<relative literal>, import.meta.url)`
 * in EVERY bundled module is too wide: it would also touch
 * `new Worker(new URL("./w.js", import.meta.url))` (a module-loading anchor,
 * not an asset read — rewriting it would change WHICH code runs, not just
 * where an asset comes from), a `fetch()`/dynamic-`import()` anchor, and a
 * `new URL(...)` that merely APPEARS inside a comment or a string literal
 * (data, never evaluated). jev `pick` on three options — ship the scoped
 * allowlist now (0.50), ship it allowlist-only with no path for the general
 * case (0.44), or hold for a full AST pass first (0.06) — picked the first:
 * land the narrow, measured fix now, file the general ("does this URL feed
 * an `fs` read") AST-aware version as follow-up (linked from the PR that
 * introduced this file).
 *
 * So this rewrite is scoped TWICE:
 *
 *   1. **Package allowlist** (`isAllowlistedAssetAnchorModule` /
 *      `allowlistedPackageRoot`) — only a module resolved from inside one of
 *      `ALLOWLISTED_PACKAGES`'s own `node_modules/<pkg>/` directory (at any
 *      nesting depth — this also matches nitro's staged sidecar copy,
 *      `.output/server/node_modules/@vercel/og/...`, not just a real
 *      install) is even considered. Every other module — including the
 *      compiled entry itself, which is never one of these packages — is left
 *      completely untouched, `new Worker`/`fetch`/comments and all.
 *   2. **Code-position awareness** (`codeMask`) — even inside an allowlisted
 *      module, a match whose START sits inside a `//`/`/* *\/` comment or a
 *      string/template literal is skipped. Measured against the SAME
 *      instinct that caught the og bug in the first place: bundled/minified
 *      output is dense enough that a literal substring match is not safe to
 *      trust blind.
 *
 * Nitro already staged the sibling asset on disk, right beside the module
 * that reads it (that is what the sidecar copy is). So a literal that
 * SURVIVES both scopes is resolved against the MODULE'S OWN real file
 * location at BUILD time (the caller does this — this module stays pure, see
 * below), and if a real file exists there, it is EMBEDDED as a Bun file
 * asset (`import x from <path> with { type: "file" }` — the same mechanism
 * `vinext-compile.mjs`'s self-contained mode already uses for
 * `.output/public` and sharp's native tree). The call site is rewritten to
 * resolve through that asset binding instead of `import.meta.url`:
 *
 *     new URL("./resvg.wasm", import.meta.url)
 *     -> require("node:url").pathToFileURL(__knextAssetAnchor0)
 *
 * `pathToFileURL`/`fileURLToPath` round-trip back to the asset's own runtime
 * path (verified: Bun's `fs` accepts `with { type: "file" }`'s `/$bunfs/...`
 * path directly), so a caller that wraps the `new URL(...)` in
 * `fileURLToPath` — the pattern `@vercel/og` uses — gets exactly the asset's
 * bytes, embedded in the binary, portable to wherever it runs.
 *
 * Conservative by construction beyond the two scopes above: a literal that
 * does NOT resolve to a real file (relative to the module's own location) is
 * left untouched — this module never guesses. Containment (no `..` escape
 * out of the package, no symlink pointing outside it) and a size cap are the
 * CALLER's job (`vinext-compile.mjs`'s `resolveAssetAnchor`), because both
 * need the real filesystem; this module stays pure.
 *
 * Dependency-free over Bun/Node filesystem APIs, like `entry-require-staticize.mjs`
 * (its sibling): the caller does the `existsSync`/containment/size checks and
 * hands this module a yes/no resolver, so the regex/rewrite logic stays
 * unit-testable without a real filesystem.
 */

/**
 * Packages this rewrite is scoped to. Only `@vercel/og` is listed: its own
 * `dist/index.node.js` is the module that reads `resvg.wasm` and its fallback
 * font via this exact idiom — measured against the installed 0.8.6, `satori`
 * and `@resvg/resvg-wasm` are tsup-bundled INTO that one file at publish time,
 * not separate `node_modules` packages with anchors of their own, so there is
 * nothing of theirs to allowlist today. Add a package here only once a REAL
 * anchor in it is measured, the same way this one was — never speculatively.
 */
const ALLOWLISTED_PACKAGES = new Set(["@vercel/og"]);

/**
 * The bare package name (scoped or not) immediately following the LAST
 * `node_modules` path segment in `absPath` — separator-agnostic (`/` or
 * `\`), so it matches both a real install and nitro's staged sidecar copy
 * (`.output/server/node_modules/@vercel/og/...`). `undefined` when `absPath`
 * has no `node_modules` segment at all.
 */
function packageNameFromPath(absPath) {
    const parts = absPath.split(/[\\/]+/);
    const idx = parts.lastIndexOf("node_modules");
    if (idx === -1 || idx + 1 >= parts.length) return undefined;
    const first = parts[idx + 1];
    if (first.startsWith("@") && idx + 2 < parts.length) {
        return `${first}/${parts[idx + 2]}`;
    }
    return first;
}

/** Whether `modulePath`'s resolved location is inside one of `ALLOWLISTED_PACKAGES`'s own `node_modules/<pkg>/` directory. */
export function isAllowlistedAssetAnchorModule(modulePath) {
    const name = packageNameFromPath(modulePath);
    return name !== undefined && ALLOWLISTED_PACKAGES.has(name);
}

/**
 * The allowlisted package's own root directory for `modulePath` — the
 * absolute path through and including the `node_modules/<pkg>` segment that
 * made it allowlisted — or `undefined` when `modulePath` is not allowlisted.
 * Pure string arithmetic on the given path; it is the CALLER's job
 * (`vinext-compile.mjs`) to `realpathSync` both this and the resolved sibling
 * before trusting either as a containment boundary — this function does not
 * touch the filesystem.
 */
export function allowlistedPackageRoot(modulePath) {
    const name = packageNameFromPath(modulePath);
    if (name === undefined || !ALLOWLISTED_PACKAGES.has(name)) return undefined;
    const parts = modulePath.split(/[\\/]+/);
    const idx = parts.lastIndexOf("node_modules");
    const depth = name.includes("/") ? 2 : 1;
    return parts.slice(0, idx + 1 + depth).join("/");
}

/** `new URL("./relative/or/../relative", import.meta.url)`, captured literal in group 2. */
const ASSET_ANCHOR_RE =
    /new\s+URL\(\s*(["'])((?:\.\/|\.\.\/)[^"'()]+?)\1\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Every `new URL(<relative literal>, import.meta.url)` anchor in `src`, in
 * source order — UNSCOPED (no allowlist, no comment/string awareness): this
 * is the raw detector `rewriteAssetAnchors` builds its scoping on top of.
 * Exported so a test can assert detection and scoping independently.
 *
 * @param {string} src
 * @returns {{ literal: string }[]}
 */
export function findAssetAnchors(src) {
    return [...src.matchAll(ASSET_ANCHOR_RE)].map((m) => ({ literal: m[2] }));
}

/**
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
 * Rewrite every asset anchor in `src` into a reference to an embedded file
 * asset, scoped to `modulePath` being one of `ALLOWLISTED_PACKAGES` AND to
 * each match sitting in real code (not a comment or string) — everything
 * else is returned exactly as written, including when `modulePath` is not
 * allowlisted at all (in which case `resolve` is never even called).
 *
 * With `resolveLocateFile`, an Emscripten `locateFile("<name>.wasm")` call in
 * the same scope is ALSO replaced — by the embedded asset's runtime path
 * (a plain path, which is what the glue's `fs.readFileSync` reads) — when the
 * resolver answers with a file to embed (#1872). Same allowlist, same
 * code-position mask, same id space, same "never guess" rule.
 *
 * @param {string} src
 * @param {string} modulePath absolute path of the module `src` came from —
 *   gates the whole rewrite via `isAllowlistedAssetAnchorModule`
 * @param {(literal: string) => string | undefined} resolve literal -> an
 *   absolute on-disk path to embed, or undefined to leave this anchor alone
 *   (the caller decides existence/containment/size; this function never
 *   touches the filesystem)
 * @param {(name: string) => string | undefined} [resolveLocateFile] wasm
 *   file name (e.g. `"hb.wasm"`) -> an absolute on-disk path to embed, or
 *   undefined to leave that `locateFile(...)` call alone
 * @returns {{ contents: string, assets: { id: string, absPath: string }[] }}
 *   `assets`: one entry per DISTINCT resolved path, in first-seen order. The
 *   caller prepends `import <id> from <JSON.stringify(absPath)> with { type:
 *   "file" };` for each, ahead of `contents`.
 */
export function rewriteAssetAnchors(src, modulePath, resolve, resolveLocateFile) {
    if (!isAllowlistedAssetAnchorModule(modulePath)) {
        return { contents: src, assets: [] };
    }
    const mask = codeMask(src);
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
    let contents = src.replace(ASSET_ANCHOR_RE, (whole, _quote, literal, offset) => {
        if (mask[offset] !== 1) return whole; // inside a comment or string literal — data, not code
        const absPath = resolve(literal);
        if (absPath === undefined) return whole;
        return `require("node:url").pathToFileURL(${idFor(absPath)})`;
    });
    if (resolveLocateFile !== undefined) {
        // Re-mask: the first pass may have changed offsets.
        const mask2 = codeMask(contents);
        contents = contents.replace(LOCATE_FILE_RE, (whole, _quote, name, offset) => {
            if (mask2[offset] !== 1) return whole;
            const absPath = resolveLocateFile(name);
            if (absPath === undefined) return whole;
            return `(${idFor(absPath)})`;
        });
    }
    return { contents, assets };
}
