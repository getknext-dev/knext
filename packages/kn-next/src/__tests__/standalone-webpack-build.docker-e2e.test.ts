// @vitest-environment node
//
// standalone-webpack-build.docker-e2e — #1219 round 2 (spec review): the
// `webpack` builder was, until this file, only SHAPE-verified —
// `describeArtifact()` asserted the descriptor equals turbopack's, but no
// real `next build --webpack` had ever run and nothing had booted. This
// suite closes that gap with a REAL build, on the pinned Next version, going
// through the same shipped functions `kn-next build` uses.
//
// ── What this proves, and how ────────────────────────────────────────────
//
// 1. `next build --webpack` actually succeeds on the pinned Next (16.3.3) —
//    not assumed, not shape-inferred from turbopack's contract entry.
// 2. The emitted `.next/standalone` tree is genuinely a WEBPACK bundle, not
//    turbopack silently winning anyway: `.next/server/webpack-runtime.js`
//    only exists in a webpack build. Measured directly (not asserted from
//    prose) against this exact fixture + pinned Next version:
//
//      $ next build --webpack   -> .next/standalone/.next/server/webpack-runtime.js EXISTS
//      $ next build             -> that path does NOT exist (Turbopack is the
//                                   pinned Next's default bundler for `next build`)
//
//    That asymmetry is exactly what the mutation proof below exploits: since
//    BOTH bundlers emit the same `.next/standalone/server.js` shape (that is
//    the whole point of the artifact contract's shape-keyed design), dropping
//    `--webpack` does NOT fail the build — it only makes the webpack-runtime
//    marker vanish. A test that only checked "the build succeeded" would stay
//    green under that mutation; this one does not.
// 3. It boots, on BOTH runtime cells the artifact contract says accept the
//    `next-standalone` shape:
//      - **node** — the shipped standalone-node image, whose Dockerfile CMD
//        points `NODE_COMPILE_CACHE` at the image-baked compile-cache dir by
//        default (ADR-0035); no extra env needed to exercise that path.
//      - **bun** — via the shipped `buildStandaloneExecutable()`, the exact
//        function `kn-next build` runs for `runtime: 'bun'` on the standalone
//        shape. That function is fail-closed on the bytecode check (it throws
//        if the compiled binary was not verified bytecode), so a green
//        `beforeAll` here already proves "bytecode verifier passes" — a
//        second explicit assertion below reads back the produced file.
// 4. Both containers answer a real page request with 200.
//
// ── Discipline mirrored from standalone-drain.docker-e2e (#1156) ───────────
//
//   - NO SKIP PATH. Missing docker or bun is a FAILURE, never a skip.
//   - UNIQUE per-run image/container names (epoch label) + afterAll cleanup.
//   - Reuses the SAME fixture source as standalone-drain.docker-e2e
//     (`fixtures/standalone-drain-app`) but its OWN throwaway copy with the
//     build script rewritten to `next build --webpack` — the fixture is never
//     mutated in place, so the two suites cannot interfere with each other
//     even when bun-test.mjs's isolated-process-per-file runner is bypassed.

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

const RUN_ID = randomBytes(4).toString("hex");
const NODE_CONTAINER = `knext-webpack-build-e2e-node-${RUN_ID}`;
const NODE_IMAGE = `knext-webpack-build-e2e-node:${RUN_ID}`;
const BUN_CONTAINER = `knext-webpack-build-e2e-bun-${RUN_ID}`;
const BUN_IMAGE = `knext-webpack-build-e2e-bun:${RUN_ID}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=webpack-build-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;
const LEAK_AGE_MS = 2 * 60 * 60 * 1000;

/** A throwaway build dir; removed in afterAll (D9 temp-dir pairing). */
let workDir = "";

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

let nodePort = 0;
let bunPort = 0;
/** Whether the WEBPACK-only marker was found in the fixture's real build output. */
let hasWebpackRuntimeMarker = false;
/** Whether the build's own banner reported using webpack. */
let buildBannerSaysWebpack = false;
/** The bun-target compiled executable path, once produced. */
let bunExecPath = "";

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
            const code = run(
                "docker",
                ["inspect", container, "--format", "{{.State.ExitCode}}"],
                { timeout: 60_000 },
            );
            throw new Error(
                `${container} never served /api/health (${died ? "it exited" : "timed out"}).\n` +
                    `exit code: ${code.stdout.trim()}\nlogs:\n${logs.stdout}\n${logs.stderr}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
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

    // 2. @getknext/core must be BUILT — the image COPYs its whole dist/ closure.
    if (!existsSync(join(PKG_ROOT, "dist", "adapters", "node-server.js"))) {
        throw new Error(
            `${join(PKG_ROOT, "dist", "adapters", "node-server.js")} missing — build ` +
                "@getknext/core before this suite (CI builds it in the " +
                "standalone-drain-bun-image job; locally: `bun run --filter @getknext/core build`).",
        );
    }

    sweepLeakedArtifacts();

    // 3. The build context — assembled UNCONDITIONALLY every run.
    workDir = mkdtempSync(join(tmpdir(), "knext-webpack-build-"));
    const appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });

    // 3a. Select webpack EXPLICITLY, the same way a real app does: its own
    //     build script runs `next build --webpack` — never a `--webpack` flag
    //     this suite bolts on outside the project's own command. This is the
    //     "project build" path `kn-next build`'s runProjectBuild seam runs
    //     (`npm run build` / `bun run build`), so it exercises the real thing
    //     a user selecting `build: 'webpack'` in kn-next.config.ts relies on.
    const pkgJsonPath = join(appDir, "package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        scripts: Record<string, string>;
    };
    if (pkgJson.scripts.build !== "next build") {
        throw new Error(
            `fixture's build script drifted from the expected "next build" ` +
                `(got ${JSON.stringify(pkgJson.scripts.build)}) — update this suite's ` +
                "assumption before trusting the --webpack override below.",
        );
    }
    pkgJson.scripts.build = "next build --webpack";
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`, "utf8");

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
            `fixture "next build --webpack" failed — if the pinned Next version ` +
                "cannot build with --webpack, that is a discovered fact this suite " +
                `surfaces rather than papering over:\n${build.stdout}\n${build.stderr}`,
        );
    }
    // The build's own banner names the bundler it used — belt-and-braces
    // alongside the on-disk marker asserted below. Recorded, not thrown: a
    // missing --webpack must fail the DEDICATED `it`s below (the
    // mutation-proof target), not abort the whole suite from inside
    // `beforeAll` — that would hide whether the on-disk marker check (the
    // primary anchor) independently catches the same mutation.
    buildBannerSaysWebpack = /\(webpack\)/i.test(build.stdout);

    const standalone = join(appDir, ".next", "standalone");
    if (!existsSync(join(standalone, "server.js"))) {
        throw new Error(
            `webpack build did not emit .next/standalone/server.js:\n${build.stdout}`,
        );
    }
    // Measured (not asserted from prose): a `next build --webpack` bundle
    // carries `.next/server/webpack-runtime.js`; a Turbopack bundle (the
    // pinned Next's default for a bare `next build`) does not. Read back
    // here rather than thrown, so a missing marker fails the DEDICATED `it`
    // below (the mutation-proof target) instead of crashing the whole suite.
    hasWebpackRuntimeMarker = existsSync(
        join(standalone, ".next", "server", "webpack-runtime.js"),
    );

    // 3b. Assemble the Docker build CONTEXT via the SHIPPED staging function
    //     (#1186), exactly as standalone-drain.docker-e2e does.
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
    mkdirSync(join(ctx, "public"), { recursive: true });
    if (existsSync(join(appDir, "public"))) {
        cpSync(join(appDir, "public"), join(ctx, "public"), {
            recursive: true,
        });
    }
    const coreDst = join(ctx, "node_modules", "@getknext", "core");
    mkdirSync(coreDst, { recursive: true });
    cpSync(join(PKG_ROOT, "package.json"), join(coreDst, "package.json"));
    cpSync(join(PKG_ROOT, "dist"), join(coreDst, "dist"), { recursive: true });
    cpSync(TEMPLATE_DIR, join(coreDst, "templates", "runtime-standalone"), {
        recursive: true,
    });
    const staged = stageStandaloneBuildContext({
        cwd: ctx,
        buildContext: ctx,
        templateDir: TEMPLATE_DIR,
    });

    // 3c. Compile the bun-target executable via the SHIPPED, fail-closed
    //     `buildStandaloneExecutable()` — the exact function `kn-next build`
    //     runs for `build: 'webpack'` (or 'turbopack') + `runtime: 'bun'`. It
    //     throws if the produced binary is not verified bytecode, so a green
    //     `beforeAll` here IS the bytecode-verifier-passes proof; the `it`
    //     below just reads the artifact back.
    bunExecPath = join(ctx, standaloneExecFileName("linux-x64"));
    buildStandaloneExecutable({
        cwd: appDir,
        arch: "linux-x64",
        outFile: bunExecPath,
    });

    // 4. Build both shipped images from the SAME webpack-built context.
    const nodeImage = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--target",
            "standalone-node",
            "--file",
            staged.dockerfile,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            NODE_IMAGE,
            ctx,
        ],
        { timeout: 600_000 },
    );
    if (nodeImage.status !== 0) {
        throw new Error(
            `docker build (node target) failed:\n${nodeImage.stdout}\n${nodeImage.stderr}`,
        );
    }

    const bunImage = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--target",
            "standalone-bun",
            "--file",
            staged.dockerfile,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            BUN_IMAGE,
            ctx,
        ],
        { timeout: 600_000 },
    );
    if (bunImage.status !== 0) {
        throw new Error(
            `docker build (bun target) failed:\n${bunImage.stdout}\n${bunImage.stderr}`,
        );
    }

    // 5. Run both. Node: the image's own ENTRYPOINT (the operator leaves
    //    Command nil for runtime: node — nextapp_controller.go:1018 only
    //    forces a command for runtime: bun), whose Dockerfile CMD points
    //    NODE_COMPILE_CACHE at the image-baked compile-cache dir by default
    //    (ADR-0035) — no extra env needed to exercise that path. Bun: the
    //    operator's forced `bun run server.js` (the R3 shim), which the
    //    supervisor answers by spawning the COMPILED executable, not the
    //    script (standalone-drain.docker-e2e pins that exec-mode contract
    //    directly; this suite only needs it to serve).
    [nodePort, bunPort] = await freePorts(2);

    const startedNode = run(
        "docker",
        [
            "run",
            "--detach",
            "--name",
            NODE_CONTAINER,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--platform",
            PLATFORM,
            "--publish",
            `${nodePort}:3000`,
            NODE_IMAGE,
        ],
        { timeout: 120_000 },
    );
    if (startedNode.status !== 0) {
        throw new Error(
            `docker run (node target) failed:\n${startedNode.stdout}\n${startedNode.stderr}`,
        );
    }

    const startedBun = run(
        "docker",
        [
            "run",
            "--detach",
            "--name",
            BUN_CONTAINER,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--platform",
            PLATFORM,
            "--entrypoint",
            "bun",
            "--publish",
            `${bunPort}:3000`,
            BUN_IMAGE,
            "run",
            "server.js",
        ],
        { timeout: 120_000 },
    );
    if (startedBun.status !== 0) {
        throw new Error(
            `docker run (bun target) failed:\n${startedBun.stdout}\n${startedBun.stderr}`,
        );
    }

    await waitForHealth(NODE_CONTAINER, nodePort);
    await waitForHealth(BUN_CONTAINER, bunPort);
}, 1_200_000);

afterAll(() => {
    run("docker", ["rm", "--force", NODE_CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", BUN_CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", NODE_IMAGE], { timeout: 60_000 });
    run("docker", ["rmi", "--force", BUN_IMAGE], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ── MUTATION-PROOF TARGET ────────────────────────────────────────────────
// Delete the `--webpack` override in beforeAll (or anywhere upstream that
// makes the fixture build with webpack) and THESE two assertions are what go
// red — the build itself still succeeds (both bundlers emit the same
// `.next/standalone` shape), so only this describe block catches the drift
// back to Turbopack. Verified by hand: reverting `pkgJson.scripts.build` to
// `"next build"` leaves the other 4 `it`s in this file green (the compiled
// exec, both boots, the exec-mode log check) and reds exactly these 2 —
// `hasWebpackRuntimeMarker === false` and `buildBannerSaysWebpack === false`.
describe("the fixture was genuinely built with webpack, not turbopack (#1219)", () => {
    it(".next/server/webpack-runtime.js exists — the webpack-only bundle marker", () => {
        expect(
            hasWebpackRuntimeMarker,
            "no .next/standalone/.next/server/webpack-runtime.js — this Next version's " +
                "default bundler (Turbopack) built the fixture instead of webpack, even " +
                "though the fixture's build script requested --webpack",
        ).toBe(true);
    });

    it("the build's own banner reported using webpack, not Turbopack", () => {
        expect(
            buildBannerSaysWebpack,
            "next build did not report using webpack in its own banner — the fixture's " +
                "build script did not actually request --webpack",
        ).toBe(true);
    });
});

describe("the compiled bun executable exists (bytecode-verifier passed in beforeAll)", () => {
    it("buildStandaloneExecutable() produced the file it names", () => {
        expect(
            existsSync(bunExecPath),
            "buildStandaloneExecutable() returned without producing its outFile — " +
                "it is fail-closed on the bytecode check, so a missing file here would " +
                "mean the check silently stopped enforcing",
        ).toBe(true);
    });
});

describe("both runtime cells boot the webpack-built standalone shape and serve a real page", () => {
    it("node: GET / is 200 and serves the fixture's page (NODE_COMPILE_CACHE is the image default)", async () => {
        const res = await fetch(`http://127.0.0.1:${nodePort}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("knext standalone drain fixture");
    });

    it("bun: GET / is 200 and serves the fixture's page (compiled bytecode executable)", async () => {
        const res = await fetch(`http://127.0.0.1:${bunPort}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("knext standalone drain fixture");
    });

    it("bun: the supervisor spawned the COMPILED executable, not the raw script", () => {
        const logs = run("docker", ["logs", BUN_CONTAINER], {
            timeout: 60_000,
        });
        const out = `${logs.stdout}\n${logs.stderr}`;
        const start = out
            .split("\n")
            .find((l) => l.includes("Starting Next.js standalone server"));
        expect(
            start,
            "the supervisor never logged the child start",
        ).toBeTruthy();
        expect(start).toContain('"mode":"exec"');
    });
});
