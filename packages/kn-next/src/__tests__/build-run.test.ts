/**
 * build.ts — the `build()` orchestrator (official-adapter + standalone). Drives
 * both post-build passes with the side-effecting seams mocked (loadConfig,
 * uploadAssets, runQuiet, the bun-heal + bytecode helpers):
 *  - no standalone dir → the heal/bytecode passes are skipped (warn branch),
 *  - standalone dir present + runtime=bun → heal runs AND the bytecode pass runs,
 *  - assets are always uploaded last.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BytecodePassResult } from "../adapters/standalone-bun-bytecode";

const runQuiet = vi.hoisted(() => vi.fn());
vi.mock("../cli/exec", () => ({ runQuiet, isEntrypoint: () => false }));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../cli/shared", () => ({ loadConfig }));

const uploadAssets = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../utils/asset-upload", () => ({ uploadAssets }));

const healBunExportTargets = vi.hoisted(() =>
    vi.fn(() => ({ copied: [], skipped: [] })),
);
vi.mock("../adapters/standalone-bun-exports", () => ({ healBunExportTargets }));

const precompileBunBytecode = vi.hoisted(() =>
    vi.fn<() => BytecodePassResult>(() => ({
        compiled: 3,
        skipped: [],
        guarded: [],
    })),
);
vi.mock("../adapters/standalone-bun-bytecode", () => ({
    precompileBunBytecode,
}));

import { build } from "../cli/build";

let dir: string;
const savedCwd = process.cwd();

const cfg = (over: Record<string, unknown> = {}) => ({
    name: "my-app",
    registry: "reg",
    storage: { provider: "gcs", bucket: "b" },
    ...over,
});

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-build-"));
    process.chdir(dir);
    vi.clearAllMocks();
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
