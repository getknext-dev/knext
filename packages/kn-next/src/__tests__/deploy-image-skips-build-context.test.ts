/**
 * #1865 (spec review round 2) — `--image` means there is nothing to build
 * (it already forces `skipBuild`/`skipUpload`), so resolving the Docker
 * build context is pointless on that path — its ONLY consumer is the
 * docker-build task inside `if (!options.image)`. Resolving it
 * UNCONDITIONALLY made every `--image` deploy from a directory with no
 * lockfile (the normal shape for a pre-built-image deploy, which brings no
 * app source at all) fail before it ever reached the `--image`
 * short-circuit — exactly what the kind e2e's second, `--image --private`
 * deploy hit.
 *
 * `requireBuildContext` is mocked to THROW UNCONDITIONALLY here (rather
 * than relying on the real filesystem having no lockfile — this test
 * process's cwd sits under the repo's own lockfile, so the real function
 * would never throw regardless of whether the fix is in place). That makes
 * the assertion direct: `--image` must never reach it at all.
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
import { reconciledNextAppCapture } from "./helpers/reconciled-nextapp";

// biome-ignore lint/suspicious/noExplicitAny: the return must be `any`; see deploy-overrides.test.ts
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");

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
    ...__knextReal1,
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
    verifyVinextStaticPrefix: () => ({ ok: true }),
    verifyBuiltImageLockstep: () => ({ ok: true }),
}));

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(async () => "reg/my-app@sha256:deadbeef");
const validateCRImageRef = mock<AnyFn>();
mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

mock.module("../cli/build-artifact", () => ({
    compileArtifactForDeploy: () => ({ compiled: false }),
    assertCompiledArtifactFresh: () => {},
}));

mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => reconciledNextAppCapture(),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));
mock.module("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: mock(),
}));

// THE SEAM UNDER TEST: throws unconditionally, so the only way a test here
// passes is if `--image` never calls it at all.
const requireBuildContext = mock<AnyFn>(() => {
    throw new Error(
        "requireBuildContext called — this must not happen under --image",
    );
});
const __knextRealTracingRoot = { ...(await import("../cli/tracing-root")) };
mock.module("../cli/tracing-root", () => ({
    ...__knextRealTracingRoot,
    requireBuildContext: (...a: unknown[]) => requireBuildContext(...a),
}));

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "my-bucket",
        publicUrl: "https://storage.googleapis.com/my-bucket",
    },
};

const loadConfig = mock<AnyFn>(async () => baseConfig);
const __knextRealShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    UsageError: class MockUsageError extends Error {},
}));

const fsRead = (p: unknown): string =>
    String(p).endsWith("package.json") ? '{"type":"module"}' : "deploytag";
const readFileSyncMock = mock<(...a: unknown[]) => string>(fsRead);
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

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    jest.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue("reg/my-app@sha256:deadbeef");
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(baseConfig);
    readFileSyncMock.mockImplementation(fsRead);
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

describe("deploy() --image skips the build-context resolution (#1865)", () => {
    it("--image <digest-ref> never calls requireBuildContext", async () => {
        setArgv([
            "deploy",
            "--tag",
            "deploytag",
            "--image",
            "reg/my-app@sha256:deadbeef",
        ]);
        const deploy = await importDeploy();
        await expect(deploy()).resolves.toBeUndefined();
        expect(requireBuildContext).not.toHaveBeenCalled();
    });

    it("without --image, the real build path calls requireBuildContext (and a throw there aborts the deploy)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(/requireBuildContext called/);
        expect(requireBuildContext).toHaveBeenCalledTimes(1);
    });
});
