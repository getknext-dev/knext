/**
 * 1.0 contract: experimental surfaces carved out of the semver commitment.
 *
 * `docs/PUBLIC_API.md` and the CLI reference commit the public TypeScript
 * surface, the config schema and the CLI verbs at 1.0 — but a handful of
 * surfaces are not ready for that promise: the `selfContained` build option
 * and the `preview`/`loadtest` directly-runnable CLI entries. Each of those
 * carries a visible marker (`@experimental` in its types, "Experimental" in
 * CLI help, "(experimental)" in the docs) precisely so a reviewer removing
 * the surface's caveat trips a test, not a silent regression.
 *
 * Every assertion below anchors on a UNIQUE string in its source file so a
 * mutation that deletes the marker (and nothing else) reds exactly one
 * assertion — never a marker that could be satisfied by unrelated text
 * elsewhere in the file.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_ONLY_VERBS } from "../cli/help";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePkgDir = resolve(__dirname, "../..");
const repoRoot = resolve(corePkgDir, "../..");

function read(relPath: string): string {
    return readFileSync(resolve(repoRoot, relPath), "utf8");
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe("1.0 contract: experimental surface markers", () => {
    describe("selfContained config key", () => {
        const configSrc = read("packages/kn-next/src/config.ts");

        it("is tagged @experimental in its JSDoc, exactly once", () => {
            // Anchor on the doc comment immediately preceding the field so a
            // marker on some unrelated symbol cannot satisfy this.
            const match = configSrc.match(
                /\/\*\*([\s\S]*?)\*\/\s*selfContained\?:\s*boolean;/,
            );
            expect(
                match,
                "selfContained?: boolean must be preceded by a doc comment",
            ).not.toBeNull();
            const doc = match?.[1] ?? "";
            expect(
                doc.includes("@experimental"),
                "selfContained's doc comment must carry @experimental",
            ).toBe(true);
        });
    });

    describe("compile config key (opt-in patched Bun toolchain)", () => {
        const configSrc = read("packages/kn-next/src/config.ts");

        it("is tagged @experimental in its JSDoc, and listed in PUBLIC_API.md", () => {
            const match = configSrc.match(
                /\/\*\*([\s\S]*?)\*\/\s*compile\?:\s*CompileConfig;/,
            );
            expect(
                match,
                "compile?: CompileConfig must be preceded by a doc comment",
            ).not.toBeNull();
            expect((match?.[1] ?? "").includes("@experimental")).toBe(true);
            expect(
                occurrences(
                    read("docs/PUBLIC_API.md"),
                    "- **`compile` (`knext.config.ts`)**",
                ),
            ).toBe(1);
        });
    });

    describe("--self-contained CLI flag", () => {
        const buildSrc = read("packages/kn-next/src/cli/build.ts");

        it("is documented as Experimental in BUILD_HELP, exactly once", () => {
            const helpMatch = buildSrc.match(
                /export const BUILD_HELP = `([\s\S]*?)`;/,
            );
            expect(helpMatch, "BUILD_HELP must exist").not.toBeNull();
            const help = helpMatch?.[1] ?? "";
            expect(help.includes("--self-contained")).toBe(true);
            expect(
                occurrences(help, "Experimental"),
                "--self-contained's help text must say Experimental exactly once",
            ).toBe(1);
        });
    });

    describe("preview and loadtest directly-runnable entries", () => {
        it("are the exact internal-only verb set (single source of truth)", () => {
            // help.ts already excludes these from --help; the experimental
            // carve-out must track the SAME list, not a second hand-typed one.
            expect([...INTERNAL_ONLY_VERBS].sort()).toEqual([
                "loadtest",
                "preview",
            ]);
        });

        it("preview.ts's module doc states it is experimental", () => {
            const src = read("packages/kn-next/src/cli/preview.ts");
            expect(
                /@experimental/.test(src.slice(0, 2000)),
                "preview.ts's header doc comment must carry @experimental",
            ).toBe(true);
        });

        it("loadtest.ts's module doc states it is experimental", () => {
            const src = read("packages/kn-next/src/cli/loadtest.ts");
            expect(
                /@experimental/.test(src.slice(0, 2000)),
                "loadtest.ts's header doc comment must carry @experimental",
            ).toBe(true);
        });

        it("the CLI reference marks both entries (experimental)", () => {
            const cliDoc = read("apps/docs/content/docs/cli.mdx");
            const section = cliDoc.slice(
                cliDoc.indexOf("## Directly runnable entries"),
                cliDoc.indexOf("## Related"),
            );
            expect(section.length).toBeGreaterThan(0);
            expect(
                occurrences(section, "(experimental)"),
                "preview and loadtest must each carry an (experimental) marker in cli.mdx",
            ).toBeGreaterThanOrEqual(2);
        });
    });

    describe("docs/PUBLIC_API.md carve-out", () => {
        const doc = read("docs/PUBLIC_API.md");

        it("has a dedicated Experimental surfaces section", () => {
            expect(doc).toMatch(/^##\s+Experimental surfaces/m);
        });

        it("names every experimental surface", () => {
            const section = doc.slice(
                doc.search(/^##\s+Experimental surfaces/m),
            );
            expect(section.includes("selfContained")).toBe(true);
            expect(section.includes("--self-contained")).toBe(true);
            expect(section.includes("preview")).toBe(true);
            expect(section.includes("loadtest")).toBe(true);
        });

        it("states the may-change-in-a-minor-release policy", () => {
            const section = doc.slice(
                doc.search(/^##\s+Experimental surfaces/m),
            );
            expect(section.toLowerCase()).toContain("minor release");
        });

        it("stays user-facing (no ADR/issue numbers, no internal jargon)", () => {
            expect(doc).not.toMatch(/ADR-\d{4}/);
            expect(doc).not.toMatch(/\bPK\d\b/);
            expect(doc).not.toMatch(/#\d{2,}/);
        });
    });
});
