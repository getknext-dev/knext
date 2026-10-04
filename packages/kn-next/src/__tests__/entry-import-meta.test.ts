/**
 * `--bytecode` cannot compile `import.meta` (CommonJS target), so
 * `vinext-compile.mjs` rewrites it to runtime expressions anchored on the
 * executable's own path. The naive version of that rewrite (three
 * `String.prototype.replaceAll` calls plus a `/import\.meta/.test()` sanity
 * check on the raw TEXT) cannot tell a real `import.meta` apart from a STRING
 * LITERAL that merely spells the words "import.meta" — which is exactly what
 * broke cluster C4b (the `twoslash` fixture).
 *
 * Root cause, measured against the REAL published packages (npm `typescript`
 * 5.9.3, the exact version `twoslash` pulls transitively): `typescript`'s own
 * compiler ships diagnostic MESSAGE TEXT that names the language feature
 * verbatim —
 *   - "The 'import.meta' meta-property is only allowed when the '--module'
 *     option is …" (TS1343)
 *   - "The 'import.meta' meta-property is not allowed in files which will
 *     build into CommonJS output." (TS1470)
 *   - one more inside an option-description string
 * — three string-literal occurrences of the text "import.meta", with ZERO
 * real `import.meta` syntax among them. #3424's regression (bundling
 * `serverExternalPackages` like `typescript` into the Nitro RSC entry instead
 * of leaving them external) puts that text directly into the compiled entry,
 * and the naive scan's "did anything survive" check counted exactly those
 * three as unrewritten `import.meta` uses and aborted a compile that had
 * nothing real left to rewrite — see entry-import-meta-typescript.test.ts for
 * the end-to-end proof against the real package via the real bundler.
 */
import { describe, expect, it } from "bun:test";
import {
    findRealImportMeta,
    rewriteImportMeta,
} from "../adapters/entry-import-meta.mjs";

const EXPRS = {
    entryUrlExpr: "__URL__",
    entryFileExpr: "__FILE__",
    entryDirExpr: "__DIR__",
};

describe("findRealImportMeta (unit)", () => {
    it("finds a bare import.meta and each known property", () => {
        const src =
            "const a=import.meta;const b=import.meta.url;const c=import.meta.filename;const d=import.meta.dirname;";
        const uses = findRealImportMeta(src);
        expect(uses.map((u) => u.prop)).toEqual([
            null,
            "url",
            "filename",
            "dirname",
        ]);
    });

    it("finds an unrecognized property (e.g. .resolve) as prop, not swallowed", () => {
        const uses = findRealImportMeta("import.meta.resolve('x')");
        expect(uses).toHaveLength(1);
        expect(uses[0].prop).toBe("resolve");
    });

    it("never matches inside a double-quoted string literal (the exact C4b false positive)", () => {
        const src =
            "const msg = \"The 'import.meta' meta-property is only allowed when the '--module' option is …\";";
        expect(findRealImportMeta(src)).toHaveLength(0);
    });

    it("never matches inside a single-quoted string literal", () => {
        expect(
            findRealImportMeta(
                "const msg = 'uses import.meta.url internally';",
            ),
        ).toHaveLength(0);
    });

    it("never matches inside a template literal with no substitution", () => {
        expect(
            findRealImportMeta(
                "const msg = `import.meta is not allowed here`;",
            ),
        ).toHaveLength(0);
    });

    it("never matches inside a line comment", () => {
        expect(
            findRealImportMeta(
                "// this module reads import.meta.url\nconst x = 1;",
            ),
        ).toHaveLength(0);
    });

    it("never matches inside a block comment", () => {
        expect(
            findRealImportMeta(
                "/* import.meta.url is read here */\nconst x = 1;",
            ),
        ).toHaveLength(0);
    });

    it("DOES match real code that follows a string containing the false-positive text (discrimination)", () => {
        const src = 'const msg = "import.meta";\nconst u = import.meta.url;';
        const uses = findRealImportMeta(src);
        expect(uses).toHaveLength(1);
        expect(uses[0].prop).toBe("url");
    });

    it("matches real code INSIDE a template literal's substitution (code, not string text)", () => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal JS source under test, not a template
        const src = "const x = `value: ${import.meta.url}`;";
        const uses = findRealImportMeta(src);
        expect(uses).toHaveLength(1);
        expect(uses[0].prop).toBe("url");
    });

    it("restores the ENCLOSING template's own quote after a substitution that opens a real string (round-2 review, #1877)", () => {
        // Real typescript source: `` `False expression: ${message}` `` closes
        // fine, but the PREVIOUS statement's pattern — a substitution whose
        // expression itself contains a string literal, `` `${message ||
        // "Unexpected node."}…` `` — overwrites the single shared `quote`
        // variable with `"` while inside the substitution. Without restoring
        // it on exit, the OUTER template then waits for ANOTHER `"` instead
        // of its own backtick, silently swallowing everything after it,
        // including a real import.meta.
        const src =
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal JS source under test, not a template
            'const m = `${a || "fallback"}after`; const u = import.meta.url;';
        const uses = findRealImportMeta(src);
        expect(uses).toHaveLength(1);
        expect(uses[0].prop).toBe("url");
    });

    it("does not resume template mode too early on a nested object literal inside a substitution", () => {
        // `{a:1}` inside the substitution must not be mistaken for the
        // substitution's own closing brace.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal JS source under test, not a template
        const src = "const x = `v: ${ (() => ({ a: import.meta.url }))() }`;";
        const uses = findRealImportMeta(src);
        expect(uses).toHaveLength(1);
        expect(uses[0].prop).toBe("url");
    });

    it("handles a nested template literal inside a substitution", () => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal JS source under test, not a template
        const src = "const x = `outer ${`inner ${import.meta.url}`}`;";
        const uses = findRealImportMeta(src);
        expect(uses).toHaveLength(1);
        expect(uses[0].prop).toBe("url");
    });

    it("does not match import.meta as part of a longer identifier", () => {
        expect(
            findRealImportMeta(
                "const notImportmeta = 1; const x = importMetaFoo;",
            ),
        ).toHaveLength(0);
    });

    it("respects escaped quotes inside a string (does not end it early)", () => {
        const src =
            'const s = "a \\" import.meta \\" b"; const u = import.meta.url;';
        const uses = findRealImportMeta(src);
        expect(uses).toHaveLength(1);
        expect(uses[0].prop).toBe("url");
    });

    describe("regex literals are lexed, not mistaken for strings (round-2 review, #1877)", () => {
        it("a quote INSIDE a regex character class does not open a fake string (the exact file-manager false positive: /[!'()*]/)", () => {
            const src =
                "const f = (s) => s.replace(/[!'()*]/g, enc); const u = import.meta.url;";
            const uses = findRealImportMeta(src);
            expect(uses).toHaveLength(1);
            expect(uses[0].prop).toBe("url");
        });

        it("a double quote inside a regex character class does not open a fake string", () => {
            const src =
                'const f = (s) => s.replace(/["]/g, enc); const u = import.meta.url;';
            const uses = findRealImportMeta(src);
            expect(uses).toHaveLength(1);
            expect(uses[0].prop).toBe("url");
        });

        it("a `/` inside a regex character class does not end the regex early", () => {
            const src =
                "const f = (s) => s.replace(/[/]/g, enc); const u = import.meta.url;";
            const uses = findRealImportMeta(src);
            expect(uses).toHaveLength(1);
            expect(uses[0].prop).toBe("url");
        });

        it("a `/` AND a quote together inside a character class do not desync the scanner (mutation-kills a skip-tracking regression the lone-quote and lone-slash cases above cannot)", () => {
            // Mutation-proof target: if character-class tracking is disabled,
            // the internal "/" ends the "regex" early, and the quote right
            // after it (now outside what was treated as the regex) opens a
            // REAL fake string that swallows everything after it — including
            // the import.meta probe. Neither the lone-quote test (no "/"
            // inside its class) nor the lone-"/" test (no quote after the
            // class, so nothing left to desync) can detect that regression on
            // its own; this one needs both in the same character class.
            const src =
                "const f = (s) => s.replace(/[/']/g, enc); const u = import.meta.url;";
            const uses = findRealImportMeta(src);
            expect(uses).toHaveLength(1);
            expect(uses[0].prop).toBe("url");
        });

        it("a division expression does not get mistaken for a regex literal", () => {
            // `a / b` after a value — division, not a regex; must not swallow
            // anything that follows it.
            const src = "const x = a / b; const u = import.meta.url;";
            const uses = findRealImportMeta(src);
            expect(uses).toHaveLength(1);
            expect(uses[0].prop).toBe("url");
        });

        it("a regex literal right after a value-producing `)` is division, not a regex (no false regex-skip)", () => {
            const src = "const x = foo() / 2; const u = import.meta.url;";
            const uses = findRealImportMeta(src);
            expect(uses).toHaveLength(1);
            expect(uses[0].prop).toBe("url");
        });

        it("a regex literal is correctly recognized after keywords that allow one (return/typeof/case)", () => {
            for (const src of [
                "function f(){return /x/.test(import.meta.url)}",
                "const t = typeof /x/;const u=import.meta.url;",
                "switch(x){case /y/.test(z):break}const u=import.meta.url;",
            ]) {
                const uses = findRealImportMeta(src);
                expect(uses.some((u) => u.prop === "url")).toBe(true);
            }
        });

        it("an escaped slash inside a regex does not end it early", () => {
            const src =
                "const f = (s) => s.replace(/a\\/b/g, enc); const u = import.meta.url;";
            const uses = findRealImportMeta(src);
            expect(uses).toHaveLength(1);
            expect(uses[0].prop).toBe("url");
        });

        it("throws, never guesses, when a `/` is ambiguous (the previous token is a bare `}`)", () => {
            // A `}` can end either a block statement (regex-ok next) or an
            // object/arrow-body expression (division next) — a token-level
            // heuristic cannot tell them apart.
            expect(() =>
                findRealImportMeta("x={}/y/;const u=import.meta.url;"),
            ).toThrow(/cannot tell whether/);
        });

        it("throws, never guesses, when a presumed regex literal cannot be closed before a newline", () => {
            const src =
                "const x = a.b(\n  /unterminated\n);\nconst u = import.meta.url;";
            expect(() => findRealImportMeta(src)).toThrow(/no closing/);
        });
    });
});

describe("rewriteImportMeta (unit)", () => {
    it("rewrites .url/.filename/.dirname to exactly the given expression (no trailing property text survives)", () => {
        const { contents, rewritten } = rewriteImportMeta(
            "a(import.meta.url);b(import.meta.filename);c(import.meta.dirname);",
            EXPRS,
        );
        expect(rewritten).toBe(3);
        expect(contents).toBe("a(__URL__);b(__FILE__);c(__DIR__);");
    });

    it("rewrites a bare import.meta to an object literal carrying url/filename/dirname", () => {
        const { contents, rewritten } = rewriteImportMeta(
            "typeof import.meta !== 'undefined'",
            EXPRS,
        );
        expect(rewritten).toBe(1);
        expect(contents).toBe(
            "typeof ({url:__URL__,filename:__FILE__,dirname:__DIR__}) !== 'undefined'",
        );
    });

    it("throws a build error naming an unrecognized property, never silently rewriting it (round-2 review, #1877)", () => {
        // import.meta.main / import.meta.env.MODE would otherwise silently
        // become undefined (or throw at runtime on an untested request path)
        // instead of a loud build-time failure.
        expect(() =>
            rewriteImportMeta("import.meta.resolve('x')", EXPRS),
        ).toThrow(/import\.meta\.resolve cannot be compiled/);
        expect(() => rewriteImportMeta("import.meta.main", EXPRS)).toThrow(
            /import\.meta\.main cannot be compiled/,
        );
        expect(() => rewriteImportMeta("import.meta.env.MODE", EXPRS)).toThrow(
            /import\.meta\.env cannot be compiled/,
        );
    });

    it("leaves a string-literal false positive untouched (cluster C4b)", () => {
        const src =
            "const msg = \"The 'import.meta' meta-property is only allowed\";";
        const { contents, rewritten } = rewriteImportMeta(src, EXPRS);
        expect(rewritten).toBe(0);
        expect(contents).toBe(src);
    });

    it("rewrites real code while leaving an adjacent string-literal false positive untouched", () => {
        const src =
            'const msg = "uses import.meta internally"; const u = import.meta.url;';
        const { contents, rewritten } = rewriteImportMeta(src, EXPRS);
        expect(rewritten).toBe(1);
        expect(contents).toBe(
            'const msg = "uses import.meta internally"; const u = __URL__;',
        );
    });

    it("is a no-op (no allocation surprises) when nothing real is present", () => {
        const src = 'const msg = "import.meta, import.meta, import.meta";';
        const { contents, rewritten } = rewriteImportMeta(src, EXPRS);
        expect(rewritten).toBe(0);
        expect(contents).toBe(src);
    });

    it("handles several real uses in one source, back to back, correctly", () => {
        const src =
            "import.meta.url+import.meta.filename+import.meta+import.meta.dirname";
        const { contents, rewritten } = rewriteImportMeta(src, EXPRS);
        expect(rewritten).toBe(4);
        expect(contents).toBe(
            "__URL__+__FILE__+({url:__URL__,filename:__FILE__,dirname:__DIR__})+__DIR__",
        );
    });

    it("fails closed: re-scans the OUTPUT and aborts if a real import.meta still remains there (round-2 review, #1877)", () => {
        // A deliberately bad `exprs` value simulates whatever the real lexer
        // missing something would look like: the rewrite "succeeds" by its
        // own bookkeeping (one use found, one substituted), but the SUBSTITUTED
        // text itself still contains a real import.meta. The post-rewrite
        // re-scan is what catches this rather than shipping it to Bun's
        // bytecode compiler silently.
        const badExprs = {
            entryUrlExpr: "import.meta.url",
            entryFileExpr: "__FILE__",
            entryDirExpr: "__DIR__",
        };
        expect(() =>
            rewriteImportMeta("const u = import.meta.url;", badExprs),
        ).toThrow(/survived the rewrite/);
    });
});
