// @vitest-environment node
//
// standalone-self-contained-image.docker-e2e — N2 (#1457): the self-contained
// `--target standalone-bun-self-contained` stage of `Dockerfile.standalone.hbs`
// actually builds and boots, and REALLY ships no `node_modules` / no
// `.next/standalone` tree — proved against the real built image, not just the
// Dockerfile's text (that half is `runtime-image-selection.test.ts`).
//
// Sibling to `standalone-drain.docker-e2e.test.ts`, reusing the same
// `standalone-drain-app` fixture, but the build CONTEXT here is assembled the
// way `knext deploy --self-contained` would actually leave it: ONLY `public/`,
// `.next/static` and the self-contained-compiled executable — no
// `.next/standalone`, no `node_modules/@getknext/core`. If a future change to
// `stageStandaloneBuildContext`/the Dockerfile ever makes this stage reach for
// either, the `docker build` below fails outright (no such COPY source),
// which is the point: this suite cannot pass on an image that silently grew
// a `node_modules` dependency back.
//
// NO SKIP PATH — same discipline as the sibling: missing docker/bun is a
// FAILURE. Excluded from the fast lane by the `.docker-e2e.test.ts` suffix.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageStandaloneBuildContext } from "../cli/runtime-image";
import {
    buildStandaloneExecutable,
    standaloneExecFileName,
} from "../cli/standalone-exec-build";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "standalone-drain-app");
const TEMPLATE_DIR = join(PKG_ROOT, "templates", "runtime-standalone");
const PLATFORM = "linux/amd64";
const TARGET = "standalone-bun-self-contained";

const RUN_ID = randomBytes(4).toString("hex");
const CONTAINER = `knext-standalone-sc-e2e-${RUN_ID}`;
const IMAGE = `knext-standalone-sc-e2e:${RUN_ID}`;
const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=standalone-sc-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;

let workDir = "";
let appPort = 0;
let metricsPort = 0;

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
        const port = await new Promise<number>((res, rej) => {
            const srv = createServer();
            srv.on("error", rej);
            srv.listen(0, "127.0.0.1", () => {
                const addr = srv.address();
                if (addr && typeof addr === "object") res(addr.port);
                else rej(new Error("no port"));
            });
            servers.push(srv);
        });
        ports.push(port);
    }
    await Promise.all(
        servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    return ports;
}

async function waitForHealth(container: string, port: number) {
    const deadline = Date.now() + 120_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (res.ok) break;
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
                `${container} never served /api/health (${died ? "it exited" : "timed out"}).\n${logs.stdout}\n${logs.stderr}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

beforeAll(async () => {
    const docker = run(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        {
            timeout: 60_000,
        },
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

    // realpathSync: on macOS `tmpdir()` sits under a symlink (`/var` ->
    // `/private/var`). standalone-compile.mjs's self-contained embed-root
    // check (`compile-embed.mjs`'s `embedBuildOptions`) compares a
    // realpath'd `ROOT` against a NOT-realpath'd derived entry path
    // (`dirname(SERVER)`, itself just `resolve()`d) and throws "entry is
    // outside the embed root" the moment those two disagree on a symlink
    // component — a real, narrow latent bug (filed as follow-up tech debt in
    // the N2 PR body), not something to route around in production code
    // under this Dockerfile-scoped issue. A real deploy's project directory
    // is essentially never itself a symlink, so this is a test-harness-only
    // workaround: resolving the temp dir up front keeps every path this
    // suite hands the compiler already real, matching that normal case.
    workDir = realpathSync(mkdtempSync(join(tmpdir(), "knext-standalone-sc-")));
    const appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });

    const install = run("bun", ["install"], { cwd: appDir, timeout: 300_000 });
    if (install.status !== 0) {
        throw new Error(
            `fixture bun install failed:\n${install.stdout}\n${install.stderr}`,
        );
    }
    const build = run("bun", ["run", "build"], {
        cwd: appDir,
        timeout: 600_000,
    });
    if (build.status !== 0) {
        throw new Error(
            `fixture next build failed:\n${build.stdout}\n${build.stderr}`,
        );
    }
    const standalone = join(appDir, ".next", "standalone");
    if (!existsSync(join(standalone, "server.js"))) {
        throw new Error(
            `fixture did not emit .next/standalone/server.js:\n${build.stdout}`,
        );
    }

    // The self-contained build CONTEXT — deliberately NOT a copy of the disk-mode
    // context. It carries ONLY what `Dockerfile.standalone.hbs`'s
    // `standalone-bun-self-contained` stage COPYs: public/, .next/static, and the
    // self-contained-compiled executable. No .next/standalone, no
    // node_modules/@getknext/core — if the Dockerfile stage ever regresses to
    // needing either, this `docker build` fails on a missing COPY source rather
    // than silently succeeding with a fatter image.
    const ctx = join(workDir, "ctx-sc");
    mkdirSync(join(ctx, "public"), { recursive: true });
    if (existsSync(join(appDir, "public"))) {
        cpSync(join(appDir, "public"), join(ctx, "public"), {
            recursive: true,
        });
    }
    cpSync(join(appDir, ".next", "static"), join(ctx, ".next", "static"), {
        recursive: true,
    });

    buildStandaloneExecutable({
        cwd: appDir,
        arch: "linux-x64",
        outFile: join(ctx, standaloneExecFileName("linux-x64")),
        selfContained: true,
    });

    const staged = stageStandaloneBuildContext({
        cwd: ctx,
        buildContext: ctx,
        templateDir: TEMPLATE_DIR,
    });

    const image = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--target",
            TARGET,
            "--file",
            staged.dockerfile,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            IMAGE,
            ctx,
        ],
        { timeout: 600_000 },
    );
    if (image.status !== 0) {
        throw new Error(
            `docker build (${TARGET}) failed:\n${image.stdout}\n${image.stderr}`,
        );
    }

    [appPort, metricsPort] = await freePorts(2);
    const started = run(
        "docker",
        [
            "run",
            "--detach",
            "--name",
            CONTAINER,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--platform",
            PLATFORM,
            "--publish",
            `${appPort}:3000`,
            "--publish",
            `${metricsPort}:9464`,
            IMAGE,
        ],
        { timeout: 120_000 },
    );
    if (started.status !== 0) {
        throw new Error(
            `docker run failed:\n${started.stdout}\n${started.stderr}`,
        );
    }
    await waitForHealth(CONTAINER, appPort);
}, 1_200_000);

afterAll(() => {
    run("docker", ["rm", "--force", CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 120_000);

describe("the self-contained image serves the app with no supervisor shim", () => {
    it("serves /api/health directly off the compiled executable (no bun run server.js, no knext-entry.mjs)", async () => {
        const res = await fetch(`http://127.0.0.1:${appPort}/api/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            status: "ok",
            target: "standalone",
        });
    });
});

describe("the image REALLY has no node_modules or .next/standalone tree (N2 exit criterion)", () => {
    it("no node_modules directory anywhere in the image", () => {
        const found = run(
            "docker",
            [
                "run",
                "--rm",
                "--platform",
                PLATFORM,
                "--entrypoint",
                "sh",
                IMAGE,
                "-c",
                "find / -xdev -name node_modules 2>/dev/null; echo DONE",
            ],
            { timeout: 60_000 },
        );
        expect(found.status, found.stderr).toBe(0);
        expect(found.stdout).not.toContain("node_modules");
        expect(found.stdout).toContain("DONE");
    });

    it("no .next/standalone directory (the executable embeds the app tree)", () => {
        const found = run(
            "docker",
            [
                "run",
                "--rm",
                "--platform",
                PLATFORM,
                "--entrypoint",
                "sh",
                IMAGE,
                "-c",
                "find / -xdev -path '*/.next/standalone' 2>/dev/null; echo DONE",
            ],
            { timeout: 60_000 },
        );
        expect(found.status, found.stderr).toBe(0);
        expect(found.stdout).not.toContain(".next/standalone");
    });

    it("only public/ and .next/static are on disk beside the executable", () => {
        const found = run(
            "docker",
            [
                "run",
                "--rm",
                "--platform",
                PLATFORM,
                "--entrypoint",
                "sh",
                IMAGE,
                "-c",
                "ls -1a /app",
            ],
            { timeout: 60_000 },
        );
        expect(found.status, found.stderr).toBe(0);
        const entries = found.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && l !== "." && l !== "..");
        expect(entries.sort()).toEqual(
            [".next", "knext-standalone-exec", "public"].sort(),
        );
    });
});

describe("the folded supervisor's :9464 metrics endpoint (N2 fold decision)", () => {
    it("serves Prometheus text with knext_up 1 — no separate sidecar process", async () => {
        const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toMatch(/^# HELP /m);
        expect(body).toContain("knext_up 1");
    });
});

// SIGTERM drain — MUST BE LAST: it terminates the container.
describe("SIGTERM drains in-flight work and exits 0, folded into the ONE process", () => {
    it("completes an in-flight request across TERM and exits 0", async () => {
        const reqId = randomBytes(3).toString("hex");
        const inFlight = fetch(
            `http://127.0.0.1:${appPort}/api/slow?ms=4000&id=${reqId}`,
        );
        await new Promise((r) => setTimeout(r, 1000));

        const killed = run("docker", ["kill", "--signal=TERM", CONTAINER], {
            timeout: 60_000,
        });
        expect(killed.status, `docker kill failed:\n${killed.stderr}`).toBe(0);

        const res = await inFlight;
        expect(
            res.status,
            "the in-flight request was dropped by the drain",
        ).toBe(200);
        expect(await res.json()).toEqual({
            ok: true,
            sleptMs: 4000,
            id: reqId,
        });

        const waited = run("docker", ["wait", CONTAINER], { timeout: 40_000 });
        expect(waited.status, `docker wait failed:\n${waited.stderr}`).toBe(0);
        expect(
            waited.stdout.trim(),
            "the folded drain handler did not exit 0 on SIGTERM",
        ).toBe("0");
    }, 90_000);
});
