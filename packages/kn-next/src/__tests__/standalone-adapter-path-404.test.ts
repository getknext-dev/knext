// @vitest-environment node
//
// Boots a REAL `next build` + the standalone `server.js` as a child process and
// talks to it over a socket; the repo's default happy-dom environment enforces
// a Same-Origin Policy that blocks that.

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
import {
    blankStandaloneAdapterPath,
    nextCarriesAdapter404Bug,
} from "../adapters/standalone-adapter-path";

/**
 * A `dynamicParams = false` route 404s through the response cache, and with
 * `adapterPath` set Next 16.3.x answers a burst of concurrent prefetches to the
 * non-listed params with a 500 (`invariant: cache entry required but not
 * generated`) instead of a 404. Fixed upstream in 16.4.0; not backported.
 *
 * The workaround blanks `adapterPath` in the standalone tree's runtime config
 * (`blankStandaloneAdapterPath`, gated on the Next version). This suite is its
 * regression proof against the REAL pieces:
 *
 *   1. `next build --webpack` of the fixture shape (`dynamicParams = false` +
 *      `generateStaticParams`, a parallel-route slot, a root param) with the
 *      real knext adapter wired through `adapterPath`;
 *   2. the production workaround applied to the standalone tree it emitted;
 *   3. the standalone `server.js` served by `node`, hit with concurrent
 *      prefetch-shaped RSC requests for the 404 params.
 *
 * Every response must be 404 (or 200 for the listed params) -- never a 5xx --
 * and the server log must carry no invariant. The race needs overlapping
 * requests (concurrency 1 to 6 is green on the broken build), hence the burst.
 *
 * Mutation proof: make the workaround a no-op and this goes RED by exit code on
 * Next 16.3.x (hundreds of 500s). On Next >= 16.4.0 the workaround is a no-op by
 * design and the suite stays green because the bug is gone.
 *
 * NOTHING here skips: `next` and `esbuild` are workspace devDependencies of
 * @getknext/core, so a missing precondition is a FAILURE, never a silent pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const FIXTURE = join(here, "fixtures", "dynamic-params-false-404");
const ADAPTER_SRC = resolve(here, "../adapters/next-adapter.ts");
const NEXT_BIN = join(PKG_ROOT, "node_modules", "next", "dist", "bin", "next");

/** Every temp root this file makes; drained (and removed) in `afterAll`. */
const tempRoots: string[] = [];
let server: ChildProcess | undefined;

function killServer(): void {
    if (!server?.pid) return;
    try {
        process.kill(-server.pid, "SIGKILL");
    } catch {
        server.kill("SIGKILL");
    }
    server = undefined;
}

afterAll(() => {
    killServer();
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

/** Run a command to completion; resolves with its exit code and combined output. */
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
                // `bun test` sets NODE_ENV=test; `next build` wants production.
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

/** The request shapes Next's client router fires for a `<Link>` prefetch. */
const PREFETCH_HEADERS: Record<string, string>[] = [
    { RSC: "1", "Next-Router-Prefetch": "1" },
    {
        RSC: "1",
        "Next-Router-Prefetch": "1",
        "Next-Router-Segment-Prefetch": "/_tree",
    },
    {
        RSC: "1",
        "Next-Router-Prefetch": "1",
        "Next-Router-Segment-Prefetch": "/_index",
    },
];

/**
 * Path -> the statuses it may answer. The `dynamicParams = false` misses must be
 * exactly 404. The listed params are not the subject: a segment-prefetch shape
 * can 404 a page that renders fine, so they allow 200 or 404 and only the
 * "never a 5xx" rule applies to them.
 */
const EXPECTED: ReadonlyArray<readonly [string, readonly number[]]> = [
    ["/en", [200, 404]],
    ["/en/gsp/stories/static-123", [200, 404]],
    ["/es", [404]],
    ["/es/gsp/stories/static-123", [404]],
    ["/es/gsp/stories/dynamic-123", [404]],
    ["/en/gsp/stories/dynamic-123", [404]],
    ["/fr/gsp/stories/dynamic-123", [404]],
];

const TOTAL_REQUESTS = 1200;
const CONCURRENCY = 40;

/**
 * Fire `TOTAL_REQUESTS` prefetch-shaped requests at `CONCURRENCY`, cycling the
 * paths and header shapes, and tally the outcomes.
 */
async function hammer(port: number): Promise<{
    byStatus: Record<string, number>;
    wrong: string[];
}> {
    const byStatus: Record<string, number> = {};
    const wrong: string[] = [];
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= TOTAL_REQUESTS) return;
            const [path, allowed] = EXPECTED[i % EXPECTED.length];
            const headers = PREFETCH_HEADERS[i % PREFETCH_HEADERS.length];
            let got: number | string;
            try {
                const res = await fetch(
                    `http://127.0.0.1:${port}${path}?_rsc=p${i}`,
                    { headers, signal: AbortSignal.timeout(30_000) },
                );
                await res.arrayBuffer();
                got = res.status;
            } catch (err) {
                got = `error:${(err as Error).message}`;
            }
            byStatus[String(got)] = (byStatus[String(got)] ?? 0) + 1;
            if (!allowed.includes(got as number) && wrong.length < 10)
                wrong.push(`${path} -> ${got} (want ${allowed.join("|")})`);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { byStatus, wrong };
}

describe("dynamicParams=false 404 under adapterPath: standalone, concurrent prefetches", () => {
    it("answers every non-listed param with a 404 -- never a 500 -- once the workaround is applied", async () => {
        expect(
            existsSync(NEXT_BIN),
            `next binary not found at ${NEXT_BIN} -- @getknext/core devDependency missing`,
        ).toBe(true);
        expect(existsSync(join(FIXTURE, "app"))).toBe(true);

        const made = mkdtempSync(join(tmpdir(), "knext-adapterpath-404-"));
        tempRoots.push(made);
        // Canonical path: macOS `tmpdir()` is a `/var` symlink to `/private/var`,
        // and Next's tracing mixes the two spellings into a bogus relative path.
        const root = realpathSync(made);
        // The app lives one level below the temp root so that `node_modules`
        // can sit above it: `next` (and later the standalone `server.js`'s
        // `require('next')`) resolves it by walking ancestor directories, and a
        // plain tmpdir has none. Linked, not copied -- the workspace install.
        const appDir = join(root, "app");
        symlinkSync(join(PKG_ROOT, "node_modules"), join(root, "node_modules"));
        cpSync(FIXTURE, appDir, { recursive: true });
        writeFileSync(
            join(appDir, "package.json"),
            JSON.stringify({ name: "adapterpath-404", private: true }),
        );

        // The REAL knext adapter, wired through `adapterPath` exactly as apps do.
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
            // `outputFileTracingRoot: "/"`: the linked `node_modules` resolves
            // into the workspace, outside this app's directory, and Next fails
            // the build trying to copy those traced files into a standalone tree
            // rooted at the app. A root above both gives the nested (monorepo)
            // layout, with the link carried into the tree so `require('next')`
            // still resolves.
            `export default {\n  adapterPath: ${JSON.stringify(adapterBundle)},\n  outputFileTracingRoot: "/",\n};\n`,
        );

        const built = await run(
            "node",
            [NEXT_BIN, "build", "--webpack"],
            appDir,
        );
        expect(
            built.code,
            `next build failed (exit ${built.code}):\n${tail(built.out)}`,
        ).toBe(0);

        const standaloneDir = join(appDir, ".next", "standalone");
        // Nested layout: the app's path under the tracing root is repeated
        // inside the tree, and `server.js` sits at its end.
        const serverDir = join(standaloneDir, relative("/", appDir));
        const serverJs = join(serverDir, "server.js");
        expect(
            existsSync(serverJs),
            `no standalone server.js:\n${tail(built.out)}`,
        ).toBe(true);
        // Premise: the build really did bake the adapter into the runtime
        // config. Without this the test could go green for the wrong reason.
        expect(readFileSync(serverJs, "utf8")).toMatch(/"adapterPath":"[^"]+"/);

        // The production workaround, on the tree Next just emitted.
        const result = blankStandaloneAdapterPath({ serverDir });
        const nextVersion = result.nextVersion ?? "unknown";
        // The workaround must really have run on an affected Next: without this
        // a silent `applied: false` (a version it could not read, a format it
        // did not match) leaves the bug in place and only the load below, which
        // is a race, would notice.
        expect(
            result.nextVersion,
            `the installed Next.js version was unreadable: ${result.reason}`,
        ).not.toBeNull();
        expect(
            result.applied,
            `workaround not applied on Next ${nextVersion}: ${result.reason}`,
        ).toBe(nextCarriesAdapter404Bug(nextVersion) === true);

        const port = await freePort();
        let log = "";
        let exited: string | null = null;
        server = spawn("node", [serverJs], {
            cwd: serverDir,
            detached: true,
            env: {
                ...process.env,
                PORT: String(port),
                HOSTNAME: "127.0.0.1",
                NODE_ENV: "production",
                NEXT_TELEMETRY_DISABLED: "1",
                // The compat harness keeps this exported for the server too.
                // The blanked config must win over it: the env feeds only the
                // config DEFAULTS, which a standalone server never applies.
                NEXT_ADAPTER_PATH: adapterBundle,
            },
        });
        server.stdout?.on("data", (b) => {
            log += String(b);
        });
        server.stderr?.on("data", (b) => {
            log += String(b);
        });
        server.on("exit", (code, signal) => {
            exited = `code=${code} signal=${signal}`;
        });

        const deadline = Date.now() + 60_000;
        let ready = false;
        while (Date.now() < deadline && !exited) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/en`, {
                    signal: AbortSignal.timeout(5_000),
                });
                await res.arrayBuffer();
                if (res.status === 200) {
                    ready = true;
                    break;
                }
            } catch {
                await new Promise((r) => setTimeout(r, 250));
            }
        }
        expect(
            ready,
            `standalone server never answered 200 on /en (exited=${exited}):\n${tail(log)}`,
        ).toBe(true);

        const { byStatus, wrong } = await hammer(port);
        // Let any in-flight invariant throw reach the log before reading it.
        await new Promise((r) => setTimeout(r, 500));
        const invariants = (
            log.match(/cache entry required but not generated/g) ?? []
        ).length;

        const summary =
            `next ${nextVersion}; workaround applied=${result.applied} (${result.reason}); ` +
            `statuses ${JSON.stringify(byStatus)}; invariants in log: ${invariants}`;
        expect(
            Object.keys(byStatus).filter((s) => !/^(200|404)$/.test(s)),
            `a non-listed param was answered with something other than 404/200 -- ${summary}\nfirst misses: ${wrong.join("; ")}`,
        ).toEqual([]);
        expect(wrong, summary).toEqual([]);
        expect(
            invariants,
            `server log carries the invariant -- ${summary}`,
        ).toBe(0);
    }, 420_000);
});
