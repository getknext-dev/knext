/**
 * `images.loaderFile` must be honoured by a vinext + Nitro `node` build.
 *
 * Unpatched vinext 1.0.1 ignores `images.loaderFile`, so `next/image` always
 * emits its built-in `/_next/image?...` URLs and a custom loader never runs.
 * knext's bundled vinext fix wires the file into the `next/image` entry shim.
 *
 * This is a real build: `bun install --frozen-lockfile` the committed fixture
 * (exact pins + bun.lock) into a temp dir, apply knext's bundled vinext
 * patches, `vite build`, run `.output` under node and read the rendered
 * `<img>` the page serves.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVinextPatches } from "../cli/vinext-patches";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const FIXTURE = join(
    import.meta.dir,
    "fixtures",
    "vinext-image-loaderfile-app",
);

describe("vinext x nitro: images.loaderFile", () => {
    it("builds, runs under node, and renders next/image through the custom loader", async () => {
        // The fixture carries exact pins plus a lockfile, so the install is
        // reproducible; it is copied out and never built in place.
        const root = mkdtempSync(join(tmpdir(), "knext-image-loaderfile-"));
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
        let status: number | undefined;
        let html = "";
        try {
            let res: Response | undefined;
            for (let i = 0; i < 40 && !res; i++) {
                try {
                    res = await fetch(`http://127.0.0.1:${port}/`);
                } catch {
                    await new Promise((r) => setTimeout(r, 250));
                }
            }
            status = res?.status;
            html = (await res?.text()) ?? "";
        } finally {
            srv.kill("SIGKILL");
        }

        expect({ status, log: status === 200 ? "" : log }).toEqual({
            status: 200,
            log: "",
        });
        expect(html).toContain("hello-loaderfile");
        // The rendered <img> must come from the configured loader file ...
        const img = /<img\b[^>]*>/.exec(html)?.[0] ?? "";
        const src = /\ssrc="([^"]*)"/.exec(img)?.[1]?.replaceAll("&amp;", "&");
        expect(src).toMatch(
            /^https:\/\/cdn\.knext-loaderfile\.test\/photo\.png\?w=\d+&q=auto$/,
        );
        // ... including the per-width srcSet, which the loader was asked for.
        expect(img).toContain("https://cdn.knext-loaderfile.test/photo.png?w=");
        // ... and never from vinext's built-in optimizer endpoint.
        expect(img).not.toContain("/_next/image");
    }, 240_000);
});
