/**
 * The doctor 'use cache' check and the tracing-root reader both read next.config
 * as TEXT after stripping comments. They used to strip with regexes whose `//`
 * guards were heuristics, so a `//` inside a string was read as a comment and
 * deleted the code after it on the same line. They now share the repo's one
 * lexer, which is string-aware.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheComponentsCheck } from "../cli/doctor/checks/use-cache";
import type { CheckContext } from "../cli/doctor/types";
import { configuredTracingRoot } from "../cli/tracing-root";
import { enablesTurbopackModuleFragments } from "../cli/turbopack-fragments-guard";

const useCacheRows = (config: string) =>
    cacheComponentsCheck({
        deps: { readNextConfigFile: () => config },
    } as unknown as CheckContext);

describe("doctor use-cache check: comment stripping is string-aware", () => {
    it("sees `cacheComponents: true` after a string holding `//` on the same line", () => {
        // The old `(^|[^:])//.*$` regex took the `//` inside "//" (preceded by a
        // quote, not a colon) for a comment and deleted the rest of the line.
        expect(
            useCacheRows(
                'const s = "//"; export default { cacheComponents: true };',
            ),
        ).not.toEqual([]);
    });

    it("sees `cacheComponents: true` after a template literal holding `//` on the same line", () => {
        expect(
            useCacheRows(
                "const s = `//`; export default { cacheComponents: true };",
            ),
        ).not.toEqual([]);
    });

    it("does not read a commented-out flag as set", () => {
        expect(
            useCacheRows(
                "export default {\n  // cacheComponents: true,\n  /* cacheComponents: true */\n};",
            ),
        ).toEqual([]);
    });

    it("does not read a commented-out cacheHandlers as set (so the row stays a WARN)", () => {
        const rows = useCacheRows(
            "export default { cacheComponents: true, // cacheHandlers: {}\n};",
        );
        expect(rows.length).toBe(1);
        expect(rows[0].status).toBe("warn");
    });
});

describe("turbopack-fragments guard: comment stripping is string-aware", () => {
    it("sees the flag after a string holding `//`", () => {
        expect(
            enablesTurbopackModuleFragments(
                'const s = "//"; module.exports = { experimental: { turbopackModuleFragments: true } };',
            ),
        ).toBe(true);
    });

    it("ignores the flag when it is only commented out", () => {
        expect(
            enablesTurbopackModuleFragments(
                "// turbopackModuleFragments: true\nmodule.exports = {};",
            ),
        ).toBe(false);
    });
});

describe("tracing-root reader: comment stripping is string-aware", () => {
    const dirs: string[] = [];
    afterAll(() => {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });
    const app = (config: string) => {
        const dir = mkdtempSync(join(tmpdir(), "tracing-root-lex-"));
        dirs.push(dir);
        writeFileSync(join(dir, "next.config.js"), config);
        return dir;
    };

    it("sees outputFileTracingRoot after a string holding ` //` on the same line", () => {
        // The old `(^|\s)//.*$` regex took the ` //` inside the string for a comment.
        const dir = app(
            'const s = "a //b"; module.exports = { outputFileTracingRoot: "/abs/root" };\n',
        );
        expect(configuredTracingRoot(dir)).toEqual({
            root: "/abs/root",
            source: "next.config.js:outputFileTracingRoot",
        });
    });

    it("ignores a commented-out outputFileTracingRoot", () => {
        const dir = app(
            'module.exports = {\n  // outputFileTracingRoot: "/abs/root",\n};\n',
        );
        expect(configuredTracingRoot(dir)).toBeNull();
    });
});
