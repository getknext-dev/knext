// @vitest-environment node
//
// The `'use cache'` metrics seam, proved ALIVE in a real built standalone server
// (architecture rule §4 / ADR-0027).

import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdtempSync,
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

/**
 * The seam's two halves meet only on `globalThis`: the use-cache handler (loaded
 * by Next through `cacheHandlers`, from the BUILT package) publishes a render
 * function, and the loopback metrics listener the instrumentation starts (also
 * from the built package, but bundled by webpack into the instrumentation chunk)
 * reads it. The BUILT supervisor then merges that listener onto the app's
 * metrics port, from a separate process. Unit tests call each half directly;
 * this file runs all three REAL pieces and asserts on the scraped body:
 *
 *   - a request to a route whose `'use cache'` function runs on every request
 *     (there is no Redis, so it is a miss and a dropped write) moves the
 *     `miss` and `dropped` events of `knext_use_cache_events_total`;
 *   - the family is declared once, beside the supervisor's own metrics.
 *
 * If either side's `Symbol.for` key drifts, or the build duplicates a module so
 * the halves stop sharing state, the counter never arrives and this goes red.
 *
 * NOTHING here skips: a missing precondition (dist not built, next missing) is
 * a FAILURE, never a silent pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const ADAPTERS = resolve(here, "../adapters");
const ADAPTER_SRC = join(ADAPTERS, "next-adapter.ts");
const NEXT_BIN = join(PKG_ROOT, "node_modules", "next", "dist", "bin", "next");
const DIST = join(PKG_ROOT, "dist", "adapters");
const DIST_HANDLER = join(DIST, "cache-handler.js");
const DIST_USE_CACHE = join(DIST, "use-cache-handler-node.js");
const DIST_USE_CACHE_REMOTE = join(DIST, "use-cache-handler-remote-node.js");
const DIST_LITE = join(DIST, "deep-health-lite.js");
const DIST_SUPERVISOR = join(DIST, "node-server.js");

const tempRoots: string[] = [];
const children: ChildProcess[] = [];

function killTree(child: ChildProcess): void {
    if (!child.pid) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}

afterAll(() => {
    for (const c of children) killTree(c);
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

let builtOnce: Promise<{ serverDir: string; serverJs: string }> | undefined;

function buildApp() {
    builtOnce ??= (async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN}`,
        ).toBe(true);
        for (const built of [
            DIST_HANDLER,
            DIST_USE_CACHE,
            DIST_USE_CACHE_REMOTE,
            DIST_LITE,
            DIST_SUPERVISOR,
        ]) {
            expect(
                existsSync(built),
                `${built} missing — run 'bun run build' in packages/kn-next first (CI builds @getknext/core before test)`,
            ).toBe(true);
        }
        const made = mkdtempSync(join(tmpdir(), "knext-uc-metrics-alive-"));
        tempRoots.push(made);
        const root = realpathSync(made);
        const appDir = join(root, "app");
        symlinkSync(join(PKG_ROOT, "node_modules"), join(root, "node_modules"));
        cpSync(join(here, "fixtures", "use-cache-metrics-app"), appDir, {
            recursive: true,
        });
        writeFileSync(
            join(appDir, "package.json"),
            JSON.stringify({ name: "use-cache-metrics-app", private: true }),
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
        // The shape `knext build` gives a Cache Components app: the knext
        // adapter, the singular handler, and `cacheHandlers` pointed at the
        // BUILT use-cache entries (named here: the adapter resolves them by
        // package self-reference, which a temp dir cannot do).
        writeFileSync(
            join(appDir, "next.config.mjs"),
            [
                "export default {",
                `  adapterPath: ${JSON.stringify(adapterBundle)},`,
                '  outputFileTracingRoot: "/",',
                "  cacheComponents: true,",
                `  cacheHandler: ${JSON.stringify(DIST_HANDLER)},`,
                "  cacheHandlers: {",
                `    default: ${JSON.stringify(DIST_USE_CACHE)},`,
                `    remote: ${JSON.stringify(DIST_USE_CACHE_REMOTE)},`,
                "  },",
                "  cacheMaxMemorySize: 0,",
                "};",
                "",
            ].join("\n"),
        );
        // What the scaffolded instrumentation does with tracing off: start the
        // dependency-free loopback metrics listener from the BUILT package.
        writeFileSync(
            join(appDir, "instrumentation.ts"),
            [
                "export async function register() {",
                "  if (process.env.NEXT_RUNTIME !== 'nodejs') return;",
                `  const { startDeepHealthLite } = await import(${JSON.stringify(DIST_LITE)});`,
                "  startDeepHealthLite();",
                "}",
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
        return { serverDir, serverJs };
    })();
    return builtOnce;
}

async function scrape(port: number): Promise<string> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        return res.ok ? await res.text() : "";
    } catch {
        return "";
    }
}

async function get(port: number, path: string) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: res.status, body: await res.text() };
    } catch {
        return { status: 0, body: "" };
    }
}

/** The value of one event's sample, or undefined when it is not served. */
function event(body: string, name: string): number | undefined {
    const m = new RegExp(
        `^knext_use_cache_events_total\\{event="${name}"\\} (\\d+)$`,
        "m",
    ).exec(body);
    return m ? Number(m[1]) : undefined;
}

/**
 * The shipped standalone shape: the BUILT supervisor on `runtime`, which spawns
 * `server.js` on the same runtime and serves the app's metrics port, merging
 * the server process's loopback listener into it. The metrics port is a free
 * one (`METRICS_PORT`), so this never contends with another test for the
 * shipped default; the default itself is pinned by the port lockstep test.
 */
async function supervise(
    b: { serverDir: string; serverJs: string },
    runtime: "node" | "bun",
) {
    const port = await freePort();
    const metricsPort = await freePort();
    const childMetricsPort = await freePort();
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
        METRICS_PORT: String(metricsPort),
        KN_CHILD_METRICS_PORT: String(childMetricsPort),
        STANDALONE_SERVER_PATH: b.serverJs,
    });
    let log = "";
    const child = spawn(
        runtime === "bun" ? (BUN_BIN as string) : NODE_BIN,
        [DIST_SUPERVISOR],
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
    while ((await get(port, "/")).status === 0) {
        if (Date.now() > deadline)
            throw new Error(`server did not come up:\n${tail(log)}`);
        await new Promise((r) => setTimeout(r, 200));
    }
    return { port, metricsPort, childMetricsPort, log: () => log };
}

for (const runtime of ["node", "bun"] as const) {
    describe(`'use cache' counters on the app's metrics port, built supervisor (${runtime})`, () => {
        it("a 'use cache' miss and dropped write reach the metrics port through the server process's loopback listener", async () => {
            const b = await buildApp();
            const s = await supervise(b, runtime);

            const r = await get(s.port, "/api/uc");
            expect(r.status, tail(s.log())).toBe(200);
            expect(r.body).toContain("stamp");

            // The instrumentation starts the loopback listener asynchronously,
            // so poll; the counters must appear well within the deadline.
            const deadline = Date.now() + 20_000;
            let child = "";
            let served = "";
            while (Date.now() < deadline) {
                child = await scrape(s.childMetricsPort);
                served = await scrape(s.metricsPort);
                if (
                    (event(child, "miss") ?? 0) >= 1 &&
                    (event(served, "miss") ?? 0) >= 1
                )
                    break;
                await new Promise((r) => setTimeout(r, 250));
            }

            // The server process's loopback listener (what the seam feeds)...
            expect(
                event(child, "miss"),
                `no 'use cache' miss on the loopback listener:\n${child}\n${tail(s.log())}`,
            ).toBeGreaterThanOrEqual(1);
            expect(event(child, "dropped")).toBeGreaterThanOrEqual(1);

            // ...and the app's metrics port, served by the separate supervisor.
            expect(
                event(served, "miss"),
                `no 'use cache' miss on the metrics port:\n${served}\n${tail(s.log())}`,
            ).toBeGreaterThanOrEqual(1);
            expect(event(served, "dropped")).toBeGreaterThanOrEqual(1);
            expect(event(served, "oversize")).toBe(0);
            expect(
                served.match(/^# TYPE knext_use_cache_events_total counter$/gm)
                    ?.length,
                "one exposition: the family is declared exactly once",
            ).toBe(1);
            // A merge, not a replacement: the supervisor's own metrics remain.
            expect(served).toMatch(/^# TYPE process_cpu_seconds_total /m);
        }, 300_000);
    });
}
