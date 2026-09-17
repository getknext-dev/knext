/**
 * no-ts-ignore-guard — ban the bare ts-ignore suppression directive (#1053).
 *
 * TypeScript has two suppression comments. The bare ignore form silences the
 * next line PERMANENTLY — it keeps passing even after the underlying error is
 * fixed, so it can later hide a *real* error. The expect-error form silences the
 * line but FAILS the build if that line stops erroring, so it self-cleans.
 *
 * The guard is Biome's `suspicious/noTsIgnore` rule, pinned to "error" in
 * biome.json so `biome check .` (the `lint`/`ci` scripts) REDS on any bare
 * directive. It shipped at Biome's default *warning* severity via `recommended`,
 * which `biome check` does NOT fail on — so before this change a re-introduced
 * directive passed CI. This spec pins BOTH the config (durable regression guard)
 * and Biome's real behaviour on synthetic inputs, and proves the fixtures/.next
 * exclusion the vendored Next.js corpus needs.
 *
 * All synthetic inputs are written under `tmpdir()` (never the checkout, #880/
 * #918) and removed in a `finally`. Biome is pointed at the repo's root config
 * with `--config-path` so the pinned severity applies to a tmpdir file.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// repo root: packages/kn-next/src/__tests__ -> up 4
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const ROOT_BIOME = join(REPO_ROOT, "biome.json");
const NESTED_BIOME = join(REPO_ROOT, "packages", "kn-next", "biome.json");
// The banned/safe directive tokens, assembled so this test's OWN source never
// carries the literal comment form (Biome's rule would then flag this file).
const IGNORE = `@ts-${"ignore"}`;
const EXPECT = `@ts-${"expect-error"}`;

/** Run `biome lint --config-path=<repo root> <file>`; return exit + output. */
function biomeLint(file: string): { code: number; out: string } {
    try {
        const out = execFileSync(
            "bunx",
            ["biome", "lint", `--config-path=${REPO_ROOT}`, file],
            { cwd: REPO_ROOT, encoding: "utf8" },
        );
        return { code: 0, out };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return {
            code: e.status ?? 1,
            out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
        };
    }
}

function readJson(path: string): {
    linter?: { rules?: { suspicious?: { noTsIgnore?: string } } };
    overrides?: {
        includes?: string[];
        linter?: { rules?: { suspicious?: { noTsIgnore?: string } } };
    }[];
} {
    return JSON.parse(readFileSync(path, "utf8"));
}

describe("ban bare ts-ignore directive (#1053)", () => {
    it("pins Biome noTsIgnore to 'error' in the root config", () => {
        expect(readJson(ROOT_BIOME).linter?.rules?.suspicious?.noTsIgnore).toBe(
            "error",
        );
    });

    it("pins Biome noTsIgnore to 'error' in the nested packages/kn-next config", () => {
        // This nested config (root: false) governs **/src/**/*.ts and is the
        // effective config for most source — pinning only the root would leave
        // the bulk of the tree at warn.
        expect(
            readJson(NESTED_BIOME).linter?.rules?.suspicious?.noTsIgnore,
        ).toBe("error");
    });

    it("excludes fixtures + .next from the rule in BOTH configs (vendored corpus carries the string)", () => {
        for (const cfg of [ROOT_BIOME, NESTED_BIOME]) {
            const override = (readJson(cfg).overrides ?? []).find(
                (o) => o.linter?.rules?.suspicious?.noTsIgnore === "off",
            );
            expect(
                override,
                `${cfg}: an override turning noTsIgnore off must exist`,
            ).toBeDefined();
            expect(override?.includes).toContain("**/fixtures/**");
            expect(override?.includes).toContain("**/.next/**");
        }
    });

    it("REDS `biome lint` on a bare ts-ignore directive", () => {
        const dir = mkdtempSync(join(tmpdir(), "no-ts-ignore-"));
        try {
            const bad = join(dir, "probe.ts");
            writeFileSync(
                bad,
                `// ${IGNORE}\nexport const x = someMaybeErroringCall();\n`,
            );
            const { code, out } = biomeLint(bad);
            expect(out).toContain("noTsIgnore");
            expect(code).not.toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does NOT flag the self-cleaning expect-error directive", () => {
        const dir = mkdtempSync(join(tmpdir(), "no-ts-ignore-"));
        try {
            const good = join(dir, "probe.ts");
            writeFileSync(
                good,
                `// ${EXPECT} self-cleaning\nexport const y = someMaybeErroringCall();\n`,
            );
            const { code, out } = biomeLint(good);
            expect(out).not.toContain("noTsIgnore");
            expect(code).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does NOT flag a fixtures/ file carrying the directive (override)", () => {
        const dir = mkdtempSync(join(tmpdir(), "no-ts-ignore-"));
        try {
            mkdirSync(join(dir, "fixtures"), { recursive: true });
            const fx = join(dir, "fixtures", "vendored.ts");
            writeFileSync(
                fx,
                `// ${IGNORE} the timeouts have weird types\nexport const z = 1;\n`,
            );
            expect(biomeLint(fx).out).not.toContain("noTsIgnore");
        } finally {
            rmSync(dir, { recursive: true, force: true });
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
