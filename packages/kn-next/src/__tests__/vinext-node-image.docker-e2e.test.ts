// @vitest-environment node
//
// vinext-node-image.docker-e2e — #1260: vinext × node, built and booted for
// real, with the V8 compile cache baked into the image and ACCEPTED on boot.
//
// ── What this proves, and how ────────────────────────────────────────────
//
// 1. The SHIPPED scaffold templates build a node-runnable artifact. The suite
//    renders `vite.config.ts`, `knext-node-entry.mjs` and `runtime-contract.mjs`
//    through `renderScaffold` (the function `knext create` uses) over a
//    minimal fixture app whose kn-next.config.ts says `runtime: 'node'`, then
//    runs the app's own `vite build`. `.output/nitro.json` must say
//    `node-server` — checked by the SHIPPED `assertNodePresetOutput`, the same
//    gate `knext build` runs.
// 2. The image recipe is staged by the SHIPPED `stageVinextNodeDockerfile`
//    (what `knext build` does for an app that lacks it) and built with
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
// 6. #1298: `/_next/image` actually RESIZES, through the shipped image. The
//    SHIPPED `stageSharpForVinextNode` (what `kn-next build` runs) replaces
//    nitro's own host-platform/incomplete trace before the docker build, and
//    the node entry direct-passes sharp to the image optimizer (`sharp` no
//    longer relies on a `createRequire(cwd)` resolve that can never find
//    `.output/server/node_modules` in the deployed image). A negotiated-format
//    response that is SMALLER than the source PNG is proof the real sharp
//    ran, not the fail-open passthrough.
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
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderScaffold } from "../cli/create";
import { stageVinextNodeDockerfile } from "../cli/runtime-image";
import { stageSharpForVinextNode } from "../cli/vinext-build";
import { assertNodePresetOutput } from "../cli/vinext-node-build";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "vinext-node-app");

const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const CONTAINER = `knext-vinext-node-e2e-${RUN_ID}`;
const DEBUG_CONTAINER = `knext-vinext-node-e2e-debug-${RUN_ID}`;
const AFTER_CONTAINER = `knext-vinext-node-e2e-after-${RUN_ID}`;
const NESTED_CONTAINER = `knext-vinext-node-e2e-nested-${RUN_ID}`;
const CAP_CONTAINER = `knext-vinext-node-e2e-cap-${RUN_ID}`;
/** Same image, with the deployed Cache-Control rule switched off. */
const CC_OFF_CONTAINER = `knext-vinext-node-e2e-ccoff-${RUN_ID}`;
/** The hardcap container's grace: short, so the force path is observable. */
const CAP_GRACE_MS = 3000;
const IMAGE = `knext-vinext-node-e2e:${RUN_ID}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=vinext-node-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;
const LEAK_AGE_MS = 2 * 60 * 60 * 1000;

/** The templates the node cell ships, rendered exactly as `knext create` would. */
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

/**
 * Packages the node server entry imports that the fixture does NOT declare
 * itself: taken from the rendered template package.json (see 2b). `sharp`
 * moved here with #1298's direct-pass fix — the entry now statically imports
 * it (like the bun entry always has), so an undeclared template dependency
 * fails the fixture's OWN build, exactly like `srvx`.
 */
const ENTRY_RUNTIME_DEPS = ["srvx", "sharp"] as const;

/** The real, decodable PNG `/_next/image` resizes in the tests below. */
const TEST_IMAGE = join(
    __dirname,
    "fixtures",
    "vinext-node-app",
    "public",
    "test-image.png",
);

let workDir = "";
let appDir = "";
let port = 0;
let debugPort = 0;
let afterPort = 0;
let nestedPort = 0;
let capPort = 0;
let ccOffPort = 0;
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
    // #1342/ADR-0058: `knext create`'s DEFAULT builder no longer renders
    // these vinext-shaped files at all — request the `--builder vinext`
    // override explicitly, matching what this suite actually exercises (the
    // vinext × node runtime image).
    const rendered = renderScaffold({
        name: "vinext-node-fixture",
        version: "0.0.0",
        builder: "vinext",
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
    // What `knext build` does for an app that has no recipe yet.
    const staged = stageVinextNodeDockerfile({ cwd: appDir });
    if (!staged.staged) {
        throw new Error(
            "stageVinextNodeDockerfile wrote nothing into a fresh app",
        );
    }

    // 2b. The runtime dependencies the SERVER ENTRY imports come from the
    //     rendered `knext create` package.json — never from the fixture — so
    //     a template that forgets to declare one fails here, not in a user's
    //     repo. (The fixture deliberately omits srvx.) Only the packages the
    //     entry needs: the rest of the template's deps (@getknext/lib, otel…)
    //     are published packages this offline fixture does not build.
    const templatePkg = JSON.parse(rendered.get("package.json") ?? "{}") as {
        dependencies?: Record<string, string>;
    };
    const fixturePkgPath = join(appDir, "package.json");
    const fixturePkg = JSON.parse(readFileSync(fixturePkgPath, "utf8")) as {
        dependencies: Record<string, string>;
    };
    for (const name of ENTRY_RUNTIME_DEPS) {
        const version = templatePkg.dependencies?.[name];
        // Absent → NOT injected; the isolated install below then leaves the
        // import unresolvable and the build fails, which is the point.
        if (version !== undefined) fixturePkg.dependencies[name] = version;
    }
    writeFileSync(fixturePkgPath, `${JSON.stringify(fixturePkg, null, 2)}\n`);

    // 3. Install with an ISOLATED linker (pnpm-like: only declared packages
    //    are resolvable from the app), then link @getknext/core to THIS
    //    checkout (the published version would test someone else's code).
    const install = run("bun", ["install", "--linker", "isolated"], {
        cwd: appDir,
        timeout: 300_000,
    });
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
    // The shipped gate `knext build` runs; throws on a bun-preset output.
    assertNodePresetOutput(appDir);

    // 4b. #1298: nitro's own trace into `.output/server/node_modules` copies
    //     the BUILD HOST's sharp addon and an incomplete JS package — exactly
    //     what `kn-next build` fixes before the image is built. Re-run that
    //     fix here for the same reason the other shipped gates run here: this
    //     proves the SHIPPED function, not a copy of its logic.
    const sharpStaged = stageSharpForVinextNode(appDir, { arch: "linux-x64" });
    if (!sharpStaged.staged) {
        throw new Error(
            "stageSharpForVinextNode reported nothing staged for a fixture that declares sharp",
        );
    }

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
    //    Plus one container per SIGTERM case, since each one ends its container.
    [port, debugPort, afterPort, nestedPort, capPort, ccOffPort] =
        await freePorts(6);
    startContainer(CONTAINER, port);
    startContainer(DEBUG_CONTAINER, debugPort, [
        "NODE_DEBUG_NATIVE=COMPILE_CACHE",
    ]);
    startContainer(AFTER_CONTAINER, afterPort);
    startContainer(NESTED_CONTAINER, nestedPort);
    startContainer(CAP_CONTAINER, capPort, [
        `SHUTDOWN_GRACE_MS=${CAP_GRACE_MS}`,
    ]);
    startContainer(CC_OFF_CONTAINER, ccOffPort, [
        "KNEXT_CACHE_CONTROL_NORMALIZE=0",
    ]);
    await waitForHealth(CONTAINER, port);
    await waitForHealth(DEBUG_CONTAINER, debugPort);
    await waitForHealth(AFTER_CONTAINER, afterPort);
    await waitForHealth(NESTED_CONTAINER, nestedPort);
    await waitForHealth(CAP_CONTAINER, capPort);
    await waitForHealth(CC_OFF_CONTAINER, ccOffPort);
}, 1_800_000);

afterAll(() => {
    run("docker", ["rm", "--force", CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", DEBUG_CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", AFTER_CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", NESTED_CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", CAP_CONTAINER], { timeout: 60_000 });
    run("docker", ["rm", "--force", CC_OFF_CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    // Five containers and an image take longer to remove than bun's 5s hook
    // default on a loaded host — measured: the hook timed out and failed a
    // run whose every test had passed.
}, 300_000);

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
        // `docker exec` + a node boot under linux/amd64 emulation outlives
        // bun's 5s default on a loaded host — measured, with four containers up.
    }, 60_000);
});

describe("#1298 /_next/image resizes for real, through the shipped image", () => {
    const SOURCE_BYTES = statSync(TEST_IMAGE).size;

    it("a webp-negotiated request is smaller than the source and decodes as webp", async () => {
        const res = await fetch(
            `http://127.0.0.1:${port}/_next/image?url=%2Ftest-image.png&w=32&q=75`,
            { headers: { accept: "image/webp" } },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/webp");
        const bytes = await res.arrayBuffer();
        // A passthrough (sharp missing/failed) would serve the source PNG
        // byte-for-byte — same size, same content-type. A real resize to 32px
        // wide + webp is a two-orders-of-magnitude shrink on this fixture
        // (measured locally: 49456 -> 376 bytes); assert an order of
        // magnitude margin rather than the exact figure.
        expect(bytes.byteLength).toBeLessThan(SOURCE_BYTES / 10);
        expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it("an unnegotiated request (no Accept) still resizes, kept in the source format", async () => {
        const res = await fetch(
            `http://127.0.0.1:${port}/_next/image?url=%2Ftest-image.png&w=32&q=75`,
        );
        expect(res.status).toBe(200);
        const bytes = await res.arrayBuffer();
        expect(bytes.byteLength).toBeLessThan(SOURCE_BYTES / 5);
    });
});

const DEPLOY_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const ORIGIN_CACHE_CONTROL = "s-maxage=2, stale-while-revalidate=31535998";

describe("the deployed Cache-Control rule in the vinext × node image", () => {
    // srvx/node writes response headers as a flat array, which the node:http
    // preload does not rewrite, so this is the entry's Response-level
    // middleware at work, proven through the shipped image.
    it("an app-set origin ISR value reaches clients as the deployed value", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/cache-probe`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe(DEPLOY_CACHE_CONTROL);
    });

    it("an ISR page is served with the deployed value", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/isr`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe(DEPLOY_CACHE_CONTROL);
    });

    it("vinext's own deploy switch is on by default in the serving process", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/cache-probe`);
        expect(
            ((await res.json()) as { vinextDeploy: unknown }).vinextDeploy,
        ).toBe("1");
    });

    it("KNEXT_CACHE_CONTROL_NORMALIZE=0 serves the origin values and leaves vinext's switch unset", async () => {
        const probe = await fetch(
            `http://127.0.0.1:${ccOffPort}/api/cache-probe`,
        );
        expect(probe.headers.get("cache-control")).toBe(ORIGIN_CACHE_CONTROL);
        expect(
            ((await probe.json()) as { vinextDeploy: unknown }).vinextDeploy,
        ).toBeNull();
        const isr = await fetch(`http://127.0.0.1:${ccOffPort}/isr`);
        expect(isr.status).toBe(200);
        // vinext's own origin value for this page on Node, measured in this
        // image with both layers off. Anything else means a layer still ran.
        expect(isr.headers.get("cache-control")).toBe(
            "no-store, must-revalidate",
        );
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
    }, 60_000);

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
// ── SIGTERM (security.md: drain in-flight work and run after() before exit) ──
//
// Every scale-to-zero scale-down is a SIGTERM, so these are the shutdown
// guarantees the node entry owes, proved against the REAL image over REAL
// sockets — the same shape as the bun image's drain gate (alpine-image e2e)
// and the bun entry's hardcap e2e. Each case owns its container, because each
// one ends it. The in-flight case uses the main container, so it runs LAST.

/** `docker kill --signal=TERM`, then `docker wait`: the exit code and how long it took. */
function termAndWait(container: string): { code: string; ms: number } {
    const t0 = Date.now();
    const killed = run("docker", ["kill", "--signal=TERM", container], {
        timeout: 60_000,
    });
    expect(killed.status, `docker kill failed:\n${killed.stderr}`).toBe(0);
    const waited = run("docker", ["wait", container], { timeout: 60_000 });
    expect(waited.status, `docker wait failed:\n${waited.stderr}`).toBe(0);
    return { code: waited.stdout.trim(), ms: Date.now() - t0 };
}

describe("SIGTERM — the node entry drains in the shipped image", () => {
    it("after(): background work scheduled by a finished request runs BEFORE the process exits", async () => {
        // The response returns at once; the after() callback finishes 3s later.
        const res = await fetch(
            `http://127.0.0.1:${afterPort}/api/after?ms=3000`,
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ scheduled: true, ms: 3000 });

        const { code } = termAndWait(AFTER_CONTAINER);
        const out = logsOf(AFTER_CONTAINER);
        expect(code, `not the graceful exit-0 path:\n${out}`).toBe("0");
        // Order is the claim: the signal, THEN the after() work, THEN the drain
        // concluding. `AFTER-RAN` missing means shutdown did not wait for it.
        const sig = out.indexOf("SIGNAL:SIGTERM");
        const ran = out.indexOf("AFTER-RAN ms=3000");
        const drained = out.indexOf("DRAINED cleanly");
        expect(sig, out).toBeGreaterThan(-1);
        expect(
            ran,
            `after() work was dropped on SIGTERM:\n${out}`,
        ).toBeGreaterThan(sig);
        expect(drained, out).toBeGreaterThan(ran);
    }, 60_000);

    it("nested after(): work an after() callback registers DURING the drain still runs before exit", async () => {
        // The outer callback sleeps NESTED_MS (the signal lands inside it),
        // then hands a further NESTED_MS of work to `after(promise)` — vinext's
        // `waitUntil` — and returns. A drain that awaited only the tasks pending
        // when it started reports DRAINED as soon as the outer callback returns.
        // 4s, not 2s: `docker kill` on a loaded host was measured landing >2s
        // after the response, which would let the outer work finish first.
        const NESTED_MS = 4000;
        const res = await fetch(
            `http://127.0.0.1:${nestedPort}/api/after-nested?ms=${NESTED_MS}`,
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            scheduled: true,
            nested: true,
            ms: NESTED_MS,
        });

        const { code } = termAndWait(NESTED_CONTAINER);
        const out = logsOf(NESTED_CONTAINER);
        expect(code, `not the graceful exit-0 path:\n${out}`).toBe("0");
        const sig = out.indexOf("SIGNAL:SIGTERM");
        const outer = out.indexOf(`OUTER-RAN ms=${NESTED_MS}`);
        const nested = out.indexOf(`NESTED-RAN ms=${NESTED_MS}`);
        const drained = out.indexOf("DRAINED cleanly");
        expect(sig, out).toBeGreaterThan(-1);
        // The outer callback must still be running when the signal lands, or
        // the nested registration happens BEFORE the drain and proves nothing.
        expect(
            outer,
            `the outer after() did not span the signal:\n${out}`,
        ).toBeGreaterThan(sig);
        expect(
            nested,
            `nested after()/waitUntil work was dropped on SIGTERM:\n${out}`,
        ).toBeGreaterThan(outer);
        expect(drained, out).toBeGreaterThan(nested);
    }, 60_000);

    it("hardcap: a request that outlives SHUTDOWN_GRACE_MS is force-stopped, exit 1, at ~the grace", async () => {
        // Sleeps far past the 3s grace; the connection is expected to be cut.
        const hung = fetch(
            `http://127.0.0.1:${capPort}/api/slow?ms=30000`,
        ).catch(() => null);
        await new Promise((r) => setTimeout(r, 750));

        const { code, ms } = termAndWait(CAP_CONTAINER);
        const out = logsOf(CAP_CONTAINER);
        expect(code, `the hardcap path exits 1:\n${out}`).toBe("1");
        expect(out).toContain("HARDCAP: drain exceeded grace, forcing stop");
        // NOT before the grace (something other than the cap released it) and
        // NOT near the request's own 30s (the cap never fired).
        expect(ms).toBeGreaterThanOrEqual(CAP_GRACE_MS - 250);
        expect(ms).toBeLessThan(CAP_GRACE_MS + 12_000);
        await hung;
    }, 60_000);

    // MUST BE LAST: it terminates the main container.
    it("in-flight: a request mid-handler when SIGTERM lands COMPLETES, then the process exits 0", async () => {
        const inFlight = fetch(`http://127.0.0.1:${port}/api/slow?ms=4000`);
        // Let the request reach the handler before the signal.
        await new Promise((r) => setTimeout(r, 750));

        const { code } = termAndWait(CONTAINER);
        // A dropped connection here is the user-visible failure the drain
        // exists to prevent.
        const res = await inFlight;
        expect(
            res.status,
            "the in-flight request was dropped by the drain",
        ).toBe(200);
        expect(await res.json()).toEqual({ ok: true, sleptMs: 4000 });

        const out = logsOf(CONTAINER);
        expect(code, `not the graceful exit-0 path:\n${out}`).toBe("0");
        expect(out.indexOf("SIGNAL:SIGTERM")).toBeGreaterThan(-1);
        expect(out.indexOf("DRAINED cleanly")).toBeGreaterThan(
            out.indexOf("SIGNAL:SIGTERM"),
        );
    }, 60_000);
});
