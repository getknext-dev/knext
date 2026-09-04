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

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import type { KnativeNextConfig } from "../config";

// bun types `mockResolvedValue`/`mockReturnValue` off the declared return
// type. A mock returning `unknown` is not Promise-shaped, so every
// `mockResolvedValue` call is rejected. Arguments stay `unknown[]` — that is
// where the strictness that matters lives.
// biome-ignore lint/suspicious/noExplicitAny: the return must be `any`; see above
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
// `createRequire` and the REAL `node:fs` are resolved OUT HERE, not inside the
// `mock.module("node:fs", …)` factory below.
//
// An `await import(...)` inside a mock factory deadlocks under bun: the mock is
// already registered when the factory runs, so the import re-enters module
// resolution and waits on itself. The file does not fail — it HANGS with no
// output, which the runner can only report as a timeout naming no test.
const { createRequire: __knextCreateRequire } = await import("node:module");
const __knextRealFs = __knextCreateRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

mock.module("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: mock(),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: mock(),
    isEntrypoint: () => false,
}));

const uploadAssets = mock<AnyFn>(async () => {});
const pruneOldBuilds = mock<AnyFn>(() => ({
    reaped: [],
    keptUnmarked: [],
    keptWindow: [],
    keptLive: [],
    reservedExcluded: [],
    dryRun: false,
}));
const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", async () => {
    const actual = __knextReal1;
    return {
        ...actual,
        uploadAssets: (...a: unknown[]) => uploadAssets(...a),
        pruneOldBuilds: (...a: unknown[]) => pruneOldBuilds(...a),
    };
});

const logInfo = mock<AnyFn>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: (...a: unknown[]) => logInfo(...a),
        warn: mock(),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
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

const loadConfig = mock<AnyFn>(async () => storagelessConfig);
// The REAL module is spread first, then overridden.
//
// bun replaces a mocked module WHOLESALE — there is no partial/automock — so a
// factory listing only what the test drives drops every other export, and the
// importer dies with `Export named 'handleUsageError' not found in module`.
// That error names the consumer, not this factory, which is what made it slow
// to place. Spreading keeps the file honest as `../cli/shared` grows.
const __knextRealShared = { ...(await import("../cli/shared")) };

mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    UsageError: class extends Error {},
    handleUsageError: () => false,
    handleConfigNotFound: () => false,
}));

// The single-exec compile (ADR-0048 Amendment 3) runs for the default (vinext)
// artifact shape inside build(). Left unmocked it probes the host's real Bun
// version and tries a real compile — neither belongs in a hermetic ADR-0047
// test about storage modes.
const buildVinextExecutable = mock<AnyFn>(() => "knext-exec-linux-x64");
const __knextRealVinextBuild = { ...(await import("../cli/vinext-build")) };
mock.module("../cli/vinext-build", () => ({
    ...__knextRealVinextBuild,
    buildVinextExecutable: (...a: unknown[]) => buildVinextExecutable(...a),
}));

const writeSyncMock = mock<AnyFn>();
mock.module("node:fs", async () => {
    // Spreading importOriginal() does NOT carry node-builtin named exports
    // under vitest (same note as deploy-overrides.test.ts) — resolve the REAL
    // fs via createRequire and stub only writeSync (gc's fd-1 report channel).
    const realFs = __knextRealFs;
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
    // No `resetModules()`: everything this file varies goes through the mocks
    // cleared on the next line and the fixtures set below. bun has no registry
    // reset, and the deploy path holds no module state of its own — it reads
    // config and calls injected collaborators.
    jest.clearAllMocks();
    loadConfig.mockResolvedValue(storagelessConfig);
});

afterEach(() => {
    jest.restoreAllMocks();
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
