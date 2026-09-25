// @vitest-environment node
//
// vinext-node-custom-health-path.docker-e2e — the vinext-node compile-cache
// bake (#1260) warmed a HARDCODED `/api/health`, ignoring the app's
// configured `healthCheckPath` (`kn-next.config.ts` / `config.healthCheckPath`,
// #326 in config.ts) — the same regression class #1264 fixed for the
// standalone-node image (`standalone-node-custom-health-path.docker-e2e.test.ts`),
// left open here in that PR and filed as #1273.
//
// This suite proves BOTH directions against a REAL docker build of a fixture
// that has ONLY `/healthz`, never `/api/health`:
//
//   1. `--build-arg KNEXT_HEALTH_CHECK_PATH=/healthz` (what `dockerBuildxArgs`
//      now emits when `config.healthCheckPath` is set and the selection's
//      `bakesCompileCache` is true — see runtime-image-selection.test.ts for
//      that argv-construction half) makes the build SUCCEED — the bake warms
//      the right path.
//   2. Omitting that build-arg — the Dockerfile's own `ARG
//      KNEXT_HEALTH_CHECK_PATH=/api/health` default applies — makes the SAME
//      fixture's build FAIL, because the bake warms a route that does not
//      exist. This is the regression this suite pins: it is the mutation
//      proof, committed, not just run by hand once.
//
// ── Discipline mirrored from standalone-node-custom-health-path.docker-e2e ─
//
//   - NO SKIP PATH. Missing docker or bun, or an unbuilt @getknext/core, is a
//     FAILURE, never a skip.
//   - UNIQUE per-run image names (epoch label) + afterAll cleanup.
//   - Its OWN throwaway copy of the vinext-node-app fixture, with
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
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
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
const IMAGE_WITH_ARG = `knext-vinext-node-custom-health-with-arg:${RUN_ID}`;
const IMAGE_WITHOUT_ARG = `knext-vinext-node-custom-health-without-arg:${RUN_ID}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=vinext-node-custom-health-path-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;
// No container-age sweep here: this suite never `docker run`s — only
// `docker build`s two throwaway images — so the only leak surface is images,
// already covered by the `until=2h` filter below.

/** The templates the node cell ships, rendered exactly as `knext create` would. */
const RENDERED_TEMPLATES = [
    "vite.config.ts",
    "knext-node-entry.mjs",
    "knext-bun-entry.mjs",
    "runtime-contract.mjs",
    ".dockerignore",
] as const;

/**
 * Packages the node server entry imports that the fixture does NOT declare
 * itself: taken from the rendered template package.json (see 2b).
 */
const ENTRY_RUNTIME_DEPS = ["srvx"] as const;

/** A throwaway build dir; removed in afterAll (D9 temp-dir pairing). */
let workDir = "";
let appDir = "";
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

    // 2. Throwaway fixture copy with app/api/health RENAMED to app/api/healthz
    //    — the app now has ONLY a custom health route, never /api/health.
    workDir = mkdtempSync(join(tmpdir(), "knext-vinext-node-custom-health-"));
    appDir = join(workDir, "app");
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

    // #1342/ADR-0058: `knext create`'s DEFAULT builder no longer renders
    // these vinext-shaped files — request `--builder vinext` explicitly,
    // matching what this suite actually exercises (the vinext × node runtime
    // image with a custom health path).
    const rendered = renderScaffold({
        name: "vinext-node-custom-health-fixture",
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
    const staged = stageVinextNodeDockerfile({ cwd: appDir });
    if (!staged.staged) {
        throw new Error(
            "stageVinextNodeDockerfile wrote nothing into a fresh app",
        );
    }

    const templatePkg = JSON.parse(rendered.get("package.json") ?? "{}") as {
        dependencies?: Record<string, string>;
    };
    const fixturePkgPath = join(appDir, "package.json");
    const fixturePkg = JSON.parse(readFileSync(fixturePkgPath, "utf8")) as {
        dependencies: Record<string, string>;
    };
    for (const name of ENTRY_RUNTIME_DEPS) {
        const version = templatePkg.dependencies?.[name];
        if (version !== undefined) fixturePkg.dependencies[name] = version;
    }
    writeFileSync(fixturePkgPath, `${JSON.stringify(fixturePkg, null, 2)}\n`);

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

    const build = run("bun", ["run", "build"], {
        cwd: appDir,
        timeout: 600_000,
    });
    if (build.status !== 0) {
        throw new Error(
            `fixture "vite build" failed:\n${build.stdout}\n${build.stderr}`,
        );
    }
    // The shipped gate `knext build` runs; throws on a bun-preset output.
    assertNodePresetOutput(appDir);

    // 3. Build WITH the build-arg — must SUCCEED.
    const withArg = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--file",
            staged.dockerfile,
            "--build-arg",
            "KNEXT_HEALTH_CHECK_PATH=/api/healthz",
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            IMAGE_WITH_ARG,
            appDir,
        ],
        { timeout: 600_000 },
    );
    withArgStatus = withArg.status ?? -1;
    withArgBuildLog = `${withArg.stdout}\n${withArg.stderr}`;

    // 4. Build WITHOUT the build-arg (the Dockerfile's own /api/health default
    //    applies) — must FAIL, against the SAME fixture/context. This is the
    //    committed mutation proof for the #1273 regression.
    const withoutArg = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--file",
            staged.dockerfile,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            IMAGE_WITHOUT_ARG,
            appDir,
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
    // Two images take longer to remove than bun's 5s hook default on a
    // loaded host — same discipline as the sibling standalone-node suite.
}, 90_000);

describe("the vinext-node bake warms config.healthCheckPath, not a hardcoded /api/health (#1273)", () => {
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
                "not actually warming the configured path (the #1273 regression)",
        ).not.toBe(0);
        expect(withoutArgBuildLog).toMatch(
            /compile-cache bake FAILED: a warm path did not answer 2xx/,
        );
    });
});
