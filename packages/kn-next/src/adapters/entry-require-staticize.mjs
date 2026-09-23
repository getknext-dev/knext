/**
 * Make the nitro entry's RUNTIME requires visible to `Bun.build` (#1309).
 *
 * nitro/rolldown bundles CommonJS dependencies into the ESM entry and gives
 * them a module-scope require bound to the entry's own location:
 *
 *     var __require = createRequire(import.meta.url);
 *     ... var Bh = __require(`@opentelemetry/api`); ...
 *
 * Every package nitro leaves EXTERNAL is reached that way — traced into
 * `.output/server/node_modules` and resolved from disk at runtime. `Bun.build`
 * only follows STATIC `import` / `require("<literal>")` specifiers, so such a
 * call never enters the compiled single executable's module graph: the binary
 * throws `Cannot find module '<pkg>'` the first time it runs (and production
 * images ship no `.output/server/node_modules` to fall back on anyway).
 *
 * Measured trigger: vinext 1.0.0-beta.11 auto-adds every `@opentelemetry/*`
 * dependency in the app's package.json to `serverExternalPackages`, so an app
 * depending on `@opentelemetry/api` (file-manager) got a runtime
 * `__require(\`@opentelemetry/api\`)` from prom-client and 500'd on every
 * request, while the OTel-free compat fixtures stayed green.
 *
 * Rewriting the call to a static `require("<pkg>")` is semantically identical
 * — both resolve `<pkg>` from the entry's directory — and lets `Bun.build`
 * bundle it. Deliberately narrow:
 *  - only bindings created as `createRequire…(import.meta.url)` (sharp's own
 *    `createRequire(join(...))` loader is a separate, dlopen-shimmed path);
 *  - only literal, non-interpolated, bare, non-builtin specifiers;
 *  - only specifiers `canResolve` confirms exist from the entry — an optional
 *    dependency that is absent stays a runtime require (it throws only if its
 *    code path runs, exactly as before) instead of failing the whole build.
 *
 * Pure (no Bun/Node APIs) so it is unit-testable; vinext-compile.mjs supplies
 * the resolver.
 */
import { builtinModules } from "node:module";

const BUILTINS = new Set(builtinModules);

const IDENT = "[A-Za-z_$][\\w$]*";
const BINDING_RE = new RegExp(
    `(?<![\\w$.])(${IDENT})\\s*=\\s*createRequire[\\w$]*\\s*\\(\\s*import\\.meta\\.url\\s*\\)`,
    "g",
);

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBareNonBuiltin(spec) {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) {
        return false;
    }
    if (spec.startsWith("bun:") || spec === "bun") return false;
    // `fs/promises` → `fs/promises` is itself listed; a subpath of a builtin
    // like `util/types` is too. Check both the full spec and its root.
    return !BUILTINS.has(spec) && !BUILTINS.has(spec.split("/")[0]);
}

/**
 * @param {string} src the entry source
 * @param {(spec: string) => boolean} canResolve whether `spec` resolves from the entry dir
 * @returns {{ contents: string, rewritten: string[], unresolved: string[] }}
 */
export function staticizeEntryRequires(src, canResolve) {
    const bindings = new Set();
    for (const m of src.matchAll(BINDING_RE)) bindings.add(m[1]);
    const rewritten = new Set();
    const unresolved = new Set();
    let contents = src;
    for (const name of bindings) {
        // `name(<quote>spec<quote>)` — same quote on both ends, no `${`, no
        // escapes, and not a member access or the tail of a longer identifier.
        const callRe = new RegExp(
            `(?<![\\w$.])${escapeRe(name)}\\(\\s*(["'\`])([^"'\`$\\\\\\s]+)\\1\\s*\\)`,
            "g",
        );
        contents = contents.replace(callRe, (whole, _q, spec) => {
            if (!isBareNonBuiltin(spec)) return whole;
            if (!canResolve(spec)) {
                unresolved.add(spec);
                return whole;
            }
            rewritten.add(spec);
            return `require(${JSON.stringify(spec)})`;
        });
    }
    return { contents, rewritten: [...rewritten], unresolved: [...unresolved] };
}
