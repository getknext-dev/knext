// @vitest-environment node
//
// A proxied (external-style) middleware rewrite must not carry the INNER
// response's edge directive onto the OUTER, middleware-matched response
// (ADR-0068 D4.1 condition 10; Amendment 2).

import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { BUN_BIN, NODE_BIN } from "../../../../tests/helpers/runtime-binaries";
import { stageCdnRoutingArtifact } from "../adapters/cdn-routing-artifact";
import { rawRequest } from "./cdn-test-harness";

/**
 * THE REPRO (the CDN-3a fixture `fixtures/cdn-kind-app`, real `next build`, the
 * real knext adapter and cache handler, the standalone server on Node and Bun).
 *
 * `proxy.ts` rewrites `/variant` by cookie with `new URL('/variant-a',
 * request.url)`. Bound to `127.0.0.1`, Next's `request.url` host is `localhost`,
 * so the destination is a DIFFERENT origin and Next handles the rewrite as an
 * EXTERNAL one: it proxies it over HTTP. The proxied inner request reaches the
 * preload as a fresh request on an unmatched path, gets an allowed edge
 * decision and edge headers, and Next copies the inner response's headers onto
 * the outer response, whose path IS middleware-matched (condition 10). Before
 * the fix the outer `/variant` response left the origin carrying
 * `cloudflare-cdn-cache-control` and `cache-tag`, and a Vary-ignoring CDN served
 * variant A to a variant-B visitor.
 *
 * The preconditions are asserted, not assumed, so this cannot go green by the
 * rewrite turning internal (`x-middleware-rewrite` must be the absolute
 * loopback URL) or by nothing being edge-cacheable at all (`/variant-a`
 * requested directly must carry the edge directive).
 *
 * NOTHING here skips: a missing precondition is a FAILURE, never a silent pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const ADAPTERS = resolve(here, "../adapters");
const ADAPTER_SRC = join(ADAPTERS, "next-adapter.ts");
const HANDLER_SRC = join(ADAPTERS, "cache-handler.js");
const PRELOADS = ["cache-control-normalize.cjs", "public-origin.cjs"].map((f) =>
    join(ADAPTERS, f),
);
const NEXT_BIN = join(PKG_ROOT, "node_modules", "next", "dist", "bin", "next");
const FIXTURE = join(here, "fixtures", "cdn-kind-app");
const PREFIX = "0123456789ab";
const EDGE = "cloudflare-cdn-cache-control";

const tempRoots: string[] = [];
const servers: ChildProcess[] = [];

function killTree(child: ChildProcess): void {
    if (!child.pid) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}

afterAll(() => {
    for (const s of servers) killTree(s);
    for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
}, 120_000);

async function freePort(): Promise<number> {
    return await new Promise((res, rej) => {
        const srv = createServer();
        srv.on("error", rej);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => res(port));
        });
    });
}

function run(
    cmd: string,
    args: string[],
    cwd: string,
): Promise<{ code: number | null; out: string }> {
    return new Promise((res) => {
        let out = "";
        const child = spawn(cmd, args, {
            cwd,
            env: {
                ...process.env,
                NEXT_TELEMETRY_DISABLED: "1",
                NODE_ENV: "production",
                CI: "1",
            },
        });
        child.stdout?.on("data", (b) => {
            out += String(b);
        });
        child.stderr?.on("data", (b) => {
            out += String(b);
        });
        child.on("error", (err) => {
            out += `\nspawn error: ${err.message}`;
            res({ code: -1, out });
        });
        child.on("close", (code) => res({ code, out }));
    });
}

const tail = (s: string, n = 30) =>
    s.split("\n").filter(Boolean).slice(-n).join("\n");

interface Built {
    serverDir: string;
    serverJs: string;
}

let builtOnce: Promise<Built> | undefined;

/**
 * The fixture is TypeScript, and Next refuses to build TypeScript without
 * `typescript` and `@types/react` installed, which this package does not
 * depend on. The COPY is transpiled to JavaScript (same code, types erased)
 * and its tsconfig dropped; the fixture in the repo is untouched.
 */
async function transpileToJs(dir: string): Promise<void> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            await transpileToJs(p);
            continue;
        }
        const ext = extname(entry.name);
        if (ext !== ".ts" && ext !== ".tsx") continue;
        const out = await transform(readFileSync(p, "utf8"), {
            loader: ext === ".tsx" ? "tsx" : "ts",
            jsx: "automatic",
        });
        writeFileSync(p.slice(0, -ext.length) + ".js", out.code);
        rmSync(p);
    }
    rmSync(join(dir, "tsconfig.json"), { force: true });
}

/**
 * Build a copy of the fixture with the knext adapter and cache handler taken
 * from SOURCE (the fixture's one-line re-exports point at the published package
 * names, which a source checkout does not install).
 */
function buildFixture(): Promise<Built> {
    if (builtOnce) return builtOnce;
    builtOnce = (async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN}`,
        ).toBe(true);
        const made = mkdtempSync(join(tmpdir(), "knext-cdn-foreign-rewrite-"));
        tempRoots.push(made);
        const root = realpathSync(made);
        // The package's own dependencies: next, react, react-dom.
        symlinkSync(join(PKG_ROOT, "node_modules"), join(root, "node_modules"));
        const appDir = join(root, "app");
        cpSync(FIXTURE, appDir, { recursive: true });
        await transpileToJs(appDir);
        const adapterBundle = join(root, "adapter.mjs");
        await build({
            entryPoints: [ADAPTER_SRC],
            outfile: adapterBundle,
            bundle: true,
            format: "esm",
            platform: "node",
            target: "node20",
            packages: "external",
        });
        writeFileSync(
            join(appDir, "next-adapter.mjs"),
            `export { default } from ${JSON.stringify(adapterBundle)};\n`,
        );
        writeFileSync(
            join(appDir, "cache-handler.js"),
            `export { default } from ${JSON.stringify(HANDLER_SRC)};\n`,
        );
        writeFileSync(
            join(appDir, "package.json"),
            JSON.stringify({ name: "cdn-kind-app", private: true }),
        );
        // The fixture's config, with the trace root widened to `/` so the
        // source cache handler (outside the app) is traced too.
        writeFileSync(
            join(appDir, "next.config.mjs"),
            [
                "export default {",
                '  output: "standalone",',
                "  typescript: { ignoreBuildErrors: true },",
                '  outputFileTracingRoot: "/",',
                `  adapterPath: ${JSON.stringify(join(appDir, "next-adapter.mjs"))},`,
                `  cacheHandler: ${JSON.stringify(join(appDir, "cache-handler.js"))},`,
                "  cacheMaxMemorySize: 0,",
                "};",
                "",
            ].join("\n"),
        );
        const res = await run("node", [NEXT_BIN, "build", "--webpack"], appDir);
        expect(
            res.code,
            `next build failed (exit ${res.code}):\n${tail(res.out)}`,
        ).toBe(0);
        const serverDir = join(
            appDir,
            ".next",
            "standalone",
            relative("/", appDir),
        );
        const serverJs = join(serverDir, "server.js");
        expect(
            existsSync(serverJs),
            `no standalone server.js:\n${tail(res.out)}`,
        ).toBe(true);
        expect(stageCdnRoutingArtifact(join(appDir, ".next"), serverDir)).toBe(
            true,
        );
        return { serverDir, serverJs };
    })();
    return builtOnce;
}

async function serve(b: Built, runtime: "node" | "bun") {
    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("KNEXT_") && k !== "REDIS_URL")
            env[k] = v;
    }
    Object.assign(env, {
        PORT: String(port),
        // The bind that makes Next's `request.url` host (`localhost`) differ
        // from the server's own origin: the hole's precondition.
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        KNEXT_CDN_PROVIDER: "emulator",
        KNEXT_CDN_TAG_PREFIX: PREFIX,
        KNEXT_CDN_HTML_TTL_SECONDS: "30",
    });
    const cmd = runtime === "bun" ? (BUN_BIN as string) : NODE_BIN;
    let log = "";
    const child = spawn(
        cmd,
        [...PRELOADS.flatMap((p) => ["--require", p]), b.serverJs],
        { cwd: b.serverDir, detached: true, env: env as NodeJS.ProcessEnv },
    );
    servers.push(child);
    child.stdout?.on("data", (d) => {
        log += String(d);
    });
    child.stderr?.on("data", (d) => {
        log += String(d);
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
        try {
            const r = await rawRequest(
                port,
                "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            if (r.status > 0) break;
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline)
            throw new Error(`server did not come up:\n${tail(log)}`);
        await new Promise((r) => setTimeout(r, 200));
    }
    return { port, log: () => log, stop: () => killTree(child) };
}

function getRaw(port: number, target: string, cookie?: string) {
    return rawRequest(
        port,
        [
            `GET ${target} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            ...(cookie ? [`Cookie: ${cookie}`] : []),
            "Connection: close",
            "",
            "",
        ].join("\r\n"),
    );
}

for (const runtime of ["node", "bun"] as const) {
    describe(`CDN: a proxied middleware rewrite on a 127.0.0.1 bind, real Next (${runtime})`, () => {
        it("the outer, middleware-matched response carries no edge directive and no cache tag", async () => {
            const b = await buildFixture();
            const s = await serve(b, runtime);
            try {
                // Precondition 1: the inner page IS edge-cacheable on its own, so
                // the headers the rewrite would carry over really exist. (Twice:
                // the first request may render, the second is a HIT.)
                await getRaw(s.port, "/variant-a");
                const inner = await getRaw(s.port, "/variant-a");
                expect(inner.status, s.log()).toBe(200);
                expect(inner.header(EDGE), inner.head).toBe("max-age=30");
                expect(inner.header("cache-tag"), inner.head).toContain(
                    `kn-${PREFIX}`,
                );

                for (const [cookie, body] of [
                    ["v=a", "VARIANT-A-BODY"],
                    ["v=b", "VARIANT-B-BODY"],
                ] as const) {
                    const r = await getRaw(s.port, "/variant", cookie);
                    expect(r.status, `${r.head}\n${s.log()}`).toBe(200);
                    expect(r.body).toContain(body);
                    // Precondition 2: the rewrite was handled as EXTERNAL (proxied
                    // over HTTP to an absolute loopback URL), not internally.
                    expect(r.header("x-middleware-rewrite") ?? "").toMatch(
                        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/variant-/,
                    );
                    // The fix: none of the inner response's edge headers survive.
                    expect(r.header(EDGE), r.head).toBeUndefined();
                    expect(
                        r.header("cdn-cache-control"),
                        r.head,
                    ).toBeUndefined();
                    expect(r.header("cache-tag"), r.head).toBeUndefined();
                }
            } finally {
                s.stop();
            }
        }, 300_000);
    });
}
