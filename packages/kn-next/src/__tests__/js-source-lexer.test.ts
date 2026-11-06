/**
 * Golden vectors for the ONE comment/string lexer the repo's source-text guards share.
 *
 * Before this module existed, six guards each carried their own lexer and they
 * disagreed on what a template body, an escaped quote, or a comment gap looks like.
 * These vectors pin both policies, `keep-strings` (default) and `blank-strings`
 * (`blankStrings: true`), plus the regex-body option, so a guard that looks for a
 * token inside string content no longer depends on which lexer it happened to copy.
 */
import { describe, expect, it } from "bun:test";
import { stripComments } from "../adapters/js-source-lexer.mjs";

const sp = (n: number) => " ".repeat(n);

describe("js-source-lexer: keep-strings (default)", () => {
    it("drops a line comment but keeps a template body that contains `//`", () => {
        const src = "const t = `a // b`; // c";
        expect(stripComments(src)).toBe(`const t = \`a // b\`; ${sp(4)}`);
    });

    it("keeps a string with an escaped quote and drops the trailing comment", () => {
        const src = "s = 'it\\'s // no' // yes";
        expect(stripComments(src)).toBe(`s = 'it\\'s // no' ${sp(6)}`);
    });

    it("blanks a block comment to the same width (offsets are preserved)", () => {
        const src = "x = 1 /* a */ y = 2";
        expect(stripComments(src)).toBe(`x = 1 ${sp(7)} y = 2`);
    });

    it("keeps newlines inside a multi-line block comment", () => {
        const src = "a /* l1\nl2 */ b";
        expect(stripComments(src)).toBe(`a ${sp(5)}\n${sp(5)} b`);
    });

    it("does not read comment openers inside strings as comments", () => {
        expect(stripComments(`a = '/*'; b = "//"; c = 1`)).toBe(
            `a = '/*'; b = "//"; c = 1`,
        );
    });

    it("does not read a regex literal containing `//` as a line comment", () => {
        const src = "const r = /^https?:\\/\\//; call(); // tail";
        expect(stripComments(src)).toBe(
            `const r = /^https?:\\/\\//; call(); ${sp(7)}`,
        );
    });

    it("treats `/` after an identifier as division, not a regex", () => {
        const src = "x = a / b / c; // d";
        expect(stripComments(src)).toBe(`x = a / b / c; ${sp(4)}`);
    });

    it("keeps a real import that follows a leading block comment", () => {
        const src = "/* c */ import './x.mjs';";
        expect(stripComments(src)).toBe(`${sp(7)} import './x.mjs';`);
    });

    it("strips a comment inside a template `${}` expression and keeps the rest", () => {
        const src = "t = `x ${ f('// y') /* z */ } w`;";
        expect(stripComments(src)).toBe(
            `t = \`x \${ f('// y') ${sp(7)} } w\`;`,
        );
    });

    it("does not end a template at an escaped backtick", () => {
        const src = "t = `a \\` // b`; // c";
        expect(stripComments(src)).toBe(`t = \`a \\\` // b\`; ${sp(4)}`);
    });

    it("handles templates nested in `${}`", () => {
        const src = "t = `a ${ `b ${ c } // d` } e`; // f";
        expect(stripComments(src)).toBe(
            `t = \`a \${ \`b \${ c } // d\` } e\`; ${sp(4)}`,
        );
    });

    it("ends an unterminated string at the newline (fail toward scanning more code)", () => {
        const src = "a = 'oops\nb = 2 // c";
        expect(stripComments(src)).toBe(`a = 'oops\nb = 2 ${sp(4)}`);
    });

    it("is length- and newline-preserving on every vector", () => {
        for (const src of [
            "const t = `a // b`; // c",
            "x = 1 /* a */ y = 2",
            "a /* l1\nl2 */ b",
            "t = `a ${ `b ${ c } // d` } e`; // f",
        ]) {
            for (const opts of [
                {},
                { blankStrings: true },
                { blankStrings: true, blankRegex: true },
            ]) {
                const out = stripComments(src, opts);
                expect(out.length).toBe(src.length);
                expect([...out].map((c) => c === "\n")).toEqual(
                    [...src].map((c) => c === "\n"),
                );
            }
        }
    });
});

describe("js-source-lexer: blank-strings", () => {
    const opts = { blankStrings: true };

    it("blanks a template body and drops the comment", () => {
        const src = "const t = `a // b`; // c";
        expect(stripComments(src, opts)).toBe(
            `const t = \`${sp(6)}\`; ${sp(4)}`,
        );
    });

    it("blanks a string with an escaped quote", () => {
        const src = "s = 'it\\'s // no' // yes";
        expect(stripComments(src, opts)).toBe(`s = '${sp(11)}' ${sp(6)}`);
    });

    it("blanks a call named inside a message but keeps real code", () => {
        const src = "run('spawnSync(x) failed'); spawnSync(y);";
        expect(stripComments(src, opts)).toBe(
            `run('${sp("spawnSync(x) failed".length)}'); spawnSync(y);`,
        );
    });

    it("keeps code inside a template `${}` but blanks the surrounding text and inner strings", () => {
        const src = "t = `x ${ f('// y') } w`;";
        expect(stripComments(src, opts)).toBe(
            `t = \`${sp(2)}\${ f('${sp(4)}') }${sp(2)}\`;`,
        );
    });

    it("leaves a regex body visible by default", () => {
        const src = "r = /require\\(/; // c";
        expect(stripComments(src, opts)).toBe(`r = /require\\(/; ${sp(4)}`);
    });
});

describe("js-source-lexer: blank-strings + blankRegex", () => {
    const opts = { blankStrings: true, blankRegex: true };

    it("blanks a regex body, keeping delimiters and flags", () => {
        const src = "r = /require\\(/gi; // c";
        expect(stripComments(src, opts)).toBe(`r = /${sp(9)}/gi; ${sp(4)}`);
    });

    it("blanks a regex with a character class containing `/`", () => {
        const src = "r = /[/]x/; y();";
        expect(stripComments(src, opts)).toBe(`r = /${sp(4)}/; y();`);
    });
});

describe("js-source-lexer: postfix/prefix increment vs regex", () => {
    it("treats `/` after postfix ++ as division, so the trailing comment is dropped", () => {
        const src = "let n = i++ / 2; // cacheComponents: true";
        expect(stripComments(src)).toBe(`let n = i++ / 2; ${sp(24)}`);
    });

    it("treats `/` after postfix -- as division", () => {
        const src = "let n = i-- / 2; // c: 1";
        expect(stripComments(src)).toBe(`let n = i-- / 2; ${sp(7)}`);
    });

    it("still lexes a regex after a prefix ++", () => {
        const src = "x = ++i; r = ++/a\\/\\/b/.x; // c";
        expect(stripComments(src)).toBe(
            `x = ++i; r = ++/a\\/\\/b/.x; ${sp(4)}`,
        );
    });

    it("still lexes a regex after a prefix unary minus", () => {
        const src = "x = -/re\\//.source; // c";
        expect(stripComments(src)).toBe(`x = -/re\\//.source; ${sp(4)}`);
    });

    it("lexes `/` after `a + +b` operand pair correctly (prefix after binary op)", () => {
        const src = "x = a + ++b / 2; // c";
        expect(stripComments(src)).toBe(`x = a + ++b / 2; ${sp(4)}`);
    });
});
