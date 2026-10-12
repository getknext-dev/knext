// @vitest-environment node
//
// Boots a REAL `next build` (webpack) of two fixtures with the real knext adapter
// wired through `adapterPath`, then the standalone `server.js` as a child process
// on Node and on Bun, and talks to it with raw bytes over a socket.

import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
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

/**
 * THE SOUNDNESS TEST (ADR-0068 D4.1 condition 10, widened at gate r4).
 *
 * The CDN preload decides whether a path is matched by the app's middleware from
 * the wire request-target and the knext routing artifact; Next decides whether to
 * RUN the middleware from its own routing (locale insertion, percent-decoding,
 * dot-segment removal, data-route rewriting, basePath). Those are two
 * implementations of one question, and the dangerous failure is the preload
 * thinking a path is NOT middleware-protected when Next's middleware actually
 * ran on it: a CDN would then store the protected page for anonymous visitors.
 *
 * So the property under test is exactly:
 *
 *     Next's middleware ran on this request  =>  the preload refused to
 *     edge-cache it, or counted it as matched.
 *
 * The fixture middleware stamps every response it runs on with `x-mw-ran`. A
 * test-only preload records an own-entry `_N_T_` tag for every request (the cache
 * handler's write side belongs to another team this sprint), so every OTHER
 * condition of the allowlist is satisfied and the middleware / path conditions are
 * what is measured. Over-matching and refusal are both allowed; under-matching
 * fails. The reverse direction is not required: over-matching only costs hits.
 *
 * It runs against the REAL pinned Next on every run of the suite, so a Next bump
 * that changes how Next normalises a path (the Dependabot `next` PRs run this
 * file) reds here before it ships.
 *
 * TODO(#2259): ADR-0068 also wants this run in each compat-matrix Next cell, not
 * only at the pinned version. That is workflow wiring (a compat dispatch), left
 * for the lead: it costs a dispatch from the compat budget.
 *
 * NOTHING here skips: a missing precondition is a FAILURE, never a silent pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const ADAPTERS = resolve(here, "../adapters");
const PRELOAD = join(ADAPTERS, "cache-control-normalize.cjs");
const RECORDER = join(here, "fixtures", "cdn-soundness-record-tags.cjs");
const ADAPTER_SRC = join(ADAPTERS, "next-adapter.ts");
const NEXT_BIN = join(PKG_ROOT, "node_modules", "next", "dist", "bin", "next");
const COMPILE_SCRIPT = join(ADAPTERS, "standalone-compile.mjs");

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
});

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
    root: string;
    appDir: string;
    standaloneDir: string;
    serverDir: string;
    serverJs: string;
    buildId: string;
}

const built = new Map<string, Promise<Built>>();

function buildFixture(name: string, nextConfig: string): Promise<Built> {
    const existing = built.get(name);
    if (existing) return existing;
    const p = (async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN}`,
        ).toBe(true);
        const made = mkdtempSync(join(tmpdir(), `knext-${name}-`));
        tempRoots.push(made);
        const root = realpathSync(made);
        const appDir = join(root, "app");
        symlinkSync(join(PKG_ROOT, "node_modules"), join(root, "node_modules"));
        cpSync(join(here, "fixtures", name), appDir, { recursive: true });
        writeFileSync(
            join(appDir, "package.json"),
            JSON.stringify({ name, private: true }),
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
            `export default {\n  adapterPath: ${JSON.stringify(adapterBundle)},\n  outputFileTracingRoot: "/",\n  ${nextConfig}\n};\n`,
        );
        const res = await run("node", [NEXT_BIN, "build", "--webpack"], appDir);
        expect(
            res.code,
            `next build failed (exit ${res.code}):\n${tail(res.out)}`,
        ).toBe(0);
        const standaloneDir = join(appDir, ".next", "standalone");
        const serverDir = join(standaloneDir, relative("/", appDir));
        const serverJs = join(serverDir, "server.js");
        expect(
            existsSync(serverJs),
            `no standalone server.js:\n${tail(res.out)}`,
        ).toBe(true);
        // The adapter wrote the artifact beside Next's build output (onBuildComplete);
        // the build pipeline stages it into the standalone tree.
        expect(
            existsSync(join(appDir, ".next", "knext-cdn-routing.json")),
        ).toBe(true);
        expect(stageCdnRoutingArtifact(join(appDir, ".next"), serverDir)).toBe(
            true,
        );
        const buildId = readFileSync(
            join(appDir, ".next", "BUILD_ID"),
            "utf8",
        ).trim();
        return { root, appDir, standaloneDir, serverDir, serverJs, buildId };
    })();
    built.set(name, p);
    return p;
}

interface Served {
    port: number;
    stop: () => void;
}

async function serve(b: Built, runtime: "node" | "bun"): Promise<Served> {
    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("KNEXT_")) env[k] = v;
    }
    Object.assign(env, {
        PORT: String(port),
        HOSTNAME: "",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        KNEXT_CDN_PROVIDER: "cloudflare",
        KNEXT_CDN_TAG_PREFIX: "abcdef012345",
        KNEXT_CDN_HTML_TTL_SECONDS: "30",
    });
    const cmd = runtime === "bun" ? (BUN_BIN as string) : NODE_BIN;
    let log = "";
    const child = spawn(
        cmd,
        ["--require", RECORDER, "--require", PRELOAD, b.serverJs],
        {
            cwd: b.serverDir,
            detached: true,
            env: env as NodeJS.ProcessEnv,
        },
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
                "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            );
            if (r.status > 0) break;
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline)
            throw new Error(`server did not come up:\n${tail(log)}`);
        await new Promise((r) => setTimeout(r, 200));
    }
    return { port, stop: () => killTree(child) };
}

async function fetchRaw(port: number, target: string, host = "example.com") {
    return await rawRequest(
        port,
        `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    );
}

const EDGE = "cloudflare-cdn-cache-control";

/** Assert the soundness property over a corpus and return how many ran middleware. */
async function soundness(
    port: number,
    corpus: Array<[string, string?]>,
): Promise<{ ran: string[]; cached: string[]; total: number }> {
    const ran: string[] = [];
    const cached: string[] = [];
    for (const [target, host] of corpus) {
        const r = await fetchRaw(port, target, host);
        const hasEdge =
            r.header(EDGE) !== undefined || r.header("cache-tag") !== undefined;
        const label = `${host ?? "example.com"} ${target}`;
        if (r.header("x-mw-ran") !== undefined) {
            ran.push(label);
            expect(
                hasEdge,
                `UNSOUND: Next's middleware ran on ${label} but the preload would edge-cache it`,
            ).toBe(false);
        }
        if (hasEdge) cached.push(label);
    }
    return { ran, cached, total: corpus.length };
}

for (const runtime of ["node", "bun"] as const) {
    describe(`CDN soundness: app router with basePath, real Next (${runtime})`, () => {
        it("Next's middleware ran => the preload refused or matched, over the widened corpus", async () => {
            const b = await buildFixture(
                "cdn-soundness-app",
                `basePath: "/base",`,
            );
            const s = await serve(b, runtime);
            try {
                const P = "/base";
                const corpus: Array<[string, string?]> = [
                    `${P}/dashboard`,
                    `${P}/dashboard/`,
                    `${P}/Dashboard`,
                    `${P}/DASHBOARD/`,
                    `${P}/%64ashboard`,
                    `${P}/%64ashboard/`,
                    `${P}/%44ashboard`,
                    `${P}/%2564ashboard`, // double-encoded
                    `${P}/%E0%A4%A`, // malformed escape
                    `${P}/dashboard%2F`,
                    `${P}/dashboard%2f..%2fopen`,
                    `${P}/x/%2e%2e/dashboard`,
                    `${P}/x/%2E%2E/dashboard`,
                    `${P}/x/../dashboard`,
                    `${P}/./dashboard`,
                    `${P}/open/../dashboard`,
                    `${P}//dashboard`,
                    `${P}/dashboard//`,
                    `${P}/\\dashboard`,
                    `${P}/%5cdashboard`,
                    `${P}/x/%2F..%2Fdashboard`,
                    `${P}/dashboard?x=1`,
                    `${P}/dashboard/extra`,
                    `${P}/dashboard.json`,
                    `/dashboard`, // outside the basePath
                    `/base/%2e%2e/base/dashboard`,
                    // unmatched paths, to keep the corpus honest
                    `${P}/open`,
                    `${P}/blog/a`,
                    `${P}/`,
                ].map((t) => [t]);
                const out = await soundness(s.port, corpus);
                // Not vacuous: the middleware really ran on a good part of the corpus...
                expect(
                    out.ran.length,
                    `middleware ran on only: ${out.ran.join(" | ")}`,
                ).toBeGreaterThanOrEqual(8);
                // ...and the preload really does cache the unmatched pages (so the
                // green cases are green because of the check, not because nothing caches).
                expect(out.cached).toContain(`example.com ${P}/open`);
                expect(out.cached).toContain(`example.com ${P}/blog/a`);
            } finally {
                s.stop();
            }
        }, 300_000);
    });

    describe(`CDN soundness: pages router with i18n domains and data routes, real Next (${runtime})`, () => {
        it("Next's middleware ran => the preload refused or matched, over the widened corpus", async () => {
            const b = await buildFixture(
                "cdn-soundness-pages",
                `i18n: { locales: ["en", "fr"], defaultLocale: "en", domains: [{ domain: "example.com", defaultLocale: "en" }, { domain: "example.fr", defaultLocale: "fr" }] },`,
            );
            const s = await serve(b, runtime);
            try {
                const id = b.buildId;
                const corpus: Array<[string, string?]> = [
                    ["/dashboard", "example.com"],
                    ["/dashboard", "example.fr"], // the Host decides the locale
                    ["/fr/dashboard", "example.com"],
                    ["/en/dashboard", "example.fr"],
                    ["/dashboard/", "example.com"],
                    ["/Dashboard", "example.com"],
                    ["/%64ashboard", "example.com"],
                    ["/%64ashboard", "example.fr"],
                    ["/%2564ashboard", "example.com"],
                    ["/%E0%A4%A", "example.com"],
                    ["/x/%2e%2e/dashboard", "example.com"],
                    ["/./dashboard", "example.fr"],
                    [`/_next/data/${id}/dashboard.json`, "example.com"],
                    [`/_next/data/${id}/fr/dashboard.json`, "example.com"],
                    [`/_next/data/${id}/en/dashboard.json`, "example.fr"],
                    [
                        "/_next/data/stale-build-id/dashboard.json",
                        "example.com",
                    ],
                    ["/_next/data/forged/dashboard.json", "example.fr"],
                    [`/_next/data/${id}/%64ashboard.json`, "example.com"],
                    // unmatched paths
                    ["/", "example.com"],
                    ["/", "example.fr"],
                    ["/blog/a", "example.com"],
                ];
                const out = await soundness(s.port, corpus);
                expect(
                    out.ran.length,
                    `middleware ran on only: ${out.ran.join(" | ")}`,
                ).toBeGreaterThanOrEqual(8);
                // The conservative i18n rule (any matcher + i18n => every path matched):
                // NOTHING is edge-cached on this app by default. That is the stated cost.
                expect(out.cached).toEqual([]);
            } finally {
                s.stop();
            }
        }, 300_000);
    });
}

describe("CDN soundness harness can see red", () => {
    it("a request the middleware ran on and the preload would cache is flagged", async () => {
        // Run the app fixture WITHOUT the routing artifact being "none-ified": simulate
        // an under-matching preload by serving the same build with an artifact that
        // claims there is no middleware, then assert the property fails.
        const b = await buildFixture("cdn-soundness-app", `basePath: "/base",`);
        const artifactPath = join(
            b.serverDir,
            ".next",
            "knext-cdn-routing.json",
        );
        const saved = readFileSync(artifactPath, "utf8");
        writeFileSync(
            artifactPath,
            JSON.stringify({
                version: 1,
                basePath: "/base",
                i18n: null,
                middleware: "none",
            }),
        );
        const s = await serve(b, "node");
        try {
            const r = await fetchRaw(s.port, "/base/dashboard");
            expect(r.header("x-mw-ran")).toBeDefined(); // the middleware ran...
            expect(r.header(EDGE)).toBeDefined(); // ...and an under-matching artifact lets it be cached
        } finally {
            s.stop();
            writeFileSync(artifactPath, saved);
        }
    }, 300_000);
});

describe("the compiled executable (disk mode) runs the CDN preload and finds the staged artifact (D11)", () => {
    it("a compiled binary bundles the preload's relative require and reads knext-cdn-routing.json", async () => {
        const b = await buildFixture("cdn-soundness-app", `basePath: "/base",`);
        const outfile = join(b.root, "knext-exec");
        const compiled = await run(
            BUN_BIN as string,
            [
                COMPILE_SCRIPT,
                "--server",
                b.serverJs,
                "--root",
                b.standaloneDir,
                "--outfile",
                outfile,
            ],
            b.root,
        );
        expect(
            compiled.code,
            `standalone compile failed (exit ${compiled.code}):\n${tail(compiled.out)}`,
        ).toBe(0);
        const port = await freePort();
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined && !k.startsWith("KNEXT_")) env[k] = v;
        }
        Object.assign(env, {
            PORT: String(port),
            HOSTNAME: "",
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            // Disk mode: the executable serves the tree it was compiled from.
            KNEXT_STANDALONE_DIR: b.serverDir,
            KNEXT_CDN_PROVIDER: "cloudflare",
            KNEXT_CDN_TAG_PREFIX: "abcdef012345",
        });
        let log = "";
        const child = spawn(outfile, [], {
            cwd: b.serverDir,
            detached: true,
            env: env as NodeJS.ProcessEnv,
        });
        servers.push(child);
        child.stdout?.on("data", (d) => {
            log += String(d);
        });
        child.stderr?.on("data", (d) => {
            log += String(d);
        });
        try {
            const deadline = Date.now() + 60_000;
            for (;;) {
                try {
                    const r = await fetchRaw(port, "/base/open");
                    if (r.status > 0) break;
                } catch {
                    // not listening yet
                }
                if (Date.now() > deadline) {
                    throw new Error(`binary did not answer:\n${tail(log)}`);
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            // The first response runs the decision, which loads the artifact lazily.
            expect(log).toContain(
                `CDN_EDGE: provider=cloudflare routing artifact loaded (${join(b.serverDir, ".next")})`,
            );
            expect(log).not.toContain("routing artifact missing");
        } finally {
            killTree(child);
        }
    }, 600_000);
});
