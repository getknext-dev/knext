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
 * Regex literals ARE lexed (round-2 review, #1877): a `/` in code position is
 * disambiguated from division by the usual heuristic — what the previous
 * SIGNIFICANT token was — and a real regex body is skipped wholesale (escapes
 * and character classes honoured, so a `/` or a quote INSIDE `[...]` does not
 * end anything). Measured on the real file-manager build: a character class
 * containing a quote (`/[!'()*]/g`, S3's URI-escape helper) made the OLD,
 * regex-blind version of this scanner enter fake "string" mode at that `'`
 * and never correctly recover — silently swallowing several REAL
 * `import.meta.filename`/`.dirname` uses elsewhere in the same bundle as "text
 * inside a string", which then survived uncompiled into the bytecode step and
 * crashed the binary at boot (`SyntaxError: import.meta is only valid inside
 * modules`) despite `vinext-compile.mjs` logging a successful rewrite. When
 * the regex/division call is genuinely AMBIGUOUS from the previous token alone
 * (the one real case: a bare `}`, which can end either a block statement or an
 * object/arrow-body expression — telling those apart needs a real parser) or a
 * guessed regex body cannot be closed before a raw newline, this throws rather
 * than guess: per this file's own history, a silent wrong guess is far worse
 * than a loud failure.
 */

const IMPORT_META = "import.meta";
const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isIdentChar(ch) {
    return ch !== undefined && IDENT_CHAR.test(ch);
}

/**
 * Keywords after which a following `/` starts a regex literal, never
 * division — the operand position of a unary/control keyword, not the tail
 * of a value-producing expression.
 */
const REGEX_ALLOWED_KEYWORDS = new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "throw",
    "case",
    "yield",
    "do",
    "else",
]);

/**
 * Past a regex literal's closing (unescaped, outside a character class) `/`,
 * returning the index right after it; or `-1` if a raw `\n` or end of source
 * is reached first (not a real regex after all, or malformed — either way
 * this scanner cannot safely continue past it silently).
 */
function skipRegexLiteral(src, i) {
    let inClass = false;
    for (let j = i + 1; j < src.length; j++) {
        const c = src[j];
        if (c === "\\") {
            j++;
            continue;
        }
        if (c === "\n") return -1;
        if (inClass) {
            if (c === "]") inClass = false;
            continue;
        }
        if (c === "[") inClass = true;
        else if (c === "/") return j + 1;
    }
    return -1;
}

/**
 * Every REAL `import.meta` token in `src` (never one spelled inside a string
 * literal, a comment, or a regex-literal body).
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
    // records, per pending substitution, the brace-depth at which it must
    // close (so a nested `{…}` object literal inside the substitution does
    // not prematurely resume template mode) AND the enclosing template's OWN
    // delimiter — always "`", but RESTORING it matters: a substitution's
    // expression can itself open a real string (`${a || "b"}`), which
    // overwrites the single shared `quote` variable, and without restoring
    // it here the scanner would then wait for ANOTHER `"` to close the
    // template instead of its real backtick — silently swallowing
    // everything after it, including a real `import.meta` (measured: this
    // exact shape, `` `${message || "Unexpected node."}…` ``, is real
    // typescript source).
    const templateReturnDepth = [];
    let braceDepth = 0;
    // Whether the previous SIGNIFICANT (non-whitespace, non-comment) token in
    // code position was value-producing — i.e. a following bare `/` means
    // division, not a regex literal's start. `null` only at the very start of
    // `src` (before anything), where a regex is allowed, same as real JS.
    // `"ambiguous"` marks the one case a token-level heuristic cannot resolve:
    // a bare `}` (block-statement end vs. object/arrow-body-expression end).
    let lastValue = null;
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
                templateReturnDepth.push({ depth: braceDepth, quote });
                braceDepth++;
                mode = "code";
                lastValue = false; // `${` opens an expression position
                i++;
                continue;
            }
            if (c === quote) {
                mode = "code";
                lastValue = true; // a string/template literal is a value
            }
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
                const pending = templateReturnDepth[templateReturnDepth.length - 1];
                if (braceDepth === pending.depth) {
                    templateReturnDepth.pop();
                    mode = "template";
                    quote = pending.quote; // restore — see the stack's own comment
                    continue;
                }
            }
        }
        // Whitespace is not a token: it must never change `lastValue` (a
        // value followed by " / " is still division, not a regex restart).
        if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
        if (c === "/") {
            if (lastValue === "ambiguous") {
                throw new Error(
                    `[knext compile] cannot tell whether "/" at offset ${i} starts a regex literal ` +
                        "or is division — the preceding \"}\" could end either a block statement or an " +
                        "expression, and this scanner is not a full parser; refusing to guess",
                );
            }
            if (lastValue === true) {
                // Division/compound-assignment operator: an ordinary
                // character, not entered specially (matches the
                // `lastValue = false` default fallthrough below for any
                // other operator character).
                lastValue = false;
                continue;
            }
            const end = skipRegexLiteral(src, i);
            if (end < 0) {
                throw new Error(
                    `[knext compile] a "/" at offset ${i} looks like a regex literal (the preceding ` +
                        "token does not produce a value) but no closing \"/\" was found before a raw " +
                        "newline or the end of the source — refusing to guess whether this is really " +
                        "division or a malformed regex",
                );
            }
            i = end - 1;
            lastValue = true; // a regex literal is a value
            continue;
        }
        if (c === ")" || c === "]") {
            lastValue = true;
            continue;
        }
        if (c === "}") {
            lastValue = "ambiguous";
            continue;
        }
        if (isIdentChar(c)) {
            // Only the START of a word decides lastValue; mid-word characters
            // fall through to the import.meta check below unaffected. A
            // number (starts with a digit) is always a value; a letter/_/$
            // word is a value UNLESS it is one of the keywords a regex can
            // follow.
            if (!isIdentChar(src[i - 1])) {
                let k = i;
                while (isIdentChar(src[k])) k++;
                const word = src.slice(i, k);
                lastValue = !REGEX_ALLOWED_KEYWORDS.has(word);
            }
        } else {
            lastValue = false;
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
 *   - a BARE `import.meta` (no property at all) → an inline object literal
 *     carrying `url`/`filename`/`dirname`, valid wherever a MetaProperty
 *     expression was (e.g. `typeof import.meta !== "undefined"`);
 *   - `.url` / `.filename` / `.dirname` → the matching runtime expression.
 *
 * Any OTHER property (`.main`, `.env`, `.resolve`, …) is a loud build error
 * naming the property, never a silent rewrite (round-2 review, #1877): an
 * object literal has no such property, so `import.meta.main` would silently
 * become `undefined` and `import.meta.env.MODE` would throw at runtime on a
 * request path nobody tested at compile time — exactly the kind of failure
 * this whole rewrite exists to turn into a build-time one instead.
 *
 * A false positive inside a string, comment or regex-literal body (cluster
 * C4b) is left untouched — `findRealImportMeta` never reports one.
 *
 * Fails closed: after rewriting, the OUTPUT is re-scanned, and the presence
 * of even one real `import.meta` there aborts the build rather than shipping
 * a binary bytecode cannot compile (round-2 review, #1877 — a bundled
 * dependency's own `import.meta` the lexer still cannot see through, for
 * whatever reason, must not reach `Bun.build` silently).
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
        if (use.prop === null) {
            out += bareExpr;
            last = use.end;
        } else if (known[use.prop] !== undefined) {
            // Splice out THROUGH the property name too, replacing
            // "import.meta.url" wholesale with the expression — never just
            // "import.meta", which would leave a stray ".url" appended after
            // the replacement expression.
            out += known[use.prop];
            last = use.propEnd;
        } else {
            throw new Error(
                `[knext compile] import.meta.${use.prop} cannot be compiled for --bytecode ` +
                    "(only a bare import.meta and .url/.filename/.dirname are rewritten; found " +
                    `${JSON.stringify(src.slice(use.start, use.propEnd))})`,
            );
        }
    }
    out += src.slice(last);
    // Fail closed: re-scan the OUTPUT, not just trust that every reported
    // `use` was handled above (it was) — this is the belt to that
    // suspenders' braces: whatever `findRealImportMeta` still finds here is,
    // BY DEFINITION, real `import.meta` syntax `--bytecode` cannot hold.
    const remaining = findRealImportMeta(out);
    if (remaining.length > 0) {
        const sample = out.slice(remaining[0].start, remaining[0].propEnd);
        throw new Error(
            `[knext compile] ${remaining.length} import.meta use(s) survived the rewrite ` +
                `(e.g. ${JSON.stringify(sample)}); --bytecode cannot compile them`,
        );
    }
    return { contents: out, rewritten: uses.length };
}
