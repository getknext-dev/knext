/**
 * `images.loaderFile` must be honoured by a vinext + Nitro `node` build.
 *
 * Unpatched vinext 1.0.1 ignores `images.loaderFile`, so `next/image` always
 * emits its built-in `/_next/image?...` URLs and a custom loader never runs.
 * knext's bundled vinext fix wires the file into the `next/image` entry shim.
 *
 * The fixture's loader sends `/photo.png` to a CDN and keeps
 * `/optimize/logo.png` on the default optimizer, written as Next.js's
 * loader-config-default-loader-with-file fixture writes it
 * (`/_next/image/?url=<raw src>&w=..&q=..`). That URL must then load: on a
 * Nitro build of a Pages Router app, vinext 1.0.1 answers `/_next/image` with
 * a 404 (the Pages handler only serves it through a Workers ASSETS binding),
 * so a second bundled fix hands it to the running Nitro app.
 *
 * This is a real build: `bun install --frozen-lockfile` the committed fixture
 * (exact pins + bun.lock) into a temp dir, apply knext's bundled vinext
 * patches, `vite build`, run `.output` under node and read what it serves.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVinextPatches } from "../cli/vinext-patches";

const FIXTURE = join(
    import.meta.dir,
    "fixtures",
    "vinext-image-loaderfile-app",
);

/** What the fixture's loader file returns for the default-optimizer image. */
const OPTIMIZED_SRC = "/_next/image/?url=/optimize/logo.png&w=828&q=50";
const OPTIMIZED_SRCSET =
    "/_next/image/?url=/optimize/logo.png&w=640&q=50 1x, /_next/image/?url=/optimize/logo.png&w=828&q=50 2x";

const tempRoots: string[] = [];
let srv: ChildProcess | undefined;
let base = "";
let log = "";

beforeAll(async () => {
    // The fixture carries exact pins plus a lockfile, so the install is
    // reproducible; it is copied out and never built in place.
    const root = mkdtempSync(join(tmpdir(), "knext-image-loaderfile-"));
    tempRoots.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    const sh = (cmd: string, args: string[]) => {
        const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
        if (r.status !== 0)
            throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`);
    };
    sh("bun", ["install", "--frozen-lockfile"]);
    applyVinextPatches(join(root, "node_modules", "vinext"));
    sh(join(root, "node_modules", ".bin", "vite"), ["build"]);

    const port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    srv = spawn("node", [".output/server/index.mjs"], {
        cwd: root,
        env: { ...process.env, PORT: String(port), NITRO_PORT: String(port) },
    });
    srv.stdout?.on("data", (d) => {
        log += d;
    });
    srv.stderr?.on("data", (d) => {
        log += d;
    });
    for (let i = 0; i < 40; i++) {
        try {
            await fetch(`${base}/`);
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    throw new Error(`the built server never answered\n${log}`);
}, 240_000);

afterAll(() => {
    srv?.kill("SIGKILL");
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

async function page(path: string): Promise<string> {
    const res = await fetch(base + path);
    expect({ status: res.status, log: res.status === 200 ? "" : log }).toEqual({
        status: 200,
        log: "",
    });
    return res.text();
}

function imgByAlt(html: string, alt: string): string {
    const img = [...html.matchAll(/<img\b[^>]*>/g)]
        .map((m) => m[0])
        .find((tag) => tag.includes(` alt="${alt}"`));
    expect(img).toBeDefined();
    return img ?? "";
}

const attr = (tag: string, name: string) =>
    new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]?.replaceAll("&amp;", "&");

describe("vinext x nitro: images.loaderFile", () => {
    it("renders next/image through the custom loader", async () => {
        const html = await page("/");
        expect(html).toContain("hello-loaderfile");
        // The rendered <img> must come from the configured loader file ...
        const img = imgByAlt(html, "a photo");
        expect(attr(img, "src")).toMatch(
            /^https:\/\/cdn\.knext-loaderfile\.test\/photo\.png\?w=\d+&q=auto$/,
        );
        // ... including the per-width srcSet, which the loader was asked for.
        expect(img).toContain("https://cdn.knext-loaderfile.test/photo.png?w=");
        // ... and never from vinext's built-in optimizer endpoint.
        expect(img).not.toContain("/_next/image");
    });

    it("a loader file that returns /_next/image/ URLs keeps default image optimization enabled (component and getImageProps)", async () => {
        for (const path of ["/", "/get-img-props"]) {
            const img = imgByAlt(await page(path), "optimized");
            expect({ path, src: attr(img, "src") }).toEqual({
                path,
                src: OPTIMIZED_SRC,
            });
            expect({ path, srcset: attr(img, "srcSet") }).toEqual({
                path,
                srcset: OPTIMIZED_SRCSET,
            });
        }
    });

    it("the default-optimizer URL the loader file emits serves the image", async () => {
        // A browser follows the trailing-slash 308 to /_next/image?..., which
        // must answer with the image itself (Next.js's test checks the <img>
        // loaded with a non-zero naturalWidth).
        const res = await fetch(base + OPTIMIZED_SRC, {
            headers: { Accept: "image/png,image/*" },
        });
        const body = new Uint8Array(await res.arrayBuffer());
        expect({
            status: res.status,
            type: res.headers.get("content-type"),
            url: new URL(res.url).pathname,
        }).toEqual({ status: 200, type: "image/png", url: "/_next/image" });
        // The PNG signature: the fixture's own image, not an error page.
        expect([...body.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it("a recursive /_next/image source is rejected, not fetched", async () => {
        const res = await fetch(
            `${base}/_next/image?url=${encodeURIComponent(`/_next/image?url=/optimize/logo.png&w=828&q=50`)}&w=828&q=50`,
        );
        expect(res.status).toBe(400);
    });
});
