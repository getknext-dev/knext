/**
 * deploy.ts — applyOverrides (CLI/env → config) + the post-apply retention-GC
 * branches, hermetically (mirrors deploy-orchestrator.test.ts's seams). Pins:
 *  - --registry / --bucket override the config the CR is rendered from,
 *  - KN_REDIS_URL overrides a redis cache url,
 *  - a GC "skip" result (pruned:false) is tolerated (warn), and a GC throw is
 *    swallowed — a shipped deploy never fails on best-effort GC.
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
const getAssetPrefix = vi.fn<AnyFn>(() => "https://cdn.example.com/_next");
const reclaimBuildPrefix = vi.fn<AnyFn>();
vi.mock("../utils/asset-upload", () => ({
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
}));

const renderNextAppCR = vi.fn<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = vi.fn<AnyFn>(async () => "reg/my-app@sha256:deadbeef");
const validateCRImageRef = vi.fn<AnyFn>();
vi.mock("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

const runAssetGC = vi.fn<AnyFn>(() => ({ pruned: true }));
// #314: deploy runs a server-side dry-run prune preflight BEFORE any side
// effect. Stub its kubectl boundary so this suite stays hermetic; the preflight
// itself is covered by cr-prune-preflight.test.ts + deploy-preflight-ordering.test.ts.
vi.mock("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

vi.mock("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: vi.fn(),
}));

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "my-bucket",
        publicUrl: "https://storage.googleapis.com/my-bucket",
    },
    cache: {
        provider: "redis",
        url: "redis://redis:6379",
        keyPrefix: "my-app",
    },
};

const loadConfig = vi.fn<AnyFn>(async () => baseConfig);
vi.mock("../cli/shared", () => ({
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
}));

const readFileSyncMock = vi.fn<(...a: unknown[]) => string>(() => "deploytag");
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    const overrides = {
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

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
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
    loadConfig.mockResolvedValue(baseConfig);
    readFileSyncMock.mockReturnValue("deploytag");
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

describe("deploy() applyOverrides", () => {
    it("--registry and --bucket override the rendered CR config", async () => {
        setArgv([
            "deploy",
            "--tag",
            "deploytag",
            "--registry",
            "reg2.example.com",
            "--bucket",
            "bucket2",
        ]);
        const deploy = await importDeploy();
        await deploy();

        const cfg = renderNextAppCR.mock.calls.at(-1)?.[0] as KnativeNextConfig;
        expect(cfg.registry).toBe("reg2.example.com");
        expect(cfg.storage.bucket).toBe("bucket2");
    });

    it("KN_REDIS_URL overrides a redis cache url", async () => {
        process.env.KN_REDIS_URL = "redis://override:6379";
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const cfg = renderNextAppCR.mock.calls.at(-1)?.[0] as KnativeNextConfig;
        expect((cfg.cache as { url?: string } | undefined)?.url).toBe(
            "redis://override:6379",
        );
    });
});

describe("deploy() post-apply retention GC (best-effort)", () => {
    it("tolerates a GC skip result (pruned:false) without failing the deploy", async () => {
        runAssetGC.mockReturnValue({
            pruned: false,
            liveRevisions: ["my-app-00001"],
            skipReason: "no-traffic",
            pinnedRevision: undefined,
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).resolves.toBeUndefined();
        expect(runAssetGC).toHaveBeenCalledTimes(1);
    });

    it("swallows a GC throw — a shipped deploy never fails on GC", async () => {
        runAssetGC.mockImplementation(() => {
            throw new Error("gc boom");
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).resolves.toBeUndefined();
    });
});
