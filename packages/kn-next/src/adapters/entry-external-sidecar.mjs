/**
 * Load the app's server externals from the traced sidecar beside the compiled
 * binary, falling back to the bundled copy only when the sidecar lacks them.
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
 * Next itself never bundles these packages: that is what the option means.
 *
 * ## How
 *
 * For each bare import of the ENTRY that nitro left external, `vinext-compile`
 * substitutes a small CommonJS shim (`sidecarShimSource`):
 *
 *   1. If `<dir of the binary>/.output/server/node_modules/<pkg>/package.json`
 *      exists, the package is loaded from there: `Bun.resolveSync(spec, dir)`
 *      resolves with ESM/Bun conditions (nitro traces only a package's `import`
 *      target, so a `require`-condition resolve would pick an untraced `.cjs`),
 *      then `require(<absolute path>)`. Load errors PROPAGATE: a present-but-
 *      broken sidecar (wrong-arch addon, missing file) fails loudly instead of
 *      silently running a different copy.
 *   2. Otherwise the bundled copy is used, exactly as before. The production
 *      image does not ship the sidecar today, so this keeps every app that works
 *      today working.
 *
 * The anchor is the binary's own directory (`process.execPath`), the same
 * convention as the `import.meta` rewrite: the binary and `.output/` are
 * siblings by construction. Never `process.cwd()`.
 *
 * Runtime bare-specifier resolution is OFF in a compiled Bun binary unless it
 * was compiled with `autoloadPackageJson` — even from a real on-disk anchor,
 * and even for the real package's own nested imports. `vinext-compile` turns it
 * on; without it step 1 cannot resolve anything.
 *
 * sharp is excluded: its addon already has its own `process.dlopen` path
 * (`sharp-addon-dlopen.mjs`) staged in `native/` with integrity pinning.
 */
import { builtinModules } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Packages that must never be redirected: sharp has its own addon path. */
export const NEVER_SIDECAR = ["sharp"];

/** The namespace prefix for the bundled fallback of a redirected specifier. */
export const BUNDLED_PREFIX = "knext-bundled:";

const BUILTINS = new Set(builtinModules);

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageNameOf(spec) {
    const parts = spec.split("/");
    return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
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
 * The CommonJS module that stands in for `spec` in the entry's import graph.
 * `require("knext-bundled:<spec>")` is a LITERAL so `Bun.build` bundles the
 * fallback; the sidecar `require` is computed so it stays a runtime load.
 */
export function sidecarShimSource(spec) {
    const name = packageNameOf(spec);
    const P = 'require("node:path")';
    const dir = `${P}.join(${P}.dirname(process.execPath),".output","server")`;
    const marker = `${P}.join(__knextDir,"node_modules",${name
        .split("/")
        .map((s) => JSON.stringify(s))
        .join(",")},"package.json")`;
    return [
        `var __knextDir=${dir};`,
        `module.exports=require("node:fs").existsSync(${marker})`,
        `?require(Bun.resolveSync(${JSON.stringify(spec)},__knextDir))`,
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
