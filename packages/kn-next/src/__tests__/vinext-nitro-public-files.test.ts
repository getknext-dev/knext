/**
 * `public/` files under a vinext + Nitro `node` build.
 *
 * Two behaviours knext used to patch into vinext itself, now shipped by vinext:
 *
 *   - a rewrite whose destination is a `public/` file serves that file (the
 *     Pages Router for all three rewrite phases, the App Router for
 *     `beforeFiles`, `afterFiles`, `fallback` and middleware rewrites) instead
 *     of the 404 page or an empty 200;
 *   - middleware runs before a `public/` file its `matcher` covers, as with
 *     `next start`, and a file the matcher does not cover keeps the static
 *     fast path.
 *
 * This is a real build, not a mechanism test: each scenario copies a committed
 * fixture (exact pins plus a lockfile) into a temp dir, writes the `public/`
 * files, a `next.config` with the rewrites and a middleware beside it,
 * `bun install --frozen-lockfile`s, runs `vite build` and requests the files
 * from the built `.output` server under node. No knext patch is applied: the
 * point is that the unpatched vinext already behaves. (On vinext 1.1.0 the same
 * requests answered 404, an empty 200, or skipped the middleware.)
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForHttpOk } from "./helpers/wait-for-http-ok";

const tempRoots: string[] = [];
// Explicit timeout: removing a node_modules tree under CPU contention blows
// bun's default hook timeout.
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
}, 120_000);

const FIXTURES = join(import.meta.dir, "fixtures");

const NEXT_CONFIG = `export default {
    async rewrites() {
        return {
            beforeFiles: [{ source: "/before/file.txt", destination: "/file.txt" }],
            afterFiles: [{ source: "/after/file.txt", destination: "/file.txt" }],
            fallback: [{ source: "/fallback/file.txt", destination: "/file.txt" }],
        };
    },
};
`;

// Covers one public file, one rewrite source and one path it rewrites itself.
const MIDDLEWARE = `import { NextResponse } from "next/server";
export function middleware(request) {
    if (request.nextUrl.pathname === "/mw-rewrite") {
        return NextResponse.rewrite(new URL("/file.txt", request.url));
    }
    const res = NextResponse.next();
    res.headers.set("x-mw", "ran");
    return res;
}
export const config = {
    matcher: ["/covered.txt", "/before/:path*", "/mw-rewrite"],
};
`;

const NODE_VITE_CONFIG = `import { nitro } from "nitro/vite";
import vinext from "vinext";
import { defineConfig } from "vite";
export default defineConfig({
    plugins: [vinext(), nitro({ preset: "node" })],
});
`;

interface Built {
    /** GET a path from the built node server. */
    get: (path: string) => Promise<{
        status: number;
        body: string;
        mw: string | null;
    }>;
    log: () => string;
    stop: () => void;
}

/** Copy a fixture, lay the scenario's files over it, install, build and serve it. */
async function buildAndServe(
    fixture: string,
    files: Record<string, string>,
    remove: string[] = [],
): Promise<Built> {
    const root = mkdtempSync(join(tmpdir(), "knext-nitro-public-"));
    tempRoots.push(root);
    cpSync(join(FIXTURES, fixture), root, { recursive: true });
    for (const rel of remove) rmSync(join(root, rel), { force: true });
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), text);
    }
    const sh = (cmd: string, args: string[]) => {
        const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
        if (r.status !== 0)
            throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`);
    };
    sh("bun", ["install", "--frozen-lockfile"]);
    sh(join(root, "node_modules", ".bin", "vite"), ["build"]);

    const port = 20000 + Math.floor(Math.random() * 20000);
    const srv = spawn("node", [".output/server/index.mjs"], {
        cwd: root,
        env: { ...process.env, PORT: String(port), NITRO_PORT: String(port) },
    });
    let log = "";
    srv.stdout.on("data", (d) => {
        log += d;
    });
    srv.stderr.on("data", (d) => {
        log += d;
    });
    let exited: string | null = null;
    srv.on("exit", (code, signal) => {
        exited = `code=${code} signal=${signal}`;
    });
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${origin}/plain.txt`, {
        deadlineMs: 90_000,
        log: () => log,
        exited: () => exited,
    });
    return {
        get: async (path) => {
            const res = await fetch(`${origin}${path}`, { redirect: "manual" });
            return {
                status: res.status,
                body: (await res.text()).trim(),
                mw: res.headers.get("x-mw"),
            };
        },
        log: () => log,
        stop: () => {
            srv.kill("SIGKILL");
        },
    };
}

const PUBLIC_FILES = {
    "public/plain.txt": "plain-body\n",
    "public/covered.txt": "covered-body\n",
    "public/file.txt": "public-file-body\n",
};

/** The assertions both routers share. */
async function expectPublicFileBehaviour(app: Built) {
    // A public file nothing covers: served straight, no middleware.
    const plain = await app.get("/plain.txt");
    expect(plain).toEqual({ status: 200, body: "plain-body", mw: null });

    // Middleware runs before a public file its matcher covers.
    const covered = await app.get("/covered.txt");
    expect(covered).toEqual({ status: 200, body: "covered-body", mw: "ran" });

    // A rewrite to a public file serves that file, in every phase...
    const before = await app.get("/before/file.txt");
    expect(before).toEqual({
        status: 200,
        body: "public-file-body",
        mw: "ran",
    });
    const after = await app.get("/after/file.txt");
    expect(after.status).toBe(200);
    expect(after.body).toBe("public-file-body");
    const fallback = await app.get("/fallback/file.txt");
    expect(fallback.status).toBe(200);
    expect(fallback.body).toBe("public-file-body");

    // ...and when the middleware itself does the rewriting.
    const viaMiddleware = await app.get("/mw-rewrite");
    expect(viaMiddleware.status).toBe(200);
    expect(viaMiddleware.body).toBe("public-file-body");
}

describe("vinext x nitro: public files, rewrites to them and middleware before them", () => {
    it("Pages Router: unpatched vinext serves them as Next.js does", async () => {
        const app = await buildAndServe("vinext-styled-jsx-app", {
            ...PUBLIC_FILES,
            "next.config.mjs": NEXT_CONFIG,
            "middleware.js": MIDDLEWARE,
        });
        try {
            // (The fixture's only page uses <style jsx>, which needs the
            // react-tracing fix this test deliberately leaves out; the
            // files are what is under test.)
            await expectPublicFileBehaviour(app);
        } finally {
            app.stop();
        }
    }, 300_000);

    it("App Router: unpatched vinext serves them as Next.js does", async () => {
        const app = await buildAndServe(
            "vinext-bun-og-app",
            {
                ...PUBLIC_FILES,
                "next.config.mjs": NEXT_CONFIG,
                "middleware.js": MIDDLEWARE,
                "vite.config.mjs": NODE_VITE_CONFIG,
            },
            // The fixture's own bun-preset config and TypeScript next.config.
            ["vite.config.ts", "next.config.ts"],
        );
        try {
            await expectPublicFileBehaviour(app);
            const page = await app.get("/");
            expect(page.status).toBe(200);
            expect(page.body).toContain("knext vinext-bun-og fixture");
        } finally {
            app.stop();
        }
    }, 300_000);
});
