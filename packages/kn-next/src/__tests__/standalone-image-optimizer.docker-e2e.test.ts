// standalone-image-optimizer.docker-e2e — next/image really optimizes on the
// compiled standalone executable and in the SHIPPED standalone images (#2360).
//
// ── What failed, measured (diag run 38515418989, GitHub runner) ─────────────
//
// `/_next/image` answered image/png where it must answer image/webp, on both:
//
//   - the compiled executable (turbopack x bun): the compile bundled sharp, Bun
//     extracted its embedded `.node` to /tmp, and the addon's relative rpath to
//     libvips then pointed nowhere (ERR_DLOPEN_FAILED);
//   - the shipped alpine image: built on a glibc host, the traced tree carried
//     only `@img/sharp-linux-x64` (glibc), and `require('sharp')` in the image
//     failed for the linuxmusl-x64 runtime.
//
// Next's optimizer catches a sharp load failure and serves the original bytes,
// so neither surfaced as an error — only as a format check like this one.
//
// ── What this proves ────────────────────────────────────────────────────────
//
// The build runs through the SHIPPED `compileArtifactForDeploy` (the step
// `knext build`/`deploy`/`preview` all run), which stages the image platform's
// sharp into the traced tree and compiles the linux-x64 (musl) executable.
// Then, each answering a negotiated WebP smaller than the source:
//
//   1. a host-arch twin of the executable on the build machine (what the
//      compat-smoke lanes boot);
//   2. the standalone-bun image, under the operator's `bun run server.js`;
//   3. the standalone-node image (same traced tree, node:alpine).
//
// NO SKIP PATH: missing docker or bun is a failure. Excluded from the fast lane
// by its `.docker-e2e.test.ts` suffix and run by the `standalone-drain-bun-image`
// CI job (guarded by tests/standalone-drain-image-ci.test.ts).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileArtifactForDeploy } from "../cli/build-artifact";
import { stageStandaloneBuildContext } from "../cli/runtime-image";
import {
    buildStandaloneExecutable,
    standaloneExecFileName,
} from "../cli/standalone-exec-build";
import { hostSmokeArch } from "../cli/vinext-build";
import type { KnativeNextConfig } from "../config";

const PKG_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "standalone-drain-app");
const TEMPLATE_DIR = join(PKG_ROOT, "templates", "runtime-standalone");
// The same PNG compat-smoke check (g) optimizes.
const PNG_SRC = join(
    REPO_ROOT,
    "apps",
    "file-manager",
    "public",
    "knext-optimize-fixture.png",
);
const PNG = "/knext-optimize-fixture.png";
const OPTIMIZE_URL = `/_next/image?url=${encodeURIComponent(PNG)}&w=128&q=75`;
const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const BUN_IMAGE = `knext-image-optimizer-e2e-bun:${RUN_ID}`;
const NODE_IMAGE = `knext-image-optimizer-e2e-node:${RUN_ID}`;
const BUN_CONTAINER = `knext-image-optimizer-e2e-bun-${RUN_ID}`;
const NODE_CONTAINER = `knext-image-optimizer-e2e-node-${RUN_ID}`;
const LABEL = "dev.knext.test=standalone-image-optimizer-e2e";

let workDir = "";
let twin: ChildProcess | undefined;
let twinLog = "";
let twinPort = 0;
let bunPort = 0;
let nodePort = 0;
let tracedImg: string[] = [];

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

function must(label: string, r: ReturnType<typeof run>): void {
    if (r.status !== 0) {
        throw new Error(
            `${label} failed (${r.status}):\n${r.stdout}\n${r.stderr}`,
        );
    }
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

async function waitForHealth(
    port: number,
    describeFailure: () => string,
): Promise<void> {
    const deadline = Date.now() + 120_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (res.ok) return;
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            throw new Error(
                `port ${port} never served /api/health.\n${describeFailure()}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

function dockerLogs(container: string): string {
    const logs = run("docker", ["logs", container], { timeout: 60_000 });
    return `${logs.stdout}\n${logs.stderr}`;
}

beforeAll(async () => {
    must(
        "docker",
        run("docker", ["version", "--format", "{{.Server.Version}}"], {
            timeout: 60_000,
        }),
    );
    must("bun", run("bun", ["--version"], { timeout: 60_000 }));
    if (!existsSync(join(PKG_ROOT, "dist", "adapters", "node-server.js"))) {
        throw new Error(
            "@getknext/core is not built — the image COPYs its dist/ as the supervisor " +
                "(locally: `bun run --filter @getknext/core build`).",
        );
    }

    workDir = mkdtempSync(join(tmpdir(), "knext-image-optimizer-"));
    const appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });
    mkdirSync(join(appDir, "public"), { recursive: true });
    copyFileSync(PNG_SRC, join(appDir, "public", PNG.slice(1)));
    must(
        "fixture bun install",
        run("bun", ["install"], { cwd: appDir, timeout: 300_000 }),
    );
    must("fixture next build", run("bun", ["run", "build"], { cwd: appDir }));

    // The shipped compile step: heal, stage the image platform's sharp into the
    // traced tree, compile the linux-x64 (musl) executable, stamp it.
    const config = {
        name: "image-optimizer-e2e",
        registry: "reg",
    } as KnativeNextConfig;
    const compiled = compileArtifactForDeploy(config, appDir, {
        arch: "linux-x64",
    });
    if (!compiled.compiled || !compiled.binaryPath) {
        throw new Error(
            "compileArtifactForDeploy did not compile the standalone-bun executable",
        );
    }
    const imgDir = join(appDir, ".next", "standalone", "node_modules", "@img");
    tracedImg = existsSync(imgDir) ? readdirSync(imgDir).sort() : [];

    // 1. The host-arch twin, on a copy laid out the way the image lays it out
    //    (static + public inside the tree, the executable beside server.js).
    const twinTree = join(workDir, "twin");
    cpSync(join(appDir, ".next", "standalone"), twinTree, { recursive: true });
    cpSync(join(appDir, ".next", "static"), join(twinTree, ".next", "static"), {
        recursive: true,
    });
    cpSync(join(appDir, "public"), join(twinTree, "public"), {
        recursive: true,
    });
    const twinExe = join(twinTree, "knext-twin-exec");
    // Compiled from the ORIGINAL app dir's tree (the one the shipped binary was
    // compiled from), written into the copy beside its server.js.
    buildStandaloneExecutable({
        cwd: appDir,
        arch: hostSmokeArch(),
        outFile: twinExe,
    });

    [twinPort, bunPort, nodePort] = await freePorts(3);
    twin = spawn(twinExe, [], {
        cwd: twinTree,
        env: { ...process.env, PORT: String(twinPort), HOSTNAME: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    twin.stdout?.on("data", (d) => {
        twinLog += d;
    });
    twin.stderr?.on("data", (d) => {
        twinLog += d;
    });

    // 2 + 3. The shipped images, from a context assembled exactly as the
    //    Dockerfile's COPY lines name it (staged by the shipped function).
    const ctx = join(workDir, "ctx");
    mkdirSync(ctx, { recursive: true });
    cpSync(
        join(appDir, ".next", "standalone"),
        join(ctx, ".next", "standalone"),
        { recursive: true },
    );
    cpSync(join(appDir, ".next", "static"), join(ctx, ".next", "static"), {
        recursive: true,
    });
    cpSync(join(appDir, "public"), join(ctx, "public"), { recursive: true });
    const coreDst = join(ctx, "node_modules", "@getknext", "core");
    mkdirSync(coreDst, { recursive: true });
    copyFileSync(join(PKG_ROOT, "package.json"), join(coreDst, "package.json"));
    cpSync(join(PKG_ROOT, "dist"), join(coreDst, "dist"), { recursive: true });
    cpSync(TEMPLATE_DIR, join(coreDst, "templates", "runtime-standalone"), {
        recursive: true,
    });
    const staged = stageStandaloneBuildContext({
        cwd: ctx,
        buildContext: ctx,
        templateDir: TEMPLATE_DIR,
    });
    copyFileSync(
        compiled.binaryPath,
        join(ctx, standaloneExecFileName("linux-x64")),
    );

    for (const [target, tag] of [
        ["standalone-bun", BUN_IMAGE],
        ["standalone-node", NODE_IMAGE],
    ] as const) {
        must(
            `docker build --target ${target}`,
            run("docker", [
                "build",
                "--platform",
                PLATFORM,
                "--target",
                target,
                "--file",
                staged.dockerfile,
                "--label",
                LABEL,
                "--tag",
                tag,
                ctx,
            ]),
        );
    }
    // bun: the operator's forced command; node: the image's own ENTRYPOINT.
    must(
        "docker run (bun)",
        run("docker", [
            "run",
            "--detach",
            "--name",
            BUN_CONTAINER,
            "--label",
            LABEL,
            "--platform",
            PLATFORM,
            "--entrypoint",
            "bun",
            "--publish",
            `${bunPort}:3000`,
            BUN_IMAGE,
            "run",
            "server.js",
        ]),
    );
    must(
        "docker run (node)",
        run("docker", [
            "run",
            "--detach",
            "--name",
            NODE_CONTAINER,
            "--label",
            LABEL,
            "--platform",
            PLATFORM,
            "--publish",
            `${nodePort}:3000`,
            NODE_IMAGE,
        ]),
    );

    await waitForHealth(twinPort, () => twinLog);
    await waitForHealth(bunPort, () => dockerLogs(BUN_CONTAINER));
    await waitForHealth(nodePort, () => dockerLogs(NODE_CONTAINER));
}, 1_800_000);

afterAll(() => {
    twin?.kill("SIGKILL");
    run("docker", ["rm", "--force", BUN_CONTAINER, NODE_CONTAINER], {
        timeout: 60_000,
    });
    run("docker", ["rmi", "--force", BUN_IMAGE, NODE_IMAGE], {
        timeout: 120_000,
    });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 300_000);

/** The optimizer's own evidence, as compat-smoke check (g) asserts it. */
async function expectOptimized(
    port: number,
    logs: () => string,
): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${port}${OPTIMIZE_URL}`, {
        headers: { accept: "image/webp,image/*,*/*" },
    });
    const body = new Uint8Array(await res.arrayBuffer());
    const detail = `status ${res.status}, ${res.headers.get("content-type")}, ${body.length}B\n${logs()}`;
    // A failed sharp load is not an error to Next: it serves the original PNG.
    const optimized =
        res.status === 200 &&
        res.headers.get("content-type") === "image/webp" &&
        body.length > 0 &&
        body.length < statSync(PNG_SRC).size;
    if (!optimized) throw new Error(`not optimized: ${detail}`);
    expect(res.headers.get("content-type")).toBe("image/webp");
}

describe("next/image optimizes on the compiled standalone executable and in the shipped images (#2360)", () => {
    it("the build staged the image platform's sharp pair beside the traced sharp (the twin below proves the host's pair stayed)", () => {
        expect(tracedImg).toContain("sharp-linuxmusl-x64");
        expect(tracedImg).toContain("sharp-libvips-linuxmusl-x64");
    });

    it("the host-arch twin of the compiled executable answers a negotiated WebP", async () => {
        await expectOptimized(twinPort, () => twinLog);
    });

    it("the standalone-bun image (compiled executable, linuxmusl) answers a negotiated WebP", async () => {
        await expectOptimized(bunPort, () => dockerLogs(BUN_CONTAINER));
    });

    it("the standalone-node image (same traced tree, node:alpine) answers a negotiated WebP", async () => {
        await expectOptimized(nodePort, () => dockerLogs(NODE_CONTAINER));
    });
});
