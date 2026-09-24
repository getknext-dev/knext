/**
 * Make the nitro server output's RUNTIME requires visible to `Bun.build`
 * (#1309 for the entry, #1314 for every chunk).
 *
 * nitro/rolldown bundles CommonJS dependencies into its ESM output and gives
 * them a require bound to the module's own location. rolldown 1.2.6 emits it as
 *
 *     import { createRequire } from "node:module";
 *     var __require = /* #__PURE__ *\/ (() => createRequire(import.meta.url))();
 *
 * (minified: `import{createRequire as e}from"node:module";…u=e(import.meta.url)`),
 * and with more than one CommonJS chunk it hoists that binding into
 * `chunks/rolldown-runtime.mjs`, which other chunks import
 * (`import { n as __require } from "./rolldown-runtime.mjs"`) and call as
 * `` __require(`@opentelemetry/api`) ``. Every package nitro leaves EXTERNAL is
 * reached that way. `Bun.build` follows only STATIC `import` / `require("<literal>")`
 * specifiers, so such a call never enters the compiled executable: the binary
 * throws `Cannot find module '<pkg>'` once `.output/server/node_modules` is not
 * beside it.
 *
 * ## Why the BINDING is rewritten, not the call sites
 *
 * The calls live in other modules than the binding (the multi-chunk case), and
 * in minified output the caller's name is a one-letter identifier that inner
 * functions routinely shadow, so rewriting `e(\`pkg\`)` call sites textually
 * could turn an unrelated call into a require. Instead, each
 * `<createRequire alias>(import.meta.url)` expression is wrapped in a require
 * whose `switch` maps every EMBEDDED specifier to a static `require("<spec>")`
 * (which `Bun.build` bundles) and forwards anything else to the original
 * require. Every caller, in every chunk, under any alias, gets the embedded
 * copy; nothing else changes.
 *
 * Which specifiers to embed is decided by the caller (vinext-compile.mjs) from
 * the whole server output: bare literals passed to calls, whose package nitro
 * traced into `.output/server/node_modules`. This module stays pure (no Bun or
 * Node filesystem APIs) so it is unit-testable.
 */
import { builtinModules } from "node:module";

const BUILTINS = new Set(builtinModules);

const IDENT = "[A-Za-z_$][\\w$]*";
/** A `/* … *\/` comment and surrounding whitespace, e.g. rolldown's `/* #__PURE__ *\/`. */
const GAP = "(?:\\s|/\\*[\\s\\S]*?\\*/)*";

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isBareNonBuiltin(spec) {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) {
        return false;
    }
    if (spec.startsWith("bun:") || spec === "bun") return false;
    // `fs/promises` is itself listed; a subpath of a builtin like `util/types`
    // is too. Check both the full spec and its root.
    return !BUILTINS.has(spec) && !BUILTINS.has(spec.split("/")[0]);
}

/** `a as b, c` → [["a","b"],["c","c"]] (order: [left, right]). */
function parseSpecifierList(list) {
    return list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const m = /^(\S+)\s+as\s+(\S+)$/.exec(s);
            return m ? [m[1], m[2]] : [s, s];
        });
}

/**
 * Static facts about one server-output module.
 *
 * @param {string} src
 * @returns {{
 *   aliases: string[],
 *   requireBindings: string[],
 *   exports: Map<string, string[]>,
 *   imports: { from: string, names: Map<string, string> }[],
 *   literalCalls: Map<string, Set<string>>,
 *   nonLiteralCallees: Set<string>,
 *   unrecognizedBinding: boolean,
 * }}
 */
export function analyzeServerModule(src) {
    // Local names of `createRequire` imported from `module` / `node:module`.
    const aliases = new Set();
    const importRe = new RegExp(
        `import${GAP}\\{([^}]*)\\}${GAP}from${GAP}(["'])(?:node:)?module\\2`,
        "g",
    );
    for (const m of src.matchAll(importRe)) {
        for (const [imported, local] of parseSpecifierList(m[1])) {
            if (imported === "createRequire") aliases.add(local);
        }
    }

    // Bindings: `X = alias(import.meta.url)` and rolldown's
    // `X = (() => alias(import.meta.url))()`, with optional comments.
    const requireBindings = new Set();
    let recognized = 0;
    for (const alias of aliases) {
        const call = `${escapeRe(alias)}${GAP}\\(${GAP}import\\.meta\\.url${GAP}\\)`;
        const bindingRe = new RegExp(
            `(?<![\\w$.])(${IDENT})${GAP}=${GAP}(?:\\(${GAP}\\(${GAP}\\)${GAP}=>${GAP}${call}${GAP}\\)${GAP}\\(${GAP}\\)|${call})`,
            "g",
        );
        for (const m of src.matchAll(bindingRe)) {
            requireBindings.add(m[1]);
            recognized++;
        }
    }
    // Any alias(import.meta.url) call the binding patterns did not account for
    // is a shape this analysis cannot see through.
    let aliasCalls = 0;
    for (const alias of aliases) {
        const anyCall = new RegExp(
            `(?<![\\w$.])${escapeRe(alias)}${GAP}\\(${GAP}import\\.meta\\.url${GAP}\\)`,
            "g",
        );
        aliasCalls += [...src.matchAll(anyCall)].length;
    }

    // `export { a as b }` → a → [b]
    const exportsMap = new Map();
    for (const m of src.matchAll(new RegExp(`export${GAP}\\{([^}]*)\\}(?!${GAP}from)`, "g"))) {
        for (const [local, exported] of parseSpecifierList(m[1])) {
            const list = exportsMap.get(local) ?? [];
            list.push(exported);
            exportsMap.set(local, list);
        }
    }

    // `import { b as c } from "./x.mjs"` → { from: "./x.mjs", names: b → c }
    const imports = [];
    const relImportRe = new RegExp(
        `import${GAP}\\{([^}]*)\\}${GAP}from${GAP}(["'])(\\.{1,2}/[^"']+)\\2`,
        "g",
    );
    for (const m of src.matchAll(relImportRe)) {
        imports.push({ from: m[3], names: new Map(parseSpecifierList(m[1])) });
    }

    // `callee(<literal bare spec>)` → callee → specs
    const literalCalls = new Map();
    const callRe = new RegExp(
        `(?<![\\w$.])(${IDENT})${GAP}\\(${GAP}(["'\`])([^"'\`$\\\\\\s]+)\\2${GAP}\\)`,
        "g",
    );
    for (const m of src.matchAll(callRe)) {
        const spec = m[3];
        if (!isBareNonBuiltin(spec)) continue;
        const set = literalCalls.get(m[1]) ?? new Set();
        set.add(spec);
        literalCalls.set(m[1], set);
    }

    // Callees also called with anything but ONE string literal (`__require(n)`,
    // `r(a + b)`, a template with `${…}`): their specifier is only known at
    // runtime, so nothing can embed it. The caller flags these on require
    // bindings. In minified output a one-letter callee can be a shadowed inner
    // parameter; that can only over-report (a warning), never hide a require.
    const nonLiteralCallees = new Set();
    // Sticky, positioned at each call's `(`: no per-call copy of a multi-MB bundle.
    const literalArgRe = new RegExp(`${GAP}(["'\`])([^"'\`$\\\\\\s]+)\\1${GAP}\\)`, "y");
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})${GAP}\\(`, "g"))) {
        literalArgRe.lastIndex = m.index + m[0].length;
        if (!literalArgRe.test(src)) nonLiteralCallees.add(m[1]);
    }

    return {
        aliases: [...aliases],
        requireBindings: [...requireBindings],
        exports: exportsMap,
        imports,
        literalCalls,
        nonLiteralCallees,
        unrecognizedBinding: aliasCalls > recognized,
    };
}

/**
 * Wrap every `<alias>(import.meta.url)` in a require that statically embeds
 * `embed` specifiers and forwards the rest to the original require.
 *
 * @param {string} src
 * @param {string[]} aliases createRequire local names (analyzeServerModule)
 * @param {string[]} embed specifiers to embed (resolvable, bare, non-builtin)
 * @returns {{ contents: string, count: number }}
 */
export function wrapRequireBindings(src, aliases, embed) {
    if (aliases.length === 0 || embed.length === 0) return { contents: src, count: 0 };
    const cases = [...new Set(embed)]
        .sort()
        .map((spec) => `case ${JSON.stringify(spec)}:return require(${JSON.stringify(spec)});`)
        .join("");
    let contents = src;
    let count = 0;
    for (const alias of aliases) {
        const re = new RegExp(
            `(?<![\\w$.])${escapeRe(alias)}${GAP}\\(${GAP}import\\.meta\\.url${GAP}\\)`,
            "g",
        );
        contents = contents.replace(re, (whole) => {
            count++;
            return (
                "((__knextBase)=>{const __knextRequire=(__knextSpec)=>{switch(__knextSpec){" +
                cases +
                "}return __knextBase(__knextSpec)};" +
                "__knextRequire.resolve=__knextBase.resolve;__knextRequire.cache=__knextBase.cache;" +
                `return __knextRequire})(${whole})`
            );
        });
    }
    return { contents, count };
}
