// @vitest-environment node
//
// Boots a REAL `next build` + the standalone `server.js` as a child process and
// talks to it over a socket.

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
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BUN_BIN, NODE_BIN } from "../../../../tests/helpers/runtime-binaries";

/**
 * A redirect built from `request.url` must carry the app's public origin.
 *
 * Next's standalone server builds `request.url` from its bind address, and the
 * knext supervisor binds the wildcard (`HOSTNAME` is sanitized to empty, so
 * `server.js` falls through to `0.0.0.0`). Without the public-origin preload a
 * route handler's `NextResponse.redirect(new URL(path, request.url))` therefore
 * answers `Location: http://0.0.0.0:PORT/...` — unroutable, and a browser that
 * follows it drops every host-only cookie (the Draft Mode bypass cookie among
 * them).
 *
 * This suite is the proof against the REAL pieces:
 *
 *   1. `next build --webpack` of a fixture with the real knext adapter wired
 *      through `adapterPath`;
 *   2. the standalone `server.js`, bound to the wildcard exactly as in a pod,
 *      started three ways — `node --require <preload>`, `bun --require
 *      <preload>`, and through the `node-server.ts` supervisor itself (which
 *      must load the preload on its own);
 *   3. real requests carrying the headers a front proxy sends (and an attacker
 *      would).
 *
 * The premise case runs first: with `KNEXT_PUBLIC_ORIGINS` unset the same build
 * still answers with the bind origin — unchanged behaviour, and proof the
 * green cases are green because of the preload.
 *
 * NOTHING here skips: `next` and `esbuild` are workspace devDependencies of
 * @getknext/core, and the suite runs under bun, so a missing precondition is a
 * FAILURE, never a silent pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const FIXTURE = join(here, "fixtures", "public-origin-redirect");
const ADAPTERS = resolve(here, "../adapters");
const PRELOAD = join(ADAPTERS, "public-origin.cjs");
const SUPERVISOR = join(ADAPTERS, "node-server.ts");
const COMPILE_SCRIPT = join(ADAPTERS, "standalone-compile.mjs");
const ADAPTER_SRC = join(ADAPTERS, "next-adapter.ts");
const NEXT_BIN = join(PKG_ROOT, "node_modules", "next", "dist", "bin", "next");

const ORIGINS = "app.example.com,www.example.com";

/** Every temp root this file makes; drained (and removed) in `afterAll`. */
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

interface Reply {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
}

/** GET with exact header control (`fetch` would set its own Host). */
function get(
    port: number,
    path: string,
    headers: Record<string, string> = {},
): Promise<Reply> {
    return new Promise((done, fail) => {
        const req = httpRequest(
            {
                host: "127.0.0.1",
                port,
                path,
                headers,
                signal: AbortSignal.timeout(30_000),
            },
            (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (c) => {
                    body += c;
                });
                res.on("end", () =>
                    done({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body,
                    }),
                );
            },
        );
        req.on("error", fail);
        req.end();
    });
}

interface Standalone {
    root: string;
    standaloneDir: string;
    serverDir: string;
    serverJs: string;
}

let standalone: Standalone | undefined;

/** Build the fixture once; every mode serves the same tree. */
async function buildOnce(): Promise<Standalone> {
    if (standalone) return standalone;
    expect(existsSync(NEXT_BIN), `next binary not found at ${NEXT_BIN}`).toBe(
        true,
    );
    const made = mkdtempSync(join(tmpdir(), "knext-public-origin-"));
    tempRoots.push(made);
    const root = realpathSync(made);
    const appDir = join(root, "app");
    symlinkSync(join(PKG_ROOT, "node_modules"), join(root, "node_modules"));
    cpSync(FIXTURE, appDir, { recursive: true });
    writeFileSync(
        join(appDir, "package.json"),
        JSON.stringify({ name: "public-origin", private: true }),
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
        `export default {\n  adapterPath: ${JSON.stringify(adapterBundle)},\n  outputFileTracingRoot: "/",\n};\n`,
    );
    const built = await run("node", [NEXT_BIN, "build", "--webpack"], appDir);
    expect(
        built.code,
        `next build failed (exit ${built.code}):\n${tail(built.out)}`,
    ).toBe(0);
    const standaloneDir = join(appDir, ".next", "standalone");
    const serverDir = join(standaloneDir, relative("/", appDir));
    const serverJs = join(serverDir, "server.js");
    expect(
        existsSync(serverJs),
        `no standalone server.js:\n${tail(built.out)}`,
    ).toBe(true);
    // Premise: the standalone server binds the wildcard when HOSTNAME is empty.
    expect(readFileSync(serverJs, "utf8")).toContain(
        "process.env.HOSTNAME || '0.0.0.0'",
    );
    standalone = { root, standaloneDir, serverDir, serverJs };
    return standalone;
}

let compiled: string | undefined;

/**
 * Compile the same tree into the standalone single executable with the
 * shipped compile script (host target), once. The preloads are baked into the
 * executable's entry — nothing is passed at run time.
 */
async function compileOnce(): Promise<string> {
    if (compiled) return compiled;
    const { root, standaloneDir, serverJs } = await buildOnce();
    const outfile = join(root, "knext-exec");
    const res = await run(
        BUN_BIN as string,
        [
            COMPILE_SCRIPT,
            "--server",
            serverJs,
            "--root",
            standaloneDir,
            "--outfile",
            outfile,
        ],
        root,
    );
    expect(
        res.code,
        `standalone compile failed (exit ${res.code}):\n${tail(res.out)}`,
    ).toBe(0);
    expect(existsSync(outfile)).toBe(true);
    compiled = outfile;
    return compiled;
}

type Mode =
    | "node --require"
    | "bun --require"
    | "node-server.ts supervisor (bun)"
    | "compiled single executable";

interface Served {
    port: number;
    log: () => string;
    stop: () => void;
}

async function serve(
    mode: Mode,
    publicOrigins: string | undefined,
): Promise<Served> {
    const { serverDir, serverJs } = await buildOnce();
    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== "KNEXT_PUBLIC_ORIGINS") env[k] = v;
    }
    Object.assign(env, {
        PORT: String(port),
        // What the supervisor hands its child (env.ts): the bind falls through to 0.0.0.0.
        HOSTNAME: "",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
    });
    if (publicOrigins !== undefined) env.KNEXT_PUBLIC_ORIGINS = publicOrigins;

    let cmd: string;
    let args: string[];
    if (mode === "node --require") {
        cmd = NODE_BIN;
        args = ["--require", PRELOAD, serverJs];
    } else if (mode === "bun --require") {
        cmd = BUN_BIN as string;
        args = ["--require", PRELOAD, serverJs];
    } else if (mode === "compiled single executable") {
        cmd = await compileOnce();
        args = [];
        // Disk mode: the executable serves the tree it was compiled from.
        env.KNEXT_STANDALONE_DIR = serverDir;
    } else {
        cmd = BUN_BIN as string;
        args = [SUPERVISOR];
        env.STANDALONE_SERVER_PATH = serverJs;
        env.METRICS_PORT = String(await freePort());
        env.KN_CHILD_METRICS_PORT = String(await freePort());
    }

    let log = "";
    let exited: string | null = null;
    const child = spawn(cmd, args, {
        cwd: serverDir,
        detached: true,
        env: env as NodeJS.ProcessEnv,
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

    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline && !exited) {
        try {
            const res = await get(port, "/");
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
        `${mode}: server never answered 200 on / (exited=${exited}):\n${tail(log)}`,
    ).toBe(true);
    return { port, log: () => log, stop: () => killTree(child) };
}

const MODES: Mode[] = [
    "node --require",
    "bun --require",
    "node-server.ts supervisor (bun)",
    "compiled single executable",
];

describe("redirects built from request.url carry the public origin (real standalone build)", () => {
    it("premise: with KNEXT_PUBLIC_ORIGINS unset the build still answers with the bind origin", async () => {
        expect(BUN_BIN, "bun executable not found").toBeTruthy();
        for (const mode of MODES) {
            const s = await serve(mode, undefined);
            try {
                const res = await get(s.port, "/go", {
                    Host: "app.example.com",
                });
                expect({
                    mode,
                    status: res.status,
                    location: res.headers.location,
                }).toEqual({
                    mode,
                    status: 307,
                    location: `http://0.0.0.0:${s.port}/article/one?from=go`,
                });
                expect(s.log()).not.toContain("PUBLIC_ORIGINS");
            } finally {
                s.stop();
            }
        }
    }, 600_000);

    for (const mode of MODES) {
        it(`${mode}: the redirect lands on the allowlisted origin, and no header outside the allowlist reaches it`, async () => {
            const s = await serve(mode, ORIGINS);
            try {
                // Behind the platform ingress: Host is the public host, no forwarded headers.
                const plain = await get(s.port, "/go", {
                    Host: "www.example.com",
                });
                expect(plain.status).toBe(307);
                expect(plain.headers.location).toBe(
                    "https://www.example.com/article/one?from=go",
                );

                // An allowlisted forwarded host with `X-Forwarded-Proto: http` (what a
                // plain-HTTP ingress listener sets, or a client forges): the scheme
                // comes from the https allowlist entry, so it stays https.
                const forwarded = await get(s.port, "/go", {
                    Host: "internal.svc.cluster.local",
                    "X-Forwarded-Host": "www.example.com",
                    "X-Forwarded-Proto": "http",
                });
                expect(forwarded.headers.location).toBe(
                    "https://www.example.com/article/one?from=go",
                );

                // An attacker's host and proto: the first allowlisted origin, https.
                const attack = await get(s.port, "/go", {
                    Host: "evil.com",
                    "X-Forwarded-Host": "evil.com",
                    "X-Forwarded-Proto": "javascript",
                });
                expect(attack.headers.location).toBe(
                    "https://app.example.com/article/one?from=go",
                );

                // A port on an allowlisted name is not on the allowlist.
                const ported = await get(s.port, "/go", {
                    Host: "www.example.com:6666",
                });
                expect(ported.headers.location).toBe(
                    "https://app.example.com/article/one?from=go",
                );

                // A redirect to another site is not the bind origin: untouched.
                const away = await get(s.port, "/away", {
                    Host: "www.example.com",
                });
                expect(away.status).toBe(307);
                expect(away.headers.location).toBe(
                    "https://other.example.org/landing?x=1",
                );

                // The effective allowlist is announced once at boot.
                expect(s.log()).toContain(
                    "PUBLIC_ORIGINS:https://app.example.com,https://www.example.com",
                );
            } finally {
                s.stop();
            }
        }, 300_000);
    }

    it("an http:// allowlist entry yields http:// and an https:// entry https://, whatever X-Forwarded-Proto says", async () => {
        const s = await serve(
            "node --require",
            "http://app.example.com,https://www.example.com",
        );
        try {
            for (const proto of ["http", "https", "javascript"]) {
                const plain = await get(s.port, "/go", {
                    Host: "app.example.com",
                    "X-Forwarded-Proto": proto,
                });
                expect(plain.headers.location).toBe(
                    "http://app.example.com/article/one?from=go",
                );
                const secure = await get(s.port, "/go", {
                    Host: "www.example.com",
                    "X-Forwarded-Proto": proto,
                });
                expect(secure.headers.location).toBe(
                    "https://www.example.com/article/one?from=go",
                );
            }
        } finally {
            s.stop();
        }
    }, 300_000);

    it("the Draft Mode entry route redirects to the app host, where the bypass cookie renders the draft", async () => {
        const s = await serve("node --require", ORIGINS);
        try {
            const entered = await get(s.port, "/draft", {
                Host: "app.example.com",
            });
            expect(entered.status).toBe(307);
            expect(entered.headers.location).toBe(
                "https://app.example.com/article/one",
            );
            const cookies = entered.headers["set-cookie"] ?? [];
            const bypass = cookies.find((c) =>
                c.startsWith("__prerender_bypass="),
            );
            expect(
                bypass,
                `no bypass cookie in ${JSON.stringify(cookies)}`,
            ).toBeDefined();
            // Host-only: no Domain attribute, so the browser sends it back only to
            // the host that set it — which the redirect now targets.
            expect(bypass?.toLowerCase()).not.toContain("domain=");

            const target = new URL(entered.headers.location as string);
            const cookie = (bypass as string).split(";")[0];
            const draft = await get(s.port, target.pathname, {
                Host: target.host,
                Cookie: cookie,
            });
            expect(draft.status).toBe(200);
            expect(draft.body).toContain("Draft article one");

            const published = await get(s.port, target.pathname, {
                Host: target.host,
            });
            expect(published.body).toContain("Published article one");
        } finally {
            s.stop();
        }
    }, 300_000);
});
