/**
 * Build-time half of the compiled exec's server-externals sidecar (#1320):
 * which of the entry's externals load from `.output/server/node_modules` beside
 * the binary, and the shim that loads them.
 *
 * ## Why
 *
 * nitro leaves every `serverExternalPackages` entry (the app's own list, Next's
 * default external list, and the `@opentelemetry/*` packages vinext adds) as a
 * bare `import` in `.output/server/index.mjs`, and traces it into
 * `.output/server/node_modules`. `vinext-compile` used to bundle all of them into
 * the binary's virtual filesystem (`/$bunfs`). That works for pure JavaScript and
 * breaks every package that needs its REAL files at runtime (measured, Bun 1.4.2):
 *
 *  - `twoslash` → `@typescript/vfs` calls `require.resolve("typescript")` and reads
 *    the `lib.*.d.ts` beside it → `Cannot find module 'typescript'` from `/$bunfs`;
 *  - `sqlite3` → `bindings` walks up from its caller looking for `package.json`
 *    → `Could not find module root given file: "/$bunfs/root/…"`.
 *
 * ## How
 *
 * 1. `sidecar-install.mjs` is injected as an early import of the entry. It
 *    installs a `Module._resolveFilename` hook that resolves bare CommonJS
 *    `require`/`require.resolve` requests against the sidecar ONLY
 *    (sidecar-runtime.mjs). Bundled code's runtime `require.resolve` (the
 *    `@typescript/vfs` case) and a real sidecar package's own dependencies both
 *    go through it. It never resolves against `process.cwd()` or anywhere
 *    outside `<dir of the binary>/.output/server/node_modules`, and the binary is
 *    NOT compiled with `autoloadPackageJson`, which would open exactly that path.
 * 2. Each entry-level external whose entry is CommonJS is replaced by a shim
 *    (`sidecarShimSource`): when the sidecar holds the package, the shim requires
 *    the absolute entry file resolved from its `package.json`; load errors
 *    propagate (fail closed). Otherwise the bundled copy is used, exactly as
 *    before, so today's images, which ship no sidecar, behave identically.
 * 3. ESM externals stay bundled: the compiled runtime resolves an ESM file's own
 *    `import` statements without consulting the hook, so a real ESM package
 *    could not reach its dependencies. Their runtime `require.resolve` calls
 *    still reach the sidecar through the hook.
 *
 * sharp is excluded: its addon already has its own `process.dlopen` path
 * (`sharp-addon-dlopen.mjs`) staged in `native/` with integrity pinning.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { REQUIRE_CONDITIONS, resolveInPackage, SIDECAR_GLOBAL, splitRequest } from "./sidecar-runtime.mjs";

/** Packages that must never be redirected: sharp has its own addon path. */
export const NEVER_SIDECAR = ["sharp"];

/** The namespace prefix for the bundled fallback of a redirected specifier. */
export const BUNDLED_PREFIX = "knext-bundled:";

const BUILTINS = new Set(builtinModules);

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageNameOf(spec) {
    return splitRequest(spec).name;
}

/** A bare, non-builtin specifier that is not sharp (or one of sharp's `@img/*` addons). */
export function isSidecarCandidate(spec) {
    if (!spec || /^[./]/.test(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return false;
    if (spec === "bun") return false;
    const name = packageNameOf(spec);
    if (BUILTINS.has(spec) || BUILTINS.has(name)) return false;
    if (NEVER_SIDECAR.includes(name) || name.startsWith("@img/")) return false;
    return true;
}

/**
 * Whether `spec`, resolved in the sidecar the way the runtime shim will resolve
 * it, lands on a CommonJS file (`.cjs`, `.node`, `.json`, or `.js` in a package
 * that is not `"type": "module"`). Null when it does not resolve at all.
 */
export function isCommonJsEntry(sidecarNodeModules, spec) {
    const { name, subpath } = splitRequest(spec);
    const pkgDir = join(sidecarNodeModules, name);
    const file = resolveInPackage(pkgDir, subpath, REQUIRE_CONDITIONS);
    if (!file) return null;
    if (/\.(cjs|node|json)$/.test(file)) return true;
    if (file.endsWith(".mjs")) return false;
    // `.js`: the nearest package.json at or above the file, within the package.
    let dir = dirname(file);
    while (dir.startsWith(pkgDir)) {
        const pj = join(dir, "package.json");
        if (existsSync(pj)) {
            try {
                return JSON.parse(readFileSync(pj, "utf8")).type !== "module";
            } catch {
                return true;
            }
        }
        if (dir === pkgDir) break;
        dir = dirname(dir);
    }
    return true;
}

/**
 * The CommonJS module that stands in for `spec` in the entry's import graph.
 * `require("knext-bundled:<spec>")` is a LITERAL so `Bun.build` bundles the
 * fallback; the sidecar `require` takes a computed absolute path, so it stays a
 * runtime load that needs no resolution.
 */
export function sidecarShimSource(spec) {
    const name = packageNameOf(spec);
    return [
        `var __k=globalThis[Symbol.for(${JSON.stringify(SIDECAR_GLOBAL)})];`,
        `module.exports=__k&&__k.has(${JSON.stringify(name)})`,
        `?require(__k.entryFile(${JSON.stringify(spec)}))`,
        `:require(${JSON.stringify(BUNDLED_PREFIX + spec)});`,
    ].join("");
}

/**
 * Whether a package tree carries a native addon (a `.node` binary or a
 * `binding.gyp`). Such a package can NEVER work from the bundled fallback, so the
 * compile names it: the binary needs the sidecar beside it at runtime.
 */
export function hasNativeAddon(pkgDir, depth = 6) {
    if (!existsSync(pkgDir) || depth < 0) return false;
    let entries;
    try {
        entries = readdirSync(pkgDir);
    } catch {
        return false;
    }
    for (const e of entries) {
        if (e === "binding.gyp" || e.endsWith(".node")) return true;
        const p = join(pkgDir, e);
        let st;
        try {
            st = statSync(p);
        } catch {
            continue;
        }
        if (st.isDirectory() && hasNativeAddon(p, depth - 1)) return true;
    }
    return false;
}
