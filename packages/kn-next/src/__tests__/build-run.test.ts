/**
 * build.ts — the `build()` orchestrator. Drives the post-build steps with the
 * side-effecting seams mocked (loadConfig, uploadAssets, runQuiet, the bun-heal
 * helper, the single-exec compile):
 *  - default (vinext) build → the single-executable compile runs, the
 *    standalone-tree steps do not,
 *  - turbopack shape → the heal runs and the vinext compile does not; on Bun
 *    the standalone executable compile runs after the heal,
 *  - assets are always uploaded last.
 *
 * The per-file Bun bytecode pass that used to be asserted here is RETIRED
 * (ADR-0048 Amendment 3): bytecode exists only inside a WHOLE-BUNDLE
 * single-executable compile. `standalone-bun-bytecode` is gone and stays gone.
 * Since bytecode became mandatory for every runtime cell, the standalone
 * shape on Bun gets the whole-bundle compile too (`standalone-exec-build.ts`)
 * — these tests pin that it runs for turbopack × bun ONLY: never for
 * turbopack × node, never for vinext, and never as a per-file pass.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";
import type { StandaloneExecBuildOptions } from "../cli/standalone-exec-build";
import type { VinextBuildOptions } from "../cli/vinext-build";

// #965: installs process-global `mock.module` fakes of shared CLI modules that
// bun cannot unregister. MUST have the `bun test` process to itself — the
// suite of record (`scripts/bun-test.mjs`) gives it one; a hand-rolled batch
// gets a loud pointer there instead of phantom failures in a sibling.
requireIsolatedProcess("build-run.test.ts");

const runQuiet = (() => mock())();
mock.module("../cli/exec", () => ({ runQuiet, isEntrypoint: () => false }));

const loadConfig = (() => mock())();
mock.module("../cli/shared", () => ({ loadConfig }));

const uploadAssets = (() => mock(async () => {}))();
const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    // keep the REAL hasStorage/notice exports (ADR-0047) — stub only the seams
    ...__knextReal1,
    uploadAssets,
}));

const healBunExportTargets = (() =>
    mock(() => ({ copied: [], skipped: [] })))();
mock.module("../adapters/standalone-bun-exports", () => ({
    healBunExportTargets,
}));

// TYPED signature: an untyped `mock()` infers `calls` as `[]`, so reading
// `calls[n][0].arch` in `shipCompiles()` below is a TS2493 under the PACKAGE
// typecheck (`bun run --filter @getknext/core typecheck`). The root typecheck
// excludes `packages/`, so it never sees it.
const buildVinextExecutable = (() =>
    mock((_opts: VinextBuildOptions): string => "knext-exec-linux-x64"))();
const __knextRealVinext = { ...(await import("../cli/vinext-build")) };
mock.module("../cli/vinext-build", () => ({
    ...__knextRealVinext,
    buildVinextExecutable,
}));

// The post-compile smoke (#894) BOOTS the compiled binary, and these cases mock
// the compile — so without this the smoke would spawn a path that was never
// produced and fail every vinext case here. Its own coverage is
// `postcompile-smoke.test.ts` (behaviour) + `postcompile-smoke-wiring.test.ts`
// (that build() calls it, fail-closed).
const runPostCompileSmoke = (() =>
    mock(async () => ({
        appPort: 1,
        metricsPort: 2,
        healthStatus: 200,
        metricsStatus: 200,
        exitCode: 0,
        bootMs: 1,
        termMs: 1,
    })))();
const buildStandaloneExecutable = (() =>
    mock(
        (_opts: StandaloneExecBuildOptions): string =>
            "knext-standalone-exec-linux-x64",
    ))();
const __knextRealStandaloneExec = {
    ...(await import("../cli/standalone-exec-build")),
};
mock.module("../cli/standalone-exec-build", () => ({
    ...__knextRealStandaloneExec,
    buildStandaloneExecutable,
}));

const __knextRealSmoke = { ...(await import("../cli/postcompile-smoke")) };
mock.module("../cli/postcompile-smoke", () => ({
    ...__knextRealSmoke,
    runPostCompileSmoke,
}));

import { build } from "../cli/build";

let dir: string;
const savedCwd = process.cwd();

/**
 * `build: "turbopack"` is explicit here, and it is not incidental.
 *
 * The bun-exports heal walks a `.next/standalone` tree, so it only runs for an
 * artifact of that SHAPE. The default build is vinext, whose artifact is a nitro
 * output — meaning a config that omits `build` correctly skips the heal and
 * instead compiles the single executable.
 *
 * turbopack is a SELECTABLE builder again (#1167, ADR-0054) that emits the
 * `.next/standalone` shape, so these tests cover the standalone-build machinery
 * on the path a user reaches by choosing `build: "turbopack"`.
 */
const cfg = (over: Record<string, unknown> = {}) => ({
    name: "my-app",
    registry: "reg",
    build: "turbopack",
    storage: { provider: "gcs", bucket: "b" },
    ...over,
});

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-build-"));
    process.chdir(dir);
    jest.clearAllMocks();
    healBunExportTargets.mockReturnValue({ copied: [], skipped: [] });
    buildVinextExecutable.mockReturnValue("knext-exec-linux-x64");
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

/** A `.next/standalone` tree with the `server.js` the bun compile needs. */
function standaloneTree(): void {
    mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
    writeFileSync(join(dir, ".next", "standalone", "server.js"), "// server\n");
}

/** The compiles that target the SHIPPED arch, ignoring any host-arch smoke one. */
const shipCompiles = () =>
    buildVinextExecutable.mock.calls.filter((c) => c[0]?.arch === "linux-x64");

/**
 * The turbopack artifact CHECK (#1184) keys on the entry FILE
 * (`.next/standalone/server.js`), not on the directory existing — so a test
 * proving the check is satisfied must write the file, not just `mkdirSync`
 * the tree.
 */
const writeStandaloneServer = () => {
    mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
    writeFileSync(join(dir, ".next", "standalone", "server.js"), "");
};

describe("build()", () => {
    it("skips the heal and uploads assets when no standalone dir exists (turbopack)", async () => {
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });

        expect(healBunExportTargets).not.toHaveBeenCalled();
        expect(buildVinextExecutable).not.toHaveBeenCalled();
        expect(uploadAssets).toHaveBeenCalledTimes(1);
        // skipNextBuild → no `npm run build`.
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("runs the project build when not skipped", async () => {
        loadConfig.mockResolvedValue(cfg());
        // The artifact must exist so the #1184 fail-fast check (below) does
        // not trip — this test is about the project-build invocation, not
        // about that check.
        writeStandaloneServer();
        await build({});
        expect(runQuiet).toHaveBeenCalledWith(["npm", "run", "build"]);
    });

    it("runs the heal (not the vinext compile) when a standalone dir exists on the turbopack shape", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));
        standaloneTree();

        await build({ skipNextBuild: true });

        expect(healBunExportTargets).toHaveBeenCalledTimes(1);
        expect(buildVinextExecutable).not.toHaveBeenCalled();
        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });

    it("compiles the standalone bytecode executable for turbopack × bun, AFTER the heal", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));
        standaloneTree();

        await build({ skipNextBuild: true });

        expect(buildStandaloneExecutable).toHaveBeenCalledTimes(1);
        expect(buildStandaloneExecutable).toHaveBeenCalledWith(
            expect.objectContaining({ arch: "linux-x64" }),
        );
        // The heal adds files the compile must see, so it must come first.
        const healOrder = healBunExportTargets.mock.invocationCallOrder[0];
        const compileOrder =
            buildStandaloneExecutable.mock.invocationCallOrder[0];
        expect(compileOrder).toBeGreaterThan(healOrder);
    });

    it("never compiles the standalone executable for turbopack × node", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "node" }));
        standaloneTree();

        await build({ skipNextBuild: true });

        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("never compiles the standalone executable when runtime is unset (node is the default)", async () => {
        loadConfig.mockResolvedValue(cfg());
        standaloneTree();

        await build({ skipNextBuild: true });

        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("never compiles the standalone executable on the vinext build, even with runtime bun", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "bun", build: undefined }));
        standaloneTree();

        await build({ skipNextBuild: true });

        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
    });

    it("FAILS the build for turbopack × bun when there is no standalone tree to compile", async () => {
        // The bun image requires the executable; a build that skipped it would
        // fail at `docker build` (or ship a stale one), so the build fails here.
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));

        await expect(build({ skipNextBuild: true })).rejects.toThrow(
            /standalone/,
        );
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("compiles the single executable on the default (vinext) build", async () => {
        // The load-bearing case: `kn-next deploy` builds an image whose
        // Dockerfile COPYs `knext-exec-linux-x64` from the build context, so a
        // default `kn-next build` that does not produce it emits a build that
        // fails at docker-build time — or worse, dockerizes a stale binary.
        loadConfig.mockResolvedValue(cfg({ build: undefined }));

        await build({ skipNextBuild: true });

        // Exactly ONE ship compile. Not "one compile": since #894 a host whose
        // arch differs from the ship target gets a SECOND, host-arch compile so
        // the post-compile smoke has something it can actually execute, and a
        // bare call count would make this case pass or fail by which machine
        // ran it.
        expect(shipCompiles()).toHaveLength(1);
        expect(buildVinextExecutable).toHaveBeenCalledWith(
            expect.objectContaining({
                arch: "linux-x64",
                // build() already ran the app's own `vite build` (or the user
                // asked to reuse one) — compiling must not run vite twice.
                skipViteBuild: true,
            }),
        );
        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });

    it("fails fast with an actionable message when turbopack produces no .next/standalone (#1184)", async () => {
        // The project build itself is mocked (runQuiet), so this reproduces
        // the real #1184 shape: the app's OWN build script ran (e.g. still
        // `vite build`, unmodified from `kn-next create`) and exited 0, but
        // never emitted `.next/standalone` — this must be a HARD failure, not
        // a warning, and it must happen before assets are uploaded or an
        // image is built.
        loadConfig.mockResolvedValue(cfg());

        await expect(build({})).rejects.toThrow(
            /next-standalone|standalone\/server\.js|is not there/i,
        );

        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("proceeds past the missing-artifact check when turbopack's .next/standalone IS present", async () => {
        loadConfig.mockResolvedValue(cfg());
        writeStandaloneServer();

        await expect(build({})).resolves.toBeUndefined();

        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });

    it("does not fail fast on the default (vinext) build when its own artifact is missing", async () => {
        // vinext's artifact is `.output/server/index.mjs`, produced by
        // `buildVinextExecutable` — which is mocked out here, so the
        // artifact never actually lands on disk. #1184 scopes the hard
        // failure to the next-standalone shape only; vinext must be
        // completely unaffected and still resolve. A `package.json` is
        // needed here (unlike the turbopack cases above) because the
        // vinext path preflights it as an ESM app before this check runs.
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({ name: "my-app", type: "module" }),
        );
        loadConfig.mockResolvedValue(cfg({ build: undefined }));

        await expect(build({})).resolves.toBeUndefined();

        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });

    it("skips the standalone heal on the default (vinext) build, even with a standalone dir present", async () => {
        // The directory is created ON PURPOSE: the gate must key on the
        // artifact SHAPE, not on whether a stale standalone tree happens to be
        // lying around from an earlier build.
        loadConfig.mockResolvedValue(cfg({ runtime: "bun", build: undefined }));
        standaloneTree();

        await build({ skipNextBuild: true });

        expect(healBunExportTargets).not.toHaveBeenCalled();
        expect(shipCompiles()).toHaveLength(1);
        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });
});

/**
 * vinext × node (#1260). The node-preset nitro output runs uncompiled under
 * node; its bytecode caching is the V8 compile cache the IMAGE bakes. So the
 * build must NOT bun-compile it (there is nothing for bun to compile into a
 * node image), must refuse a bun-preset `.output` (it crashes under node), and
 * must leave the vinext-node image recipe in the build context.
 */
describe("build() — vinext × node", () => {
    const nodeCfg = () => cfg({ build: "vinext", runtime: "node" });

    function nitroOutput(preset: string): void {
        mkdirSync(join(dir, ".output", "server"), { recursive: true });
        writeFileSync(
            join(dir, ".output", "server", "index.mjs"),
            "// entry\n",
        );
        writeFileSync(
            join(dir, ".output", "nitro.json"),
            JSON.stringify({ preset, serverEntry: "server/index.mjs" }),
        );
    }

    it("compiles NOTHING with bun and boots no binary smoke — the image bakes the cache", async () => {
        loadConfig.mockResolvedValue(nodeCfg());
        nitroOutput("node-server");

        await build({ skipNextBuild: true });

        expect(buildVinextExecutable).not.toHaveBeenCalled();
        expect(buildStandaloneExecutable).not.toHaveBeenCalled();
        expect(runPostCompileSmoke).not.toHaveBeenCalled();
        expect(healBunExportTargets).not.toHaveBeenCalled();
        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });

    it("stages Dockerfile.vinext-node into the app when it is absent", async () => {
        loadConfig.mockResolvedValue(nodeCfg());
        nitroOutput("node-server");

        await build({ skipNextBuild: true });

        const staged = join(dir, "Dockerfile.vinext-node");
        expect(existsSync(staged)).toBe(true);
        const text = readFileSync(staged, "utf8");
        expect(text).toContain("NODE_COMPILE_CACHE");
        expect(text).not.toContain("{{");
        // Its own ignore file, which keeps `.output/server` in the context —
        // the app's .dockerignore excludes it, and the image COPYs it.
        const ignore = readFileSync(`${staged}.dockerignore`, "utf8");
        expect(ignore.split("\n")).not.toContain(".output");
        expect(ignore.split("\n")).toContain("node_modules");
    });

    it("never clobbers an existing Dockerfile.vinext-node — it may carry the user's edits", async () => {
        loadConfig.mockResolvedValue(nodeCfg());
        nitroOutput("node-server");
        writeFileSync(join(dir, "Dockerfile.vinext-node"), "# mine\n");

        await build({ skipNextBuild: true });

        expect(readFileSync(join(dir, "Dockerfile.vinext-node"), "utf8")).toBe(
            "# mine\n",
        );
    });

    it("REFUSES a bun-preset .output — it would crash under node — before any upload", async () => {
        // The realistic shape: an app scaffolded before #1260 whose
        // vite.config.ts hardcodes `preset: 'bun'`, switched to runtime: node.
        loadConfig.mockResolvedValue(nodeCfg());
        nitroOutput("bun");

        let message = "";
        try {
            await build({ skipNextBuild: true });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toMatch(/node-server[\s\S]*bun|bun[\s\S]*node-server/);
        // Actionable in place, not only a docs pointer: the three edits an
        // older app needs — the entry file, the vite preset, the srvx dep.
        expect(message).toContain("copy knext-node-entry.mjs");
        expect(message).toContain("preset: 'node'");
        expect(message).toContain("declare `srvx`");
        expect(uploadAssets).not.toHaveBeenCalled();
        expect(buildVinextExecutable).not.toHaveBeenCalled();
    });

    it("REFUSES when there is no .output at all — nothing for the image to ship", async () => {
        loadConfig.mockResolvedValue(nodeCfg());

        await expect(build({ skipNextBuild: true })).rejects.toThrow(
            /nitro\.json/,
        );
        expect(uploadAssets).not.toHaveBeenCalled();
    });
});
