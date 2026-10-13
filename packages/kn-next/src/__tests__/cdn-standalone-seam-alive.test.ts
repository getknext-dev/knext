// @vitest-environment node
//
// The CDN request-tag seam, proved ALIVE inside a real built standalone server
// (architecture rule §4 / ADR-0027; ADR-0068 D5.1).

import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BUN_BIN, NODE_BIN } from "../../../../tests/helpers/runtime-binaries";
import { stageCdnRoutingArtifact } from "../adapters/cdn-routing-artifact";
import { rawRequest } from "./cdn-test-harness";
import { type FakeCdn, startFakeCdn } from "./helpers/cdn-purge-fixtures";

/**
 * The seam has two halves that live in different places and meet only on
 * `globalThis`: the header preload (`cache-control-normalize.cjs` →
 * `cdn-edge.cjs`, loaded with `--require`) opens it, and the cache handler
 * (loaded by Next, by computed path, from the BUILT package) records into it.
 * Unit tests stub one half or the other. This file runs both REAL halves in a
 * REAL `next build` standalone server -- with the cache handler taken from the
 * package's built `dist`, exactly as an app ships it -- and asserts the result
 * on the wire:
 *
 *   - an ISR page's response carries the edge directive AND a `Cache-Tag` with
 *     the prefixed hashes of its explicit tag and of its implicit `_N_T_` path
 *     tag -- which only the cache handler knows (Next strips them from the
 *     response in non-minimal mode);
 *   - Next's own `revalidatePath` reaches the handler's purge, which sends the
 *     prefixed `_N_T_` tag to the CDN.
 *
 * If either side's `Symbol.for` key drifts, or the build duplicates a module so
 * the two halves stop sharing state, the tag never arrives and this goes red.
 *
 * NOTHING here skips: a missing precondition (dist not built, next missing) is
 * a FAILURE, never a silent pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const ADAPTERS = resolve(here, "../adapters");
const PRELOAD = join(ADAPTERS, "cache-control-normalize.cjs");
const ROUTE_FETCH = join(here, "fixtures", "cdn-route-purge-fetch.cjs");
const ADAPTER_SRC = join(ADAPTERS, "next-adapter.ts");
const NEXT_BIN = join(PKG_ROOT, "node_modules", "next", "dist", "bin", "next");
const DIST_HANDLER = join(PKG_ROOT, "dist", "adapters", "cache-handler.js");

const PREFIX = "abcdef012345";
const hex = (s: string, n: number) =>
    createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);
const nextTag = (t: string) => `kn-${PREFIX}-t${hex(t, 16)}`;
const EDGE = "cloudflare-cdn-cache-control";

const tempRoots: string[] = [];
const children: ChildProcess[] = [];
const cdns: FakeCdn[] = [];

function killTree(child: ChildProcess): void {
    if (!child.pid) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}

afterAll(async () => {
    for (const c of children) killTree(c);
    await Promise.all(cdns.map((c) => c.close()));
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

const tail = (s: string, n = 30) =>
    s.split("\n").filter(Boolean).slice(-n).join("\n");

function run(cmd: string, args: string[], cwd: string) {
    return new Promise<{ code: number | null; out: string }>((res) => {
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
        child.on("error", (err) =>
            res({ code: -1, out: `${out}\n${err.message}` }),
        );
        child.on("close", (code) => res({ code, out }));
    });
}

interface Built {
    serverDir: string;
    serverJs: string;
}

let builtOnce: Promise<Built> | undefined;

function buildApp(): Promise<Built> {
    builtOnce ??= (async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN}`,
        ).toBe(true);
        expect(
            existsSync(DIST_HANDLER),
            `${DIST_HANDLER} missing — run 'bun run build' in packages/kn-next first (CI builds @getknext/core before test)`,
        ).toBe(true);
        const made = mkdtempSync(join(tmpdir(), "knext-cdn-seam-alive-"));
        tempRoots.push(made);
        const root = realpathSync(made);
        const appDir = join(root, "app");
        symlinkSync(join(PKG_ROOT, "node_modules"), join(root, "node_modules"));
        cpSync(join(here, "fixtures", "cdn-seam-alive-app"), appDir, {
            recursive: true,
        });
        writeFileSync(
            join(appDir, "package.json"),
            JSON.stringify({ name: "cdn-seam-alive-app", private: true }),
        );
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
            join(appDir, "next.config.mjs"),
            [
                "export default {",
                `  adapterPath: ${JSON.stringify(adapterBundle)},`,
                '  outputFileTracingRoot: "/",',
                `  cacheHandler: ${JSON.stringify(DIST_HANDLER)},`,
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
        // The handler Next loads is the built one, traced into the standalone tree.
        const config = readFileSync(serverJs, "utf8");
        expect(config).toContain("cache-handler.js");
        return { serverDir, serverJs };
    })();
    return builtOnce;
}

async function serve(
    b: Built,
    runtime: "node" | "bun",
    cdn: FakeCdn,
    token: string,
) {
    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("KNEXT_") && k !== "REDIS_URL")
            env[k] = v;
    }
    Object.assign(env, {
        PORT: String(port),
        HOSTNAME: "",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        // What the operator renders for spec.cdn on the emulator row.
        KNEXT_CDN_PROVIDER: "emulator",
        KNEXT_CDN_TAG_PREFIX: PREFIX,
        KNEXT_CDN_HTML_TTL_SECONDS: "30",
        KNEXT_CDN_PURGE_TARGET: "zone-1",
        KNEXT_CDN_EMULATOR_ENDPOINT:
            "http://cdn-emulator.e2e.svc.cluster.local:8080",
        SEAM_ALIVE_CDN_PORT: String(cdn.port),
        SEAM_ALIVE_REVALIDATE_TOKEN: token,
    });
    const cmd = runtime === "bun" ? (BUN_BIN as string) : NODE_BIN;
    let log = "";
    const child = spawn(
        cmd,
        ["--require", ROUTE_FETCH, "--require", PRELOAD, b.serverJs],
        { cwd: b.serverDir, detached: true, env: env as NodeJS.ProcessEnv },
    );
    children.push(child);
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
                "GET /api/revalidate HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            );
            if (r.status > 0) break;
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline)
            throw new Error(`server did not come up:\n${tail(log)}`);
        await new Promise((r) => setTimeout(r, 200));
    }
    return { port, log: () => log };
}

const get = (port: number, path: string) =>
    rawRequest(
        port,
        `GET ${path} HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`,
    );

for (const runtime of ["node", "bun"] as const) {
    describe(`CDN seam alive in a built standalone server (${runtime})`, () => {
        it("the real handler's tags reach the real preload: Cache-Tag + edge header on an ISR page; revalidatePath purges the _N_T_ tag", async () => {
            const b = await buildApp();
            const cdn = await startFakeCdn();
            cdns.push(cdn);
            const token = randomUUID();
            const s = await serve(b, runtime, cdn, token);

            // The first request may render (an ISR miss can record the page's
            // tags after the first flush, which fails closed); a hit records
            // them on `get`. A cacheable page must carry the directive by the
            // second or third request.
            let tagged: Awaited<ReturnType<typeof get>> | undefined;
            for (let i = 0; i < 3; i++) {
                const r = await get(s.port, "/tagged");
                expect(r.status, s.log()).toBe(200);
                if (r.header(EDGE) !== undefined) {
                    tagged = r;
                    break;
                }
            }
            expect(
                tagged,
                `no edge directive on /tagged after 3 requests:\n${tail(s.log())}`,
            ).toBeDefined();
            const cacheTag = (tagged?.header("cache-tag") ?? "").split(",");
            expect(tagged?.header(EDGE)).toMatch(/^max-age=30\b/);
            expect(cacheTag).toContain(`kn-${PREFIX}`);
            expect(cacheTag).toContain(nextTag("posts"));
            expect(cacheTag).toContain(nextTag("_N_T_/tagged"));
            // Next's own tag header is still never leaked to clients.
            expect(tagged?.header("x-next-cache-tags")).toBeUndefined();
            // No Redis, so no first-ready purge: nothing sent yet.
            expect(cdn.requests).toEqual([]);

            // The mutating fixture route refuses without the token.
            const denied = await rawRequest(
                s.port,
                "POST /api/revalidate HTTP/1.1\r\nHost: example.com\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            expect(denied.status).toBe(401);

            const ok = await rawRequest(
                s.port,
                `POST /api/revalidate HTTP/1.1\r\nHost: example.com\r\nAuthorization: Bearer ${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
            );
            expect(ok.status, s.log()).toBe(200);
            const deadline = Date.now() + 15_000;
            const purged = () =>
                cdn.requests.flatMap(
                    (r) => (r.json as { tags?: string[] })?.tags ?? [],
                );
            while (
                !purged().includes(nextTag("_N_T_/tagged")) &&
                Date.now() < deadline
            ) {
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(purged(), tail(s.log())).toContain(nextTag("_N_T_/tagged"));
            expect(cdn.requests[0]?.url).toBe(
                "/client/v4/zones/zone-1/purge_cache",
            );
        }, 300_000);
    });
}
