/**
 * Contract tests (v3-P6a) for the `kn-next loadtest` CLI wrapper.
 *
 * Two guarantees:
 *  1. The entrypoint guard uses the SHARED `isEntrypoint(import.meta.url)` helper
 *     (from ./exec) — not a hand-rolled `import.meta.url === file://...` /
 *     `endsWith("loadtest.js")` check.
 *  2. Silent-exit-0 contract: an error/empty argv path must NOT return exit 0,
 *     and it must print a short hint to STDERR first (stderr-hint = YES). A
 *     command that exits without output reads as false success.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runLoadTestCli } from "../cli/loadtest";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOADTEST_SRC = resolve(HERE, "../cli/loadtest.ts");

describe("loadtest entrypoint normalization", () => {
    it("uses the shared isEntrypoint helper, not a hand-rolled check", () => {
        const src = readFileSync(LOADTEST_SRC, "utf-8");
        expect(src).toContain("isEntrypoint(import.meta.url)");
        // Must import it from the shared exec module.
        expect(src).toMatch(
            /import\s*\{[^}]*isEntrypoint[^}]*\}\s*from\s*["']\.\/exec["']/,
        );
        // Hand-rolled forms must be gone. (Substrings chosen to avoid embedding
        // a `${...}` placeholder in this source — biome noTemplateCurlyInString.)
        expect(src).not.toContain("file://");
        expect(src).not.toContain('endsWith("loadtest.js")');
        expect(src).not.toContain("import.meta.main");
        expect(src).not.toContain("require.main");
    });
});

describe("loadtest silent-exit-0 / stderr-hint contract", () => {
    it("missing --url: exits non-zero AND prints a hint to stderr first", async () => {
        const stderr: string[] = [];
        const code = await runLoadTestCli([], {
            stderr: (s) => stderr.push(s),
        });
        expect(code).not.toBe(0);
        const out = stderr.join("");
        expect(out.trim().length).toBeGreaterThan(0);
        expect(out).toMatch(/--url/);
    });

    it("invalid --type: exits non-zero AND prints a hint to stderr first", async () => {
        const stderr: string[] = [];
        const code = await runLoadTestCli(
            ["--url", "https://app.example.com", "--type", "bogus"],
            {
                stderr: (s) => stderr.push(s),
            },
        );
        expect(code).not.toBe(0);
        const out = stderr.join("");
        expect(out.trim().length).toBeGreaterThan(0);
        expect(out).toMatch(/--type/);
    });

    it("never returns exit 0 on an error path without having written to stderr", async () => {
        // Drive every early-exit branch; each must be (code !== 0) with output.
        const cases: string[][] = [
            [],
            ["--url", "https://app.example.com", "--type", "nope"],
        ];
        for (const argv of cases) {
            const stderr: string[] = [];
            const code = await runLoadTestCli(argv, {
                stderr: (s) => stderr.push(s),
            });
            const wroteSomething = stderr.join("").trim().length > 0;
            // Contract: a silent exit-0 (no output) is forbidden on error paths.
            expect(code === 0 && !wroteSomething).toBe(false);
        }
    });
});
