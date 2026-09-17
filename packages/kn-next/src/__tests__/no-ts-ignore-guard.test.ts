/**
 * no-ts-ignore-guard — ban the bare ts-ignore suppression directive (#1053).
 *
 * TypeScript has two suppression comments. The bare "ignore" form silences the
 * next line PERMANENTLY — it keeps passing even after the underlying error is
 * fixed, so it can later hide a *real* error. The "expect-error" form silences
 * the line but FAILS the build if that line stops erroring, so it self-cleans.
 *
 * The guard is Biome's `suspicious/noTsIgnore` rule, pinned to "error" in
 * biome.json so `biome check .` (the `lint`/`ci` scripts) REDS on any bare
 * directive. It shipped at Biome's default warning severity via `recommended`,
 * which biome check does NOT fail on — so before this change a re-introduced
 * directive passed CI. This spec pins BOTH the config (durable regression guard)
 * and Biome's real behaviour on synthetic inputs, and proves the fixtures/.next
 * exclusion the vendored Next.js corpus needs.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// repo root: packages/kn-next/src/__tests__ -> up 4
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const BIOME_JSON = join(REPO_ROOT, "biome.json");
// The banned directive token, assembled so this test's OWN source never carries
// the literal in a comment (Biome would then flag this very file).
const IGNORE = `@ts-${"ignore"}`;
const EXPECT = `@ts-${"expect-error"}`;

/**
 * Run `biome lint <file>`; return exit code + combined output.
 * NOTE: biome exits non-zero with "no files processed" when a path is ignored
 * (e.g. the `.js.txt` fixture), which is NOT a lint failure — so exclusion tests
 * assert on the ABSENCE of the noTsIgnore diagnostic, not on exit code.
 */
function biomeLint(file: string): { code: number; out: string } {
    try {
        const out = execFileSync("bunx", ["biome", "lint", file], {
            cwd: REPO_ROOT,
            encoding: "utf8",
        });
        return { code: 0, out };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return {
            code: e.status ?? 1,
            out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
        };
    }
}

/**
 * Write a file with the given body somewhere Biome's REPO config applies (under
 * the repo tree, not a leading-dot dir which Biome ignores). Returns path +
 * cleanup.
 */
function withRepoTempFile(
    relDir: string,
    name: string,
    body: string,
): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(REPO_ROOT, relDir, "no-ts-ignore-"));
    const path = join(dir, name);
    writeFileSync(path, body);
    return {
        path,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

describe("ban bare ts-ignore directive (#1053)", () => {
    it("pins Biome's noTsIgnore rule to 'error' in biome.json", () => {
        const cfg = JSON.parse(readFileSync(BIOME_JSON, "utf8"));
        expect(cfg.linter.rules.suspicious.noTsIgnore).toBe("error");
    });

    it("excludes fixtures + .next from the rule (vendored corpus carries the string)", () => {
        const cfg = JSON.parse(readFileSync(BIOME_JSON, "utf8"));
        const override = (cfg.overrides ?? []).find(
            (o: {
                linter?: { rules?: { suspicious?: { noTsIgnore?: string } } };
            }) => o.linter?.rules?.suspicious?.noTsIgnore === "off",
        );
        expect(
            override,
            "an override turning noTsIgnore off must exist",
        ).toBeDefined();
        expect(override.includes).toContain("**/fixtures/**");
        expect(override.includes).toContain("**/.next/**");
    });

    it("REDS `biome lint` on a bare ts-ignore directive in tracked-shaped source", () => {
        const { path, cleanup } = withRepoTempFile(
            "packages/kn-next/src",
            "probe.ts",
            `// ${IGNORE}\nexport const x = someMaybeErroringCall();\n`,
        );
        try {
            const { code, out } = biomeLint(path);
            expect(out).toContain("noTsIgnore");
            expect(code).not.toBe(0);
        } finally {
            cleanup();
        }
    });

    it("does NOT red on the self-cleaning expect-error directive", () => {
        const { path, cleanup } = withRepoTempFile(
            "packages/kn-next/src",
            "probe.ts",
            `// ${EXPECT} self-cleaning\nexport const y = someMaybeErroringCall();\n`,
        );
        try {
            const { code, out } = biomeLint(path);
            expect(out).not.toContain("noTsIgnore");
            expect(code).toBe(0);
        } finally {
            cleanup();
        }
    });

    it("does NOT flag a fixtures/ file carrying the directive (override)", () => {
        const { path, cleanup } = withRepoTempFile(
            "packages/kn-next/src/__tests__/fixtures",
            "vendored.ts",
            `// ${IGNORE} the timeouts have weird types in the edge runtime\nexport const z = 1;\n`,
        );
        try {
            expect(biomeLint(path).out).not.toContain("noTsIgnore");
        } finally {
            cleanup();
        }
    });

    it("does NOT flag the real vendored next-16.2.0 fixture (which carries the directive)", () => {
        const real = join(
            REPO_ROOT,
            "packages",
            "kn-next",
            "src",
            "__tests__",
            "fixtures",
            "next-16.2.0-sandbox-context.js.txt",
        );
        expect(biomeLint(real).out).not.toContain("noTsIgnore");
    });
});
