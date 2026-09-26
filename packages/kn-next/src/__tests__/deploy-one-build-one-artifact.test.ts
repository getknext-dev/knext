/**
 * deploy-one-build-one-artifact — #1447.
 *
 * On the vinext target an in-image build (an app Dockerfile that runs
 * `vite build` itself) and a HOST build uploaded in parallel produce different
 * `vinext-*.js` chunk hashes, so storage mode served a 404 for the app's main
 * chunk. The invariant: the uploaded asset set is derived from the SAME build
 * that produced the image. These tests pin the pipeline SHAPE:
 *
 *  - app-dockerfile + vinext + storage: NO host upload; the assets are
 *    uploaded FROM THE IMAGE, after the image build/push.
 *  - a shipped template Dockerfile (COPYs the host build): the host upload
 *    stays (the host build IS the image's build) and stays parallel.
 *  - a failed asset/image guard aborts before the CR apply.
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
const getAssetPrefix = mock<AnyFn>(() => "https://cdn.example.com/my-app");
const reclaimBuildPrefix = mock<AnyFn>();
const verifyVinextStaticPrefix = mock<AnyFn>(() => ({ ok: true }));
const verifyBuiltImageLockstep = mock<AnyFn>(() => ({ ok: true }));
const uploadAssetsFromImage = mock<AnyFn>(async () => {});

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
    uploadAssetsFromImage: (...a: unknown[]) => uploadAssetsFromImage(...a),
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

// #1339 review finding #1: `deploy()` now compiles the standalone-bun/vinext
// executable via this shared step — stub it the same way as every other
// side-effecting seam here, so this suite stays about the LOCKSTEP guard.
mock.module("../cli/build-artifact", () => ({
    compileArtifactForDeploy: () => ({ compiled: false }),
    assertCompiledArtifactFresh: () => {},
}));

// Fully controllable: `selectRuntimeImageKind` + `isKnownGoodTemplate` are
// module-level `let`s the tests flip directly, so each scoping condition is
// exercised in isolation rather than inferred from a real filesystem check.
let selectRuntimeImageKind: "app-dockerfile" | "standalone" = "app-dockerfile";
let isKnownGoodTemplate = false;
mock.module("../cli/runtime-image", () => ({
    selectRuntimeImage: (
        _config: { build?: string; runtime?: string },
        cwd: string,
    ) =>
        selectRuntimeImageKind === "app-dockerfile"
            ? { kind: "app-dockerfile", dockerfile: `${cwd}/Dockerfile` }
            : {
                  kind: "standalone",
                  dockerfile: `${cwd}/Dockerfile.standalone`,
                  target: "standalone-node",
              },
    stageStandaloneBuildContext: () => ({ dockerfile: "" }),
    isKnownGoodTemplateDockerfile: () => isKnownGoodTemplate,
    dockerBuildxArgs: (o: {
        taggedRef: string;
        buildContext: string;
        dockerfile: string;
        target?: string;
    }) => [
        "docker",
        "buildx",
        "build",
        "-f",
        o.dockerfile,
        ...(o.target ? ["--target", o.target] : []),
        "-t",
        o.taggedRef,
        o.buildContext,
    ],
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));
// `warn` is hoisted out (not a fresh `mock()` per call) so tests can assert on
// it — the #1283 round 3 opt-out announcement.
const logWarn = mock<AnyFn>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: mock(),
        warn: (...a: unknown[]) => logWarn(...a),
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

const storageConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    // build: "vinext" EXPLICIT — #1183/ADR-0058 flipped the ambient default
    // to turbopack, and this suite's whole scenario name is "app-dockerfile +
    // vinext + storage".
    build: "vinext",
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
};
const { storage: _dropped, ...noStorageConfig } = storageConfig;

const loadConfig = mock<AnyFn>(async () => storageConfig);
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

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

/** Did the mutating `kubectl apply` run? */
function applied(): boolean {
    return runInherit.mock.calls.some(
        (c) =>
            (c[0] as string[])?.[0] === "kubectl" &&
            (c[0] as string[])?.[1] === "apply",
    );
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    jest.clearAllMocks();
    selectRuntimeImageKind = "app-dockerfile";
    isKnownGoodTemplate = false;
    runQuiet.mockImplementation(() => {});
    runInherit.mockImplementation(() => {});
    runCapture.mockReturnValue("");
    uploadAssets.mockImplementation(async () => {});
    uploadAssetsFromImage.mockImplementation(async () => {});
    resolveDigest.mockResolvedValue(
        "registry.example.com/my-app@sha256:deadbeef",
    );
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(storageConfig);
    readFileSyncMock.mockImplementation(pkgOr("deploytag"));
    verifyVinextStaticPrefix.mockReturnValue({ ok: true });
    verifyBuiltImageLockstep.mockReturnValue({ ok: true });
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy() — one build, one artifact (#1447)", () => {
    const buildOrder = (): number =>
        runInherit.mock.invocationCallOrder[
            runInherit.mock.calls.findIndex(
                (c) => (c[0] as string[])?.[0] === "docker",
            )
        ];

    it("app-dockerfile + vinext + storage: does NOT upload from the host build", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("uploads FROM THE IMAGE, after the image was built and pushed", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(uploadAssetsFromImage).toHaveBeenCalledTimes(1);
        expect(uploadAssetsFromImage.mock.calls[0]?.[1]).toBe("deploytag");
        expect(String(uploadAssetsFromImage.mock.calls[0]?.[2])).toContain(
            "my-app:deploytag",
        );
        expect(
            uploadAssetsFromImage.mock.invocationCallOrder[0],
        ).toBeGreaterThan(buildOrder());
    });

    it("a shipped template Dockerfile keeps the parallel host upload (host build IS the image's build)", async () => {
        isKnownGoodTemplate = true;
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(uploadAssets).toHaveBeenCalledTimes(1);
        expect(uploadAssetsFromImage).not.toHaveBeenCalled();
    });

    it("the standalone shape keeps the host upload", async () => {
        selectRuntimeImageKind = "standalone";
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(uploadAssetsFromImage).not.toHaveBeenCalled();
    });

    it("--skip-image-lockstep-check turns off only the cross-check, not the image sourcing", async () => {
        setArgv([
            "deploy",
            "--tag",
            "deploytag",
            "--skip-image-lockstep-check",
        ]);
        const deploy = await importDeploy();
        await deploy();
        expect(uploadAssetsFromImage.mock.calls[0]?.[3]).toEqual({
            verify: false,
        });
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("no storage: uploads nothing from anywhere", async () => {
        loadConfig.mockResolvedValue(noStorageConfig);
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(uploadAssets).not.toHaveBeenCalled();
        expect(uploadAssetsFromImage).not.toHaveBeenCalled();
    });

    it("an asset/image mismatch aborts the deploy BEFORE the CR apply", async () => {
        uploadAssetsFromImage.mockRejectedValue(
            new Error("Asset/image mismatch: chunk-missing"),
        );
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(/Asset\/image mismatch/);
        expect(applied()).toBe(false);
    });
});
