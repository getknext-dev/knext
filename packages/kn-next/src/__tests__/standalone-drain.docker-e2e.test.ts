// @vitest-environment node
//
// standalone-drain.docker-e2e — SIGTERM drain under the SHIPPED standalone-on-bun
// image, driven by the OPERATOR'S OWN command (#1156).
//
// ── What this proves, and why nothing else did ──────────────────────────────
//
// The operator forces the container command `["bun","run","server.js"]` for a
// non-vinext build on the bun runtime (`nextapp_controller.go`). Before the
// ADR-0055 R3 shim, that command booted the RAW Next standalone `server.js`,
// bypassing knext's supervisor (`node-server.ts`) entirely — no metrics
// sidecar, no exit-0 drain coordination, none of the compile-cache diagnostics.
// The shipped image (`templates/runtime-standalone/Dockerfile.standalone.hbs`)
// now copies the supervisor entry to BOTH `/app/knext-entry.mjs` (the
// ENTRYPOINT) AND `/app/server.js` (the R3 shim), so `bun run server.js` REACHES
// the supervisor. This suite sends a real SIGTERM to the real container started
// with that exact operator command and asserts the drain contract holds.
//
// The repo's other SIGTERM gates each miss this: `sigterm-drain-shipped` boots
// node-server directly (not via `bun run server.js`, not in the shipped image),
// and `bun-exec-alpine-image` exercises the vinext single-executable, a
// different runtime shape. This is the first gate that drives the operator
// command against the standalone-on-bun IMAGE.
//
// ── A DISCOVERED FACT that refines #1156's premise (workflow.md trigger) ─────
//
// #1156 assumed bypassing the supervisor DROPS the in-flight request. Measured
// under Bun 1.4.x against a real next@16.3.3 standalone build, that is FALSE for
// this shape: Next's own `start-server` cleanup drains in-flight requests and
// runs `after()` on SIGTERM by default (`server.close()` finishes pending
// requests; `closeAllConnections()` fires only in dev), then exits 143. So the
// in-flight-completion + after() assertions PROVE the shim does not BREAK Next's
// drain, but on their own they do NOT distinguish the shim from raw Next. What
// the supervisor uniquely owns — and what a bypass regresses — is the exit-0
// graceful contract, the eager :9464 metrics sidecar, and the drain log markers.
// The mutation proof below reds on exactly those (see MUTATION-PROOF).
//
// ── Discipline mirrored from examples/bun-exec/test/alpine-image.docker-e2e ──
//
//   - NO SKIP PATH. Missing docker or bun is a FAILURE, never a skip. A suite
//     that silently passes when its runtime is absent is the anti-pattern the
//     drain guarantee cannot afford. It is excluded from the fast lane by the
//     `.docker-e2e.test.ts` suffix (scripts/bun-test.mjs / vitest.config.ts) and
//     run by the dedicated `standalone-drain-bun-image` CI job — whose existence
//     is guarded by tests/standalone-drain-image-ci.test.ts.
//   - UNIQUE per-run image/container names (epoch label) + afterAll cleanup, so
//     concurrent worktrees never reap each other's artifacts.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "standalone-drain-app");
const TEMPLATE_DIR = join(PKG_ROOT, "templates", "runtime-standalone");

// Always build + run for linux/amd64: the pinned bases and the operator's real
// target are amd64, and CI runs on amd64. On an arm64 host Docker Desktop
// emulates — slower, but the artifact under test stays the shipped one.
const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const CONTAINER = `knext-standalone-drain-e2e-${RUN_ID}`;
const IMAGE = `knext-standalone-drain-e2e:${RUN_ID}`;

// Labels make ABORTED runs' leftovers findable + reapable (a hard Ctrl-C skips
// afterAll). Same scheme as the bun-exec sibling.
const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=standalone-drain-e2e`;
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

/**
 * Reserve N free TCP ports, holding every socket in LISTEN until all N numbers
 * are known — so the OS cannot hand the same port to two `--publish` flags (the
 * collision class the sibling documents at #683/#686).
 */
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

let appPort = 0;
let metricsPort = 0;

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

    // 2. @getknext/core must be BUILT — the image COPYs its whole dist/ closure as
    //    the supervisor. CI builds it before this job (see the CI guard test); a
    //    local run needs `bun run --filter @getknext/core build` first.
    if (!existsSync(join(PKG_ROOT, "dist", "adapters", "node-server.js"))) {
        throw new Error(
            `${join(PKG_ROOT, "dist", "adapters", "node-server.js")} missing — build ` +
                "@getknext/core before this suite (CI builds it in the " +
                "standalone-drain-bun-image job; locally: `bun run --filter @getknext/core build`).",
        );
    }

    sweepLeakedArtifacts();

    // 3. The build context — assembled UNCONDITIONALLY every run, into a throwaway
    //    dir, so a green run can never validate a stale artifact.
    workDir = mkdtempSync(join(tmpdir(), "knext-standalone-drain-"));
    const appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });

    // 3a. Install the fixture's own deps + build .next/standalone.
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

    // 3b. Assemble the Docker build CONTEXT exactly as the Dockerfile's COPY lines
    //     name it (mirrors cli/runtime-image.ts stageStandaloneBuildContext).
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
    // public/ is optional in a fixture; the Dockerfile COPYs it, so guarantee it exists.
    mkdirSync(join(ctx, "public"), { recursive: true });
    if (existsSync(join(appDir, "public"))) {
        cpSync(join(appDir, "public"), join(ctx, "public"), {
            recursive: true,
        });
    }
    // The BUILT @getknext/core, dereferenced into a real directory (the workspace
    // symlink points outside the context, which `docker build` COPY cannot follow).
    const coreDst = join(ctx, "node_modules", "@getknext", "core");
    mkdirSync(coreDst, { recursive: true });
    cpSync(join(PKG_ROOT, "package.json"), join(coreDst, "package.json"));
    cpSync(join(PKG_ROOT, "dist"), join(coreDst, "dist"), { recursive: true });
    cpSync(TEMPLATE_DIR, join(coreDst, "templates", "runtime-standalone"), {
        recursive: true,
    });
    // The supervisor shim + Dockerfile, staged verbatim from the template.
    cpSync(
        join(TEMPLATE_DIR, "knext-standalone-entry.mjs.hbs"),
        join(ctx, "knext-standalone-entry.mjs"),
    );
    cpSync(
        join(TEMPLATE_DIR, "Dockerfile.standalone.hbs"),
        join(ctx, "Dockerfile.standalone"),
    );

    // 4. Build the shipped image, --target standalone-bun (the operator's bun runtime).
    const image = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--target",
            "standalone-bun",
            "--file",
            join(ctx, "Dockerfile.standalone"),
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
            `docker build failed:\n${image.stdout}\n${image.stderr}`,
        );
    }

    // 5. Run it with the OPERATOR'S command: `bun run server.js`. ENTRYPOINT is
    //    overridden to `bun` and args are `run server.js`, reproducing exactly what
    //    the operator forces — so `/app/server.js` (the R3 shim) boots the supervisor.
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
            "--entrypoint",
            "bun",
            "--publish",
            `${appPort}:3000`,
            "--publish",
            `${metricsPort}:9464`,
            IMAGE,
            "run",
            "server.js",
        ],
        { timeout: 120_000 },
    );
    if (started.status !== 0) {
        throw new Error(
            `docker run failed:\n${started.stdout}\n${started.stderr}`,
        );
    }

    // 6. Wait for the app to serve. A died container never listens, so surface its
    //    logs + exit code rather than waiting out the deadline.
    const deadline = Date.now() + 120_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${appPort}/api/health`);
            if (res.ok) break;
        } catch {
            // not listening yet
        }
        const running = run(
            "docker",
            ["inspect", CONTAINER, "--format", "{{.State.Running}}"],
            { timeout: 60_000 },
        );
        const died = running.status === 0 && running.stdout.trim() === "false";
        if (died || Date.now() > deadline) {
            const logs = run("docker", ["logs", CONTAINER], {
                timeout: 60_000,
            });
            const code = run(
                "docker",
                ["inspect", CONTAINER, "--format", "{{.State.ExitCode}}"],
                { timeout: 60_000 },
            );
            throw new Error(
                `the container never served /api/health (${died ? "it exited" : "timed out"}).\n` +
                    `exit code: ${code.stdout.trim()}\nlogs:\n${logs.stdout}\n${logs.stderr}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}, 1_200_000);

afterAll(() => {
    run("docker", ["rm", "--force", CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("the shipped standalone-on-bun image boots the supervisor via `bun run server.js`", () => {
    it("serves the app AND the supervisor-only :9464 metrics sidecar (proves the shim reached node-server, not raw Next)", async () => {
        const health = await fetch(`http://127.0.0.1:${appPort}/api/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({
            status: "ok",
            target: "standalone",
        });

        // Raw Next serves ONLY :3000. A live :9464 with Prometheus text is proof the
        // supervisor (node-server.ts) is the PID-1 process — the R3 shim worked.
        const metrics = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
        expect(
            metrics.status,
            "the :9464 metrics sidecar is not served — the shim did not reach the supervisor",
        ).toBe(200);
        expect(await metrics.text()).toMatch(/^# HELP /m);
    });
});

// ── SIGTERM drain — MUST BE LAST: it terminates the container ────────────────
describe("SIGTERM under the operator command drains in-flight work, runs after(), and exits 0 (#1156)", () => {
    it("completes an in-flight request across the TERM, runs its after() callback, and the container exits 0", async () => {
        const reqId = randomBytes(3).toString("hex");
        // 1. Put a request genuinely in flight (4s server sleep leaves ample room
        //    for signal delivery + drain inside the 25s SHUTDOWN_GRACE_MS cap).
        const inFlight = fetch(
            `http://127.0.0.1:${appPort}/api/slow?ms=4000&id=${reqId}`,
        );
        await new Promise((r) => setTimeout(r, 1000));

        // 2. Deliver SIGTERM exactly as Knative/Kubernetes does — to PID 1 (the supervisor).
        const killed = run("docker", ["kill", "--signal=TERM", CONTAINER], {
            timeout: 60_000,
        });
        expect(killed.status, `docker kill failed:\n${killed.stderr}`).toBe(0);

        // 3. The in-flight request must COMPLETE — a dropped/reset connection here is
        //    the exact user-visible failure the drain exists to prevent.
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

        // 4. The container must exit ON ITS OWN with code 0 — the supervisor's
        //    graceful path (shutdown.ts finish(0)). Raw Next would exit 143; a
        //    still-running container is a drain that never concluded.
        const waited = run("docker", ["wait", CONTAINER], { timeout: 40_000 });
        expect(waited.status, `docker wait failed:\n${waited.stderr}`).toBe(0);
        expect(
            waited.stdout.trim(),
            "the supervisor did not take the graceful exit-0 path on SIGTERM",
        ).toBe("0");

        // 5. The drain markers must be present, in order: the supervisor logged the
        //    signal, the after() callback (run by Next during graceful close) fired
        //    for THIS request, and the child exited under the supervisor's watch.
        const logs = run("docker", ["logs", CONTAINER], { timeout: 60_000 });
        const out = `${logs.stdout}\n${logs.stderr}`;
        expect(out, "the supervisor never logged the SIGTERM").toContain(
            "Shutting down gracefully",
        );
        expect(
            out,
            "the after() callback did not run during the drain",
        ).toContain(`AFTER_SENTINEL_RAN:${reqId}`);
        expect(out, "the supervisor never observed the child exit").toContain(
            "Next.js standalone server exited",
        );
        expect(out.indexOf("Shutting down gracefully")).toBeLessThan(
            out.indexOf("Next.js standalone server exited"),
        );
    }, 90_000);
});
