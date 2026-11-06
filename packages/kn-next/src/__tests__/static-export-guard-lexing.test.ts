/**
 * The static-export guard reads next.config as TEXT, so how it strips comments
 * decides what it sees. It now shares the repo's one lexer, which is regex- and
 * template-aware; the older guard-local lexer was not, and a regex literal holding
 * a quote desynchronised it for the rest of the file, hiding a real
 * `output: 'export'` (a false negative on a guard whose job is to refuse it).
 */
import { describe, expect, it } from "bun:test";
import {
    classifyStaticExport,
    configuredDistDir,
    stripCommentsStringAware,
} from "../cli/static-export-guard";

describe("static-export-guard comment handling", () => {
    it("still sees `output: 'export'` after a regex literal that contains `//` on the same line", () => {
        const config =
            "const r = /^https?:\\/\\//; module.exports = { output: 'export' };\n";
        // The old guard-local lexer read the regex's `//` as a line comment and
        // dropped the rest of the line, so this classified as "none".
        expect(classifyStaticExport(config)).toBe("unconditional");
    });

    it("sees `output: 'export'` after a template literal that contains a comment opener", () => {
        const config =
            "const url = `https://example.com/x`;\nmodule.exports = { output: 'export' };\n";
        expect(classifyStaticExport(config)).toBe("unconditional");
    });

    it("ignores `output: 'export'` that only appears in a comment", () => {
        const config =
            "// output: 'export'\n/* output: 'export' */\nmodule.exports = {};\n";
        expect(classifyStaticExport(config)).toBe("none");
    });

    it("sees `output: 'export'` when a block comment sits between the key and the value", () => {
        const config = "module.exports = { output: /* static */ 'export' };\n";
        expect(classifyStaticExport(config)).toBe("unconditional");
    });

    it("keeps a `//` inside a string (a URL) instead of treating it as a comment", () => {
        const config =
            "module.exports = { distDir: 'build//out', output: 'export' };\n";
        expect(configuredDistDir(config)).toBe("build//out");
        expect(classifyStaticExport(config)).toBe("unconditional");
    });

    it("classifies an unconditional `output: 'export'` after a regex literal holding a quote as unconditional", () => {
        // The brace walk used to keep its own quote tracking, so the `'` inside
        // the regex opened a "string" that never closed and the real top-level
        // declaration was reported as the warn-only `conditional`.
        const config =
            "const q = /'/;\nmodule.exports = { output: 'export' };\n";
        expect(classifyStaticExport(config)).toBe("unconditional");
    });

    it("is not thrown off by quotes in strings, templates, regexes or comments before the declaration", () => {
        const config = [
            'const a = "it\'s";',
            "const b = `don't stop`;",
            "// it's a comment with a ' quote",
            'const c = /"/;',
            "module.exports = { output: 'export' };",
        ].join("\n");
        expect(classifyStaticExport(config)).toBe("unconditional");
    });

    it("still calls a declaration under a ternary conditional after a quote-holding regex", () => {
        const config =
            "const q = /'/;\nmodule.exports = { ...(process.env.X ? { output: 'export' } : {}) };\n";
        expect(classifyStaticExport(config)).toBe("conditional");
    });

    it("is not thrown off by brackets inside strings, templates or regexes before the declaration", () => {
        const config = [
            'const a = "{ [ (";',
            "const b = `} ] )`;",
            "const c = /[{(]/;",
            "module.exports = { output: 'export' };",
        ].join("\n");
        expect(classifyStaticExport(config)).toBe("unconditional");
    });

    it("calls the literal conditional when it only appears inside a string value", () => {
        const config =
            "module.exports = { note: \"output: 'export'\", reactStrictMode: true };\n";
        expect(classifyStaticExport(config)).toBe("conditional");
    });

    it("preserves offsets and newlines (same-width blanks, not removal)", () => {
        const src = "a /* x */ b // y\nc";
        const out = stripCommentsStringAware(src);
        expect(out.length).toBe(src.length);
        expect(out.indexOf("\n")).toBe(src.indexOf("\n"));
    });
});
