/**
 * A `<style jsx>` page must render under a vinext + Nitro `node` build.
 *
 * vinext bundles styled-jsx (CommonJS) into the SSR output while React stays
 * external, so styled-jsx's `require('react')` becomes a runtime
 * `createRequire(...)('react')` Nitro's tracer cannot see. A second React then
 * loads, the renderer's dispatcher is set on the other copy, and the page 500s
 * with `Invalid hook call` / a null dispatcher.
 *
 * This is a real build: install the pinned toolchain into a temp dir, apply
 * knext's bundled vinext patches, `vite build`, run `.output` under node and
 * request the page. It needs the npm registry (like the install-smoke gate).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    applyVinextPatches,
    loadVinextPatchManifest,
    vinextPatchesDir,
} from "../cli/vinext-patches";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const VINEXT = loadVinextPatchManifest(vinextPatchesDir()).vinext;

function write(root: string, rel: string, body: string) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
}

describe("vinext x nitro: <style jsx> keeps a single React", () => {
    it("builds, runs under node, returns 200 and renders the page", async () => {
        const root = mkdtempSync(join(tmpdir(), "knext-styled-jsx-"));
        tempRoots.push(root);
        write(
            root,
            "package.json",
            '{"name":"sj","private":true,"type":"module"}\n',
        );
        write(
            root,
            "pages/index.js",
            "export default function Home(){return (<div><p>hello-jsx</p><style jsx>{`p{color:red}`}</style></div>)}\n",
        );
        write(
            root,
            "vite.config.mjs",
            "import { nitro } from 'nitro/vite';\nimport vinext from 'vinext';\nimport { defineConfig } from 'vite';\n" +
                "export default defineConfig({plugins:[vinext(),nitro({preset:'node',rollupConfig:{output:{inlineDynamicImports:true}}})]});\n",
        );
        const sh = (cmd: string, args: string[]) => {
            const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
            if (r.status !== 0)
                throw new Error(
                    `${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`,
                );
        };
        sh("bun", [
            "add",
            `vinext@${VINEXT}`,
            "vite@8.2.2",
            "nitro@3.0.260610-beta",
            "react@19.2.6",
            "react-dom@19.2.6",
            "next@16.3.6",
        ]);
        applyVinextPatches(join(root, "node_modules", "vinext"));
        sh(join(root, "node_modules", ".bin", "vite"), ["build"]);

        const port = 20000 + Math.floor(Math.random() * 20000);
        const srv = spawn("node", [".output/server/index.mjs"], {
            cwd: root,
            env: {
                ...process.env,
                PORT: String(port),
                NITRO_PORT: String(port),
            },
        });
        let log = "";
        srv.stdout.on("data", (d) => {
            log += d;
        });
        srv.stderr.on("data", (d) => {
            log += d;
        });
        try {
            let res: Response | undefined;
            for (let i = 0; i < 40 && !res; i++) {
                try {
                    res = await fetch(`http://127.0.0.1:${port}/`);
                } catch {
                    await new Promise((r) => setTimeout(r, 250));
                }
            }
            expect(res?.status).toBe(200);
            expect(await res?.text()).toContain("hello-jsx");
            expect(log).not.toContain("Invalid hook call");
        } finally {
            srv.kill("SIGKILL");
        }
        // Single React: the built server must not resolve `react` through a
        // runtime createRequire the tracer cannot see.
        expect(
            readFileSync(join(root, ".output/server/index.mjs"), "utf8"),
        ).not.toMatch(/createRequire\([^)]*\)\(["']react["']\)/);
    }, 240_000);
});
