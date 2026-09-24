/**
 * Runtime half of the compiled exec's server-externals sidecar (#1320): a
 * package resolver CONFINED to `<dir of the binary>/.output/server/node_modules`,
 * and a `Module._resolveFilename` hook that uses it.
 *
 * ## Why a hand-written resolver
 *
 * A compiled Bun binary never reads a `package.json` at runtime unless it was
 * compiled with `autoloadPackageJson` (measured, Bun 1.4.2): bare resolution then
 * finds only a default `index.js`, so `typescript` (`main: ./lib/typescript.js`)
 * and every `exports` package fail, even from a real on-disk file. Turning that
 * option on is NOT acceptable: it makes every runtime bare `require`/`import()`
 * in the binary resolve against `process.cwd()/node_modules` and its ancestors,
 * so anyone who can write to the working directory, or any parent of it, could
 * plant code into the server.
 *
 * So resolution is done here, by reading `package.json` with `fs`, and only
 * inside the sidecar tree. The result is an ABSOLUTE FILE PATH, which a compiled
 * binary loads without any resolution of its own.
 *
 * ## What the hook covers (measured)
 *
 * The compiled runtime honours `Module._resolveFilename` for CommonJS `require()`
 * and `require.resolve()`, both from bundled code (`/$bunfs`) and from real
 * files. That covers a bundled `@typescript/vfs` resolving `typescript`, a real
 * `sqlite3` requiring `bindings`, and any CommonJS package's own dependencies.
 * ESM `import` statements inside real `.mjs` files do NOT go through it, which is
 * why only CommonJS packages are loaded from the sidecar (see
 * entry-external-sidecar.mjs); ESM packages stay bundled.
 *
 * The hook only answers bare, non-builtin requests that name a package present
 * in the sidecar. Everything else goes to the original resolver unchanged,
 * which throws exactly as before.
 *
 * Dependency-free (node:fs, node:path, node:module) because it is bundled into
 * the binary.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

/** Conditions for a CommonJS `require` (the hook, and the entry shims). */
export const REQUIRE_CONDITIONS = ["bun", "node", "require", "default"];
/** Conditions for an ESM import, used only to classify a package's format. */
export const IMPORT_CONDITIONS = ["bun", "node", "import", "default"];

const BUILTINS = new Set(builtinModules);
const EXTENSIONS = ["", ".js", ".cjs", ".mjs", ".json", ".node"];
const INSTALLED = Symbol.for("knext.sidecarResolution.installed");

/** The sidecar root for the running binary. */
export function sidecarRoot(execPath = process.execPath) {
    return join(dirname(execPath), ".output", "server", "node_modules");
}

/** A bare package request (not relative, absolute, a URL, or a builtin). */
export function isBareRequest(request) {
    if (typeof request !== "string" || request.length === 0) return false;
    if (/^[./]/.test(request) || /^[a-z][a-z0-9+.-]*:/i.test(request)) return false;
    if (request === "bun" || BUILTINS.has(request)) return false;
    const name = splitRequest(request).name;
    return !BUILTINS.has(name);
}

/** `@s/n/a/b` → { name: "@s/n", subpath: "./a/b" }; `n` → { name: "n", subpath: "." }. */
export function splitRequest(request) {
    const parts = request.split("/");
    const n = request.startsWith("@") ? 2 : 1;
    const name = parts.slice(0, n).join("/");
    const rest = parts.slice(n).join("/");
    return { name, subpath: rest ? `./${rest}` : "." };
}

function isFile(p) {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

/** The file a path names, trying the usual extensions and `index` files. */
export function probeFile(base) {
    for (const ext of EXTENSIONS) if (isFile(base + ext)) return base + ext;
    for (const ext of EXTENSIONS.slice(1)) {
        const idx = join(base, `index${ext}`);
        if (isFile(idx)) return idx;
    }
    return null;
}

/**
 * Every target an `exports` field offers for `subpath` under `conditions`, in
 * priority order. Several are returned because nitro traces only SOME targets
 * (typically the `import` one), so the first target that exists on disk wins.
 */
export function exportsTargets(exp, subpath, conditions) {
    if (exp == null) return [];
    const isSubpathMap =
        typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."));
    const map = isSubpathMap ? exp : { ".": exp };
    let entry;
    let star = "";
    if (Object.hasOwn(map, subpath)) {
        entry = map[subpath];
    } else {
        // Longest matching `./prefix*suffix` pattern.
        let best = -1;
        for (const key of Object.keys(map)) {
            const i = key.indexOf("*");
            if (i < 0) continue;
            const pre = key.slice(0, i);
            const post = key.slice(i + 1);
            if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= key.length - 1) {
                if (pre.length > best) {
                    best = pre.length;
                    entry = map[key];
                    star = subpath.slice(pre.length, subpath.length - post.length);
                }
            }
        }
    }
    const out = [];
    const walk = (t) => {
        if (typeof t === "string") out.push(t.replaceAll("*", star));
        else if (Array.isArray(t)) for (const x of t) walk(x);
        else if (t && typeof t === "object") {
            for (const [k, v] of Object.entries(t)) if (k === "default" || conditions.includes(k)) walk(v);
        }
    };
    walk(entry);
    return out;
}

/** Resolve `subpath` inside a package directory to an absolute file, or null. */
export function resolveInPackage(pkgDir, subpath, conditions) {
    let pj;
    try {
        pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    } catch {
        return null;
    }
    if (pj.exports !== undefined && pj.exports !== null) {
        for (const t of exportsTargets(pj.exports, subpath, conditions)) {
            if (!t.startsWith("./")) continue;
            const abs = resolve(pkgDir, t);
            if (isFile(abs)) return abs;
        }
        return null; // `exports` encapsulates the package: no fallback to paths.
    }
    if (subpath === ".") {
        if (typeof pj.main === "string") {
            const hit = probeFile(resolve(pkgDir, pj.main));
            if (hit) return hit;
        }
        return probeFile(join(pkgDir, "index"));
    }
    return probeFile(resolve(pkgDir, subpath));
}

/**
 * The directory of package `name` as seen from `fromFile`, searching ONLY inside
 * `root` (`.../.output/server/node_modules`): the Node lookup walk from the
 * requiring file, stopped at the sidecar boundary. A requester outside the
 * sidecar (bundled code in `/$bunfs`, the entry) sees only the top level.
 */
export function findPackageDir(name, fromFile, root) {
    const top = dirname(root); // .../.output/server
    const inside = typeof fromFile === "string" && fromFile.startsWith(root + sep);
    if (inside) {
        // fromFile is under root = top/node_modules, so walking up reaches `top`
        // exactly; stop there. Every candidate is then inside the sidecar.
        let dir = dirname(fromFile);
        for (;;) {
            if (!dir.endsWith(`${sep}node_modules`)) {
                const cand = join(dir, "node_modules", name);
                if (isFile(join(cand, "package.json"))) return cand;
            }
            if (dir === top || dir === dirname(dir)) return null;
            dir = dirname(dir);
        }
    }
    const cand = join(root, name);
    return isFile(join(cand, "package.json")) ? cand : null;
}

/** Resolve a bare request against the sidecar only, or null. */
export function resolveSidecar(request, fromFile, root, conditions = REQUIRE_CONDITIONS) {
    if (!isBareRequest(request)) return null;
    const { name, subpath } = splitRequest(request);
    const dir = findPackageDir(name, fromFile, root);
    return dir ? resolveInPackage(dir, subpath, conditions) : null;
}

/** Whether the sidecar at `root` holds package `name` at its top level. */
export function sidecarHas(name, root) {
    return existsSync(join(root, name, "package.json"));
}

/**
 * Install the `Module._resolveFilename` hook for `root`. Idempotent. Returns
 * whether it is installed.
 */
export function installSidecarResolution(Module, root = sidecarRoot()) {
    if (!Module || typeof Module._resolveFilename !== "function") return false;
    if (Module[INSTALLED]) return true;
    const original = Module._resolveFilename;
    Module._resolveFilename = function knextSidecarResolveFilename(request, parent, ...rest) {
        const from = parent && typeof parent.filename === "string" ? parent.filename : undefined;
        const hit = resolveSidecar(request, from, root);
        if (hit) return hit;
        if (isBareRequest(request) && !(from && from.startsWith(root + sep))) {
            // Fail CLOSED for code outside the sidecar (the bundled server in
            // /$bunfs). Bun's compiled resolver would otherwise search
            // process.cwd()/node_modules and its ancestors for it — measured on
            // Bun 1.4.2 even WITHOUT autoloadPackageJson, for any request that
            // needs no package.json (a file subpath, an index.js package) —
            // which lets anyone who can write there plant code into the server.
            const err = new Error(
                `Cannot find module '${request}' (the compiled server resolves packages only from ${root})`,
            );
            err.code = "MODULE_NOT_FOUND";
            throw err;
        }
        return original.call(this, request, parent, ...rest);
    };
    Module[INSTALLED] = true;
    return true;
}

/**
 * The absolute file an entry shim requires for a top-level sidecar package.
 * Throws (fail closed) when the sidecar holds the package but its entry cannot
 * be resolved: a present-but-broken sidecar must not silently run another copy.
 */
export function sidecarEntryFile(request, root = sidecarRoot()) {
    const file = resolveSidecar(request, undefined, root);
    if (!file) {
        throw new Error(
            `[knext] ${request} is in ${root} but its entry cannot be resolved (package.json exports/main)`,
        );
    }
    return file;
}

/** The global the entry shims read (set by sidecar-install.mjs). */
export const SIDECAR_GLOBAL = "knext.sidecar";
