/**
 * deploy-buildarg-passthrough — #1273 round 2.
 *
 * `deploy-orchestrator.test.ts` module-mocks `../cli/runtime-image` WHOLESALE
 * (its own comment: "selectRuntimeImage and dockerBuildxArgs are pure and
 * covered by runtime-image-selection.test.ts") with a thin fake
 * `dockerBuildxArgs` that never accepted `healthCheckPath`/`bakesCompileCache`
 * at all. That leaves `deploy.ts:723-724`'s own passthrough
 * (`healthCheckPath: config.healthCheckPath, bakesCompileCache:
 * selection.bakesCompileCache,`) completely unexercised: deleting either line
 * keeps every existing suite green (the fake never asserted on those fields)
 * while silently re-breaking the #1264/#1273 health-path fix for real
 * `deploy` runs.
 *
 * This suite runs `deploy()` the same hermetic way `deploy-orchestrator.test.ts`
 * does (same side-effecting seams stubbed: exec, asset-upload, cr-builder, gc,
 * logger, shared/loadConfig, node:fs), but leaves `../cli/runtime-image`'s
 * `selectRuntimeImage` and `dockerBuildxArgs` REAL — only the file-writing
 * `stageStandaloneBuildContext` is stubbed. It asserts the REAL `docker buildx
 * build` argv `runInherit` receives contains `--build-arg
 * KNEXT_HEALTH_CHECK_PATH=<configured>` for both bake-shape configs:
 * vinext-node (`build:'vinext', runtime:'node'`) and standalone-node
 * (`build:'turbopack', runtime:'node'`).
 *
 * MUTATION-PROVEN (not committed, per workflow.md — verified locally): deleting
 * `bakesCompileCache: selection.bakesCompileCache,` or `healthCheckPath:
 * config.healthCheckPath,` at deploy.ts:723-724 each turns this suite red (no
 * `--build-arg` in the captured docker argv) while every other suite in the
 * repo — including deploy-orchestrator.test.ts, whose fake never looked at
 * either field — stays green.
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

// biome-ignore lint/suspicious/noExplicitAny: thin mock factory plumbing
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
const isEntrypoint = mock<AnyFn>(() => false);

const { createRequire: __knextCreateRequire } = await import("node:module");
const __knextRealFs = __knextCreateRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

mock.module("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: mock(),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
}));

const uploadAssets = mock<AnyFn>(async () => {});
const getAssetPrefix = mock<AnyFn>(() => "https://cdn.example.com/_next");
const reclaimBuildPrefix = mock<AnyFn>();
const verifyVinextStaticPrefix = mock<AnyFn>(() => ({ ok: true }));
const verifyBuiltImageLockstep = mock<AnyFn>(() => ({ ok: true }));

const __knextRealAssetUpload = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    ...__knextRealAssetUpload,
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
    verifyVinextStaticPrefix: (...a: unknown[]) =>
        verifyVinextStaticPrefix(...a),
    verifyBuiltImageLockstep: (...a: unknown[]) =>
        verifyBuiltImageLockstep(...a),
}));

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(
    async () => "registry.example.com/my-app@sha256:deadbeef",
);
const validateCRImageRef = mock<AnyFn>();

mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

// The ONLY runtime-image seam stubbed is the file-writing one
// (`stageStandaloneBuildContext`). `selectRuntimeImage` and `dockerBuildxArgs`
// are left REAL — that is the entire point of this suite (unlike
// deploy-orchestrator.test.ts, which fakes both).
const __knextRealRuntimeImage = { ...(await import("../cli/runtime-image")) };
mock.module("../cli/runtime-image", () => ({
    ...__knextRealRuntimeImage,
    stageStandaloneBuildContext: () => ({ dockerfile: "" }),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));

mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
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
    scaling: { minScale: 0, maxScale: 5 },
    healthCheckPath: "/healthz",
};

const loadConfig = mock<AnyFn>(async () => baseConfig);
const __knextRealShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    UsageError: class MockUsageError extends Error {},
}));

const pkgOr = (fallback: string) => (p: unknown) =>
    String(p).endsWith("package.json") ? '{"type":"module"}' : fallback;
const readFileSyncMock = mock<(...a: unknown[]) => string>(pkgOr("deploytag"));
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

function argvOf(call: unknown[]): string[] {
    return (call[0] as string[]) ?? [];
}

function dockerArgv(): string[] | undefined {
    const call = runInherit.mock.calls.find((c) => argvOf(c)[0] === "docker");
    return call ? argvOf(call) : undefined;
}

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
    jest.clearAllMocks();
    runQuiet.mockImplementation(() => {});
    runInherit.mockImplementation(() => {});
    runCapture.mockReturnValue("");
    uploadAssets.mockImplementation(async () => {});
    resolveDigest.mockResolvedValue(
        "registry.example.com/my-app@sha256:deadbeef",
    );
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(baseConfig);
    readFileSyncMock.mockImplementation(pkgOr("deploytag"));
    verifyVinextStaticPrefix.mockReturnValue({ ok: true });
    verifyBuiltImageLockstep.mockReturnValue({ ok: true });
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy() — the real dockerBuildxArgs call, both bake shapes (#1273)", () => {
    it("vinext-node (build:'vinext', runtime:'node') passes --build-arg KNEXT_HEALTH_CHECK_PATH=<configured>", async () => {
        loadConfig.mockResolvedValue({
            ...baseConfig,
            build: "vinext",
            runtime: "node",
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = dockerArgv();
        expect(argv, "no `docker` argv captured by runInherit").toBeDefined();
        const i = argv?.indexOf("--build-arg") ?? -1;
        expect(i).toBeGreaterThan(-1);
        expect(argv?.[i + 1]).toBe("KNEXT_HEALTH_CHECK_PATH=/healthz");
        expect(argv).not.toContain("--target");
    });

    it("standalone-node (build:'turbopack', runtime:'node') passes --build-arg KNEXT_HEALTH_CHECK_PATH=<configured>", async () => {
        loadConfig.mockResolvedValue({
            ...baseConfig,
            build: "turbopack",
            runtime: "node",
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = dockerArgv();
        expect(argv, "no `docker` argv captured by runInherit").toBeDefined();
        const i = argv?.indexOf("--build-arg") ?? -1;
        expect(i).toBeGreaterThan(-1);
        expect(argv?.[i + 1]).toBe("KNEXT_HEALTH_CHECK_PATH=/healthz");
        expect(argv?.[(argv?.indexOf("--target") ?? -1) + 1]).toBe(
            "standalone-node",
        );
    });

    it("standalone-bun (no bake) never gets the build-arg even with healthCheckPath configured", async () => {
        loadConfig.mockResolvedValue({
            ...baseConfig,
            build: "turbopack",
            runtime: "bun",
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = dockerArgv();
        expect(argv, "no `docker` argv captured by runInherit").toBeDefined();
        expect(argv).not.toContain("--build-arg");
    });
});
