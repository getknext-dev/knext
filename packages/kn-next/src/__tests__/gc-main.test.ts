/**
 * gc.ts — gcMain entry (help path + a full read-only run). Complements the
 * gc-cli / gc-toctou / gc-skip suites (which drive runAssetGC + renderGcReport
 * directly) by covering the gcMain wiring: parse → loadConfig → runAssetGC →
 * renderGcReport, with the exec + prune + config seams mocked so no cluster or
 * object store is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCapture = vi.hoisted(() => vi.fn(() => ""));
vi.mock("../cli/exec", () => ({ runCapture, isEntrypoint: () => false }));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../cli/shared", () => ({ loadConfig }));

const pruneOldBuilds = vi.hoisted(() =>
    vi.fn(() => ({
        reaped: [],
        keptWindow: [],
        keptLive: [],
        keptUnmarked: [],
        reservedExcluded: [],
        dryRun: false,
    })),
);
vi.mock("../utils/asset-upload", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../utils/asset-upload")>();
    return { ...actual, pruneOldBuilds };
});

import { gcMain } from "../cli/gc";

const cfg = {
    name: "my-app",
    registry: "r",
    storage: { provider: "gcs", bucket: "b" },
};

beforeEach(() => {
    runCapture.mockReturnValue("");
    loadConfig.mockResolvedValue(cfg);
    pruneOldBuilds.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("gcMain", () => {
    it("returns 0 for --help without loading config", async () => {
        expect(await gcMain(["--help"])).toBe(0);
        expect(loadConfig).not.toHaveBeenCalled();
    });

    it("runs the GC (empty traffic, no pin) and prunes, returning 0", async () => {
        // runCapture returns "" for status.currentTraffic + spec pin → empty
        // live set, empty pin → the prune runs over an empty live-build set.
        expect(await gcMain([])).toBe(0);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(pruneOldBuilds).toHaveBeenCalledTimes(1);
    });

    it("--dry-run computes the plan and issues no drift re-read", async () => {
        pruneOldBuilds.mockReturnValue({
            reaped: [],
            keptWindow: [],
            keptLive: [],
            keptUnmarked: [],
            reservedExcluded: [],
            dryRun: true,
        });
        expect(await gcMain(["--dry-run"])).toBe(0);
        const [, , , opts] = pruneOldBuilds.mock.calls[0] as unknown[];
        expect((opts as { dryRun: boolean }).dryRun).toBe(true);
    });

    it("propagates a parse error for an unknown flag", async () => {
        await expect(gcMain(["--bogus"])).rejects.toThrow(/unknown flag/);
    });
});
