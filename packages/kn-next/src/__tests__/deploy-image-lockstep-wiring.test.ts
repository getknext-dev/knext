/**
 * deploy-image-lockstep-wiring — #1283 round 2 review finding #4.
 *
 * `deploy-orchestrator.test.ts` covers the pre-build vinext skew guard
 * (T2a, `verifyVinextStaticPrefix`) but never asserted on the POST-build
 * image guard (`verifyBuiltImageLockstep`) introduced alongside it — the
 * round-1 wiring for that guard shipped with no dedicated test proving deploy
 * actually CALLS it in scope, SKIPS it out of scope, and ABORTS the deploy
 * before the mutating `kubectl apply` when it fails. This suite closes that.
 *
 * Hermetic, same treatment as deploy-orchestrator.test.ts: every side-effecting
 * seam module-mocked, no live docker/cluster. `../cli/runtime-image` is FULLY
 * replaced (not spread from the real module) so `selection.kind` and
 * `isKnownGoodTemplateDockerfile`'s answer are both directly controllable per
 * test, rather than depending on what happens to exist on disk at
 * `process.cwd()`.
 *
 * MUTATION-PROOF (by construction, not a side note): the "aborts before CR
 * apply" test asserts BOTH that `deploy()` rejects AND that `kubectl apply`
 * never ran. Delete deploy.ts's call to `verifyBuiltImageLockstep` (or the
 * `if (!imageCheck.ok) throw` that follows it) and this test goes red — the
 * mocked guard's `{ ok: false }` would simply be ignored and the deploy would
 * proceed to a successful apply, which the assertion below fails on.
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

const storageConfig: KnativeNextConfig = {
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

describe("deploy() — verifyBuiltImageLockstep scope (#1283 round 2, finding #4)", () => {
    it("CALLS the guard: app-dockerfile + vinext + storage + NOT a known-good template", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(verifyBuiltImageLockstep).toHaveBeenCalledTimes(1);
        expect(verifyBuiltImageLockstep).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedId: "deploytag",
                assetPrefix: "https://cdn.example.com/my-app",
            }),
        );
    });

    it("SKIPS the guard for the standalone (--target) shape", async () => {
        selectRuntimeImageKind = "standalone";
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(verifyBuiltImageLockstep).not.toHaveBeenCalled();
    });

    it("SKIPS the guard when no storage is configured (uploadsAssets false)", async () => {
        loadConfig.mockResolvedValue(noStorageConfig);
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(verifyBuiltImageLockstep).not.toHaveBeenCalled();
    });

    it("SKIPS the guard for a byte-identical, unmodified shipped template (isKnownGoodTemplateDockerfile: true) — this is what stops round 1 from blocking EVERY vinext+storage deploy", async () => {
        isKnownGoodTemplate = true;
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(verifyBuiltImageLockstep).not.toHaveBeenCalled();
        // The deploy still succeeds — nothing else about it changed.
        expect(applied()).toBe(true);
    });

    it("SKIPS the guard when --skip-image-lockstep-check is passed (the documented opt-out for a non-standard layout)", async () => {
        setArgv([
            "deploy",
            "--tag",
            "deploytag",
            "--skip-image-lockstep-check",
        ]);
        const deploy = await importDeploy();
        await deploy();
        expect(verifyBuiltImageLockstep).not.toHaveBeenCalled();
        expect(applied()).toBe(true);
    });

    it("ABORTS before the mutating CR apply when the guard fails — mutation-proof: deleting the call site or its throw makes this pass wrongly (see file header)", async () => {
        verifyBuiltImageLockstep.mockReturnValue({
            ok: false,
            reason: "prefix-missing",
            siblings: ["some-other-id"],
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(
            /In-image build lock-step check failed/,
        );
        expect(applied()).toBe(false);
    });
});
