/**
 * build.ts — the `build()` orchestrator. Drives the post-build steps with the
 * side-effecting seams mocked (loadConfig, uploadAssets, runQuiet, the bun-heal
 * helper, the single-exec compile):
 *  - default (vinext) build → the single-executable compile runs, the
 *    standalone-tree steps do not,
 *  - turbopack shape → the heal runs, the compile does not,
 *  - assets are always uploaded last.
 *
 * The per-file Bun bytecode pass that used to be asserted here is RETIRED
 * (ADR-0048 Amendment 3): bytecode now exists only inside the whole-bundle
 * single-executable compile. `standalone-bun-bytecode` is gone; these tests
 * are the guard that nothing standalone-shaped re-grows a bytecode step.
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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";
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
 * artifact of that SHAPE. Since ADR-0048 the default build is vinext, whose
 * artifact is a nitro output — meaning a config that omits `build` correctly
 * skips the heal and instead compiles the single executable.
 *
 * turbopack is retired (`available: false`) but still described, because
 * `apps/docs` has not migrated yet. The turbopack tests therefore cover
 * machinery that is alive but scheduled for deletion: when the last standalone
 * consumer moves, the heal and those tests go together.
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

/** The compiles that target the SHIPPED arch, ignoring any host-arch smoke one. */
const shipCompiles = () =>
    buildVinextExecutable.mock.calls.filter((c) => c[0]?.arch === "linux-x64");

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
        await build({});
        expect(runQuiet).toHaveBeenCalledWith(["npm", "run", "build"]);
    });

    it("runs the heal (not the compile) when a standalone dir exists on the turbopack shape", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });

        await build({ skipNextBuild: true });

        expect(healBunExportTargets).toHaveBeenCalledTimes(1);
        expect(buildVinextExecutable).not.toHaveBeenCalled();
        expect(uploadAssets).toHaveBeenCalledTimes(1);
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

    it("skips the standalone heal on the default (vinext) build, even with a standalone dir present", async () => {
        // The directory is created ON PURPOSE: the gate must key on the
        // artifact SHAPE, not on whether a stale standalone tree happens to be
        // lying around from an earlier build.
        loadConfig.mockResolvedValue(cfg({ runtime: "bun", build: undefined }));
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });

        await build({ skipNextBuild: true });

        expect(healBunExportTargets).not.toHaveBeenCalled();
        expect(shipCompiles()).toHaveLength(1);
        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });
});
