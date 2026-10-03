/**
 * Containment + size-cap guards for the C4 asset-anchor fix
 * (entry-asset-anchor.mjs's allowlist + vinext-compile.mjs's
 * `resolveAssetAnchor`) — code-review round 2.
 *
 * Each case hand-builds a MINIMAL `.output/server` tree with a module at
 * `node_modules/@vercel/og/dist/index.node.js` (the one allowlisted shape),
 * compiles it for real through the SHIPPED script, and asserts by EXIT CODE
 * ONLY (never output-grep — a prior mutation-harness bug here certified 14
 * decorative mutations all-green by grepping colored terminal output
 * instead) that:
 *   - a normal, contained, in-cap sibling SUCCEEDS (the control case — proves
 *     the guards below are not simply refusing everything);
 *   - a literal that `..`-escapes the package root FAILS the build;
 *   - a literal that resolves through a SYMLINK pointing outside the package
 *     root FAILS the build, even though the literal itself has no `..`;
 *   - a sibling over the size cap FAILS the build.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function temp(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}

function hostTarget(): string {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return process.platform === "darwin"
        ? `bun-darwin-${arch}`
        : `bun-linux-${arch}`;
}

/**
 * A minimal `.output/server` tree in @vercel/og's allowlisted shape, with ONE
 * `new URL(<anchorLiteral>, import.meta.url)` anchor in its module. The
 * entry statically imports the module's `marker` export, so Bun's bundler
 * reaches it the same way it reaches the real og package.
 */
function buildFixture(anchorLiteral: string) {
    const buildDir = temp("knext-asset-anchor-guard-");
    const serverDir = join(buildDir, ".output", "server");
    const ogDistDir = join(serverDir, "node_modules", "@vercel", "og", "dist");
    mkdirSync(ogDistDir, { recursive: true });
    writeFileSync(
        join(ogDistDir, "index.node.js"),
        [
            'import { readFileSync } from "node:fs";',
            'import { fileURLToPath } from "node:url";',
            `const p = fileURLToPath(new URL(${JSON.stringify(anchorLiteral)}, import.meta.url));`,
            "export const marker = readFileSync(p, 'utf8');",
        ].join("\n"),
    );
    writeFileSync(
        join(serverDir, "index.mjs"),
        [
            'import { marker } from "./node_modules/@vercel/og/dist/index.node.js";',
            "console.log(marker);",
        ].join("\n"),
    );
    return {
        buildDir,
        serverDir,
        ogDistDir,
        nodeModulesDir: join(serverDir, "node_modules"),
    };
}

function compile(buildDir: string, serverDir: string) {
    const outFile = join(buildDir, "guard-exec");
    const result = spawnSync(
        "bun",
        [
            "run",
            COMPILE,
            "--entry",
            join(serverDir, "index.mjs"),
            "--outfile",
            outFile,
            "--target",
            hostTarget(),
        ],
        { encoding: "utf-8", timeout: 60_000 },
    );
    return { result, outFile };
}

describe("#C4 review round 2 — asset-anchor containment and size cap (exit-code only)", () => {
    it("SUCCEEDS for a normal, contained, in-cap sibling (the control case)", () => {
        const { buildDir, serverDir, ogDistDir } = buildFixture("./ok.wasm");
        writeFileSync(join(ogDistDir, "ok.wasm"), "OK_MARKER");
        const { result, outFile } = compile(buildDir, serverDir);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(existsSync(outFile)).toBe(true);
    }, 60_000);

    it("FAILS when the literal `..`-escapes the package root", () => {
        const { buildDir, serverDir, ogDistDir } =
            buildFixture("../../outside.txt");
        // `resolve(dirname(module), "../../outside.txt")` from
        // `.../@vercel/og/dist` pops "dist" then "og", landing in `@vercel/` —
        // a SIBLING of og's own root, not inside it. A real file there is
        // genuinely outside the containment boundary.
        writeFileSync(
            resolve(ogDistDir, "../../outside.txt"),
            "SHOULD_NOT_EMBED",
        );
        const { result, outFile } = compile(buildDir, serverDir);
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(existsSync(outFile)).toBe(false);
    }, 60_000);

    it("FAILS when the literal resolves through a SYMLINK pointing outside the package root", () => {
        const { buildDir, serverDir, ogDistDir, nodeModulesDir } =
            buildFixture("./escape-link.wasm");
        writeFileSync(
            join(nodeModulesDir, "outside2.txt"),
            "SHOULD_NOT_EMBED_EITHER",
        );
        // The LITERAL itself is a plain, non-escaping relative path; only its
        // REAL (symlink-resolved) target is outside the package.
        symlinkSync(
            join(nodeModulesDir, "outside2.txt"),
            join(ogDistDir, "escape-link.wasm"),
        );
        const { result, outFile } = compile(buildDir, serverDir);
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(existsSync(outFile)).toBe(false);
    }, 60_000);

    it("FAILS when the sibling is over the asset-anchor size cap", () => {
        const { buildDir, serverDir, ogDistDir } =
            buildFixture("./toolarge.bin");
        const TOO_BIG = 16 * 1024 * 1024 + 1;
        writeFileSync(join(ogDistDir, "toolarge.bin"), Buffer.alloc(TOO_BIG));
        const { result, outFile } = compile(buildDir, serverDir);
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(existsSync(outFile)).toBe(false);
    }, 90_000);
});
