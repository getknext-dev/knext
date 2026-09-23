/**
 * Pure helpers for compiling a Next.js standalone server into a Bun single
 * executable (`standalone-compile.mjs`). Dependency-free and side-effect free,
 * so the compile script bundles them and the tests import them directly.
 */

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
 * Throws on any shape it does not recognise — never guesses.
 *
 * @param {string} serverSrc the generated server.js
 * @param {readonly string[]} preloads absolute paths, required first, in order
 * @returns {string}
 */
export function standaloneExecEntrySource(serverSrc, preloads) {
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

    return [
        `const ${STANDALONE_DIR_BINDING} = process.env.KNEXT_STANDALONE_DIR || require("node:path").dirname(process.execPath);`,
        ...preloads.map((p) => `require(${JSON.stringify(p)});`),
        body,
    ].join("\n");
}

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
