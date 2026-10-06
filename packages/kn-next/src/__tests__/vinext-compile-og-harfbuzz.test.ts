/**
 * #1872 — `next/og` on the vinext × bun compiled executable 500s with
 * `ENOENT … @vercel/og/dist/hb.wasm`.
 *
 * `@vercel/og` 1.x inlines harfbuzzjs's Emscripten glue, which reads its WASM
 * through `locateFile("hb.wasm")` = `__dirname + "/hb.wasm"`. 1.0.3 (the
 * version vinext 1.0.1 pins) ships no `dist/hb.wasm` at all, and nitro
 * externalizes `@vercel/og`, so vinext's own `vinext:og-harfbuzz` transform
 * never runs on the copy knext's compile bundles. The compile embeds the
 * `hb.wasm` from the exact dependency chain the glue was built from
 * (`@vercel/og` → `satori` → `harfbuzzjs`) and points `locateFile` at it.
 *
 * Each case hand-builds a MINIMAL app: nitro's staged `.output/server` copy of
 * `@vercel/og` (no `hb.wasm`, like 1.0.3) plus the app's real
 * `node_modules/{@vercel/og,satori,harfbuzzjs}`. It compiles through the
 * SHIPPED script, moves the binary to a fresh dir, DELETES the build dir, and
 * runs it. Asserted by EXIT CODE only (the module throws when the read fails).
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
const HB_MARKER = "KNEXT_HB_WASM_MARKER_1872";

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

function pkg(dir: string, json: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(json));
}

/** The glue shape @vercel/og 1.0.3's `dist/index.node.js` inlines (trimmed). */
const GLUE = [
    'import { readFileSync } from "node:fs";',
    'var scriptDirectory = __dirname + "/";',
    "function locateFile(path) { return scriptDirectory + path; }",
    'function findWasmBinary() { return locateFile("hb.wasm"); }',
    "export const marker = readFileSync(findWasmBinary(), 'utf8');",
].join("\n");

/**
 * The app-router shape: vinext bundles @vercel/og into the RSC chunk and its
 * og-harfbuzz/og-assets plugins rewrite the read to a path relative to an
 * intermediate RSC output dir; nitro inlines that chunk into the entry and
 * ships no hb.wasm, so the URL resolves to nothing.
 */
const RSC_ENTRY = [
    'import { readFileSync } from "node:fs";',
    "const marker = readFileSync(new URL(`../../hb.wasm`, import.meta.url), 'utf8');",
    `if (marker !== ${JSON.stringify(HB_MARKER)}) { console.error("wrong hb.wasm bytes"); process.exit(3); }`,
    'console.log("hb ok");',
].join("\n");

function buildApp(opts: {
    installedSatori: string;
    shape?: "sidecar" | "rsc-entry";
}) {
    const buildDir = temp("knext-og-hb-build-");
    const serverDir = join(buildDir, ".output", "server");
    // nitro's staged copy — JS only, no hb.wasm (1.0.3's real shape); nitro
    // keeps the package.json, exact `satori` pin included
    const stagedOg = join(serverDir, "node_modules", "@vercel", "og");
    pkg(stagedOg, {
        name: "@vercel/og",
        version: "1.0.3",
        dependencies: { "@resvg/resvg-wasm": "2.4.1", satori: "0.33.5" },
    });
    mkdirSync(join(stagedOg, "dist"), { recursive: true });
    writeFileSync(join(stagedOg, "dist", "index.node.js"), GLUE);
    writeFileSync(
        join(serverDir, "index.mjs"),
        opts.shape === "rsc-entry"
            ? RSC_ENTRY
            : [
                  'import { marker } from "./node_modules/@vercel/og/dist/index.node.js";',
                  `if (marker !== ${JSON.stringify(HB_MARKER)}) { console.error("wrong hb.wasm bytes"); process.exit(3); }`,
                  'console.log("hb ok");',
              ].join("\n"),
    );
    // vinext depends on @vercel/og; the RSC-entry chain is resolved through it
    pkg(join(buildDir, "node_modules", "vinext"), {
        name: "vinext",
        version: "1.0.1",
        type: "module",
        // vinext 1.0.1 is ESM-only: an "import"-only export, no package.json export
        exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
        dependencies: { "@vercel/og": "1.0.3" },
    });
    writeFileSync(join(buildDir, "node_modules", "vinext", "index.js"), "");
    // the app's own install: @vercel/og → satori → harfbuzzjs (hb.wasm lives here)
    const nm = join(buildDir, "node_modules");
    pkg(buildDir, { name: "app", version: "0.0.0", private: true });
    pkg(join(nm, "@vercel", "og"), {
        name: "@vercel/og",
        version: "1.0.3",
        dependencies: { satori: "0.33.5" },
    });
    pkg(join(nm, "satori"), {
        name: "satori",
        version: opts.installedSatori,
        dependencies: { harfbuzzjs: "0.10.0" },
    });
    pkg(join(nm, "harfbuzzjs"), { name: "harfbuzzjs", version: "0.10.0" });
    writeFileSync(join(nm, "harfbuzzjs", "hb.wasm"), HB_MARKER);
    return { buildDir, serverDir };
}

/** Compile, ship the binary alone, delete the build dir, run it. */
function compileShipRun(buildDir: string, serverDir: string) {
    const outFile = join(buildDir, "og-hb-exec");
    const build = spawnSync(
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
    expect(build.status, build.stdout + build.stderr).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    const shipDir = temp("knext-og-hb-ship-");
    const shipped = join(shipDir, "og-hb-exec");
    cpSync(outFile, shipped);
    rmSync(buildDir, { recursive: true, force: true });
    return spawnSync(shipped, [], {
        cwd: shipDir,
        encoding: "utf-8",
        timeout: 30_000,
    });
}

describe("#1872 — @vercel/og's harfbuzz hb.wasm survives the compiled executable (exit-code only)", () => {
    it("embeds harfbuzzjs/hb.wasm and the shipped binary reads it with the build dir gone", () => {
        const { buildDir, serverDir } = buildApp({ installedSatori: "0.33.5" });
        const run = compileShipRun(buildDir, serverDir);
        expect(run.status, run.stdout + run.stderr).toBe(0);
    }, 120_000);

    it("does NOT embed hb.wasm from a satori other than the staged @vercel/og's exact pin (the read still fails)", () => {
        const { buildDir, serverDir } = buildApp({ installedSatori: "0.30.0" });
        const run = compileShipRun(buildDir, serverDir);
        expect(run.status).not.toBe(0);
    }, 120_000);

    it("app-router shape: embeds hb.wasm for the vinext-rewritten new URL(../../hb.wasm) in the entry", () => {
        const { buildDir, serverDir } = buildApp({
            installedSatori: "0.33.5",
            shape: "rsc-entry",
        });
        const run = compileShipRun(buildDir, serverDir);
        expect(run.status, run.stdout + run.stderr).toBe(0);
    }, 120_000);

    it("app-router shape: does NOT embed hb.wasm from a satori off the exact pin (the read still fails)", () => {
        const { buildDir, serverDir } = buildApp({
            installedSatori: "0.30.0",
            shape: "rsc-entry",
        });
        const run = compileShipRun(buildDir, serverDir);
        expect(run.status).not.toBe(0);
    }, 120_000);
});
