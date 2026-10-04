/**
 * Rewrite the compiled entry's `import.meta` for `--bytecode` (cluster C4b).
 *
 * Bytecode emission targets CommonJS, where `import.meta` is a syntax error, so
 * `vinext-compile.mjs` rewrites it to runtime expressions anchored on the
 * executable's own path. The naive version of that rewrite (three
 * `String.prototype.replaceAll` calls plus a `/import\.meta/.test()` sanity
 * check) operates on the RAW TEXT of the bundle, with no notion of "this is a
 * string literal" or "this is a comment" — so when a bundled dependency's own
 * source happens to SPELL "import.meta" inside a string or comment, the naive
 * scan cannot tell that apart from real syntax.
 *
 * That is exactly what breaks the `twoslash` fixture. nitro's `serverExternalPackages`
 * handling has a known regression (#3424) that bundles `typescript` into the
 * compiled entry instead of leaving it external, and `typescript`'s own compiler
 * ships diagnostic MESSAGE TEXT that names the language feature verbatim —
 * `"The 'import.meta' meta-property is only allowed when…"`,
 * `"The 'import.meta' meta-property is not allowed in files…"`, and one more in
 * an option-description string — three string-literal occurrences, zero real
 * `import.meta` syntax. The naive scan's final check counted exactly those
 * three as "survived" and aborted a compile that had nothing left to rewrite.
 *
 * The fix is a single-pass lexer that tracks line comments, block comments, and
 * string/template literals (with `${…}` substitution nesting, since code inside
 * a substitution is real code again) and only reports `import.meta` found in
 * genuine code position. A real bare `import.meta` (no `.url`/`.filename`/
 * `.dirname` — e.g. `typeof import.meta !== "undefined"`, or an unrecognized
 * property like `.resolve`) is rewritten to an inline object literal carrying
 * `url`/`filename`/`dirname`, which is always valid wherever a MetaProperty
 * expression was (the same grammar slot), rather than aborting the build.
 *
 * Not a full JS parser, by design: regex literals are not specially detected,
 * which can only make this scanner treat MORE text as "code" than a real
 * parser would — never less — so it cannot HIDE a real `import.meta` inside
 * what is actually a regex body (the one failure mode that would matter here).
 * String and template literals ARE tracked, because that is the one place a
 * false positive was actually observed.
 */

const IMPORT_META = "import.meta";
const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isIdentChar(ch) {
    return ch !== undefined && IDENT_CHAR.test(ch);
}

/**
 * Every REAL `import.meta` token in `src` (never one spelled inside a string
 * literal or a comment).
 *
 * @param {string} src
 * @returns {{ start: number, end: number, propEnd: number, prop: string | null }[]}
 *   `end` always covers exactly `"import.meta"` (never a trailing `.prop`);
 *   `propEnd` additionally covers `.prop` when one follows (equal to `end`
 *   when `prop` is `null`). `prop` is the identifier immediately following a
 *   `.`, if any — the caller decides which ones it understands and which end
 *   to splice at.
 */
export function findRealImportMeta(src) {
    const out = [];
    /** @type {"code" | "line" | "block" | "string" | "template"} */
    let mode = "code";
    let quote = "";
    // Nested `${…}` inside a template literal re-enters "code" mode; this stack
    // records the brace-depth (relative to the braces counted below) at which
    // each pending substitution must close, so a nested `{…}` object literal
    // inside the substitution does not prematurely resume template mode.
    const templateReturnDepth = [];
    let braceDepth = 0;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (mode === "line") {
            if (c === "\n") mode = "code";
            continue;
        }
        if (mode === "block") {
            if (c === "*" && src[i + 1] === "/") {
                i++;
                mode = "code";
            }
            continue;
        }
        if (mode === "string" || mode === "template") {
            if (c === "\\") {
                i++;
                continue;
            }
            if (mode === "template" && c === "$" && src[i + 1] === "{") {
                templateReturnDepth.push(braceDepth);
                braceDepth++;
                mode = "code";
                i++;
                continue;
            }
            if (c === quote) mode = "code";
            continue;
        }
        // mode === "code"
        if (c === "/" && src[i + 1] === "/") {
            mode = "line";
            i++;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            mode = "block";
            i++;
            continue;
        }
        if (c === "'" || c === '"') {
            mode = "string";
            quote = c;
            continue;
        }
        if (c === "`") {
            mode = "template";
            quote = "`";
            continue;
        }
        if (templateReturnDepth.length > 0) {
            if (c === "{") {
                braceDepth++;
            } else if (c === "}") {
                braceDepth--;
                if (braceDepth === templateReturnDepth[templateReturnDepth.length - 1]) {
                    templateReturnDepth.pop();
                    mode = "template";
                    continue;
                }
            }
        }
        if (
            c === "i" &&
            src.startsWith(IMPORT_META, i) &&
            !isIdentChar(src[i - 1]) &&
            !isIdentChar(src[i + IMPORT_META.length])
        ) {
            const j = i + IMPORT_META.length;
            let prop = null;
            let propEnd = j;
            if (src[j] === "." && isIdentChar(src[j + 1])) {
                let k = j + 1;
                while (isIdentChar(src[k])) k++;
                prop = src.slice(j + 1, k);
                propEnd = k;
            }
            out.push({ start: i, end: j, propEnd, prop });
        }
    }
    return out;
}

/**
 * Rewrite every real `import.meta` in `src`:
 *   - `.url` / `.filename` / `.dirname` → the matching runtime expression;
 *   - anything else (bare `import.meta`, or an unrecognized property like
 *     `.resolve`/`.env`) → an inline object literal carrying all three, so the
 *     expression stays valid wherever `import.meta` was.
 *
 * A false positive inside a string or comment (cluster C4b) is left untouched
 * — `findRealImportMeta` never reports one.
 *
 * @param {string} src
 * @param {{ entryUrlExpr: string, entryFileExpr: string, entryDirExpr: string }} exprs
 * @returns {{ contents: string, rewritten: number }}
 */
export function rewriteImportMeta(src, exprs) {
    const known = {
        url: exprs.entryUrlExpr,
        filename: exprs.entryFileExpr,
        dirname: exprs.entryDirExpr,
    };
    const bareExpr = `({url:${exprs.entryUrlExpr},filename:${exprs.entryFileExpr},dirname:${exprs.entryDirExpr}})`;
    const uses = findRealImportMeta(src);
    if (uses.length === 0) return { contents: src, rewritten: 0 };
    let out = "";
    let last = 0;
    for (const use of uses) {
        out += src.slice(last, use.start);
        const isKnownProp = use.prop !== null && known[use.prop] !== undefined;
        // A known property (.url/.filename/.dirname): splice out THROUGH the
        // property name too, replacing "import.meta.url" wholesale with the
        // expression — never just "import.meta", which would leave a stray
        // ".url" appended after the replacement expression. An unknown or
        // absent property splices out only "import.meta" itself, so a
        // trailing ".resolve"/".env" (or nothing) applies to the synthesized
        // object afterwards.
        out += isKnownProp ? known[use.prop] : bareExpr;
        last = isKnownProp ? use.propEnd : use.end;
    }
    out += src.slice(last);
    return { contents: out, rewritten: uses.length };
}
