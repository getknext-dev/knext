// @vitest-environment node
//
// Boots a REAL `next build` (next@16.4.0, Cache Components on, the scaffold's
// `cacheMaxMemorySize: 0`, the real knext adapter) and serves the standalone
// `server.js` as TWO separate processes -- two "pods" -- that share one Redis.
// Both talk to a real socket; the default happy-dom environment blocks that.

import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
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
import { blankStandaloneAdapterPath } from "../adapters/standalone-adapter-path";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * `'use cache'` on knext is shared across pods.
 *
 * On a stock knext scaffold only the singular `cacheHandler` was wired and
 * `cacheMaxMemorySize` is 0, so Next's built-in `'use cache'` handler was a
 * no-op: two requests returned different timestamps even in ONE process. This
 * builds the shape of that scaffold and proves, against the real pieces:
 *
 *   1. two pods behind one Redis return the SAME timestamp from a `'use cache'`
 *      function;
 *   2. `revalidateTag` on pod A invalidates it on pod B (and `revalidateTag(tag,
 *      profile)` refreshes it too);
 *   3. the entry is stored under Next's own build-scoped key, in knext's
 *      `uc` namespace, with a bounded TTL.
 *
 * Red before the backend exists (the timestamps differ), green after.
 * NOTHING here skips: a missing precondition is a FAILURE.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const FIXTURE = join(here, "fixtures", "use-cache-redis");
const ADAPTER_SRC = resolve(here, "../adapters/next-adapter.ts");
const NEXT_BIN = join(PKG_ROOT, "node_modules", "next", "dist", "bin", "next");
const PREFIX = "uc-served";

const tempRoots: string[] = [];
const servers: ChildProcess[] = [];
let fake: FakeRedis | undefined;

function killServers(): void {
    for (const s of servers.splice(0)) {
        if (!s.pid) continue;
        try {
            process.kill(-s.pid, "SIGKILL");
        } catch {
            s.kill("SIGKILL");
        }
    }
}

afterAll(async () => {
    killServers();
    await fake?.close();
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
    env: Record<string, string>,
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

const tail = (s: string, n = 40) =>
    s.split("\n").filter(Boolean).slice(-n).join("\n");

interface Pod {
    port: number;
    log: () => string;
}

async function startPod(
    serverJs: string,
    serverDir: string,
    redisUrl: string,
): Promise<Pod> {
    const port = await freePort();
    let log = "";
    let exited: string | null = null;
    const child = spawn("node", [serverJs], {
        cwd: serverDir,
        detached: true,
        env: {
            ...process.env,
            PORT: String(port),
            HOSTNAME: "127.0.0.1",
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            REDIS_URL: redisUrl,
            REDIS_KEY_PREFIX: PREFIX,
        },
    });
    servers.push(child);
    child.stdout?.on("data", (b) => {
        log += String(b);
    });
    child.stderr?.on("data", (b) => {
        log += String(b);
    });
    child.on("exit", (code, signal) => {
        exited = `code=${code} signal=${signal}`;
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !exited) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/`, {
                signal: AbortSignal.timeout(5_000),
            });
            await res.arrayBuffer();
            if (res.status === 200) return { port, log: () => log };
        } catch {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    throw new Error(
        `pod on :${port} never answered 200 (exited=${exited}):\n${tail(log)}`,
    );
}

async function stamp(pod: Pod): Promise<{ t: number; pid: number }> {
    const res = await fetch(`http://127.0.0.1:${pod.port}/api/stamp`, {
        signal: AbortSignal.timeout(30_000),
    });
    expect(res.status, `stamp -> ${res.status}\n${tail(pod.log())}`).toBe(200);
    return (await res.json()) as { t: number; pid: number };
}

async function revalidate(pod: Pod, mode: "expire" | "max"): Promise<void> {
    const res = await fetch(
        `http://127.0.0.1:${pod.port}/api/revalidate?mode=${mode}`,
        { method: "POST", signal: AbortSignal.timeout(30_000) },
    );
    expect(res.status, tail(pod.log())).toBe(200);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("'use cache' is shared across pods (real next@16.4.0, two processes, one Redis)", () => {
    it("two pods return the same timestamp; revalidateTag on one invalidates the other; the key is build-scoped", async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN}`,
        ).toBe(true);
        // The adapter points the handlers at @getknext/core's BUILT entries.
        expect(
            existsSync(
                join(PKG_ROOT, "dist", "adapters", "cache-handler-node.js"),
            ),
            "dist is not built -- run the core build first (the CI way builds dists before the suite)",
        ).toBe(true);

        const made = mkdtempSync(join(tmpdir(), "knext-usecache-redis-"));
        tempRoots.push(made);
        const root = realpathSync(made);
        const appDir = join(root, "app");
        symlinkSync(join(PKG_ROOT, "node_modules"), join(root, "node_modules"));
        cpSync(FIXTURE, appDir, { recursive: true });
        // `@getknext/core` as the scaffold's cache-handler.js and the adapter
        // import it: this package itself, resolved from the app's own
        // node_modules (its BUILT dist, which is what ships). The workspace
        // `node_modules` link above does not carry the package's own name.
        mkdirSync(join(appDir, "node_modules", "@getknext"), {
            recursive: true,
        });
        symlinkSync(
            PKG_ROOT,
            join(appDir, "node_modules", "@getknext", "core"),
        );
        writeFileSync(
            join(appDir, "package.json"),
            JSON.stringify({ name: "usecache-redis", private: true }),
        );
        // The one-line re-export every knext scaffold generates.
        writeFileSync(
            join(appDir, "cache-handler.js"),
            'export { default } from "@getknext/core/adapters/cache-handler";\n',
        );

        // Inside the app, so the adapter's `@getknext/core/...` resolution finds
        // the link above.
        const adapterBundle = join(appDir, "adapter.mjs");
        await build({
            entryPoints: [ADAPTER_SRC],
            outfile: adapterBundle,
            bundle: true,
            format: "esm",
            platform: "node",
            target: "node20",
            packages: "external",
        });
        // The scaffold's shape: the singular handler, `cacheMaxMemorySize: 0`,
        // the knext adapter, Cache Components on -- and NO `cacheHandlers`.
        writeFileSync(
            join(appDir, "next.config.mjs"),
            `export default {
  adapterPath: ${JSON.stringify(adapterBundle)},
  outputFileTracingRoot: "/",
  generateBuildId: () => process.env.KNEXT_BUILD_ID || null,
  cacheComponents: true,
  partialPrefetching: false,
  cacheHandler: new URL("./cache-handler.js", import.meta.url).pathname,
  cacheMaxMemorySize: 0,
};
`,
        );

        const built = await run(
            "node",
            [NEXT_BIN, "build", "--webpack"],
            appDir,
            // The CLI exports the configured runtime; the adapter picks the
            // runtime's own handler entries from it.
            { KNEXT_RUNTIME: "node", KNEXT_BUILD_ID: "uc-served-build-1" },
        );
        expect(
            built.code,
            `next build failed (exit ${built.code}):\n${tail(built.out)}`,
        ).toBe(0);

        const serverDir = join(
            appDir,
            ".next",
            "standalone",
            relative("/", appDir),
        );
        const serverJs = join(serverDir, "server.js");
        expect(existsSync(serverJs), tail(built.out)).toBe(true);
        const applied = blankStandaloneAdapterPath({ serverDir });
        expect(applied.nextVersion, applied.reason).not.toBeNull();
        // Premise: this is the Next the contract is written against.
        expect(applied.nextVersion).toMatch(/^16\.4\./);
        const buildId = readFileSync(
            join(appDir, ".next", "BUILD_ID"),
            "utf8",
        ).trim();
        expect(buildId).toBe("uc-served-build-1");

        fake = await startFakeRedis();
        const podA = await startPod(serverJs, serverDir, fake.url);
        const podB = await startPod(serverJs, serverDir, fake.url);

        // ── 1. shared across pods ────────────────────────────────────────────
        const a1 = await stamp(podA);
        const a2 = await stamp(podA);
        expect(
            a2.t,
            "pod A must cache at all (a no-op 'use cache' recomputes every request)",
        ).toBe(a1.t);
        const b1 = await stamp(podB);
        expect(
            b1.t,
            `pod B must serve pod A's entry: A=${a1.t} (pid ${a1.pid}) B=${b1.t} (pid ${b1.pid})`,
        ).toBe(a1.t);
        expect(b1.pid, "the two requests really ran in two processes").not.toBe(
            undefined,
        );
        expect(podA.port).not.toBe(podB.port);

        // ── 3. the stored key is Next's build-scoped key in knext's namespace
        const ucKeys = [...fake.strings.keys()].filter((k) =>
            k.startsWith(`${PREFIX}:uc:default:`),
        );
        expect(
            ucKeys.length,
            [...fake.strings.keys()].join("\n"),
        ).toBeGreaterThan(0);
        expect(
            ucKeys.every((k) => k.includes(buildId)),
            `Next's cache key carries the build id; keys: ${ucKeys.join(" | ")}`,
        ).toBe(true);
        for (const k of ucKeys) {
            const ttl = fake.ttls.get(k);
            expect(ttl, `no EX on ${k}`).toBeDefined();
            expect(ttl as number).toBeGreaterThan(0);
            expect(ttl as number).toBeLessThanOrEqual(86_400);
        }

        // ── 2. revalidateTag on A invalidates B ──────────────────────────────
        await sleep(20);
        await revalidate(podA, "expire");
        const b2 = await stamp(podB);
        expect(
            b2.t,
            "revalidateTag on pod A must expire the entry on pod B",
        ).toBeGreaterThan(a1.t);
        const a3 = await stamp(podA);
        expect(a3.t, "and both pods agree on the regenerated entry").toBe(b2.t);

        // revalidateTag(tag, 'max'): stale-while-revalidate -- the entry is
        // refreshed (possibly after one stale read) on the OTHER pod too.
        await sleep(20);
        await revalidate(podB, "max");
        let refreshed = b2.t;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && refreshed === b2.t) {
            refreshed = (await stamp(podA)).t;
            if (refreshed === b2.t) await sleep(200);
        }
        expect(
            refreshed,
            "revalidateTag(tag, 'max') on pod B must refresh the entry on pod A",
        ).toBeGreaterThan(b2.t);
    }, 420_000);
});
