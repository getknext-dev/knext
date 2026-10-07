/**
 * The compiled entry's `import.meta.{url,filename,dirname}` rewrite (so
 * `--bytecode`'s CommonJS output can hold it) must touch CODE only. It used to
 * be a textual `replaceAll`, which also rewrote the text inside a string that
 * merely MENTIONS `import.meta.url` — e.g. an MDX docs page whose code sample
 * compiles to a JSX text child — and spliced `require("node:url")` into a
 * single- or double-quoted string, so the entry no longer parsed.
 *
 * `findImportMetaUses` (acorn, in asset-anchor-analyze.mjs) locates the code
 * uses; `rewriteImportMetaUses` (pure, in entry-asset-anchor.mjs) splices them.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findImportMetaUses } from "../adapters/asset-anchor-analyze.mjs";
import { rewriteImportMetaUses } from "../adapters/entry-asset-anchor.mjs";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const EXPRS = {
    url: '(require("node:url").pathToFileURL("/x/index.mjs").href)',
    filename: '("/x/index.mjs")',
    dirname: '("/x")',
};

const rewriteCode = (src: string) => {
    const found = findImportMetaUses(src);
    if (found.parseError !== undefined) throw new Error(found.parseError);
    return rewriteImportMetaUses(src, found.uses, EXPRS);
};

/** Whether `node --check` accepts `src` as an ES module. */
function nodeChecks(src: string): { ok: boolean; err: string } {
    const r = mkdtempSync(join(tmpdir(), "knext-x-import-meta-"));
    tempRoots.push(r);
    const file = join(r, "entry.mjs");
    writeFileSync(file, src);
    const res = spawnSync("node", ["--check", file], { encoding: "utf8" });
    return { ok: res.status === 0, err: res.stderr };
}

// The docs page's code sample, as MDX compiles it: JSX text children are
// plain string literals in the bundled entry (single- AND double-quoted).
const MDX_TEXT_DQ = `_jsx(_components.code, { children: "readFileSync(new URL('./data.wasm', import.meta.url))" })`;
const MDX_TEXT_SQ = `_jsx("span", { children: 'new URL("./x", import.meta.url) and import.meta.dirname' })`;

describe("findImportMetaUses — code positions only", () => {
    it("finds url / filename / dirname member uses, and a bare import.meta", () => {
        const src =
            "const a = import.meta.url; const b = import.meta.filename; const c = import.meta.dirname; const d = import.meta;";
        expect(findImportMetaUses(src).uses.map((u) => u.prop)).toEqual([
            "url",
            "filename",
            "dirname",
            null,
        ]);
    });

    it.each([
        ["a double-quoted string (MDX JSX text)", MDX_TEXT_DQ],
        ["a single-quoted string (MDX JSX text)", MDX_TEXT_SQ],
        ["a template literal's text", "const t = `see import.meta.url`;"],
        ["a line comment", "// import.meta.url\nconst x = 1;"],
        ["a block comment", "/* import.meta.filename */ const x = 1;"],
        ["a regex literal", "const re = /import.meta.url/;"],
    ])("sees none inside %s", (_name, src) => {
        expect(findImportMetaUses(src).uses).toEqual([]);
    });

    it("still sees one inside a template interpolation, and after a regex holding a quote", () => {
        const src = 'const re = /"/; const t = `${import.meta.url}`;';
        expect(findImportMetaUses(src).uses.map((u) => u.prop)).toEqual([
            "url",
        ]);
    });

    it("reports a parse error instead of guessing", () => {
        expect(
            typeof findImportMetaUses("const = import.meta.url").parseError,
        ).toBe("string");
    });
});

describe("rewriteImportMetaUses", () => {
    it("rewrites real uses and leaves an MDX string that mentions import.meta.url byte-for-byte", () => {
        const src = [
            "const here = import.meta.url;",
            `const page = ${MDX_TEXT_DQ};`,
            `const page2 = ${MDX_TEXT_SQ};`,
            "const dir = import.meta.dirname;",
        ].join("\n");
        const { contents, count, survived } = rewriteCode(src);
        expect(count).toBe(2);
        expect(survived).toEqual([]);
        expect(contents).toContain(MDX_TEXT_DQ);
        expect(contents).toContain(MDX_TEXT_SQ);
        expect(contents).toContain(`const here = ${EXPRS.url};`);
        expect(contents).toContain(`const dir = ${EXPRS.dirname};`);
        const check = nodeChecks(contents);
        expect(check.ok, check.err).toBe(true);
    });

    it("the old textual replaceAll breaks the same entry (the bug this replaces)", () => {
        const src = `const here = import.meta.url;\nconst page = ${MDX_TEXT_DQ};`;
        const textual = src.replaceAll("import.meta.url", EXPRS.url);
        expect(nodeChecks(textual).ok).toBe(false);
        expect(nodeChecks(rewriteCode(src).contents).ok).toBe(true);
    });

    it("reports a use it cannot rewrite (import.meta.resolve) as survived", () => {
        const { survived } = rewriteCode("import.meta.resolve('x');");
        expect(survived).toEqual(["import.meta.resolve"]);
    });

    it("rewrites a bare import.meta to an object literal carrying url/filename/dirname (#1877: rolldown's `var t = import.meta` getter shape)", () => {
        const src = "var t = import.meta; console.log(t.url, t.dirname);";
        const { contents, count, survived } = rewriteCode(src);
        expect(survived).toEqual([]);
        expect(count).toBe(1);
        expect(contents).not.toContain("import.meta");
        expect(contents).toContain(`url:${EXPRS.url}`);
        expect(contents).toContain(`filename:${EXPRS.filename}`);
        expect(contents).toContain(`dirname:${EXPRS.dirname}`);
        expect(nodeChecks(contents).ok).toBe(true);
    });
});
