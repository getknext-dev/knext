/**
 * ADR-0047 — `kn-next gc` and `kn-next build` in the no-storage mode,
 * hermetically. Pinned:
 *
 *   - gcMain: storage-less config ⇒ "no object storage configured — nothing
 *     to reap" on fd 1, exit 0, and NOT ONE cluster read or prune call — an
 *     intentional, announced no-op, never a crash and never a fake "reaped".
 *   - build: storage-less config ⇒ the upload step is skipped with the
 *     announced-mode notice; the configuration log says the mode instead of
 *     "undefined (undefined)".
 *   - regression pins for both with storage configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnativeNextConfig } from "../config";

type AnyFn = (...args: unknown[]) => unknown;

const runQuiet = vi.fn<AnyFn>();
const runCapture = vi.fn<AnyFn>(() => "");
vi.mock("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: vi.fn(),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: vi.fn(),
    isEntrypoint: () => false,
}));

const uploadAssets = vi.fn<AnyFn>(async () => {});
const pruneOldBuilds = vi.fn<AnyFn>(() => ({
    reaped: [],
    keptUnmarked: [],
    keptWindow: [],
    keptLive: [],
    reservedExcluded: [],
    dryRun: false,
}));
vi.mock("../utils/asset-upload", async (importOriginal) => {
    const actual = await importOriginal<object>();
    return {
        ...actual,
        uploadAssets: (...a: unknown[]) => uploadAssets(...a),
        pruneOldBuilds: (...a: unknown[]) => pruneOldBuilds(...a),
    };
});

const logInfo = vi.fn<AnyFn>();
vi.mock("../utils/logger", () => ({
    createLogger: () => ({
        info: (...a: unknown[]) => logInfo(...a),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
    }),
}));

const storagelessConfig: KnativeNextConfig = {
    name: "starter",
    registry: "ghcr.io/someone",
};

const storageBackedConfig: KnativeNextConfig = {
    name: "starter",
    registry: "ghcr.io/someone",
    storage: {
        provider: "gcs",
        bucket: "assets",
        publicUrl: "https://storage.googleapis.com/assets",
    },
};

const loadConfig = vi.fn<AnyFn>(async () => storagelessConfig);
vi.mock("../cli/shared", () => ({
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    UsageError: class extends Error {},
    handleUsageError: () => false,
    handleConfigNotFound: () => false,
}));

const writeSyncMock = vi.fn<AnyFn>();
vi.mock("node:fs", async () => {
    // Spreading importOriginal() does NOT carry node-builtin named exports
    // under vitest (same note as deploy-overrides.test.ts) — resolve the REAL
    // fs via createRequire and stub only writeSync (gc's fd-1 report channel).
    const { createRequire } = await import("node:module");
    const realFs = createRequire(import.meta.url)(
        "node:fs",
    ) as typeof import("node:fs");
    const overrides = {
        ...realFs,
        writeSync: (...a: unknown[]) => writeSyncMock(...a),
    };
    return { ...overrides, default: overrides };
});

function writtenToFd1(): string {
    return writeSyncMock.mock.calls
        .filter((c) => c[0] === 1)
        .map((c) => String(c[1]))
        .join("");
}

function infoMessages(): string[] {
    return logInfo.mock.calls.map((call) =>
        call
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" "),
    );
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loadConfig.mockResolvedValue(storagelessConfig);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("kn-next gc without storage (ADR-0047 condition 3)", () => {
    it("says nothing-to-reap, exits 0, and never touches the cluster or a bucket", async () => {
        const { gcMain } = await import("../cli/gc");
        const code = await gcMain([]);

        expect(code).toBe(0);
        expect(writtenToFd1()).toContain(
            "no object storage configured — nothing to reap",
        );
        // Not a fake success: nothing was classified, listed, or deleted.
        expect(writtenToFd1()).not.toContain("reaped:");
        expect(runCapture).not.toHaveBeenCalled();
        expect(pruneOldBuilds).not.toHaveBeenCalled();
    });

    it("with storage configured the GC still runs its normal path (regression pin)", async () => {
        loadConfig.mockResolvedValue(storageBackedConfig);
        // Cluster reads: currentTraffic → empty pin probe values.
        runCapture.mockReturnValue("");
        const { gcMain } = await import("../cli/gc");
        const code = await gcMain([]);

        expect(code).toBe(0);
        expect(runCapture).toHaveBeenCalled();
        expect(writtenToFd1()).not.toContain(
            "no object storage configured — nothing to reap",
        );
    });
});

describe("kn-next build without storage (ADR-0047 conditions 1 + 3)", () => {
    it("skips the upload with the announced-mode notice", async () => {
        const { build } = await import("../cli/build");
        await build({ skipNextBuild: true });

        expect(uploadAssets).not.toHaveBeenCalled();
        const notice = infoMessages().find((m) =>
            /no object storage configured/i.test(m),
        );
        expect(notice).toBeDefined();
        expect(notice).toMatch(/served from the image/i);
    });

    it("the configuration log names the mode instead of crashing on storage.provider", async () => {
        const { build } = await import("../cli/build");
        await build({ skipNextBuild: true });

        const cfgLine = infoMessages().find((m) =>
            /Configuration loaded/.test(m),
        );
        expect(cfgLine).toBeDefined();
        expect(cfgLine).not.toMatch(/undefined/);
    });

    it("clears an inherited ASSET_PREFIX BEFORE `next build` runs (review F3)", async () => {
        process.env.ASSET_PREFIX = "https://stale-bucket.example.com/app";
        let prefixDuringBuild: string | undefined = "unset-sentinel";
        runQuiet.mockImplementation((...args: unknown[]) => {
            const argv = args[0] as string[];
            if (argv?.[0] === "npm" && argv?.[2] === "build") {
                prefixDuringBuild = process.env.ASSET_PREFIX;
            }
        });
        const { build } = await import("../cli/build");
        await build({});

        // The mode's guarantee is relative asset paths; a stale bucket URL
        // inherited from the shell must not reach the build.
        expect(prefixDuringBuild).toBeUndefined();
        expect(process.env.ASSET_PREFIX).toBeUndefined();
        delete process.env.ASSET_PREFIX;
    });

    it("with storage configured the upload still runs (regression pin)", async () => {
        loadConfig.mockResolvedValue(storageBackedConfig);
        const { build } = await import("../cli/build");
        await build({ skipNextBuild: true });

        expect(uploadAssets).toHaveBeenCalledTimes(1);
        expect(
            infoMessages().some((m) => /no object storage configured/i.test(m)),
        ).toBe(false);
    });
});
