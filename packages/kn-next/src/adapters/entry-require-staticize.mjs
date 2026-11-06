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
 * A THIRD shape (cluster C11, `streaming-ssr`'s pages-router edge-runtime
 * pages): when rolldown merges several originally-separate modules into one
 * chunk (nitro's `inlineDynamicImports`/no-code-splitting output) and more than
 * one of them calls `createRequire(import.meta.url)`, each module's OWN
 * `import.meta.url` cannot survive the merge as a bare token — it is hoisted
 * into a per-module getter so each merged module keeps its own file identity:
 *
 *     var __require = e({ get value() { return t.url } }.value);
 *
 * (`t.url` stands in for that one module's `import.meta.url`). The binding
 * created this way is just as real a `require` as the other two shapes — it is
 * recognized as one, and its creation expression is wrapped the same way — but
 * nothing about the PACKAGE it is later called with (`react`, bundled directly
 * by nitro rather than traced to `.output/server/node_modules`, since nitro
 * never left it external here) was ever staged beside the binary. See
 * `planRuntimeRequires` in vinext-compile.mjs for the embed side of this: a
 * spec reached through any of the three binding shapes is embeddable once it
 * resolves from the entry's own directory, sidecar or not.
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
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUILTINS = new Set(builtinModules);

const IDENT = "[A-Za-z_$][\\w$]*";
/**
 * Whitespace and `/* … *\/` comments, e.g. rolldown's `/* #__PURE__ *\/`. A
 * comment body never contains `*\/`, so backtracking cannot stretch one comment
 * across code into the next (`/* a *\/ n /* b *\/` is two comments around `n`).
 */
const COMMENT = "/\\*[^*]*\\*+(?:[^*/][^*]*\\*+)*/";
const GAP = `(?:\\s|${COMMENT})*`;

/**
 * A synthetic `requireBindings`/`literalCalls`/`nonLiteralCallees` key for a
 * create-and-immediately-call site (`createRequire(getterShape)("spec")`,
 * measured on the real file-manager build — no named binding at all exists
 * to key on). NUL-prefixed: no real JS identifier can ever spell it, so it
 * can never collide with a real callee name, however the module is minified.
 */
const DIRECT_CALL_MARKER = "\0knext-direct-require-call";

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBareNonBuiltin(spec) {
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

/**
 * Past a string or template literal starting at `i`; -1 if unterminated, or
 * if a template holds a `${…}` substitution: its expression can nest strings
 * and templates (`${c ? "`" : ""}`), and a flat scan would close the template
 * on the inner backtick. Rather than lex the nesting, the caller bails.
 */
function skipStringLiteral(src, i) {
    const quote = src[i];
    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === quote) return j;
        else if (quote === "`" && src[j] === "$" && src[j + 1] === "{") return -1;
    }
    return -1;
}

/**
 * The `)` closing the parameter list opened at `open`, with nested parens and
 * string/template literals (which may hold `(`, `)` or `) {`) balanced; -1 if
 * not found within HEAD_SCAN_LIMIT characters (then it is not treated as a
 * head — a long argument list is a call, and the bound keeps a multi-MB bundle
 * linear).
 *
 * Also -1 on any `/` before the close, and on any `${` inside a template: a
 * regex literal, a comment or a substitution's nested strings can hold
 * a quote this scan would pair with a later string's quote, landing it on an
 * unrelated `) {` and hiding a call. Rather than lex regexes and comments, the
 * scan bails — a real method head almost never has `/` in its parameters, and
 * bailing means "call", which fails safe.
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
        } else if (c === "/") return -1;
        else if (c === "(") depth++;
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
 *     a call). A parameter list longer than HEAD_SCAN_LIMIT, or holding any
 *     `/` (regex, comment or division) or template `${`, is not a head.
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
 * `analyzeCreateRequire(src)` (create-require-analyze.mjs) in a child process,
 * run synchronously so `analyzeServerModule` keeps its synchronous contract.
 * acorn is a third-party package, so it cannot be imported into this module
 * (the compile script's node-builtins-only import closure — see
 * create-require-analyze.mjs's header). A failure of the CHILD throws: a broken
 * install must not read as a clean module. Fails closed when the analyzer file
 * is absent, as asset-anchor-analyze.mjs does.
 */
const CREATE_REQUIRE_ANALYZER_TIMEOUT_MS = 120_000;

/**
 * The analyzer beside THIS module's source. Correct only where this module is
 * loaded from its own directory (the source tree, and tests). Once tsup bundles
 * it into a shared chunk, `import.meta.url` names the chunk's directory, so a
 * caller in a bundled entry must pass its own analyzer path instead.
 */
function siblingCreateRequireAnalyzer() {
    const here = dirname(fileURLToPath(import.meta.url));
    return (
        [
            join(here, "create-require-analyze.js"),
            join(here, "create-require-analyze.mjs"),
        ].find((candidate) => existsSync(candidate)) ?? join(here, "create-require-analyze.mjs")
    );
}
function runCreateRequireAnalyzer(src, analyzerPath, extraArgs, isAnalysis) {
    const analyzer = analyzerPath ?? siblingCreateRequireAnalyzer();
    if (!existsSync(analyzer)) {
        throw new Error(
            `[knext compile] the createRequire analyzer is missing (${analyzer}) — the installed @getknext/core is incomplete`,
        );
    }
    // Both callers run under Bun (vinext-compile, compile-embed); outside Bun,
    // fall back to the `bun` on PATH rather than handing node a bun-only flag.
    const runtime = process.versions.bun ? process.execPath : "bun";
    const child = spawnSync(runtime, ["--no-install", analyzer, ...extraArgs], {
        input: src,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: CREATE_REQUIRE_ANALYZER_TIMEOUT_MS,
    });
    if (child.error !== undefined || child.status !== 0) {
        const how =
            child.error?.code === "ETIMEDOUT"
                ? `timed out after ${CREATE_REQUIRE_ANALYZER_TIMEOUT_MS} ms`
                : child.status === null
                  ? `was killed by ${child.signal ?? child.error}`
                  : `exited ${child.status}`;
        const stderr = String(child.stderr ?? "").trim();
        throw new Error(
            `[knext compile] the createRequire analyzer (${analyzer}) ${how}` +
                `${stderr ? ` (${stderr.split("\n").slice(-3).join(" | ")})` : ""} — refusing to ` +
                "classify a module's requires without it; reinstall @getknext/core.",
        );
    }
    let analysis;
    try {
        analysis = JSON.parse(child.stdout);
    } catch {
        throw new Error(
            `[knext compile] the createRequire analyzer (${analyzer}) printed no JSON — reinstall @getknext/core.`,
        );
    }
    if (!isAnalysis(analysis)) {
        throw new Error(
            `[knext compile] the createRequire analyzer (${analyzer}) printed JSON that is not an analysis — reinstall @getknext/core.`,
        );
    }
    return analysis;
}

/**
 * Whether a module could create a require at all: it names `createRequire`, or it
 * imports `module` / `node:module` (whose namespace carries `createRequire`).
 * Only those modules pay for an analyzer process. Kept in step with the same
 * pre-filter in create-require-analyze.mjs, which this module cannot import.
 */
const MODULE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](?:node:)?module["']/;
function mentionsCreateRequire(src) {
    return (
        src.includes("createRequire") ||
        src.includes("getBuiltinModule") ||
        MODULE_IMPORT.test(src)
    );
}

function analyzeCreateRequire(src, analyzerPath) {
    return runCreateRequireAnalyzer(
        src,
        analyzerPath,
        [],
        (a) => Array.isArray(a?.aliases) && Array.isArray(a?.sites),
    );
}

/**
 * Whether the module `src` does anything with the require bindings it IMPORTS
 * from a sibling chunk (`names`: their local names) other than call them: copy,
 * store, pass or re-export one, so a package it loads is invisible to the
 * cross-chunk plan (#2666). True also for a module the parser cannot read.
 *
 * @param {string} src
 * @param {string[]} names
 * @param {string} [analyzerPath] the create-require-analyze script to spawn.
 * @returns {boolean}
 */
export function importedRequireEscapes(src, names, analyzerPath) {
    if (names.length === 0) return false;
    const result = runCreateRequireAnalyzer(
        src,
        analyzerPath,
        ["--imported", JSON.stringify(names)],
        (a) => typeof a?.escapes === "boolean",
    );
    return result.escapes;
}

/**
 * Static facts about one server-output module.
 *
 * @param {string} src
 * @param {string} [analyzerPath] the create-require-analyze script to spawn.
 *   Callers in a bundled entry pass their own (see siblingCreateRequireAnalyzer).
 * @returns {{
 *   aliases: string[],
 *   requireBindings: string[],
 *   exports: Map<string, string[]>,
 *   imports: { from: string, names: Map<string, string> }[],
 *   literalCalls: Map<string, Set<string>>,
 *   nonLiteralCallees: Set<string>,
 *   declarationCounts: Map<string, number>,
 *   unrecognizedBinding: boolean,
 *   foldedRuntimeRequires: string[],
 * }}
 */
export function analyzeServerModule(src, analyzerPath) {
    // Local names of `createRequire` imported from `module` / `node:module`, and
    // how each `createRequire(import.meta.url)` call's value is used, come from
    // the acorn analysis in create-require-analyze.mjs (#2614). The parse runs
    // only for a module that mentions createRequire at all.
    const requireBindings = new Set();
    // Populated before the general literal-call scan below, so a DIRECT call
    // (`createRequire(...)(spec)`, no named binding — see DIRECT_CALL_MARKER)
    // lands in the SAME map the general scan adds to.
    const literalCalls = new Map();
    const nonLiteralCallees = new Set();
    // Packages a DIRECT call loads by a constant assembled from string literals
    // (`['io', 'redis'].join('')`): a deliberate runtime load of a known name.
    // Reported, never embedded and never strict-failed (see create-require-analyze).
    const foldedRuntimeRequires = new Set();
    let aliases = [];
    let unrecognizedBinding = false;
    if (mentionsCreateRequire(src)) {
        const created = analyzeCreateRequire(src, analyzerPath);
        aliases = created.aliases;
        // A module the parser cannot read may still create a require the
        // analysis cannot see: report it, never treat it as clean.
        if (created.parseError !== null) unrecognizedBinding = true;
        for (const site of created.sites) {
            if (site.kind === "binding") {
                requireBindings.add(site.name);
            } else if (site.kind === "direct") {
                if (site.dynamic && typeof site.folded === "string") {
                    foldedRuntimeRequires.add(site.folded);
                } else if (site.dynamic) {
                    requireBindings.add(DIRECT_CALL_MARKER);
                    nonLiteralCallees.add(DIRECT_CALL_MARKER);
                } else if (isBareNonBuiltin(site.spec)) {
                    requireBindings.add(DIRECT_CALL_MARKER);
                    const set = literalCalls.get(DIRECT_CALL_MARKER) ?? new Set();
                    set.add(site.spec);
                    literalCalls.set(DIRECT_CALL_MARKER, set);
                }
            } else if (site.kind === "handed") {
                // Its value is handed on (returned, passed, stored): the require
                // it makes cannot be verified.
                unrecognizedBinding = true;
            }
            // `resolve` (an existence probe, deliberately never embedded or
            // strict-failed) and `discarded` (inert) need no more than this.
        }
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

    // `callee(<literal bare spec>)` → callee → specs (merges into the map
    // DIRECT_CALL_MARKER entries were already added to, above).
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
    // two apart. (merges into the set DIRECT_CALL_MARKER was already added to, above.)
    // Sticky, positioned at each call's `(`: no per-call copy of a multi-MB bundle.
    const stickyLiteralArgRe = new RegExp(`${GAP}(["'\`])([^"'\`$\\\\\\s]+)\\1${GAP}\\)`, "y");
    // Not every `name(` is a call, but only a POSITIVELY identified definition
    // head is skipped (isDefinitionHead): anything else — `extends __require(n) {`,
    // `x = __require(n)`, a call followed by a block on the next line — is a call.
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})${GAP}\\(`, "g"))) {
        if (isDefinitionHead(src, m.index, m.index + m[0].length - 1)) continue;
        stickyLiteralArgRe.lastIndex = m.index + m[0].length;
        if (!stickyLiteralArgRe.test(src)) nonLiteralCallees.add(m[1]);
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
        unrecognizedBinding,
        foldedRuntimeRequires: [...foldedRuntimeRequires].sort(),
    };
}

/**
 * Wrap every `<alias>(import.meta.url)` — or its per-module-merge getter-
 * indirection form (cluster C11), `<alias>({get value(){return <ident>.url}}.value)`
 * — in a require that statically embeds `embed` specifiers and forwards the
 * rest to the original require.
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
        const call = `${escapeRe(alias)}${GAP}\\(${GAP}import\\.meta\\.url${GAP}\\)`;
        const getterCall =
            `${escapeRe(alias)}${GAP}\\(${GAP}\\{${GAP}get${GAP}value${GAP}\\(${GAP}\\)` +
            `${GAP}\\{${GAP}return${GAP}${IDENT}${GAP}\\.${GAP}url${GAP}\\}${GAP}\\}${GAP}\\.${GAP}value${GAP}\\)`;
        const re = new RegExp(`(?<![\\w$.])(?:${call}|${getterCall})`, "g");
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
