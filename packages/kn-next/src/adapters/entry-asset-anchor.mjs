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
 * `vinext-compile-asset-root.test.ts` guards the SAME class of bug for the
 * entry's own `import.meta.url`; this file is its sibling for every OTHER
 * bundled module.
 *
 * ## Fix
 *
 * Nitro already staged the sibling asset on disk, right beside the module
 * that reads it (that is what the sidecar copy is). So the literal in
 * `new URL(<literal>, import.meta.url)` can be resolved against the MODULE'S
 * OWN real file location at BUILD time (the caller does this — this module
 * stays pure, see below), and if a real file exists there, it is EMBEDDED as
 * a Bun file asset (`import x from <path> with { type: "file" }` — the same
 * mechanism `vinext-compile.mjs`'s self-contained mode already uses for
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
 * bytes, embedded in the binary, portable to wherever it runs. A caller that
 * used the URL some other way (e.g. `fetch(url)`) keeps a working `file:`
 * URL rather than one anchored on a path that will not exist at runtime.
 *
 * Conservative by construction: a literal that does NOT resolve to a real
 * file (relative to the module's own location) is left untouched — this
 * module never guesses, and never embeds something that was not actually on
 * disk next to the code that reads it.
 *
 * Dependency-free over Bun/Node filesystem APIs, like `entry-require-staticize.mjs`
 * (its sibling): the caller does the `existsSync` check and hands this module
 * a yes/no resolver, so the regex/rewrite logic stays unit-testable without a
 * real filesystem.
 */

/** `new URL("./relative/or/../relative", import.meta.url)`, captured literal in group 2. */
const ASSET_ANCHOR_RE =
    /new\s+URL\(\s*(["'])((?:\.\/|\.\.\/)[^"'()]+?)\1\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Every `new URL(<relative literal>, import.meta.url)` anchor in `src`, in
 * source order. Exported so a test can assert the detector independently of
 * the rewrite.
 *
 * @param {string} src
 * @returns {{ literal: string }[]}
 */
export function findAssetAnchors(src) {
    return [...src.matchAll(ASSET_ANCHOR_RE)].map((m) => ({ literal: m[2] }));
}

/**
 * Rewrite every asset anchor `resolve` can answer for into a reference to an
 * embedded file asset; leave everything else exactly as written.
 *
 * @param {string} src
 * @param {(literal: string) => string | undefined} resolve literal -> an
 *   absolute on-disk path to embed, or undefined to leave this anchor alone
 *   (the caller decides existence; this function never touches the filesystem)
 * @returns {{ contents: string, assets: { id: string, absPath: string }[] }}
 *   `assets`: one entry per DISTINCT resolved path, in first-seen order. The
 *   caller prepends `import <id> from <JSON.stringify(absPath)> with { type:
 *   "file" };` for each, ahead of `contents`.
 */
export function rewriteAssetAnchors(src, resolve) {
    const assets = [];
    const idByPath = new Map();
    const contents = src.replace(ASSET_ANCHOR_RE, (whole, _quote, literal) => {
        const absPath = resolve(literal);
        if (absPath === undefined) return whole;
        let id = idByPath.get(absPath);
        if (id === undefined) {
            id = `__knextAssetAnchor${assets.length}`;
            idByPath.set(absPath, id);
            assets.push({ id, absPath });
        }
        return `require("node:url").pathToFileURL(${id})`;
    });
    return { contents, assets };
}
