/**
 * ts-import-extension-guard — TS5097 main-red-class guard (#289).
 *
 * Incident (PR #285 → #288): a test landed a dynamic import written with an
 * explicit `.ts` extension — `import("../validate-public.ts")`. Under
 * `moduleResolution: bundler` (used by @knext/core), `tsc --noEmit` rejects an
 * explicit `.ts`/`.tsx` import extension with **TS5097**
 * (`allowImportingTsExtensions` is off). Vitest resolves it at runtime, so the
 * test *ran green locally* — but the `Typecheck @knext/core` CI gate went red
 * only AFTER merge, turning the default branch red and blocking every open PR.
 *
 * scripts/check-ts-import-extensions.mjs is the deterministic, fail-fast guard:
 * it FAILS on any relative `import`/`export … from`/`import(...)` specifier that
 * ends in `.ts`/`.tsx`/`.mts`/`.cts` under packages/kn-next/src — WITHOUT false-
 * positiving on filesystem-path STRINGS (`resolve(dir, "src/x.ts")`,
 * `readFileSync(".../foo.ts")`), which are call arguments, not import specifiers.
 *
 * This spec pins BOTH the real tree (durable regression guard) and the guard's
 * own detection semantics (good/bad synthetic inputs), so a re-added `.ts`
 * import is caught by `vitest run`, not just by the post-merge typecheck gate.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// repo root: packages/kn-next/src/__tests__ -> up 4
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const GUARD = join(REPO_ROOT, "scripts", "check-ts-import-extensions.mjs");
const KN_NEXT_SRC = join(REPO_ROOT, "packages", "kn-next", "src");

/** Run the guard against an explicit list of files; capture exit + output. */
function runGuard(files: string[]): { code: number; out: string } {
    try {
        const out = execFileSync("node", [GUARD, "--quiet", ...files], {
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

/** Write a temp .ts file with the given body; returns its path + cleanup. */
function withTempFile(
    body: string,
    ext = ".ts",
): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "knext-ts-ext-guard-"));
    const path = join(dir, `fixture${ext}`);
    writeFileSync(path, body);
    return {
        path,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

describe("no-.ts-import-extension guard (#289, TS5097 class)", () => {
    it("PASSES on the real packages/kn-next/src tree (no .ts import extensions today)", () => {
        // Default (no explicit files) scans the whole kn-next src tree.
        const { code, out } = runGuard([KN_NEXT_SRC]);
        expect(code, out).toBe(0);
    });

    it('FAILS on a re-introduced dynamic `import("../x.ts")` (the exact #285 incident)', () => {
        const { path, cleanup } = withTempFile(
            'const m = await import("../validate-public.ts");\nexport default m;\n',
        );
        try {
            const { code, out } = runGuard([path]);
            expect(code).toBe(1);
            expect(out).toMatch(/validate-public\.ts/);
        } finally {
            cleanup();
        }
    });

    it('FAILS on a static `import … from "./x.ts"` specifier', () => {
        const { path, cleanup } = withTempFile(
            'import { thing } from "./thing.ts";\nexport const y = thing;\n',
        );
        try {
            const { code, out } = runGuard([path]);
            expect(code).toBe(1);
            expect(out).toMatch(/thing\.ts/);
        } finally {
            cleanup();
        }
    });

    it('FAILS on a re-export `export … from "./x.tsx"` specifier', () => {
        const { path, cleanup } = withTempFile(
            'export { Comp } from "./comp.tsx";\n',
            ".tsx",
        );
        try {
            const { code, out } = runGuard([path]);
            expect(code).toBe(1);
            expect(out).toMatch(/comp\.tsx/);
        } finally {
            cleanup();
        }
    });

    it("does NOT false-positive on filesystem-path STRINGS (resolve/existsSync/readFileSync)", () => {
        const { path, cleanup } = withTempFile(
            [
                'import { resolve } from "node:path";',
                'import { existsSync, readFileSync } from "node:fs";',
                'const p = resolve(__dirname, "src/x.ts");',
                'const ok = existsSync("/tmp/foo.ts");',
                'const src = readFileSync("./bar.tsx", "utf8");',
                "export { p, ok, src };",
            ].join("\n") + "\n",
        );
        try {
            const { code, out } = runGuard([path]);
            expect(code, out).toBe(0);
        } finally {
            cleanup();
        }
    });

    it("does NOT flag legitimate `.js`, extensionless, or bare-module specifiers", () => {
        const { path, cleanup } = withTempFile(
            [
                'import { a } from "./a.js";',
                'import { b } from "./b";',
                'import { join } from "node:path";',
                'import vitest from "vitest";',
                'const j = await import("./lazy.js");',
                "export { a, b, join, vitest, j };",
            ].join("\n") + "\n",
        );
        try {
            const { code, out } = runGuard([path]);
            expect(code, out).toBe(0);
        } finally {
            cleanup();
        }
    });

    it("does NOT flag a `.ts` specifier that appears only in a comment", () => {
        const { path, cleanup } = withTempFile(
            [
                '// import x from "./old.ts"; // removed, kept as a note',
                '/* import y from "./legacy.ts"; */',
                'import { real } from "./real.js";',
                "export { real };",
            ].join("\n") + "\n",
        );
        try {
            const { code, out } = runGuard([path]);
            expect(code, out).toBe(0);
        } finally {
            cleanup();
        }
    });
});
