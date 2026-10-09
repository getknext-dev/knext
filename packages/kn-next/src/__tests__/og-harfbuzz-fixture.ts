/**
 * Shared fixture for the next/og HarfBuzz tests (#1872): a hand-built vinext
 * `.output/server` in either of the two shapes that read `hb.wasm`, plus the
 * app's own `node_modules` chain (vinext → @vercel/og → satori → harfbuzzjs)
 * the build resolves the binary through.
 *
 *   - `sidecar`: nitro's externalized copy of @vercel/og 1.0.3 — JS only, no
 *     `dist/hb.wasm` — whose inlined Emscripten glue reads
 *     `locateFile("hb.wasm")` = `__dirname + "/hb.wasm"` through esbuild's
 *     `__require("fs")` (which throws under plain Node ESM).
 *   - `rsc-entry`: the app-router chunk vinext's og-harfbuzz + og-assets
 *     plugins emit, `new WebAssembly.Module(read(new URL(`../../hb.wasm`, …)))`,
 *     inlined by nitro into the server entry with no hb.wasm shipped.
 *
 * The entry exits 0 only when the bytes it read are the fixture harfbuzzjs's
 * `hb.wasm` (a valid wasm module whose one custom section is named
 * `HB_MARKER`); anything else exits non-zero.
 */
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HB_MARKER = "knext_hb_1872";

/** A minimal valid wasm module carrying one custom section named HB_MARKER. */
export function markerWasm(): Uint8Array {
    const name = [...Buffer.from(HB_MARKER)];
    const content = [name.length, ...name];
    return Uint8Array.from([
        0,
        97,
        115,
        109,
        1,
        0,
        0,
        0,
        0,
        content.length,
        ...content,
    ]);
}

const temps: string[] = [];
export function temp(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}
export function cleanupTemps(): void {
    for (const d of temps.splice(0))
        rmSync(d, { recursive: true, force: true });
}

function pkg(dir: string, json: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(json));
}

/** @vercel/og 1.0.3's inlined glue, trimmed to the parts that load hb.wasm. */
const GLUE = [
    "var __require = (x) => {",
    '  if (typeof require !== "undefined") return require(x);',
    "  throw Error('Dynamic require of \"' + x + '\" is not supported');",
    "};",
    'var fs3 = __require("fs");',
    'var scriptDirectory = __dirname + "/";',
    "function locateFile(path) { return scriptDirectory + path; }",
    'function findWasmBinary() { return locateFile("hb.wasm"); }',
    "export const bytes = fs3.readFileSync(findWasmBinary());",
].join("\n");

const CHECK = [
    `if (WebAssembly.Module.customSections(__mod, ${JSON.stringify(HB_MARKER)}).length !== 1) { console.error("wrong hb.wasm bytes"); process.exit(3); }`,
    'console.log("hb ok");',
].join("\n");

const SIDECAR_ENTRY = [
    'import { bytes } from "./node_modules/@vercel/og/dist/index.node.js";',
    "const __mod = new WebAssembly.Module(bytes);",
    CHECK,
].join("\n");

const RSC_ENTRY = [
    'import { readFileSync } from "node:fs";',
    // vinext's exact (minified) shape: Module(read(new URL(`../../hb.wasm`, ...)))
    "function __vi_hb_module() { return new WebAssembly.Module(readFileSync(new URL(`../../hb.wasm`, import.meta.url))); }",
    "const __mod = __vi_hb_module();",
    CHECK,
].join("\n");

export function buildOgApp(opts: {
    installedSatori: string;
    shape: "sidecar" | "rsc-entry";
}): { appDir: string; serverDir: string } {
    const appDir = temp("knext-og-hb-app-");
    const serverDir = join(appDir, ".output", "server");
    const stagedOg = join(serverDir, "node_modules", "@vercel", "og");
    pkg(stagedOg, {
        name: "@vercel/og",
        version: "1.0.3",
        type: "module",
        dependencies: { "@resvg/resvg-wasm": "2.4.1", satori: "0.33.5" },
    });
    mkdirSync(join(stagedOg, "dist"), { recursive: true });
    writeFileSync(join(stagedOg, "dist", "index.node.js"), GLUE);
    pkg(serverDir, { type: "module" });
    writeFileSync(
        join(serverDir, "index.mjs"),
        opts.shape === "rsc-entry" ? RSC_ENTRY : SIDECAR_ENTRY,
    );

    const nm = join(appDir, "node_modules");
    pkg(appDir, {
        name: "app",
        version: "0.0.0",
        private: true,
        type: "module",
    });
    // vinext 1.0.1 is ESM-only: an "import"-only export, no package.json export
    pkg(join(nm, "vinext"), {
        name: "vinext",
        version: "1.0.1",
        type: "module",
        exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
        dependencies: { "@vercel/og": "1.0.3" },
    });
    writeFileSync(join(nm, "vinext", "index.js"), "");
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
    pkg(join(nm, "harfbuzzjs"), {
        name: "harfbuzzjs",
        version: "0.10.0",
        license: "MIT",
    });
    writeFileSync(join(nm, "harfbuzzjs", "hb.wasm"), markerWasm());
    writeFileSync(
        join(nm, "harfbuzzjs", "LICENSE"),
        "MIT for the rest of the project\n",
    );
    return { appDir, serverDir };
}
