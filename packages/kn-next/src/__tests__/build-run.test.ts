/**
 * build.ts — the `build()` orchestrator (official-adapter + standalone). Drives
 * both post-build passes with the side-effecting seams mocked (loadConfig,
 * uploadAssets, runQuiet, the bun-heal + bytecode helpers):
 *  - no standalone dir → the heal/bytecode passes are skipped (warn branch),
 *  - standalone dir present + runtime=bun → heal runs AND the bytecode pass runs,
 *  - assets are always uploaded last.
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
import type { BytecodePassResult } from "../adapters/standalone-bun-bytecode";

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

const precompileBunBytecode = (() =>
    mock<() => BytecodePassResult>(() => ({
        compiled: 3,
        skipped: [],
        guarded: [],
    })))();
mock.module("../adapters/standalone-bun-bytecode", () => ({
    precompileBunBytecode,
}));

import { build } from "../cli/build";

let dir: string;
const savedCwd = process.cwd();

/**
 * `build: "turbopack"` is explicit here, and it is not incidental.
 *
 * The bun-exports heal and the bytecode pass walk a `.next/standalone` tree, so
 * they only run for an artifact of that SHAPE. Since ADR-0048 the default build
 * is vinext, whose artifact is a nitro output — meaning a config that omits
 * `build` correctly skips both passes, and these tests would be asserting the
 * old world if they relied on the default.
 *
 * turbopack is retired (`available: false`) but still described, because
 * `apps/docs` has not migrated yet. These tests therefore cover machinery that
 * is alive but scheduled for deletion: when the last standalone consumer moves,
 * the passes and this file go together. `skips both passes on the default
 * (vinext) build` below is the guard for the other half.
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
    precompileBunBytecode.mockReturnValue({
        compiled: 3,
        skipped: [],
        guarded: [],
    });
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

describe("build()", () => {
    it("skips the heal/bytecode passes and uploads assets when no standalone dir exists", async () => {
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });

        expect(healBunExportTargets).not.toHaveBeenCalled();
        expect(precompileBunBytecode).not.toHaveBeenCalled();
        expect(uploadAssets).toHaveBeenCalledTimes(1);
        // skipNextBuild → no `npm run build`.
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("runs `next build` when not skipped", async () => {
        loadConfig.mockResolvedValue(cfg());
        await build({});
        expect(runQuiet).toHaveBeenCalledWith(["npm", "run", "build"]);
    });

    it("runs the heal AND bytecode passes when a standalone dir exists and runtime=bun", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });

        await build({ skipNextBuild: true });

        expect(healBunExportTargets).toHaveBeenCalledTimes(1);
        expect(precompileBunBytecode).toHaveBeenCalledTimes(1);
        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });

    it("skips BOTH standalone passes on the default (vinext) build, even with a standalone dir present", async () => {
        // The other half of the `build: "turbopack"` pin above. Without this,
        // every test here could keep passing while the default build silently
        // ran standalone-shaped steps against a nitro artifact — walking a
        // `.next/standalone` tree that vinext never produces.
        //
        // The directory is created ON PURPOSE: the gate must key on the
        // artifact SHAPE, not on whether a stale standalone tree happens to be
        // lying around from an earlier build. That is the failure this asserts.
        loadConfig.mockResolvedValue(cfg({ runtime: "bun", build: undefined }));
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });

        await build({ skipNextBuild: true });

        expect(healBunExportTargets).not.toHaveBeenCalled();
        expect(precompileBunBytecode).not.toHaveBeenCalled();
        // The build itself still completes — skipping the passes must not
        // skip the deploy-relevant work.
        expect(uploadAssets).toHaveBeenCalledTimes(1);
    });

    it("logs per-file skip reasons when the bytecode pass skips files", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "bun" }));
        precompileBunBytecode.mockReturnValue({
            compiled: 1,
            skipped: ["a.js: too small", "b.js: probe failed"],
            guarded: ["server.js"],
            disabled: undefined,
        });
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });

        await build({ skipNextBuild: true });
        expect(precompileBunBytecode).toHaveBeenCalledTimes(1);
    });

    it("skips the bytecode pass on a node runtime even with a standalone dir", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "node" }));
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });

        await build({ skipNextBuild: true });

        expect(healBunExportTargets).toHaveBeenCalledTimes(1);
        expect(precompileBunBytecode).not.toHaveBeenCalled();
    });
});
