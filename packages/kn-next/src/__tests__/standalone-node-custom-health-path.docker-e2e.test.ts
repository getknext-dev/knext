// @vitest-environment node
//
// standalone-node-custom-health-path.docker-e2e — the standalone-node
// compile-cache bake (#1264) warmed a HARDCODED `/api/health`, ignoring the
// app's configured `healthCheckPath` (`kn-next.config.ts` /
// `config.healthCheckPath`, #326 in config.ts). An app with a custom health
// route and NO `/api/health` route failed the docker BUILD itself — not just
// its Knative probe — with no override available.
//
// This suite proves BOTH directions against a REAL docker build of a fixture
// that has ONLY `/healthz`, never `/api/health`:
//
//   1. `--build-arg KNEXT_HEALTH_CHECK_PATH=/healthz` (what `dockerBuildxArgs`
//      now emits when `config.healthCheckPath` is set — see
//      runtime-image-selection.test.ts for that argv-construction half) makes
//      the build SUCCEED — the bake warms the right path.
//   2. Omitting that build-arg — the Dockerfile's own `ARG
//      KNEXT_HEALTH_CHECK_PATH=/api/health` default applies — makes the SAME
//      fixture's build FAIL, because the bake warms a route that does not
//      exist. This is the regression this suite pins: it is the mutation
//      proof, committed, not just run by hand once.
//
// ── Discipline mirrored from standalone-drain.docker-e2e (#1156) ───────────
//
//   - NO SKIP PATH. Missing docker or bun is a FAILURE, never a skip.
//   - UNIQUE per-run image names (epoch label) + afterAll cleanup.
//   - Its OWN throwaway copy of the standalone-drain-app fixture, with
//     `app/api/health` renamed to `app/api/healthz` — the fixture is never
//     mutated in place.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageStandaloneBuildContext } from "../cli/runtime-image";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "standalone-drain-app");
const TEMPLATE_DIR = join(PKG_ROOT, "templates", "runtime-standalone");

const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const IMAGE_WITH_ARG = `knext-custom-health-e2e-with-arg:${RUN_ID}`;
const IMAGE_WITHOUT_ARG = `knext-custom-health-e2e-without-arg:${RUN_ID}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=custom-health-path-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;
// No LEAK_AGE_MS / container-age sweep here: this suite never `docker run`s —
// only `docker build`s two throwaway images — so the only leak surface is
// images, already covered by the `until=2h` filter below.

/** A throwaway build dir; removed in afterAll (D9 temp-dir pairing). */
let workDir = "";
let ctx = "";
let dockerfilePath = "";
/** The successful build's own log (asserts the bake reported its size). */
let withArgBuildLog = "";
/** The failing build's own log (asserts it failed on the WARM step, not something else). */
let withoutArgBuildLog = "";
let withArgStatus = -1;
let withoutArgStatus = -1;

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

function sweepLeakedArtifacts() {
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

beforeAll(() => {
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
    if (!existsSync(join(PKG_ROOT, "dist", "adapters", "node-server.js"))) {
        throw new Error(
            `${join(PKG_ROOT, "dist", "adapters", "node-server.js")} missing — build ` +
                "@getknext/core before this suite: `bun run --filter @getknext/core build`.",
        );
    }

    sweepLeakedArtifacts();

    // 2. Throwaway fixture copy with app/api/health RENAMED to app/api/healthz
    //    — the app now has ONLY a custom health route, never /api/health.
    workDir = mkdtempSync(join(tmpdir(), "knext-custom-health-"));
    const appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });
    renameSync(
        join(appDir, "app", "api", "health"),
        join(appDir, "app", "api", "healthz"),
    );
    if (existsSync(join(appDir, "app", "api", "health"))) {
        throw new Error(
            "app/api/health still exists after rename — this suite's premise " +
                "(no /api/health route) does not hold",
        );
    }

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

    // 3. Assemble the docker build context + stage the shipped Dockerfile/entry/bake.
    ctx = join(workDir, "ctx");
    mkdirSync(ctx, { recursive: true });
    cpSync(
        join(appDir, ".next", "standalone"),
        join(ctx, ".next", "standalone"),
        {
            recursive: true,
        },
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
    dockerfilePath = staged.dockerfile;

    // 4. Build WITH the build-arg — must SUCCEED.
    const withArg = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--target",
            "standalone-node",
            "--file",
            dockerfilePath,
            "--build-arg",
            "KNEXT_HEALTH_CHECK_PATH=/api/healthz",
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            IMAGE_WITH_ARG,
            ctx,
        ],
        { timeout: 600_000 },
    );
    withArgStatus = withArg.status ?? -1;
    withArgBuildLog = `${withArg.stdout}\n${withArg.stderr}`;

    // 5. Build WITHOUT the build-arg (the Dockerfile's own /api/health default
    //    applies) — must FAIL, against the SAME fixture/context. This is the
    //    committed mutation proof for the #1264 follow-up regression.
    const withoutArg = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--target",
            "standalone-node",
            "--file",
            dockerfilePath,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            IMAGE_WITHOUT_ARG,
            ctx,
        ],
        { timeout: 600_000 },
    );
    withoutArgStatus = withoutArg.status ?? -1;
    withoutArgBuildLog = `${withoutArg.stdout}\n${withoutArg.stderr}`;
}, 1_200_000);

afterAll(() => {
    run("docker", ["rmi", "--force", IMAGE_WITH_ARG], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE_WITHOUT_ARG], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 90_000);

describe("the standalone-node bake warms config.healthCheckPath, not a hardcoded /api/health (#1264 follow-up)", () => {
    it("passing --build-arg KNEXT_HEALTH_CHECK_PATH=/api/healthz builds successfully against a fixture with NO /api/health route", () => {
        expect(
            withArgStatus,
            `expected the build to succeed once the custom health path was threaded through as a build-arg:\n${withArgBuildLog.slice(-4000)}`,
        ).toBe(0);
        expect(withArgBuildLog).toMatch(/compile cache baked: \d+ bytes/);
    });

    it("MUTATION PROOF: omitting the build-arg fails the SAME fixture's build — the Dockerfile's own /api/health default cannot serve a fixture with only /api/healthz", () => {
        expect(
            withoutArgStatus,
            "expected the build WITHOUT the health-path build-arg to FAIL against " +
                "a fixture with no /api/health route — if it succeeded, the bake is " +
                "not actually warming the configured path (the #1264 follow-up regression)",
        ).not.toBe(0);
        expect(withoutArgBuildLog).toMatch(
            /compile-cache bake FAILED: a warm path did not answer 2xx/,
        );
    });
});
