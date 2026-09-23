// @vitest-environment node
//
// standalone-pages.docker-e2e — the compiled bytecode bun-standalone executable
// keeps MODULE IDENTITY for (1) the Pages Router and (2) a custom cacheHandler
// that imports a Next internal (#1226).
//
// ── Why identity is the thing to test ───────────────────────────────────────
//
// `standalone-compile.mjs` bundles the Next server core into the executable
// and leaves everything Next loads by COMPUTED path on disk. Any module BOTH
// sides reach must exist ONCE, or `instanceof`, React contexts and
// AsyncLocalStorage lookups silently compare against the wrong copy — the
// NoFallbackError split that turned 404s into 500s. The compile keeps shared
// modules on disk by scanning the literal-require closure of `.next/server/**`.
// Two kinds of disk-loaded code sit outside that scan:
//
//   1. the Pages Router's contexts, which Next's require-hook reaches through a
//      COMPUTED redirect (`*.shared-runtime` -> the pages runtime's vendored
//      copy). Measured: every hook target is a thin re-export of the pages
//      runtime, which the closure already keeps on disk, so there is no split.
//      This suite PINS that — SSR, notFound, getStaticPaths fallback:false, an
//      API route, hooks + useRouter + next/head + next/link, and a
//      server-external dependency whose `useRouter` goes through the hook;
//   2. a custom `cacheHandler`, which Next loads from outside `.next/server`.
//      A handler importing a Next internal that no route chunk references got
//      a SECOND instance of it — measured on this fixture: the
//      `after-task-async-storage` singleton. The compile now scans every
//      configured handler as an extra root.
//
// Each assertion runs against the compiled executable AND, as the control,
// uncompiled Next (`node server.js`) on the same tree, so every expectation is
// proven to be real Next behaviour rather than a property of the fixture.
//
// ── Discipline mirrored from standalone-drain.docker-e2e.test.ts ────────────
//
//   - NO SKIP PATH. Missing docker or bun is a FAILURE. The `.docker-e2e.test.ts`
//     suffix keeps it out of the fast lane; the `standalone-drain-bun-image` CI
//     job runs it by path (guarded by tests/standalone-drain-image-ci.test.ts).
//   - linux/amd64 + the SHIPPED base images (read from the standalone
//     Dockerfile template, so this cannot drift from what ships). Darwin Bun
//     1.4.0 executables carry an invalid code signature, so the exec is only
//     ever run in the container.
//   - UNIQUE per-run names + epoch labels + afterAll cleanup.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildStandaloneExecutable } from "../cli/standalone-exec-build";

const PKG_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "standalone-pages-app");
const TEMPLATE = join(
    PKG_ROOT,
    "templates",
    "runtime-standalone",
    "Dockerfile.standalone.hbs",
);
const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const IMAGE = `knext-standalone-pages-e2e:${RUN_ID}`;
const NODE_IMAGE = `knext-standalone-pages-e2e-node:${RUN_ID}`;
const CONTAINER = `knext-standalone-pages-e2e-${RUN_ID}`;
const NODE_CONTAINER = `knext-standalone-pages-e2e-node-${RUN_ID}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=standalone-pages-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;
const LEAK_AGE_MS = 2 * 60 * 60 * 1000;

let workDir = "";
let execPort = 0;
let nodePort = 0;

function run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeout?: number } = {},
) {
    return spawnSync(cmd, args, {
        cwd: opts.cwd,
        encoding: "utf8",
        timeout: opts.timeout ?? 600_000,
    });
}

async function freePorts(n: number): Promise<number[]> {
    const servers: ReturnType<typeof createServer>[] = [];
    const ports: number[] = [];
    for (let i = 0; i < n; i++) {
        ports.push(
            await new Promise<number>((res, rej) => {
                const srv = createServer();
                srv.on("error", rej);
                srv.listen(0, "127.0.0.1", () => {
                    const addr = srv.address();
                    if (addr && typeof addr === "object") res(addr.port);
                    else rej(new Error("no port"));
                });
                servers.push(srv);
            }),
        );
    }
    await Promise.all(
        servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    return ports;
}

function sweepLeakedArtifacts() {
    const listed = run(
        "docker",
        [
            "ps",
            "--all",
            "--filter",
            `label=${LABEL}`,
            "--format",
            `{{.ID}} {{.Label "${EPOCH_LABEL_KEY}"}}`,
        ],
        { timeout: 60_000 },
    );
    if (listed.status === 0) {
        for (const line of listed.stdout.split("\n")) {
            const [id, epoch] = line.trim().split(/\s+/);
            const startedAt = Number(epoch);
            if (!id || !Number.isFinite(startedAt)) continue;
            if (Date.now() - startedAt > LEAK_AGE_MS)
                run("docker", ["rm", "--force", id], { timeout: 60_000 });
        }
    }
    run(
        "docker",
        [
            "image",
            "prune",
            "--force",
            "--all",
            "--filter",
            `label=${LABEL}`,
            "--filter",
            "until=2h",
        ],
        {
            timeout: 120_000,
        },
    );
}

/** The pinned `FROM` of a named stage in the SHIPPED standalone Dockerfile. */
function shippedBase(stage: string): string {
    const m = readFileSync(TEMPLATE, "utf8").match(
        new RegExp(`^FROM (\\S+) AS ${stage}$`, "m"),
    );
    if (!m) throw new Error(`no \`FROM … AS ${stage}\` in ${TEMPLATE}`);
    return m[1];
}

beforeAll(async () => {
    // 1. Prerequisites are REQUIRED, never skipped around.
    const docker = run(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        { timeout: 60_000 },
    );
    if (docker.status !== 0) {
        throw new Error(
            `docker is required by this suite and is not usable: ${docker.stderr || docker.error?.message}`,
        );
    }
    const bun = run("bun", ["--version"], { timeout: 60_000 });
    if (bun.status !== 0) {
        throw new Error(
            `bun is required by this suite and is not usable: ${bun.stderr || bun.error?.message}`,
        );
    }

    sweepLeakedArtifacts();

    // 2. Build the fixture's .next/standalone in a throwaway dir, every run.
    workDir = mkdtempSync(join(tmpdir(), "knext-standalone-pages-"));
    const appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });
    const install = run("bun", ["install"], { cwd: appDir, timeout: 300_000 });
    if (install.status !== 0)
        throw new Error(
            `fixture bun install failed:\n${install.stdout}\n${install.stderr}`,
        );
    const build = run("bun", ["run", "build"], {
        cwd: appDir,
        timeout: 600_000,
    });
    if (build.status !== 0)
        throw new Error(
            `fixture next build failed:\n${build.stdout}\n${build.stderr}`,
        );
    const standalone = join(appDir, ".next", "standalone");
    if (!existsSync(join(standalone, "cache-handler.js"))) {
        throw new Error(
            `next build did not trace the custom cacheHandler into ${standalone}:\n${build.stdout}`,
        );
    }

    // 3. Compile through the SHIPPED build step (with its fail-closed bytecode
    //    check), for the image's arch, straight into the tree it runs beside.
    buildStandaloneExecutable({
        cwd: appDir,
        arch: "linux-x64",
        outFile: join(standalone, "knext-standalone-exec"),
    });

    // 4. One context, two targets: the compiled exec on the shipped bun base,
    //    and uncompiled `node server.js` on the shipped node base (the control).
    const ctx = join(workDir, "ctx");
    mkdirSync(ctx, { recursive: true });
    // verbatimSymlinks: turbopack links each server-external package as
    // `.next/node_modules/<pkg>-<hash> -> ../../node_modules/<pkg>`; cpSync
    // would otherwise rewrite that relative link to an absolute HOST path that
    // does not exist in the container.
    cpSync(standalone, join(ctx, "standalone"), {
        recursive: true,
        verbatimSymlinks: true,
    });
    writeFileSync(
        join(ctx, "Dockerfile"),
        [
            `FROM ${shippedBase("standalone-bun")} AS exec`,
            "WORKDIR /app",
            "COPY standalone/ /app/",
            "ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0",
            'ENTRYPOINT ["/app/knext-standalone-exec"]',
            "",
            `FROM ${shippedBase("standalone-node")} AS node`,
            "WORKDIR /app",
            "COPY standalone/ /app/",
            "ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0",
            'ENTRYPOINT ["node", "/app/server.js"]',
            "",
        ].join("\n"),
    );
    for (const [target, tag] of [
        ["exec", IMAGE],
        ["node", NODE_IMAGE],
    ] as const) {
        const img = run(
            "docker",
            [
                "build",
                "--platform",
                PLATFORM,
                "--target",
                target,
                "--label",
                LABEL,
                "--label",
                EPOCH_LABEL,
                "--tag",
                tag,
                ctx,
            ],
            { timeout: 600_000 },
        );
        if (img.status !== 0)
            throw new Error(
                `docker build (${target}) failed:\n${img.stdout}\n${img.stderr}`,
            );
    }

    [execPort, nodePort] = await freePorts(2);
    for (const [name, image, port] of [
        [CONTAINER, IMAGE, execPort],
        [NODE_CONTAINER, NODE_IMAGE, nodePort],
    ] as const) {
        const started = run(
            "docker",
            [
                "run",
                "--detach",
                "--name",
                name,
                "--label",
                LABEL,
                "--label",
                EPOCH_LABEL,
                "--platform",
                PLATFORM,
                "--publish",
                `${port}:3000`,
                image,
            ],
            { timeout: 120_000 },
        );
        if (started.status !== 0)
            throw new Error(
                `docker run ${name} failed:\n${started.stdout}\n${started.stderr}`,
            );
    }
    await waitForHealth(CONTAINER, execPort);
    await waitForHealth(NODE_CONTAINER, nodePort);
}, 1_200_000);

async function waitForHealth(container: string, port: number) {
    const deadline = Date.now() + 120_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (res.ok) return;
        } catch {
            // not listening yet
        }
        const running = run(
            "docker",
            ["inspect", container, "--format", "{{.State.Running}}"],
            { timeout: 60_000 },
        );
        const died = running.status === 0 && running.stdout.trim() === "false";
        if (died || Date.now() > deadline) {
            const logs = run("docker", ["logs", container], {
                timeout: 60_000,
            });
            throw new Error(
                `${container} never served /api/health (${died ? "it exited" : "timed out"}).\nlogs:\n${logs.stdout}\n${logs.stderr}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

afterAll(() => {
    run("docker", ["rm", "--force", CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", NODE_CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE], { timeout: 60_000 });
    run("docker", ["rmi", "--force", NODE_IMAGE], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 300_000);

async function get(port: number, path: string) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.text() };
}

/** The container's recent log, so a 500 names its server-side cause. */
function logsOf(container: string): string {
    const logs = run("docker", ["logs", "--tail", "60", container], {
        timeout: 60_000,
    });
    return `${container} logs:\n${logs.stdout}\n${logs.stderr}`;
}

const TARGETS = [
    ["compiled bytecode executable", () => execPort, CONTAINER],
    ["uncompiled node server.js (control)", () => nodePort, NODE_CONTAINER],
] as const;

describe("Pages Router on the compiled executable matches uncompiled Next", () => {
    for (const [label, port, container] of TARGETS) {
        it(`${label}: getServerSideProps renders, notFound is 404, an unknown route is 404`, async () => {
            const home = await get(port(), "/");
            expect(home.status, logsOf(container)).toBe(200);
            expect(home.body).toContain("gssp-ok");
            expect(
                (await get(port(), "/nf")).status,
                "getServerSideProps notFound: true",
            ).toBe(404);
            expect(
                (await get(port(), "/no-such-page")).status,
                "unknown route",
            ).toBe(404);
        });

        it(`${label}: getStaticPaths fallback:false — a listed path is 200, any other is 404`, async () => {
            const hit = await get(port(), "/p/a");
            expect(hit.status, logsOf(container)).toBe(200);
            expect(hit.body).toContain("p-");
            expect(
                (await get(port(), "/p/zzz")).status,
                "fallback:false miss",
            ).toBe(404);
        });

        it(`${label}: an API route answers`, async () => {
            const res = await get(port(), "/api/health");
            expect(res.status).toBe(200);
            expect(JSON.parse(res.body)).toEqual({
                status: "ok",
                router: "pages",
            });
        });

        it(`${label}: React hooks, useRouter, next/head and next/link see ONE React and ONE set of Next contexts`, async () => {
            const res = await get(port(), "/ctx");
            expect(res.status, logsOf(container)).toBe(200);
            expect(
                res.body,
                "useState — a second React copy is 'Invalid hook call'",
            ).toContain("state-42");
            expect(
                res.body,
                "useRouter — a split RouterContext is 'NextRouter was not mounted'",
            ).toContain("route-/ctx");
            expect(
                res.body,
                "next/head — a split HeadManagerContext drops the title",
            ).toMatch(/<title[^>]*>knext-head-ok<\/title>/);
            expect(res.body, "next/link").toContain("link-ok");
        });

        it(`${label}: a server-external dependency's useRouter (through Next's require-hook redirect) sees the runtime's RouterContext`, async () => {
            const res = await get(port(), "/ext");
            expect(res.status, logsOf(container)).toBe(200);
            expect(res.body).toContain("ext-route-/ext-7");
        });
    }
});

describe("a custom cacheHandler importing a Next internal shares ONE instance with the server core", () => {
    for (const [label, port, container] of TARGETS) {
        it(`${label}: the handler is loaded once, serves ISR, and its Next internal is the core's own instance`, async () => {
            // Drive ISR through the handler (memory cache is off in the fixture).
            expect((await get(port(), "/p/a")).status, logsOf(container)).toBe(
                200,
            );
            expect((await get(port(), "/p/a")).status, logsOf(container)).toBe(
                200,
            );

            const res = await get(port(), "/api/handler-probe");
            expect(res.status, logsOf(container)).toBe(200);
            const probe = JSON.parse(res.body);
            expect(
                probe,
                "the custom cacheHandler was never loaded",
            ).not.toBeNull();
            expect(
                probe.loads,
                "the handler module was evaluated more than once",
            ).toBe(1);
            expect(
                probe.hasStorage,
                "the handler's Next internal did not load",
            ).toBe(true);
            expect(
                probe.sharedInstance,
                "the handler loaded a SECOND instance of after-task-async-storage.external — the server core's copy was bundled into the executable instead of kept on disk",
            ).toBe(true);
            expect(
                probe.gets,
                "ISR never read through the custom handler",
            ).toBeGreaterThanOrEqual(1);
            expect(
                probe.sets,
                "ISR never wrote through the custom handler",
            ).toBeGreaterThanOrEqual(1);
        });
    }
});
