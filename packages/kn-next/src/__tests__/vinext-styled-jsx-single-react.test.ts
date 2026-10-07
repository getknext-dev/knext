/**
 * A `<style jsx>` page must render under a vinext + Nitro `node` build.
 *
 * vinext bundles styled-jsx (CommonJS) into the SSR output while React stays
 * external, so styled-jsx's `require('react')` becomes a runtime
 * `createRequire(...)('react')` Nitro's tracer cannot see. A second React then
 * loads, the renderer's dispatcher is set on the other copy, and the page 500s
 * with `Invalid hook call` / a null dispatcher.
 *
 * This is a real build: `bun install --frozen-lockfile` the committed fixture
 * (exact pins + bun.lock) into a temp dir, apply knext's bundled vinext
 * patches, `vite build`, run `.output` under node and request the page.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVinextPatches } from "../cli/vinext-patches";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const FIXTURE = join(import.meta.dir, "fixtures", "vinext-styled-jsx-app");

describe("vinext x nitro: <style jsx> keeps a single React", () => {
    it("builds, runs under node, returns 200 and renders the page", async () => {
        // The fixture carries exact pins plus a lockfile, so the install is
        // reproducible; it is copied out and never built in place.
        const root = mkdtempSync(join(tmpdir(), "knext-styled-jsx-"));
        tempRoots.push(root);
        cpSync(FIXTURE, root, { recursive: true });
        const sh = (cmd: string, args: string[]) => {
            const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
            if (r.status !== 0)
                throw new Error(
                    `${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`,
                );
        };
        sh("bun", ["install", "--frozen-lockfile"]);
        applyVinextPatches(join(root, "node_modules", "vinext"));
        sh(join(root, "node_modules", ".bin", "vite"), ["build"]);

        const serve = async (
            cwd: string,
        ): Promise<{ status?: number; body: string; log: string }> => {
            const port = 20000 + Math.floor(Math.random() * 20000);
            const srv = spawn("node", [".output/server/index.mjs"], {
                cwd,
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
                return {
                    status: res?.status,
                    body: (await res?.text()) ?? "",
                    log,
                };
            } finally {
                srv.kill("SIGKILL");
            }
        };

        const here = await serve(root);
        expect(here.status).toBe(200);
        expect(here.body).toContain("hello-jsx");
        expect(here.log).not.toContain("Invalid hook call");

        // The output must be self-contained: relocated away from the project's
        // node_modules it still serves (a runtime `require('react')` would die
        // with "Cannot find module 'react'").
        const moved = mkdtempSync(join(tmpdir(), "knext-styled-jsx-moved-"));
        tempRoots.push(moved);
        cpSync(join(root, ".output"), join(moved, ".output"), {
            recursive: true,
        });
        const there = await serve(moved);
        expect(there.status).toBe(200);
        expect(there.body).toContain("hello-jsx");

        // Single React: the built server must not resolve `react` through a
        // runtime createRequire the tracer cannot see.
        expect(
            readFileSync(join(root, ".output/server/index.mjs"), "utf8"),
        ).not.toMatch(/createRequire\([^)]*\)\(["']react["']\)/);
    }, 240_000);
});
