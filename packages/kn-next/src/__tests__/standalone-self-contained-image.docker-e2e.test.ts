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

// Round 3 (R2-B1/B2): the drain legs must tell a clean drain apart from the
// hardcap backstop. Both exit 0, so the exit code alone cannot. The containers
// run with a grace window far longer than the bound the test allows, so a
// shutdown that only ends because the hardcap fired takes ~120 s and fails the
// bound (and `docker wait`'s own timeout) instead of passing.
const SHUTDOWN_GRACE_MS = 120_000;
/** A clean drain must finish this soon after SIGTERM. */
const DRAIN_BOUND_MS = 15_000;
/** How long the fixture's after() callback keeps working after the response. */
const AFTER_MS = 2_000;
/** How long the in-flight request's handler sleeps before responding. */
const REQUEST_MS = 4_000;
/** How long after starting the request the container is sent SIGTERM. */
const PRE_TERM_MS = 1_000;
/**
 * Round 4 (R3-B2): the fastest a CLEAN drain can possibly exit after SIGTERM.
 * The response lands REQUEST_MS - PRE_TERM_MS (~3 s) after the signal, and the
 * after() callback then keeps working for AFTER_MS more, so a process that
 * really waited for it cannot exit sooner than their sum. 500 ms of slack
 * absorbs clock and scheduling jitter (the request reaches the handler AFTER
 * the fetch starts, which only makes the real exit later, never earlier).
 * A fixture whose after() stopped waiting exits ~REQUEST_MS - PRE_TERM_MS
 * after the signal, which is below this bound by AFTER_MS - 500 (>= 500 ms,
 * because `standalone-drain-image-ci.test.ts` pins AFTER_MS >= 1000); the
 * hardcap exits at SHUTDOWN_GRACE_MS, far above DRAIN_BOUND_MS. Neither passes.
 */
const MIN_CLEAN_DRAIN_MS = REQUEST_MS - PRE_TERM_MS + AFTER_MS - 500;
/**
 * Every container whose clean drain assertCleanDrain fully proved. The
 * top-level afterAll below requires BOTH drain legs here, so a leg that is
 * disabled, filtered out, or returns before draining fails the file instead of
 * silently dropping out of it (round 4, R3-B1).
 */
const drainLegsCompleted: string[] = [];
/** Logged by the supervisor only when the hardcap fires. */
const HARDCAP_LOG = "shutdown hardcap reached";

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

/**
 * Put a slow request in flight, SIGTERM the container, and require a CLEAN
 * drain: the in-flight response completes, the after() callback finishes its
 * ~2 s of post-response async work (both markers logged), the container exits
 * 0 within DRAIN_BOUND_MS of the signal (far under SHUTDOWN_GRACE_MS, so the
 * hardcap cannot be what ended it), and the hardcap warning never appears.
 */
async function assertCleanDrain(container: string, port: number) {
    const reqId = randomBytes(3).toString("hex");
    const inFlight = fetch(
        `http://127.0.0.1:${port}/api/slow?ms=${REQUEST_MS}&afterMs=${AFTER_MS}&id=${reqId}`,
    );
    await new Promise((r) => setTimeout(r, PRE_TERM_MS));

    const termAt = Date.now();
    const killed = run("docker", ["kill", "--signal=TERM", container], {
        timeout: 60_000,
    });
    expect(killed.status, `docker kill failed:\n${killed.stderr}`).toBe(0);

    const res = await inFlight;
    expect(res.status, "the in-flight request was dropped by the drain").toBe(
        200,
    );
    expect(await res.json()).toEqual({
        ok: true,
        sleptMs: REQUEST_MS,
        id: reqId,
    });

    // Well under SHUTDOWN_GRACE_MS: a hardcap exit times this out (non-zero).
    const waited = run("docker", ["wait", container], {
        timeout: DRAIN_BOUND_MS * 2,
    });
    const elapsedMs = Date.now() - termAt;
    const logs = run("docker", ["logs", container], { timeout: 60_000 });
    const out = `${logs.stdout}\n${logs.stderr}`;
    expect(
        waited.status,
        `docker wait did not return within ${DRAIN_BOUND_MS * 2} ms of SIGTERM (a hardcap exit takes ${SHUTDOWN_GRACE_MS} ms):\n${waited.stderr}\n${out}`,
    ).toBe(0);
    expect(
        waited.stdout.trim(),
        `the container did not exit 0 on SIGTERM:\n${out}`,
    ).toBe("0");
    expect(
        elapsedMs,
        `exit took ${elapsedMs} ms after SIGTERM; a clean drain finishes well inside ${DRAIN_BOUND_MS} ms`,
    ).toBeLessThan(DRAIN_BOUND_MS);
    // The after() work (AFTER_MS after a response that lands ~3 s after TERM)
    // has to have held the process up; an exit that skipped it would be faster.
    // See MIN_CLEAN_DRAIN_MS for why this bound, not AFTER_MS alone (round 4).
    expect(
        elapsedMs,
        `exit took only ${elapsedMs} ms after SIGTERM; waiting for the after() work takes at least ${MIN_CLEAN_DRAIN_MS} ms:\n${out}`,
    ).toBeGreaterThanOrEqual(MIN_CLEAN_DRAIN_MS);

    const start = out.indexOf(`AFTER_SENTINEL_START:${reqId}`);
    const done = out.indexOf(`AFTER_SENTINEL_RAN:${reqId}`);
    expect(
        start,
        `the after() callback never started:\n${out}`,
    ).toBeGreaterThan(-1);
    expect(
        done,
        `the after() callback started but its post-response work never finished before exit:\n${out}`,
    ).toBeGreaterThan(start);
    expect(
        out,
        "the hardcap fired: the drain did not finish on its own",
    ).not.toContain(HARDCAP_LOG);
    drainLegsCompleted.push(container);
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
            "--env",
            `SHUTDOWN_GRACE_MS=${SHUTDOWN_GRACE_MS}`,
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

// Round 4 (R3-B1): both drain legs must have run to the end. `bun test` exits
// 0 when a leg is marked todo, skipped, or conditioned off, so without this a
// disabled leg reads as a pass. (The CI step also runs this file with
// `--no-skip`, and the fast lane scans it for skip-shaped constructs.)
afterAll(() => {
    expect(
        [...drainLegsCompleted].sort(),
        "a SIGTERM drain leg did not run to completion (disabled, filtered, or returned early)",
    ).toEqual([CONTAINER, `${CONTAINER}-operator-cmd`].sort());
});

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

    it("only public/, .next/static, the executable, and the B2 operator-compat server.js shim are on disk", () => {
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
            [".next", "knext-standalone-exec", "public", "server.js"].sort(),
        );
    });
});

// B2 (N2 round-2, #1457): the operator hardcodes
// `Command: ["bun", "run", "server.js"]` for build != vinext && runtime ==
// bun, which does not yet know this shape — proving the DEFAULT ENTRYPOINT
// boots is not enough; this exercises the ACTUAL command an operator-rendered
// pod runs today (mirrors the disk-mode sibling's
// `ci.yml`'s "with the operator bun run server.js command" job).
describe("the image boots under the operator's exact forced command (B2, #1457 round-2)", () => {
    const OPERATOR_CONTAINER = `${CONTAINER}-operator-cmd`;
    let operatorPort = 0;

    afterAll(() => {
        run("docker", ["rm", "--force", OPERATOR_CONTAINER], {
            timeout: 60_000,
        });
    });

    it("serves /api/health when started with `bun run server.js` (nextapp_controller.go's forced Command)", async () => {
        [operatorPort] = await freePorts(1);
        const started = run(
            "docker",
            [
                "run",
                "--detach",
                "--name",
                OPERATOR_CONTAINER,
                "--label",
                LABEL,
                "--label",
                EPOCH_LABEL,
                "--platform",
                PLATFORM,
                "--publish",
                `${operatorPort}:3000`,
                "--env",
                `SHUTDOWN_GRACE_MS=${SHUTDOWN_GRACE_MS}`,
                IMAGE,
                "bun",
                "run",
                "server.js",
            ],
            { timeout: 120_000 },
        );
        expect(
            started.status,
            `docker run (operator command) failed:\n${started.stdout}\n${started.stderr}`,
        ).toBe(0);
        await waitForHealth(OPERATOR_CONTAINER, operatorPort);
        const res = await fetch(`http://127.0.0.1:${operatorPort}/api/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            status: "ok",
            target: "standalone",
        });
    }, 150_000);

    // Round 3 (R2-B2): under this command PID 1 is the `/app/server.js` shim,
    // which must relay SIGTERM to the compiled executable that owns the
    // drain. This is the path `knext deploy` runs today, so it gets the same
    // clean-drain proof as the default ENTRYPOINT below.
    // drain-leg: operator command (`bun run server.js`, PID 1 = the shim)
    it("under `bun run server.js`: SIGTERM drains the in-flight request, finishes after(), and exits 0 well before the hardcap", async () => {
        expect(operatorPort, "the boot leg above did not run").toBeGreaterThan(
            0,
        );
        await assertCleanDrain(OPERATOR_CONTAINER, operatorPort);
    }, 120_000);
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
//
// B1 (#1519): round 1 set `NEXT_MANUAL_SIG_HANDLE=1`, so this preload's own
// close+exit path was the only SIGTERM owner and it raced away Next's own
// `after()` drain. Round 2 lets Next's handler run (it awaits
// `nextServer.close()`, which drains `after()` work) and normalises its exit
// code instead.
//
// Round 3: round 2's version of this test could not tell that fix from the
// defect. Its after() callback was synchronous (the marker printed the moment
// the response finished) and the container ran with the default 25 s hardcap,
// which also exits 0 inside `docker wait`'s window. `assertCleanDrain` now
// uses an after() that keeps working ~2 s past the response, a 120 s grace
// window, and a 15 s bound, so only a clean drain passes.
describe("SIGTERM drains in-flight work, runs after(), and exits 0, folded into the ONE process", () => {
    // drain-leg: default ENTRYPOINT (the compiled executable is PID 1)
    it("default ENTRYPOINT: completes an in-flight request, finishes after(), and exits 0 well before the hardcap", async () => {
        await assertCleanDrain(CONTAINER, appPort);
    }, 120_000);
});
