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

/** The longest run of preceding sibling text `isDiscardedPosition` scans. */
const MAX_SEQUENCE_SCAN = 4096;

/**
 * Whether the expression starting at `start` is in a position whose value is
 * DISCARDED at statement level: an expression statement on its own, or an
 * element of a statement-level comma sequence. Proven from the tokens before
 * it, scanning backwards over preceding sequence siblings to the statement
 * boundary:
 *   - start of source, `;`, `{` (a block or arrow body — never `${`, a
 *     template substitution whose value is used), or `}` ends the scan: the
 *     expression starts a statement.
 *   - `,` must be preceded by a plain call sibling `a.b(...)` (identifier
 *     chain + balanced parens holding no string, template, regex or comment
 *     — anything this scan cannot lex conservatively bails). Rolldown's real
 *     per-chunk init is exactly this: `{init_a(),init_b(),createRequire(x),…}`.
 *   - anything else — `return`, `=`, `:`, `(`, `[`, `?`, `=>`, a keyword, a
 *     non-call sibling — is NOT provably discarded.
 * Paired with a following `,`/`;`/`}`/end (the caller's `discardedRe`), an
 * element that is NOT last is discarded by the comma operator and a last one
 * is the value of an expression statement. Conservative by construction: a
 * false "not discarded" only costs a warning (an error under strict mode);
 * a false "discarded" would silently lose one.
 *
 * @param {string} src
 * @param {number} start
 * @returns {boolean}
 */
function isDiscardedPosition(src, start) {
    const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
    const isIdent = (c) => c !== undefined && /[\w$]/.test(c);
    const floor = Math.max(0, start - MAX_SEQUENCE_SCAN);
    let i = start - 1;
    const skipWs = () => {
        while (i >= floor && isWs(src[i])) i--;
    };
    for (;;) {
        skipWs();
        if (i < 0) return true;
        if (i < floor) return false;
        const c = src[i];
        if (c === ";" || c === "}" || c === "{") {
            // A `;`/`{`/`}` inside a `//` comment is not a
            // boundary (`const r = // note;\n e(x)` hands the value on).
            if (!isOutsideLineComment(src, i)) return false;
            return c !== "{" || src[i - 1] !== "$";
        }
        if (c !== ",") return false;
        // A `,`: the previous sibling must be a plain call `a.b(...)`.
        i--;
        skipWs();
        if (src[i] !== ")") return false;
        let depth = 0;
        for (; i >= floor; i--) {
            const ch = src[i];
            if (ch === '"' || ch === "'" || ch === "`" || ch === "/") return false;
            if (ch === ")" || ch === "]" || ch === "}") depth++;
            else if (ch === "(" || ch === "[" || ch === "{") {
                depth--;
                if (depth === 0) break;
            }
        }
        if (i < floor) return false;
        i--; // past the call's `(`
        skipWs();
        // The callee: an identifier chain `a.b.c`.
        let sawIdent = false;
        for (;;) {
            const end = i;
            while (i >= floor && isIdent(src[i])) i--;
            if (i === end) return false;
            const word = src.slice(i + 1, end + 1);
            if (/^\d/.test(word) || SEQUENCE_STOP_WORDS.has(word)) return false;
            sawIdent = true;
            skipWs();
            if (src[i] !== ".") break;
            if (src[i - 1] === ".") return false; // `...spread`
            i--;
            skipWs();
        }
        if (!sawIdent) return false;
    }
}

/**
 * Whether `src[at]` is provably NOT inside a `//` line comment: true only
 * when no `//` appears on its line before it. A `//` anywhere earlier on the
 * line — a real comment, or one inside a string or regex this cannot tell
 * apart (a line may begin inside a multi-line template, so lexing from the
 * line start is not reliable either) — answers false: cannot tell. Only line
 * comments need this: a `/* *\/` comment ends in `/`, which the scan meets
 * (and bails on) before any `;`/`{`/`}` inside it.
 *
 * @param {string} src
 * @param {number} at
 * @returns {boolean}
 */
function isOutsideLineComment(src, at) {
    const lineStart = src.lastIndexOf("\n", at - 1) + 1;
    return !src.slice(lineStart, at).includes("//");
}

/** Words that, as a "callee", mean the call is not a plain sequence sibling. */
const SEQUENCE_STOP_WORDS = new Set([
    "return", "throw", "typeof", "void", "delete", "new", "await", "yield",
    "in", "of", "instanceof", "case", "if", "while", "for", "switch", "catch",
    "with", "function", "else", "do",
]);

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

    // Bindings: `X = alias(import.meta.url)`, rolldown's
    // `X = (() => alias(import.meta.url))()`, and the per-module-merge getter
    // indirection (cluster C11 — see this file's header): `X =
    // alias({get value(){return <ident>.url}}.value)`.
    const requireBindings = new Set();
    // The FULL span of every recognized `IDENT = <create-expr>` match
    // (including the IIFE wrapper's own parens in that shape), so the
    // classification loop below can tell "this occurrence is the one INSIDE
    // a recognized assignment" apart from "this occurrence sits bare,
    // without one" — a plain look at what comes right AFTER the bare
    // create-expression cannot do that: the IIFE shape's create-expression
    // is immediately followed by `)` (its own wrapper's close), the exact
    // same character that follows a create-expression handed bare to an
    // ENCLOSING call (`use(createRequire(x))`) — which must NOT be treated
    // as recognized (#1877 round-2 review: that was flagged as recognized
    // too, before this span check existed).
    const bindingRanges = [];
    // Populated here, before the general literal-call scan below, so a
    // CREATE-AND-IMMEDIATELY-CALL site (no named binding at all — see
    // DIRECT_CALL_MARKER below) lands in the SAME map the general scan adds
    // to, under a marker no real identifier can ever spell.
    const literalCalls = new Map();
    const nonLiteralCallees = new Set();
    for (const alias of aliases) {
        const call = `${escapeRe(alias)}${GAP}\\(${GAP}import\\.meta\\.url${GAP}\\)`;
        const getterCall =
            `${escapeRe(alias)}${GAP}\\(${GAP}\\{${GAP}get${GAP}value${GAP}\\(${GAP}\\)` +
            `${GAP}\\{${GAP}return${GAP}${IDENT}${GAP}\\.${GAP}url${GAP}\\}${GAP}\\}${GAP}\\.${GAP}value${GAP}\\)`;
        const bindingRe = new RegExp(
            `(?<![\\w$.])(${IDENT})${GAP}=${GAP}(?:\\(${GAP}\\(${GAP}\\)${GAP}=>${GAP}${call}${GAP}\\)${GAP}\\(${GAP}\\)|${call}|${getterCall})`,
            "g",
        );
        for (const m of src.matchAll(bindingRe)) {
            requireBindings.add(m[1]);
            bindingRanges.push([m.index, m.index + m[0].length]);
        }
    }
    // Every `alias(import.meta.url)` / `alias(getter-indirection)` call NOT
    // already inside a `bindingRanges` span, classified by what immediately
    // follows it. Real rolldown output (measured against the real
    // file-manager build) creates and uses the require function in the SAME
    // expression, with no named binding at all:
    //   - `createRequire(getterShape)(` SPEC `)`         — direct call
    //   - `createRequire(getterShape).resolve(` SPEC `)` — direct resolve
    //   - `createRequire(getterShape)` alone, discarded in a comma/sequence
    //     expression or a block's last statement — rolldown's per-chunk
    //     module-init boilerplate sets one up defensively whether or not
    //     THIS chunk ends up calling it — inert, nothing to embed, not a gap
    // A shape matching none of these — including one HANDED to an enclosing
    // call this analysis cannot see into (`use(createRequire(x))`) — is the
    // one case left unaccounted for, and THAT is what `unrecognizedBinding`
    // must mean.
    let aliasCalls = 0;
    let accountedFor = 0;
    const literalArgRe = new RegExp(`^${GAP}(["'\`])([^"'\`$\\\\\\s]+)\\1${GAP}\\)`);
    const invokeRe = new RegExp(`^${GAP}\\(`);
    const resolveInvokeRe = new RegExp(`^${GAP}\\.${GAP}resolve${GAP}\\(`);
    // Followed by `,`/`;`/`}` (or end of source) is NECESSARY for a discarded
    // value but not sufficient: `return e(x);`, `use(e(x), 1)` and
    // `{r: e(x)}` all hand the require on. `isDiscardedPosition` supplies the
    // other half — see it. `)` and `]` never qualify: a bare create followed
    // by either sits inside an enclosing call, group or array literal.
    const discardedRe = new RegExp(`^(?:${GAP}[,;}]|$)`);
    for (const alias of aliases) {
        const call = `${escapeRe(alias)}${GAP}\\(${GAP}import\\.meta\\.url${GAP}\\)`;
        const getterCall =
            `${escapeRe(alias)}${GAP}\\(${GAP}\\{${GAP}get${GAP}value${GAP}\\(${GAP}\\)` +
            `${GAP}\\{${GAP}return${GAP}${IDENT}${GAP}\\.${GAP}url${GAP}\\}${GAP}\\}${GAP}\\.${GAP}value${GAP}\\)`;
        const anyCall = new RegExp(`(?<![\\w$.])(?:${call}|${getterCall})`, "g");
        for (const m of src.matchAll(anyCall)) {
            aliasCalls++;
            if (bindingRanges.some(([s, e]) => m.index >= s && m.index < e)) {
                accountedFor++;
                continue;
            }
            const after = src.slice(m.index + m[0].length);
            const invoke = invokeRe.exec(after);
            if (invoke) {
                accountedFor++;
                const argStart = invoke[0].length;
                const lit = literalArgRe.exec(after.slice(argStart));
                if (lit) {
                    const spec = lit[2];
                    if (isBareNonBuiltin(spec)) {
                        requireBindings.add(DIRECT_CALL_MARKER);
                        const set = literalCalls.get(DIRECT_CALL_MARKER) ?? new Set();
                        set.add(spec);
                        literalCalls.set(DIRECT_CALL_MARKER, set);
                    }
                } else {
                    requireBindings.add(DIRECT_CALL_MARKER);
                    nonLiteralCallees.add(DIRECT_CALL_MARKER);
                }
                continue;
            }
            // `.resolve(spec)` is an EXISTENCE PROBE, not a load: Node's own
            // `require.resolve` idiom (`try { require.resolve(x) } catch {}`,
            // measured verbatim in @getknext/lib's logger, probing for the
            // optional, deliberately-production-absent `pino-pretty`) throws
            // INSIDE the probe and is normally caught right there — unlike a
            // bare call, the enclosing module does not crash merely because
            // the target is missing. Treating it the same as a real call
            // regressed the self-contained build (#1877 round 3): recognizing
            // this shape at all made a correctly, intentionally unresolvable
            // optional dependency's probe fail `--self-contained`/
            // `KNEXT_COMPILE_STRICT_REQUIRES=1` the same way a REAL missing
            // load would. So it is accounted for (never the unrecognized-
            // binding error) but deliberately NOT fed into
            // literalCalls/nonLiteralCallees: never embedded, never warned
            // about, never strict-failed.
            if (resolveInvokeRe.test(after)) {
                accountedFor++;
                continue;
            }
            if (discardedRe.test(after) && isDiscardedPosition(src, m.index)) {
                accountedFor++;
                continue;
            }
        }
    }
    const recognized = accountedFor;

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
        unrecognizedBinding: aliasCalls > recognized,
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
