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
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
// `createRequire` and the REAL `node:fs` are resolved OUT HERE, not inside the
const __knextRealShared = { ...(await import("../cli/shared")) };

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
        // T2a: this suite mocks the BUILD, so there is no `.output`, and these
        // deploys DO upload — which puts the vinext lock-step guard in scope. It
        // would abort every case here for a reason unrelated to what is under
        // test, so state that the artifact was built under this deploy's tag. The
        // guard's own branches are exercised in deploy-orchestrator.test.ts, and
        // its out-of-scope modes in deploy-no-storage.test.ts.
        verifyVinextStaticPrefix: () => ({ ok: true }),
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

// REAL shared module (real UsageError/USAGE_ERROR_CODE, so the thrown error's
// friendly-path discriminator is the one the dispatcher actually checks) —
// only config loading is a seam.
const loadConfig = (() => mock())();
const __knextReal2 = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    // bun replaces a mocked module WHOLESALE — no partial mock, no
    // automock — so a factory listing only what the test drives drops
    // every other export and the importer dies naming the CONSUMER, not
    // this factory. Spreading keeps it honest as `../cli/shared` grows.
    ...__knextRealShared,
    ...__knextReal2,
    loadConfig,
}));

const readFileSyncMock = mock<(...a: unknown[]) => string>(() => "deploytag");
const __knextReal3 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const actual = __knextReal3;
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
    // No `resetModules()`: everything this file varies goes through the mocks
    // cleared on the next line and the fixtures set below. bun has no registry
    // reset, and the deploy path holds no module state of its own — it reads
    // config and calls injected collaborators.
    jest.clearAllMocks();
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
