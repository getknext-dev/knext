/**
 * The compiled single-exec must serve `_next/static/*` from the right place.
 *
 * `vinext-compile.mjs` rewrites `import.meta.{url,filename,dirname}` into runtime
 * expressions because `bun build --compile --bytecode` cannot hold `import.meta`.
 * nitro's bun preset resolves public assets as
 *   `resolve(dirname(fileURLToPath(import.meta.url)), "../public")`
 * so whatever `import.meta.url` becomes DECIDES where the binary looks for static
 * assets. The original bug anchored it at `pathToFileURL(process.execPath)` — but
 * the binary sits BESIDE `.output/` (e2e: `${APP_DIR}/knext-exec-e2e` +
 * `${APP_DIR}/.output`; Docker: `/app/server` + `/app/.output`), not inside
 * `.output/server/`, so `../public` climbed one level too high and every static
 * asset 500'd with `ENOENT … /<parent>/public/…` (the "/tmp/public" bug seen in
 * compat run 34441831428). The fix reconstructs the ORIGINAL entry path
 * `<dirname(execPath)>/.output/server/index.mjs` so `../public` lands on
 * `<root>/.output/public`.
 *
 * This guard evaluates the EXACT expression the source injects (extracted, not
 * copied) so a revert to the bare-execPath form reds the behavioural assertion.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");
const src = readFileSync(SRC, "utf8");

/** Recover the real injected expressions by evaluating the source's own
 *  expression-building block — no duplication, so drift cannot pass silently. */
function injectedExprs(): {
    entryFileExpr: string;
    entryDirExpr: string;
    entryUrlExpr: string;
} {
    const block = src.match(/const P = [\s\S]*?const entryUrlExpr = [^;]+;/);
    if (!block) {
        throw new Error(
            "could not locate the import.meta rewrite expression block in vinext-compile.mjs — " +
                "the guard's subject moved; re-anchor it",
        );
    }
    return new Function(
        `${block[0]}\nreturn { entryFileExpr, entryDirExpr, entryUrlExpr };`,
    )();
}

/** Evaluate an injected runtime expression with a mocked process.execPath. */
function evalWithExecPath(expr: string, execPath: string): string {
    const saved = process.execPath;
    try {
        Object.defineProperty(process, "execPath", {
            value: execPath,
            configurable: true,
        });
        return new Function("require", `return ${expr};`)(require) as string;
    } finally {
        Object.defineProperty(process, "execPath", {
            value: saved,
            configurable: true,
        });
    }
}

/** nitro bun preset: serverDir = dirname(fileURLToPath(import.meta.url)); it then
 *  serves public assets from `${serverDir}/../public`. */
function nitroPublicDir(importMetaUrl: string): string {
    return resolve(dirname(fileURLToPath(importMetaUrl)), "../public");
}

describe("vinext-compile anchors the compiled binary's public assets (#asset-root)", () => {
    it("does NOT anchor import.meta.url at the bare binary path", () => {
        // The exact bug form. Its presence means `../public` climbs too high.
        expect(src).not.toContain("pathToFileURL(process.execPath).href");
    });

    it("reconstructs the original .output/server/index.mjs entry path", () => {
        const { entryFileExpr } = injectedExprs();
        const file = evalWithExecPath(entryFileExpr, "/app/server");
        expect(file).toBe(join("/app", ".output", "server", "index.mjs"));
    });

    it("resolves nitro's `../public` to <root>/.output/public for a binary at <root>/server", () => {
        const { entryUrlExpr } = injectedExprs();
        const url = evalWithExecPath(entryUrlExpr, "/app/server");
        expect(nitroPublicDir(url)).toBe(join("/app", ".output", "public"));
    });

    it("matches the e2e lane layout (binary beside .output in a temp dir)", () => {
        const { entryUrlExpr } = injectedExprs();
        const url = evalWithExecPath(
            entryUrlExpr,
            "/tmp/next-test-123/knext-exec-e2e",
        );
        expect(nitroPublicDir(url)).toBe(
            join("/tmp/next-test-123", ".output", "public"),
        );
    });

    it("discriminates: the buggy bare-execPath form resolves to the WRONG /parent/public", () => {
        // Proves the assertions above are not vacuously true — the old form lands
        // one directory too high (the observed 500 root cause).
        const buggy = nitroPublicDir(pathToFileURL("/app/server").href);
        expect(buggy).toBe("/public");
        expect(buggy).not.toBe(join("/app", ".output", "public"));
    });
});
