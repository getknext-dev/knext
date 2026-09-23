// @vitest-environment node
//
// vinext-node-image.docker-e2e — #1260: vinext × node, built and booted for
// real, with the V8 compile cache baked into the image and ACCEPTED on boot.
//
// ── What this proves, and how ────────────────────────────────────────────
//
// 1. The SHIPPED scaffold templates build a node-runnable artifact. The suite
//    renders `vite.config.ts`, `knext-node-entry.mjs` and `runtime-contract.mjs`
//    through `renderScaffold` (the function `kn-next create` uses) over a
//    minimal fixture app whose kn-next.config.ts says `runtime: 'node'`, then
//    runs the app's own `vite build`. `.output/nitro.json` must say
//    `node-server` — checked by the SHIPPED `assertNodePresetOutput`, the same
//    gate `kn-next build` runs.
// 2. The image recipe is staged by the SHIPPED `stageVinextNodeDockerfile`
//    (what `kn-next build` does for an app that lacks it) and built with
//    `docker build`. Its bake step boots the server once, as the runtime uid,
//    and fails the build on an undersized cache — so a green build is already
//    evidence the bake ran.
// 3. The running container answers GET / with 200 and the fixture's page.
// 4. The compile cache is POPULATED inside the running container (bytes on
//    disk under /app/.compile-cache, above the recipe's own floor).
// 5. The cache is LIVE, not merely present: a second container started with
//    NODE_DEBUG_NATIVE=COMPILE_CACHE logs that V8's code cache for
//    `/app/.output/server/index.mjs` "was accepted". Node keys the cache
//    subdirectory by uid, so a bake run as root leaves (4) green and turns (5)
//    red — which is exactly why (5) exists.
//
// ── Discipline mirrored from standalone-webpack-build.docker-e2e ───────────
//
//   - NO SKIP PATH. Missing docker or bun, or an unbuilt @getknext/core, is a
//     FAILURE, never a skip.
//   - UNIQUE per-run image/container names (epoch label) + afterAll cleanup,
//     and a sweep of anything an earlier crashed run leaked.
//   - The fixture is copied to a throwaway dir; it is never built in place.

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
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderScaffold } from "../cli/create";
import { stageVinextNodeDockerfile } from "../cli/runtime-image";
import { assertNodePresetOutput } from "../cli/vinext-node-build";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "vinext-node-app");

const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const CONTAINER = `knext-vinext-node-e2e-${RUN_ID}`;
const DEBUG_CONTAINER = `knext-vinext-node-e2e-debug-${RUN_ID}`;
const IMAGE = `knext-vinext-node-e2e:${RUN_ID}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=vinext-node-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;
const LEAK_AGE_MS = 2 * 60 * 60 * 1000;

/** The templates the node cell ships, rendered exactly as `kn-next create` would. */
const RENDERED_TEMPLATES = [
    "vite.config.ts",
    "knext-node-entry.mjs",
    // A scaffolded app carries BOTH entries. Rendering the bun one too means
    // a vite config that ignored `runtime` would still BUILD (the bun preset)
    // and be caught by the preset check, not by a missing file.
    "knext-bun-entry.mjs",
    "runtime-contract.mjs",
    // The app's own ignore file, which EXCLUDES `.output/server`: rendered on
    // purpose, so a green build proves the per-Dockerfile ignore wins over it.
    ".dockerignore",
] as const;

let workDir = "";
let appDir = "";
let port = 0;
let debugPort = 0;
let nitroPreset = "";
let dockerBuildLog = "";

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
        const p = await new Promise<number>((res, rej) => {
            const srv = createServer();
            srv.on("error", rej);
            srv.listen(0, "127.0.0.1", () => {
                const addr = srv.address();
                if (addr && typeof addr === "object") res(addr.port);
                else rej(new Error("no port"));
            });
            servers.push(srv);
        });
        ports.push(p);
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
            if (Date.now() - startedAt > LEAK_AGE_MS) {
                run("docker", ["rm", "--force", id], { timeout: 60_000 });
            }
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
        { timeout: 120_000 },
    );
}

function logsOf(container: string): string {
    const logs = run("docker", ["logs", container], { timeout: 60_000 });
    return `${logs.stdout}\n${logs.stderr}`;
}

async function waitForHealth(container: string, p: number) {
    const deadline = Date.now() + 180_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${p}/api/health`);
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
            throw new Error(
                `${container} never served /api/health (${died ? "it exited" : "timed out"}).\nlogs:\n${logsOf(container)}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

function startContainer(name: string, hostPort: number, env: string[] = []) {
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
            ...env.flatMap((e) => ["--env", e]),
            "--publish",
            `${hostPort}:3000`,
            IMAGE,
        ],
        { timeout: 120_000 },
    );
    if (started.status !== 0) {
        throw new Error(
            `docker run ${name} failed:\n${started.stdout}\n${started.stderr}`,
        );
    }
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
    // The node entry imports @getknext/core's image optimizer and the vite
    // config its cache adapter; both resolve to this checkout's BUILT dist.
    const optimizer = join(
        PKG_ROOT,
        "dist",
        "adapters",
        "vinext-image-optimizer.js",
    );
    if (!existsSync(optimizer)) {
        throw new Error(
            `${optimizer} missing — build @getknext/core before this suite ` +
                "(locally: `bun run --filter @getknext/core build`, after lib and db).",
        );
    }

    sweepLeakedArtifacts();

    // 2. A throwaway app: the fixture + the SHIPPED templates, rendered.
    workDir = mkdtempSync(join(tmpdir(), "knext-vinext-node-"));
    appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });
    const rendered = renderScaffold({
        name: "vinext-node-fixture",
        version: "0.0.0",
    });
    for (const rel of RENDERED_TEMPLATES) {
        const text = rendered.get(rel);
        if (text === undefined) {
            throw new Error(
                `the scaffold no longer renders ${rel} — update this suite`,
            );
        }
        writeFileSync(join(appDir, rel), text, "utf8");
    }
    // What `kn-next build` does for an app that has no recipe yet.
    const staged = stageVinextNodeDockerfile({ cwd: appDir });
    if (!staged.staged) {
        throw new Error(
            "stageVinextNodeDockerfile wrote nothing into a fresh app",
        );
    }

    // 3. Install, then link @getknext/core to THIS checkout (the published
    //    version would test someone else's code).
    const install = run("bun", ["install"], { cwd: appDir, timeout: 300_000 });
    if (install.status !== 0) {
        throw new Error(
            `fixture bun install failed:\n${install.stdout}\n${install.stderr}`,
        );
    }
    mkdirSync(join(appDir, "node_modules", "@getknext"), { recursive: true });
    symlinkSync(
        PKG_ROOT,
        join(appDir, "node_modules", "@getknext", "core"),
        "dir",
    );

    // 4. The app's own build — the vite config picks the preset from
    //    kn-next.config.ts, which says runtime: 'node'.
    const build = run("bun", ["run", "build"], {
        cwd: appDir,
        timeout: 600_000,
    });
    if (build.status !== 0) {
        throw new Error(
            `fixture "vite build" failed:\n${build.stdout}\n${build.stderr}`,
        );
    }
    nitroPreset = String(
        (
            JSON.parse(
                readFileSync(join(appDir, ".output", "nitro.json"), "utf8"),
            ) as { preset?: unknown }
        ).preset,
    );
    // The shipped gate `kn-next build` runs; throws on a bun-preset output.
    assertNodePresetOutput(appDir);

    // 5. The image, from the staged recipe. Its bake RUN fails the build on
    //    a failed warm or an undersized cache.
    const image = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--progress",
            "plain",
            "--file",
            staged.dockerfile,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            IMAGE,
            appDir,
        ],
        { timeout: 900_000 },
    );
    dockerBuildLog = `${image.stdout}\n${image.stderr}`;
    if (image.status !== 0) {
        throw new Error(`docker build failed:\n${dockerBuildLog}`);
    }

    // 6. Run it twice: once as shipped, once with node's compile-cache
    //    diagnostics on (debug output is noisy, so it gets its own container).
    [port, debugPort] = await freePorts(2);
    startContainer(CONTAINER, port);
    startContainer(DEBUG_CONTAINER, debugPort, [
        "NODE_DEBUG_NATIVE=COMPILE_CACHE",
    ]);
    await waitForHealth(CONTAINER, port);
    await waitForHealth(DEBUG_CONTAINER, debugPort);
}, 1_800_000);

afterAll(() => {
    run("docker", ["rm", "--force", CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", DEBUG_CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("vinext × node builds the node preset from the shipped templates", () => {
    it(".output/nitro.json says node-server — not the bun preset that crashes under node", () => {
        expect(nitroPreset).toBe("node-server");
    });

    it("the built server carries no Bun API reference", () => {
        const entry = readFileSync(
            join(appDir, ".output", "server", "index.mjs"),
            "utf8",
        );
        expect(entry).not.toMatch(/\bBun\.serve\b/);
    });
});

describe("the vinext × node image serves", () => {
    it("GET / is 200 and serves the fixture's page", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("knext vinext-node fixture");
    });

    it("the :9464 metrics listener answers inside the container", () => {
        const scrape = run(
            "docker",
            [
                "exec",
                CONTAINER,
                "node",
                "-e",
                "fetch('http://127.0.0.1:9464/metrics').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))",
            ],
            { timeout: 60_000 },
        );
        expect(scrape.status, `${scrape.stdout}\n${scrape.stderr}`).toBe(0);
    });
});

describe("the V8 compile cache is baked into the image and LIVE (ADR-0035)", () => {
    it("the bake ran at docker build and reported its size", () => {
        expect(dockerBuildLog).toMatch(/compile cache baked: \d+ bytes/);
    });

    it("/app/.compile-cache is populated in the running container, above the recipe's floor", () => {
        const bytes = run(
            "docker",
            [
                "exec",
                CONTAINER,
                "sh",
                "-c",
                "find /app/.compile-cache -type f -exec cat {} + | wc -c",
            ],
            { timeout: 60_000 },
        );
        expect(bytes.status, bytes.stderr).toBe(0);
        // The recipe's own floor (ARG KNEXT_COMPILE_CACHE_MIN_BYTES).
        expect(Number(bytes.stdout.trim())).toBeGreaterThanOrEqual(65_536);
    });

    it("the entry reports the baked directory as the cache it is using", () => {
        expect(logsOf(CONTAINER)).toMatch(
            /COMPILE_CACHE:\/app\/\.compile-cache\//,
        );
    });

    it("V8 ACCEPTED the baked code cache for the server entry on boot — a hit, not just a file", () => {
        const logs = logsOf(DEBUG_CONTAINER);
        expect(
            logs,
            "node did not accept the baked cache for the entry. If the cache is " +
                "populated but not accepted, the bake most likely ran as a different " +
                `uid than the runtime (the cache subdirectory is keyed by uid).\n${logs.slice(-3000)}`,
        ).toMatch(
            // node 22 logs "cache for file:///…", node 24 "V8 code cache for ESM file:///…".
            /cache for (ESM )?file:\/\/\/app\/\.output\/server\/index\.mjs was accepted/,
        );
    });
});
