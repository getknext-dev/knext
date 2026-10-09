/**
 * The asset-anchor rewrite is no longer scoped to a package allowlist: ANY
 * package whose module reads a sibling file through
 * `readFileSync(new URL("./x.wasm", import.meta.url))` gets that file embedded
 * into the compiled single executable, decided by what the URL FEEDS (an
 * acorn pass in entry-asset-anchor.mjs), not by the package's name.
 *
 * The package here is synthetic (`@acme/wasm-reader`, never `@vercel/og`), so
 * a regression back to a name allowlist reds this suite. It compiles a
 * hand-built `.output/server` tree through the SHIPPED script, moves the
 * binary to a fresh directory, deletes the whole build directory (the only
 * place the sibling ever existed on disk), and runs the moved binary — which
 * exits 0 only if it read the exact embedded bytes. Assertions are by EXIT
 * CODE only, never by grepping output.
 *
 * Bun >= 1.4 on PATH is required; a missing bun is a failure, not a skip.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});
function temp(prefix: string): string {
    const r = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(r);
    return realpathSync(r);
}

function hostTarget(): string {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return process.platform === "darwin"
        ? `bun-darwin-${arch}`
        : `bun-linux-${arch}`;
}

/** Bytes no real wasm starts with — the moved binary checks it read exactly these. */
const WASM_BYTES = [0x00, 0x61, 0x73, 0x6d, 0x6b, 0x6e, 0x78, 0x74, 0x21];

/**
 * `.output/server/node_modules/@acme/wasm-reader/dist/index.js` reading its
 * sibling `x.wasm` at module scope, plus an entry that exits non-zero unless
 * the bytes match.
 */
function buildFixture() {
    const buildDir = temp("knext-x-anchor-build-");
    const serverDir = join(buildDir, ".output", "server");
    const pkgDir = join(serverDir, "node_modules", "@acme", "wasm-reader");
    const distDir = join(pkgDir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
            name: "@acme/wasm-reader",
            version: "1.0.0",
            type: "module",
            main: "dist/index.js",
        }),
    );
    writeFileSync(join(distDir, "x.wasm"), Buffer.from(WASM_BYTES));
    writeFileSync(
        join(distDir, "index.js"),
        [
            'import { readFileSync } from "node:fs";',
            "// A Worker anchor in the same module stays untouched (never called here).",
            'export function spawnWorker() { return new Worker(new URL("./w.js", import.meta.url)); }',
            'export const bytes = readFileSync(new URL("./x.wasm", import.meta.url));',
        ].join("\n"),
    );
    writeFileSync(
        join(serverDir, "index.mjs"),
        [
            'import { bytes } from "./node_modules/@acme/wasm-reader/dist/index.js";',
            `const want = ${JSON.stringify(WASM_BYTES)};`,
            "const got = [...bytes];",
            "if (got.length !== want.length || got.some((b, i) => b !== want[i])) {",
            '    console.error("bytes mismatch", got);',
            "    process.exit(3);",
            "}",
            "process.exit(0);",
        ].join("\n"),
    );
    return { buildDir, serverDir };
}

describe("a sibling-asset read in ANY package survives the compiled executable, moved away from its build dir", () => {
    it("embeds @acme/wasm-reader's x.wasm and the moved binary reads the exact bytes", () => {
        const bun = spawnSync("bun", ["--version"], { encoding: "utf-8" });
        expect(bun.status, "bun is required on PATH").toBe(0);

        const { buildDir, serverDir } = buildFixture();
        const outFile = join(buildDir, "anchor-exec");
        const compile = spawnSync(
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
            { encoding: "utf-8", timeout: 90_000 },
        );
        expect(compile.status, compile.stdout + compile.stderr).toBe(0);
        expect(existsSync(outFile)).toBe(true);

        // Ship ONLY the binary; delete the entire build dir, so a baked
        // build-machine path has nothing left to find.
        const shipDir = temp("knext-x-anchor-ship-");
        const shipped = join(shipDir, "anchor-exec");
        cpSync(outFile, shipped);
        rmSync(buildDir, { recursive: true, force: true });

        const run = spawnSync(shipped, [], {
            cwd: shipDir,
            encoding: "utf-8",
            timeout: 30_000,
        });
        expect(run.status, run.stdout + run.stderr).toBe(0);
    }, 120_000);
});
