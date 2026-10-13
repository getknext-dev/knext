/**
 * Build and serve the CDN-3a fixture (`fixtures/cdn-kind-app`) for real: a REAL
 * `next build` (webpack) with the knext adapter and cache handler taken from
 * SOURCE, then the standalone `server.js` on Node or Bun with the CDN preloads
 * loaded the way the runtime image loads them. Shared by the repro tests that
 * need the real Next routing / cache paths rather than a stand-in.
 *
 * NOTHING here skips: a missing precondition is a FAILURE, never a silent pass.
 */
import { expect } from "bun:test";
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
import { type RawResponse, rawRequest } from "./cdn-test-harness";

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

export const KIND_PREFIX = "0123456789ab";

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

/** Kill every server and remove every build. Register with `afterAll`. */
export function cleanupKindApp(): void {
    for (const s of servers.splice(0)) killTree(s);
    for (const d of tempRoots.splice(0))
        rmSync(d, { recursive: true, force: true });
}

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
    env: Record<string, string> = {},
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
                ...env,
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

export const tail = (s: string, n = 30) =>
    s.split("\n").filter(Boolean).slice(-n).join("\n");

/**
 * The fixture is TypeScript, and Next refuses to build TypeScript without
 * `typescript` and `@types/react` installed, which this package does not
 * depend on. The COPY is transpiled to JavaScript (same code, types erased;
 * module syntax preserved, so Next's static `export const revalidate` /
 * `config` analysis still sees it) and its tsconfig dropped. The fixture in the
 * repo is untouched.
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

export interface Built {
    serverDir: string;
    serverJs: string;
    buildId: string;
}

const builds = new Map<string, Promise<Built>>();

/**
 * Build a copy of the fixture. `buildId` is the deploy tag, wired exactly as
 * the fixture wires it (`generateBuildId`, and the build mark the pages print).
 * Each distinct `buildId` is one build, reused within the file.
 */
export function buildKindApp(buildId = ""): Promise<Built> {
    const existing = builds.get(buildId);
    if (existing) return existing;
    const p = (async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN}`,
        ).toBe(true);
        const made = mkdtempSync(join(tmpdir(), "knext-cdn-kind-app-"));
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
        // The fixture's one-line re-exports name the published package, which a
        // source checkout does not install: point them at the source.
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
        // The fixture's own config, with the trace root widened to `/` so the
        // source cache handler (outside the app) is traced too.
        writeFileSync(
            join(appDir, "next.config.mjs"),
            [
                "export default {",
                '  output: "standalone",',
                "  typescript: { ignoreBuildErrors: true },",
                '  outputFileTracingRoot: "/",',
                `  generateBuildId: () => ${JSON.stringify(buildId || null)},`,
                `  env: { KNEXT_E2E_BUILD_MARK: ${JSON.stringify(buildId || "unset")} },`,
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
        const id = readFileSync(
            join(appDir, ".next", "BUILD_ID"),
            "utf8",
        ).trim();
        if (buildId) expect(id).toBe(buildId);
        return { serverDir, serverJs, buildId: id };
    })();
    builds.set(buildId, p);
    return p;
}

export interface Served {
    port: number;
    log(): string;
    stop(): void;
}

/** Serve a build on `127.0.0.1` with the CDN preloads (emulator row). */
export async function serveKindApp(
    b: Built,
    runtime: "node" | "bun",
    extraEnv: Record<string, string> = {},
): Promise<Served> {
    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("KNEXT_") && k !== "REDIS_URL")
            env[k] = v;
    }
    Object.assign(env, {
        PORT: String(port),
        // The bind that makes Next's `request.url` host (`localhost`) differ
        // from the server's own origin.
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        KNEXT_CDN_PROVIDER: "emulator",
        KNEXT_CDN_TAG_PREFIX: KIND_PREFIX,
        KNEXT_CDN_HTML_TTL_SECONDS: "30",
        ...extraEnv,
    });
    const cmd = runtime === "bun" ? (BUN_BIN as string) : NODE_BIN;
    let log = "";
    const child = spawn(
        cmd,
        [...PRELOADS.flatMap((p) => ["--require", p]), b.serverJs],
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

/** A raw GET, so nothing normalises the request-target. */
export function getRaw(
    port: number,
    target: string,
    cookie?: string,
): Promise<RawResponse> {
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
