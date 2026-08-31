/**
 * deploy.ts — applyOverrides (CLI/env → config) + the post-apply retention-GC
 * branches, hermetically (mirrors deploy-orchestrator.test.ts's seams). Pins:
 *  - --registry / --bucket override the config the CR is rendered from,
 *  - KN_REDIS_URL overrides a redis cache url,
 *  - a GC "skip" result (pruned:false) is tolerated (warn), and a GC throw is
 *    swallowed — a shipped deploy never fails on best-effort GC.
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
const getAssetPrefix = mock<AnyFn>(() => "https://cdn.example.com/_next");
const reclaimBuildPrefix = mock<AnyFn>();
const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    // keep the REAL hasStorage/notice exports (ADR-0047) — stub only the seams
    ...__knextReal1,
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
}));

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(async () => "reg/my-app@sha256:deadbeef");
const validateCRImageRef = mock<AnyFn>();
mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));
// #314: deploy runs a server-side dry-run prune preflight BEFORE any side
// effect. Stub its kubectl boundary so this suite stays hermetic; the preflight
// itself is covered by cr-prune-preflight.test.ts + deploy-preflight-ordering.test.ts.
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

mock.module("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: mock(),
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

const loadConfig = mock<AnyFn>(async () => baseConfig);
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
    // placeholder-preflight.ts (imported by deploy.ts) extends UsageError at
    // module-eval time, so the mock must define it (same as deploy-no-storage).
    UsageError: class MockUsageError extends Error {},
}));

const readFileSyncMock = mock<(...a: unknown[]) => string>(() => "deploytag");
const __knextReal2 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const actual = __knextReal2;
    // #644: deploy now infers the docker build context from the real
    // filesystem (the lockfile walk in tracing-root.ts). Spreading
    // `importOriginal()` does NOT carry node-builtin named exports under
    // vitest, so every fs function the code touches must be listed here —
    // `existsSync` is passed through to the REAL one rather than stubbed, so
    // the walk still answers about the actual tree.
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
        expect(cfg.storage?.bucket).toBe("bucket2");
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
