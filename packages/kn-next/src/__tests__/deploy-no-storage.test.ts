/**
 * ADR-0047 — the DEPLOY path in the no-storage mode, hermetically (same seams
 * as deploy-overrides.test.ts). Pinned:
 *
 *   - a storage-less deploy COMPLETES: no asset upload, no assetPrefix, no
 *     retention GC — and the CR is rendered from the storage-less config;
 *   - the mode is ANNOUNCED at info on EVERY deploy, dry-run included
 *     (condition 1: a dropped storage block must not look identical to a
 *     deliberate choice);
 *   - an inherited ASSET_PREFIX env var is CLEARED — the emitted HTML must
 *     not point at a bucket nothing uploads to;
 *   - `--bucket` without a storage block is a loud usage error, not a
 *     silently-invented storage config;
 *   - regression pin: with storage configured the notice is NOT printed and
 *     the upload/GC path runs exactly as before.
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

type AnyFn = (...args: unknown[]) => unknown;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
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
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: mock(),
    isEntrypoint: () => false,
}));

const uploadAssets = mock<AnyFn>(async () => {});
const getAssetPrefix = mock<AnyFn>(() => "https://cdn.example.com/my-app");
const reclaimBuildPrefix = mock<AnyFn>();
const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", async () => {
    const actual = __knextReal1;
    return {
        ...actual,
        uploadAssets: (...a: unknown[]) => uploadAssets(...a),
        getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
        reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
    };
});

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(async () => "reg/my-app@sha256:deadbeef");
const validateCRImageRef = mock<AnyFn>();
mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));
mock.module("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: mock(),
}));

mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

// Capture the announcement: deploy logs through createLogger().
const logInfo = mock<AnyFn>();
const logWarn = mock<AnyFn>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: (...a: unknown[]) => logInfo(...a),
        warn: (...a: unknown[]) => logWarn(...a),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
}));

const storagelessConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
};

const storageBackedConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "my-bucket",
        publicUrl: "https://storage.googleapis.com/my-bucket",
    },
};

class MockUsageError extends Error {}

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
    UsageError: MockUsageError,
    handleUsageError: () => false,
    handleConfigNotFound: () => false,
}));

const readFileSyncMock = mock<(...a: unknown[]) => string>(() => "deploytag");
const __knextReal2 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const actual = __knextReal2;
    const realFs = __knextRealFs;
    const overrides = {
        existsSync: realFs.existsSync,
        readFileSync: (...a: unknown[]) => readFileSyncMock(...(a as [string])),
        writeFileSync: mock(),
        mkdirSync: mock(),
        writeSync: mock(),
    };
    return {
        ...actual,
        ...overrides,
        default: { ...(actual as { default?: object }).default, ...overrides },
    };
});

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

/** All log.info calls flattened to one searchable string per call. */
function infoMessages(): string[] {
    return logInfo.mock.calls.map((call) =>
        call
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" "),
    );
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    // No `resetModules()`: everything this file varies goes through the mocks
    // cleared on the next line and the fixtures set below. bun has no registry
    // reset, and the deploy path holds no module state of its own — it reads
    // config and calls injected collaborators.
    jest.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue("reg/my-app@sha256:deadbeef");
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(storagelessConfig);
    readFileSyncMock.mockReturnValue("deploytag");
    delete process.env.ASSET_PREFIX;
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy without storage (ADR-0047 conditions 1 + 3)", () => {
    it("completes without touching any storage-backed path", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        expect(uploadAssets).not.toHaveBeenCalled();
        expect(getAssetPrefix).not.toHaveBeenCalled();
        expect(runAssetGC).not.toHaveBeenCalled();
        expect(reclaimBuildPrefix).not.toHaveBeenCalled();
        // The CR is still rendered and applied — from the storage-less config.
        const cfg = renderNextAppCR.mock.calls.at(-1)?.[0] as KnativeNextConfig;
        expect(cfg.storage).toBeUndefined();
    });

    it("announces the mode at info — image-served assets, no CDN, no retention, skew, docs link", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const notice = infoMessages().find((m) =>
            /no object storage configured/i.test(m),
        );
        expect(notice).toBeDefined();
        expect(notice).toMatch(/served from the image/i);
        expect(notice).toMatch(/CDN/);
        expect(notice).toMatch(/retention/);
        expect(notice).toMatch(/skew/i);
        expect(notice).toMatch(/https:\/\/knext\.dev\/docs\//);
    });

    it("announces on a dry-run too (every deploy means EVERY deploy)", async () => {
        setArgv(["deploy", "--tag", "deploytag", "--dry-run", "--skip-build"]);
        const deploy = await importDeploy();
        await deploy();

        expect(
            infoMessages().some((m) => /no object storage configured/i.test(m)),
        ).toBe(true);
    });

    it("clears an inherited ASSET_PREFIX so the build cannot point at a bucket nothing fills", async () => {
        process.env.ASSET_PREFIX = "https://stale-bucket.example.com/app";
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        expect(process.env.ASSET_PREFIX).toBeUndefined();
    });

    it("--bucket without a storage block is a loud usage error", async () => {
        setArgv(["deploy", "--tag", "deploytag", "--bucket", "somebucket"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(/--bucket/);
    });
});

describe("deploy WITH storage — unchanged (regression pins)", () => {
    beforeEach(() => {
        loadConfig.mockResolvedValue(storageBackedConfig);
    });

    it("uploads, sets ASSET_PREFIX, runs the retention GC, prints no mode notice", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        expect(uploadAssets).toHaveBeenCalledTimes(1);
        expect(getAssetPrefix).toHaveBeenCalled();
        expect(runAssetGC).toHaveBeenCalledTimes(1);
        expect(
            infoMessages().some((m) => /no object storage configured/i.test(m)),
        ).toBe(false);
    });

    it("--bucket still overrides the configured bucket", async () => {
        setArgv(["deploy", "--tag", "deploytag", "--bucket", "bucket2"]);
        const deploy = await importDeploy();
        await deploy();

        const cfg = renderNextAppCR.mock.calls.at(-1)?.[0] as KnativeNextConfig;
        expect(cfg.storage?.bucket).toBe("bucket2");
    });
});
