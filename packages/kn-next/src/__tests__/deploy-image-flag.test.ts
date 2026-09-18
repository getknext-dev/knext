/**
 * #1063 — `deploy --image <digest-ref>`: deploy a PRE-BUILT image.
 *
 * The gap this closes: `--skip-build` only skips `next build`, NOT the
 * `docker buildx build … --push`, so a user with a pre-built, digest-pinned
 * image (or without a working buildx) had no CLI path to deploy. `--image`
 * bypasses the docker build+push entirely and applies the NextApp CR pointing
 * at the given image.
 *
 * Contract pinned here (mirrors deploy-orchestrator.test.ts's hermetic harness —
 * no live cluster, no docker, no next build):
 *  1. `--dry-run --image <digest-ref>` renders the CR with that EXACT image and
 *     invokes NO docker build/push and NO kubectl apply.
 *  2. A tag-only `--image` (no `@sha256:`) is REJECTED with the digest-pin error
 *     — mirroring the operator's admission webhook — even under --dry-run. The
 *     REAL validateCRImageRef runs here (only render/resolve are stubbed).
 *  3. A real deploy `--image <digest-ref>` applies the CR, skips docker
 *     build+push AND digest resolution (resolveDigest never called), and the CR
 *     carries the given image.
 *  4. `--image` + `--registry`: --image wins; a warning names the ignored
 *     registry; the deploy still uses the given image.
 *  5. `--skip-upload` stays orthogonal: `--image --skip-upload` uploads nothing
 *     but still applies the CR with the given image.
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

// biome-ignore lint/suspicious/noExplicitAny: the return must be `any` so bun's mockResolvedValue/mockReturnValue type off the declared return (see the orchestrator suite)
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
const isEntrypoint = mock<AnyFn>(() => false);

// Resolve the REAL node:fs OUTSIDE the mock factory (an await import inside a
// mock factory deadlocks under bun — see the orchestrator suite's note).
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

const __knextRealAssets = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    ...__knextRealAssets,
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
    verifyVinextStaticPrefix: (...a: unknown[]) =>
        verifyVinextStaticPrefix(...a),
}));

// Only render/resolve are stubbed — validateCRImageRef stays REAL so the
// digest-pin rejection (case 2) exercises the actual operator-mirroring rule.
const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(
    async () => "registry.example.com/my-app@sha256:deadbeef",
);
const __knextRealCrBuilder = { ...(await import("../cli/cr-builder")) };
mock.module("../cli/cr-builder", () => ({
    ...__knextRealCrBuilder,
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));
mock.module("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: mock(),
}));

mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

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
};

const loadConfig = mock<AnyFn>(async () => baseConfig);
const __knextRealShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    UsageError: class MockUsageError extends Error {},
}));

const readFileSyncMock = mock<(...a: unknown[]) => string>(() => "");
const __knextRealFsSpread = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const actual = __knextRealFsSpread;
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

const DIGEST_REF =
    "registry.example.com/my-app:v1@sha256:1111111111111111111111111111111111111111111111111111111111111111";

function argvOf(call: unknown[]): string[] {
    return (call[0] as string[]) ?? [];
}

function applied(): boolean {
    return runInherit.mock.calls.some(
        (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
    );
}

function dockerRan(): boolean {
    return runInherit.mock.calls.some((c) => argvOf(c)[0] === "docker");
}

/** The imageRef the CR was rendered with (arg[1]), for the NON-preflight call. */
function renderedImages(): string[] {
    return renderNextAppCR.mock.calls.map((c) => c[1] as string);
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
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue(
        "registry.example.com/my-app@sha256:deadbeef",
    );
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(baseConfig);
    readFileSyncMock.mockReturnValue("deploytag");
    verifyVinextStaticPrefix.mockReturnValue({ ok: true });
    // A pre-built-image deploy never has a KN_REGISTRY in scope unless a test sets it.
    delete process.env.KN_REGISTRY;
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy --image (pre-built image, #1063)", () => {
    it("--dry-run --image renders the CR with that EXACT image and runs NO docker/apply", async () => {
        setArgv([
            "deploy",
            "--dry-run",
            "--image",
            DIGEST_REF,
            "--tag",
            "deploytag",
        ]);
        const deploy = await importDeploy();

        await deploy();

        expect(renderedImages()).toContain(DIGEST_REF);
        expect(dockerRan()).toBe(false);
        expect(applied()).toBe(false);
        // The pre-built image is already digest-pinned, so no post-push digest
        // resolution runs. (`next build` is orthogonal — skipped via
        // --skip-build, not --image.)
        expect(resolveDigest).not.toHaveBeenCalled();
    });

    it("rejects a TAG-ONLY --image with the digest-pin (@sha256:) error, even in --dry-run", async () => {
        setArgv([
            "deploy",
            "--dry-run",
            "--image",
            "registry.example.com/my-app:v1",
            "--tag",
            "deploytag",
        ]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(/@sha256:/);
        // Nothing was rendered/applied for a rejected image.
        expect(applied()).toBe(false);
    });

    it("real deploy --image: applies the CR, skips docker build+push AND digest resolution", async () => {
        setArgv(["deploy", "--image", DIGEST_REF, "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        expect(applied()).toBe(true);
        expect(dockerRan()).toBe(false);
        expect(resolveDigest).not.toHaveBeenCalled();
        expect(renderedImages()).toContain(DIGEST_REF);
    });

    it("--image + --registry: --image wins, a warning names the ignored registry", async () => {
        setArgv([
            "deploy",
            "--dry-run",
            "--image",
            DIGEST_REF,
            "--registry",
            "other.example.com",
            "--tag",
            "deploytag",
        ]);
        const deploy = await importDeploy();

        await deploy();

        expect(renderedImages()).toContain(DIGEST_REF);
        const warnings = logWarn.mock.calls
            .map((call) => call.map((a) => JSON.stringify(a)).join(" "))
            .join("\n");
        expect(warnings).toContain("other.example.com");
    });

    it("--image --skip-upload stays orthogonal: no upload, still applies with the image", async () => {
        setArgv([
            "deploy",
            "--image",
            DIGEST_REF,
            "--skip-upload",
            "--tag",
            "deploytag",
        ]);
        const deploy = await importDeploy();

        await deploy();

        expect(uploadAssets).not.toHaveBeenCalled();
        expect(applied()).toBe(true);
        expect(dockerRan()).toBe(false);
        expect(renderedImages()).toContain(DIGEST_REF);
    });
});
