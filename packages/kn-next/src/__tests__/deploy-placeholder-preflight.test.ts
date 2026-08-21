/**
 * UX ledger row 4 (4b) — deploy fails fast on placeholder config values,
 * BEFORE any build step (hermetic, same seams as deploy-no-storage.test.ts).
 *
 * Row 4 measured the opposite: `registry: "ghcr.io/<your-user>"` flowed
 * silently into a full multi-minute `next build` and died at the image push —
 * the most expensive possible place to learn the config is unfinished.
 *
 * Pinned here:
 *   - a placeholder anywhere in the effective config rejects the deploy as a
 *     UsageError-family message (friendly write-and-exit, never FATAL);
 *   - NOTHING ran first: no build script, no upload, no CR render, no exec;
 *   - the scan sees the EFFECTIVE config — a `--registry` override rescues a
 *     placeholder file, and a placeholder typed AS the override is caught.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnativeNextConfig } from "../config";

type AnyFn = (...args: unknown[]) => unknown;

const runQuiet = vi.fn<AnyFn>();
const runInherit = vi.fn<AnyFn>();
const runCapture = vi.fn<AnyFn>(() => "");
vi.mock("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: vi.fn(),
    isEntrypoint: () => false,
}));

const uploadAssets = vi.fn<AnyFn>(async () => {});
const getAssetPrefix = vi.fn<AnyFn>(() => "https://cdn.example.com/my-app");
const reclaimBuildPrefix = vi.fn<AnyFn>();
vi.mock("../utils/asset-upload", async (importOriginal) => {
    const actual = await importOriginal<object>();
    return {
        ...actual,
        uploadAssets: (...a: unknown[]) => uploadAssets(...a),
        getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
        reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
    };
});

const renderNextAppCR = vi.fn<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = vi.fn<AnyFn>(async () => "reg/my-app@sha256:deadbeef");
const validateCRImageRef = vi.fn<AnyFn>();
vi.mock("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

const runAssetGC = vi.fn<AnyFn>(() => ({ pruned: true }));
vi.mock("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: vi.fn(),
}));

vi.mock("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

vi.mock("../utils/logger", () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
    }),
}));

// REAL shared module (real UsageError/USAGE_ERROR_CODE, so the thrown error's
// friendly-path discriminator is the one the dispatcher actually checks) —
// only config loading is a seam.
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../cli/shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../cli/shared")>()),
    loadConfig,
}));

const readFileSyncMock = vi.fn<(...a: unknown[]) => string>(() => "deploytag");
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    const { createRequire } = await import("node:module");
    const realFs = createRequire(import.meta.url)(
        "node:fs",
    ) as typeof import("node:fs");
    const overrides = {
        existsSync: realFs.existsSync,
        readFileSync: (...a: unknown[]) => readFileSyncMock(...(a as [string])),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        writeSync: vi.fn(),
    };
    return {
        ...actual,
        ...overrides,
        default: { ...(actual as { default?: object }).default, ...overrides },
    };
});

import { USAGE_ERROR_CODE } from "../cli/shared";

const placeholderConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "ghcr.io/<your-user>",
};

const cleanConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com/real",
};

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue("reg/my-app@sha256:deadbeef");
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(placeholderConfig);
    readFileSyncMock.mockReturnValue("deploytag");
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy rejects placeholder config values before any work", () => {
    it("throws the friendly UsageError-family message naming the field", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("registry"),
        });
        await expect(
            (async () => {
                loadConfig.mockResolvedValue(placeholderConfig);
                return (await importDeploy())();
            })(),
        ).rejects.toMatchObject({
            message: expect.stringContaining("ghcr.io/<your-user>"),
        });
    });

    it("ran NOTHING first: no build script, no upload, no CR render, no exec", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
        });
        expect(runQuiet).not.toHaveBeenCalled();
        expect(runInherit).not.toHaveBeenCalled();
        expect(runCapture).not.toHaveBeenCalled();
        expect(uploadAssets).not.toHaveBeenCalled();
        expect(renderNextAppCR).not.toHaveBeenCalled();
        expect(resolveDigest).not.toHaveBeenCalled();
    });

    it("a placeholder nested in storage is caught too", async () => {
        loadConfig.mockResolvedValue({
            ...cleanConfig,
            storage: { provider: "gcs", bucket: "<your-assets-bucket>" },
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("storage.bucket"),
        });
    });

    it("a --registry override RESCUES a placeholder file (effective config is scanned)", async () => {
        setArgv([
            "deploy",
            "--tag",
            "deploytag",
            "--registry",
            "registry.example.com/real",
        ]);
        const deploy = await importDeploy();
        await deploy();
        const cfg = renderNextAppCR.mock.calls.at(-1)?.[0] as KnativeNextConfig;
        expect(cfg.registry).toBe("registry.example.com/real");
    });

    it("a placeholder typed AS the override is caught (dodge: scan runs post-override)", async () => {
        loadConfig.mockResolvedValue(cleanConfig);
        setArgv([
            "deploy",
            "--tag",
            "deploytag",
            "--registry",
            "ghcr.io/<your-user>",
        ]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
            message: expect.stringContaining("registry"),
        });
        expect(runQuiet).not.toHaveBeenCalled();
    });

    it("a clean config deploys exactly as before (regression pin)", async () => {
        loadConfig.mockResolvedValue(cleanConfig);
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(renderNextAppCR).toHaveBeenCalled();
    });

    it("dodge (env carve-out): angle-bracket markup in env deploys — no refusal, no escapeless block", async () => {
        // Architect-gate fix round: env is free-text user data
        // (Record<string,string>), so a schema-valid value like an HTML
        // allowlist must never make deploy refusable. The preflight skips the
        // root env map entirely (skip, not warn — see placeholder-preflight.ts).
        loadConfig.mockResolvedValue({
            ...cleanConfig,
            env: { ALLOWED_TAGS: "<b><i>", TEMPLATE: "Hello <name>!" },
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(renderNextAppCR).toHaveBeenCalled();
    });
});
