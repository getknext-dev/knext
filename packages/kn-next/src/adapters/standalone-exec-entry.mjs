/**
 * Pure helpers for compiling a Next.js standalone server into a Bun single
 * executable (`standalone-compile.mjs`). Dependency-free (Node builtins only)
 * and side-effect free, so the compile script bundles them and the tests
 * import them directly.
 */

import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBED_ROOT_GLOBAL, installDistDirAlias, installEmbeddedJsonRequire } from "./standalone-embed.mjs";

/** The binding the re-anchored entry uses in place of `__dirname`. */
export const STANDALONE_DIR_BINDING = "__knextStandaloneDir";

/**
 * The header Next emits for a `"type": "module"` app's `server.js`. It reaches
 * `next` through `module.createRequire(import.meta.url)`, which a bundler does
 * not follow — compiled verbatim, the binary would bundle nothing and load all
 * of Next from disk. Each line is replaced by its CommonJS equivalent (or by
 * nothing, where the entry prologue already provides it).
 */
const ESM_HEADER = [
    ["import path from 'node:path'", 'const path = require("node:path")'],
    ["import { fileURLToPath } from 'node:url'", ""],
    ["import module from 'node:module'", ""],
    ["const require = module.createRequire(import.meta.url)", ""],
    ["const __dirname = fileURLToPath(new URL('.', import.meta.url))", ""],
];

/** The two `__dirname` anchors every `server.js` shape carries. */
const DIR_ANCHORS = [
    ["const dir = path.join(__dirname)", `const dir = ${STANDALONE_DIR_BINDING}`],
    ["process.chdir(__dirname)", `process.chdir(${STANDALONE_DIR_BINDING})`],
];

function replaceExactlyOnce(src, from, to) {
    const count = src.split(from).length - 1;
    if (count !== 1) {
        throw new Error(
            `server.js has ${count} occurrence(s) of \`${from}\` (expected exactly 1) — ` +
                "this Next version's standalone server shape is not one knext knows how to compile",
        );
    }
    return src.replace(from, to);
}

/**
 * Turn Next's generated `server.js` (either shape) into the CommonJS entry knext
 * compiles:
 *
 *   - `__dirname` is the binary's VIRTUAL filesystem root inside a compiled
 *     executable, so the server is re-anchored on the directory the executable
 *     sits in (KNEXT_STANDALONE_DIR overrides it);
 *   - the ESM header is rewritten to CommonJS so `require('next')` is static;
 *   - the preloads the uncompiled cell passes as `--require` run first.
 *
 * With `opts.selfContained` (the self-contained executable, which carries the
 * app's `.next` inside it), `distDir` is additionally pointed INTO the
 * executable — see `SELF_CONTAINED_DISTDIR`. Without it the output is
 * byte-identical to what it was before self-contained mode existed.
 *
 * Throws on any shape it does not recognise — never guesses.
 *
 * @param {string} serverSrc the generated server.js
 * @param {readonly string[]} preloads absolute paths, required first, in order
 * @param {{ selfContained?: { appRel: string, distDir?: string, extensionless?: readonly string[] } }} [opts]
 * @returns {string}
 */
export function standaloneExecEntrySource(serverSrc, preloads, opts = {}) {
    let body = serverSrc;
    const isEsm = body.includes("import.meta.url");
    if (isEsm) {
        for (const [from, to] of ESM_HEADER) body = replaceExactlyOnce(body, from, to);
    }
    for (const [from, to] of DIR_ANCHORS) body = replaceExactlyOnce(body, from, to);

    if (/\b__dirname\b/.test(body)) {
        throw new Error(
            "server.js still references __dirname after re-anchoring — refusing to compile a server rooted in the binary's virtual filesystem",
        );
    }
    if (body.includes("import.meta") || /^\s*import[\s{]/m.test(body)) {
        throw new Error(
            "server.js still carries ESM syntax after the CommonJS rewrite — refusing to compile an entry whose require('next') the bundler may not follow",
        );
    }

    const prologue = [
        `const ${STANDALONE_DIR_BINDING} = process.env.KNEXT_STANDALONE_DIR || require("node:path").dirname(process.execPath);`,
    ];
    if (opts.selfContained) {
        prologue.push(...selfContainedPrologue(opts.selfContained));
        body = replaceExactlyOnce(body, NEXT_CONFIG_ANCHOR, `${SELF_CONTAINED_DISTDIR}\n${NEXT_CONFIG_ANCHOR}`);
    }
    return [...prologue, ...preloads.map((p) => `require(${JSON.stringify(p)});`), body].join("\n");
}

/** The line that serialises `nextConfig` for Next's workers; the distDir rewrite must precede it. */
const NEXT_CONFIG_ANCHOR = "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)";

/** The embedded app's `.next`, and the disk one beside the executable. */
const EMBED_DIST = "__knextEmbedDistDir";
const DISK_DIST = "__knextDiskDistDir";

/**
 * Point `distDir` INTO the executable. Next derives every build-output path
 * from `path.join(dir, distDir)` while `public/` comes from `dir` alone, so
 * `dir` stays the directory the executable sits in (and the process `chdir`s
 * there, never into the virtual filesystem) and `distDir` becomes the relative
 * path from it to the embedded `.next` — `path.join` then lands on
 * `/$bunfs/root/<app>/.next`.
 */
const SELF_CONTAINED_DISTDIR = `nextConfig.distDir = require("node:path").relative(${STANDALONE_DIR_BINDING}, ${EMBED_DIST});`;

/**
 * The self-contained prologue: anchor on the EMBEDDED root — the executable's
 * own virtual path, `process.argv[1]`, never the cwd — and fail closed if the
 * process is not running from it; then alias the parts of `.next` that stay on
 * disk (`static/`, `cache/`) and each extensionless embedded file (`BUILD_ID` →
 * `BUILD_ID.`, the name Bun gives it).
 *
 * @param {{ appRel: string, distDir?: string, extensionless?: readonly string[] }} sc
 *   `appRel`: the app directory relative to the embed root (posix, "" at the
 *   root); `extensionless`: `.next`-relative paths of embedded extensionless files
 */
function selfContainedPrologue({ appRel, distDir = ".next", extensionless = [] }) {
    const p = 'require("node:path")';
    const aliases = [
        `[${EMBED_DIST} + "/static"]: ${DISK_DIST} + "/static"`,
        `[${EMBED_DIST} + "/cache"]: ${DISK_DIST} + "/cache"`,
        // @upstream-shim bun-asset-extensionless-dot
        ...extensionless.map(
            (rel) =>
                `[${EMBED_DIST} + ${JSON.stringify(`/${rel}`)}]: ${EMBED_DIST} + ${JSON.stringify(`/${rel}.`)}`,
        ),
    ];
    return [
        `globalThis.${EMBED_ROOT_GLOBAL} = (() => { const r = ${p}.dirname(process.argv[1] || ""); if (!${EMBEDDED_ROOT_RE}.test(r)) throw new Error("knext: this self-contained executable is not running from its embedded filesystem (argv[1] = " + process.argv[1] + ")"); return r; })();`,
        `const ${EMBED_DIST} = ${p}.join(globalThis.${EMBED_ROOT_GLOBAL}, ${JSON.stringify(appRel)}, ${JSON.stringify(distDir)});`,
        `const ${DISK_DIST} = ${p}.join(${STANDALONE_DIR_BINDING}, ${JSON.stringify(distDir)});`,
        `(${installDistDirAlias.toString()})(require("node:fs"), require("node:fs/promises"), { ${aliases.join(", ")} });`,
        `(${installEmbeddedJsonRequire.toString()})(require("node:module"), require("node:fs"), globalThis.${EMBED_ROOT_GLOBAL});`,
    ];
}

/** Bun's embedded root: `/$bunfs/root` (posix) or `B:\~BUN\root` (Windows). */
const EMBEDDED_ROOT_RE = String.raw`/^\/\$bunfs\/root$|^[A-Za-z]:[\\/]~BUN[\\/]root$/`;

/**
 * The module Next's dev-only requires are compiled against. Production never
 * takes those branches (`server.js` hard-codes `isDev: false`), so the stub
 * THROWS on use rather than handing back `undefined`: a future Next that does
 * reach one in production fails loudly, naming the property, instead of
 * misbehaving quietly. `__esModule`, `then` and symbol keys stay benign so
 * bundler interop and promise-probing a module never trip it on load.
 */
export const DEV_ONLY_STUB_SOURCE =
    'module.exports = new Proxy({}, { get(_t, k) { if (typeof k === "symbol" || k === "__esModule" || k === "then") return undefined; throw new Error("knext: a dev-only Next module was reached in a production standalone executable (property " + String(k) + ")"); } });\n';

/** The config line every `server.js` shape carries (one JSON literal). */
const NEXT_CONFIG_LINE = /^const nextConfig = (.*)$/m;

/**
 * Every cache handler Next can load by COMPUTED path at runtime, as absolute
 * paths resolved exactly as Next resolves them (`formatDynamicImportPath`:
 * a `file://` URL is converted, an absolute path is kept, anything else is
 * joined onto `<server dir>/<distDir>`):
 *
 *   - `cacheHandler` — the ISR / data cache handler;
 *   - every `cacheHandlers` entry — the `'use cache'` handlers.
 *
 * NOT `experimental.incrementalCacheHandlerPath`: Next 16 (the supported
 * floor) dropped it — it never relativizes, traces or loads it, and an unknown
 * key only warns, so a leftover value still reaches the inlined config. Taking
 * it as a root would fail the compile on an app that runs fine uncompiled.
 *
 * These are disk-loaded code outside `.next/server`, so the compile scans them
 * as extra roots of the disk closure. Throws when `server.js` carries no
 * inlined config — it never guesses that no handler is configured.
 *
 * @param {string} serverSrc the generated server.js
 * @param {string} serverDir the directory server.js sits in
 * @returns {string[]} absolute paths, deduplicated, in config order
 */
export function standaloneCacheHandlerFiles(serverSrc, serverDir) {
    const m = serverSrc.match(NEXT_CONFIG_LINE);
    if (!m) {
        throw new Error(
            "server.js has no `const nextConfig = …` line — cannot tell which cache handlers Next will load from disk, so refusing to compile",
        );
    }
    let config;
    try {
        config = JSON.parse(m[1]);
    } catch (err) {
        throw new Error(
            `server.js's inlined nextConfig is not JSON (${err instanceof Error ? err.message : String(err)}) — refusing to compile`,
        );
    }
    const configured = [
        config.cacheHandler,
        ...Object.values(config.cacheHandlers ?? {}),
    ].filter((p) => typeof p === "string" && p.length > 0);

    const distDir = join(serverDir, typeof config.distDir === "string" ? config.distDir : ".next");
    const out = [];
    for (const p of configured) {
        const file = p.startsWith("file://") ? fileURLToPath(p) : p;
        const abs = isAbsolute(file) ? file : join(distDir, file);
        if (!out.includes(abs)) out.push(abs);
    }
    return out;
}

/** `name` + `./subpath` of a bare specifier (`@scope/pkg/deep` included). */
export function splitBareSpecifier(spec) {
    const parts = spec.split("/");
    const scoped = spec.startsWith("@");
    const name = parts.slice(0, scoped ? 2 : 1).join("/");
    const rest = parts.slice(scoped ? 2 : 1).join("/");
    return { name, subpath: rest ? `./${rest}` : "." };
}

/** The conditions `next build`'s trace resolved under — never `bun`. */
const NODE_CONDITIONS = ["node", "require", "default"];

function pickTarget(node) {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) {
        for (const n of node) {
            const r = pickTarget(n);
            if (r) return r;
        }
        return undefined;
    }
    if (node && typeof node === "object") {
        for (const c of NODE_CONDITIONS) {
            if (c in node) {
                const r = pickTarget(node[c]);
                if (r) return r;
            }
        }
    }
    return undefined;
}

/**
 * Resolve a package `exports` field for `subpath` (`"."` or `"./x"`) under
 * Node's conditions. Returns the package-relative target, or undefined.
 * Pattern (`*`) subpaths are not expanded — nothing the compile re-resolves
 * uses one, and an unexpanded pattern yields undefined (left external), never
 * a wrong file.
 */
export function resolveExportsUnderNode(exportsField, subpath) {
    if (typeof exportsField === "string" || Array.isArray(exportsField)) {
        return subpath === "." ? pickTarget(exportsField) : undefined;
    }
    if (!exportsField || typeof exportsField !== "object") return undefined;
    const keys = Object.keys(exportsField);
    if (!keys.some((k) => k.startsWith("."))) {
        // Conditions sugar: the whole object is the "." target.
        return subpath === "." ? pickTarget(exportsField) : undefined;
    }
    return subpath in exportsField ? pickTarget(exportsField[subpath]) : undefined;
}

/**
 * Resolve a specifier the way the disk-loaded CJS code that names it actually
 * requires it, OUTSIDE an active `Bun.build()` pass (`computeDiskClosure`, the
 * turbopack-alias scan in `standalone-compile.mjs`) — both run BEFORE the
 * compile's own `Bun.build()` call exists.
 *
 * `Bun.resolveSync(spec, dir)` takes an undocumented third `isESM` argument
 * that selects which `package.json#exports` condition set to probe, and its
 * DEFAULT differs by caller context: inside an active `Bun.build()` plugin
 * (`format: "cjs"`), a bare two-arg call already resolves as `isESM: false`
 * (the "require" condition) — matching the literal `require(...)` the bundled
 * code actually executes. Called from plain, pre-build script code — exactly
 * these two sites — the SAME two-arg call resolves as `isESM: true` instead.
 *
 * Measured on `minio@8.0.6` (`exports["."]`: `require` -> `dist/main/minio.js`
 * — present; `default` -> `dist/esm/minio.mjs` — NOT present, because nft only
 * traces the file a literal `require("minio")` call actually reaches): the
 * two-arg call throws "Cannot find package 'minio'" here, even though
 * `require.resolve("minio", { paths: [dir] })` finds it immediately. The
 * disk-closure scan only ever follows `require(...)` / `import(...)` /
 * `from "..."` literals out of CJS route-chunk output, so `isESM: false` is
 * the specifier's real call-site kind — try it first. A package shipping NO
 * "require" condition at all (pure ESM) still resolves via the `isESM: true`
 * fallback, so this never narrows what the plain two-arg call used to find.
 *
 * On failure, throws an `Error` whose message names BOTH attempts' failures
 * (`require` first, then the ESM fallback) — a caller reporting the failure
 * (`standalone-compile.mjs`'s disk-closure warning, `planSelfContained`'s
 * turbopack-alias `fail()`) gets full diagnostic detail from `err.message`
 * alone, with no need to re-run either attempt itself.
 */
export function resolveRequireLike(spec, fromDir) {
    let requireErr;
    try {
        return Bun.resolveSync(spec, fromDir, false);
    } catch (err) {
        requireErr = err;
    }
    try {
        return Bun.resolveSync(spec, fromDir, true);
    } catch (esmErr) {
        const requireMsg = requireErr instanceof Error ? requireErr.message : String(requireErr);
        const esmMsg = esmErr instanceof Error ? esmErr.message : String(esmErr);
        throw new Error(
            `cannot resolve ${JSON.stringify(spec)} from ${fromDir}: require condition failed (${requireMsg}); ESM/default condition failed (${esmMsg})`,
        );
    }
}
