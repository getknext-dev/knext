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
/**
 * Whitespace and `/* … *\/` comments, e.g. rolldown's `/* #__PURE__ *\/`. A
 * comment body never contains `*\/`, so backtracking cannot stretch one comment
 * across code into the next (`/* a *\/ n /* b *\/` is two comments around `n`).
 */
const COMMENT = "/\\*[^*]*\\*+(?:[^*/][^*]*\\*+)*/";
const GAP = `(?:\\s|${COMMENT})*`;

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
 * Whether the token starting at `index` sits in statement position: preceded
 * (ignoring whitespace and comments) by nothing, `;`, `{` or `}`, possibly via
 * `export` / `default` / `async`. A `function` there is a declaration; after
 * `=`, `=>`, `(`, `,`, `?`, `:`, `return`, … it is an expression.
 */
function isStatementPosition(src, index) {
    let i = index - 1;
    for (;;) {
        while (i >= 0 && /\s/.test(src[i])) i--;
        if (i >= 1 && src[i] === "/" && src[i - 1] === "*") {
            const open = src.lastIndexOf("/*", i - 2);
            if (open < 0) return false;
            i = open - 1;
            continue;
        }
        if (i < 0) return true;
        if (";{}".includes(src[i])) return true;
        const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(Math.max(0, i - 15), i + 1))?.[0];
        if (word === "export" || word === "default" || word === "async") {
            i -= word.length;
            continue;
        }
        return false;
    }
}

/** The previous significant token before `index` (whitespace and comments skipped). */
function previousToken(src, index) {
    let i = index - 1;
    for (;;) {
        while (i >= 0 && /\s/.test(src[i])) i--;
        if (i >= 1 && src[i] === "/" && src[i - 1] === "*") {
            const open = src.lastIndexOf("/*", i - 2);
            if (open < 0) return { char: "", word: "", at: -1 };
            i = open - 1;
            continue;
        }
        if (i < 0) return { char: "", word: "", at: -1 };
        const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(Math.max(0, i - 15), i + 1))?.[0] ?? "";
        return { char: src[i], word, at: word ? i - word.length + 1 : i };
    }
}

/** Past a string or template literal starting at `i`; -1 if unterminated. */
function skipStringLiteral(src, i) {
    const quote = src[i];
    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === quote) return j;
    }
    return -1;
}

/**
 * The `)` closing the parameter list opened at `open`, with nested parens and
 * string/template literals (which may hold `(`, `)` or `) {`) balanced; -1 if
 * not found within HEAD_SCAN_LIMIT characters (then it is not treated as a
 * head — a long argument list is a call, and the bound keeps a multi-MB bundle
 * linear).
 */
const HEAD_SCAN_LIMIT = 512;
function closingParen(src, open) {
    let depth = 0;
    const end = Math.min(src.length, open + HEAD_SCAN_LIMIT);
    for (let i = open; i < end; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === "`") {
            i = skipStringLiteral(src, i);
            if (i < 0) return -1;
        } else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) return i;
    }
    return -1;
}

/**
 * Whether `name(` at `nameIndex` (its `(` at `paren`) DEFINES a function
 * rather than calling one. Only these are heads:
 *   - `function name(` / `function* name(` / `function *name(`;
 *   - a method or class member — the previous token is `{`, `,`, `}`, `;` or
 *     `*`, or `get` / `set` / `static` / `async` — whose balanced parameter list
 *     is followed by `{` on the SAME line, same-line comments allowed (a call
 *     cannot be; a call followed by a block on the next line is ASI, and stays
 *     a call). A parameter list longer than HEAD_SCAN_LIMIT is not a head.
 * Every other context (`extends`, `=`, `(`, `return`, operators …) is a call.
 */
const SAME_LINE_BRACE = /^(?:[ \t]|\/\*[^*\n]*\*+(?:[^*/\n][^*\n]*\*+)*\/)*\{/;
function isDefinitionHead(src, nameIndex, paren) {
    const prev = previousToken(src, nameIndex);
    if (prev.word === "function") return true;
    if (prev.char === "*" && previousToken(src, prev.at).word === "function") return true;
    const memberPosition =
        (prev.char !== "" && "{,};*".includes(prev.char)) ||
        ["get", "set", "static", "async"].includes(prev.word);
    if (!memberPosition) return false;
    const close = closingParen(src, paren);
    return close >= 0 && SAME_LINE_BRACE.test(src.slice(close + 1, close + 256));
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
 *   declarationCounts: Map<string, number>,
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
    // runtime, so nothing can embed it. This is scope-blind: in minified output
    // the require binding is a one-letter name that bundled libraries reuse for
    // their own functions and parameters, so a hit on such a name is NOT proof
    // of a dynamic require. declarationCounts below lets the caller tell the
    // two apart.
    const nonLiteralCallees = new Set();
    // Sticky, positioned at each call's `(`: no per-call copy of a multi-MB bundle.
    const literalArgRe = new RegExp(`${GAP}(["'\`])([^"'\`$\\\\\\s]+)\\1${GAP}\\)`, "y");
    // Not every `name(` is a call, but only a POSITIVELY identified definition
    // head is skipped (isDefinitionHead): anything else — `extends __require(n) {`,
    // `x = __require(n)`, a call followed by a block on the next line — is a call.
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})${GAP}\\(`, "g"))) {
        if (isDefinitionHead(src, m.index, m.index + m[0].length - 1)) continue;
        literalArgRe.lastIndex = m.index + m[0].length;
        if (!literalArgRe.test(src)) nonLiteralCallees.add(m[1]);
    }

    // How often each name is DECLARED in this module: var/let/const entries
    // (including `,x=` continuations), function names, parameters (arrow,
    // function, method shorthand, catch). Heuristic by design — over-counting
    // only makes a name ambiguous, which downgrades a strict failure to a
    // warning; it can never hide a require.
    const declarationCounts = new Map();
    const declare = (id) => declarationCounts.set(id, (declarationCounts.get(id) ?? 0) + 1);
    const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "function", "return"]);
    for (const m of src.matchAll(new RegExp(`(?:\\bvar|\\blet|\\bconst)\\s+(${IDENT})`, "g"))) declare(m[1]);
    for (const m of src.matchAll(new RegExp(`,${GAP}(${IDENT})${GAP}=(?![=>])`, "g"))) declare(m[1]);
    // Function DECLARATIONS only: a named function EXPRESSION
    // (`__commonJS = (cb, mod) => function __require() {…}`, esbuild/tsup's CJS
    // helper) binds its name inside itself only and shadows nothing around it.
    for (const m of src.matchAll(new RegExp(`\\bfunction${GAP}(${IDENT})${GAP}\\(`, "g"))) {
        if (isStatementPosition(src, m.index)) declare(m[1]);
    }
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})${GAP}=>`, "g"))) declare(m[1]);
    for (const m of src.matchAll(new RegExp(`\\bcatch${GAP}\\(${GAP}(${IDENT})${GAP}\\)`, "g"))) declare(m[1]);
    const paramLists = [
        new RegExp(`\\(([^()]*)\\)${GAP}=>`, "g"),
        new RegExp(`\\bfunction${GAP}(?:${IDENT})?${GAP}\\(([^()]*)\\)`, "g"),
        new RegExp(`(?<![\\w$.])(?:${IDENT})${GAP}\\(([^()]*)\\)${GAP}\\{`, "g"),
    ];
    for (const re of paramLists) {
        for (const m of src.matchAll(re)) {
            const head = src.slice(m.index, m.index + 12);
            const kw = /^[A-Za-z_$][\w$]*/.exec(head)?.[0];
            if (kw && KEYWORDS.has(kw) && re !== paramLists[1]) continue;
            for (const p of m[1].matchAll(new RegExp(`(?:^|[,{\\[])\\s*(?:\\.\\.\\.)?(${IDENT})\\s*(?=[,=}\\]]|$)`, "g"))) {
                declare(p[1]);
            }
        }
    }

    return {
        aliases: [...aliases],
        requireBindings: [...requireBindings],
        exports: exportsMap,
        imports,
        literalCalls,
        nonLiteralCallees,
        declarationCounts,
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
