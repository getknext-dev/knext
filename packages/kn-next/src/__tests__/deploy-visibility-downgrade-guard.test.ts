/**
 * #1865 (review round 2) — the fail-open fix.
 *
 * `--private` is a per-INVOCATION override, not a persistent setting. A
 * later plain `knext deploy` (no `--private`, and a config that never set
 * `networking.visibility`) renders a CR with no `spec.networking` at all,
 * and `kubectl apply` removes a field it previously applied when the new
 * manifest omits it — so without a guard, a private app would silently
 * become PUBLIC on the next ordinary redeploy.
 *
 * This suite proves the round-trip through the REAL `deploy()` orchestrator
 * (mirrors deploy-overrides.test.ts's hermetic harness — no live cluster, no
 * docker, no next build):
 *  1. `--private` deploys a brand-new app (live NextApp not found) without
 *     the guard ever blocking it.
 *  2. A later PLAIN redeploy (no flags) against a LIVE app that is currently
 *     cluster-local REFUSES, with a message naming `--public`.
 *  3. The SAME plain redeploy with `--public` succeeds despite the live app
 *     being cluster-local.
 *  4. A fresh app (live NextApp not found) is never blocked, even with no
 *     `--private`/`--public` — there is nothing to protect yet.
 *  5. A live-read failure for a reason OTHER than "not found" (RBAC/network)
 *     FAILS CLOSED — the deploy aborts rather than risking a silent
 *     downgrade.
 *
 * `captureKubectl` is a CONTROLLABLE mock here (unlike deploy-overrides.test.ts's
 * fixed factory), because this suite needs to vary what "the live NextApp"
 * looks like per test and, within one `deploy()` call, across its THREE
 * distinct call sites in order: the prune preflight's server-side dry-run
 * apply (cares only about `.ok`), this guard's `kubectl get nextapp -o json`,
 * and the post-apply reconcile-wait poll (needs a RECONCILED shape or it
 * polls for real wall-clock seconds before giving up).
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

// THE CONTROLLABLE SEAM (unlike deploy-overrides.test.ts's fixed factory).
const captureKubectl = mock<AnyFn>();
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: (...a: unknown[]) => captureKubectl(...a),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));
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

/** `ok:true`, reconciled, no networking field — the "benign" default. */
function okReconciled(): { ok: true; stdout: string; stderr: string } {
    return {
        ok: true,
        stdout: JSON.stringify({
            metadata: { generation: 1 },
            status: {
                conditions: [
                    { type: "Ready", status: "True", observedGeneration: 1 },
                ],
            },
        }),
        stderr: "",
    };
}

/** `ok:true`, reconciled, LIVE app is currently cluster-local. */
function okReconciledPrivate(): { ok: true; stdout: string; stderr: string } {
    return {
        ok: true,
        stdout: JSON.stringify({
            metadata: { generation: 1 },
            status: {
                conditions: [
                    { type: "Ready", status: "True", observedGeneration: 1 },
                ],
            },
            spec: { networking: { visibility: "cluster-local" } },
        }),
        stderr: "",
    };
}

function notFound(): { ok: false; stdout: string; stderr: string } {
    return {
        ok: false,
        stdout: "",
        stderr: 'Error from server (NotFound): nextapps.apps.kn-next.dev "my-app" not found',
    };
}

function rbacFailure(): { ok: false; stdout: string; stderr: string } {
    return {
        ok: false,
        stdout: "",
        stderr: "Error from server (Forbidden): nextapps.apps.kn-next.dev is forbidden",
    };
}

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

describe("deploy() visibility downgrade guard (#1865)", () => {
    it("--private deploys a brand-new app (live NextApp not found) without the guard blocking it", async () => {
        // call 1: prune preflight dry-run apply (cares only about .ok)
        // call 2+: reconcile-wait poll — the guard never calls captureKubectl
        // at all here, because --private makes willBeClusterLocal true.
        captureKubectl
            .mockReturnValueOnce(okReconciled())
            .mockReturnValue(okReconciled());

        setArgv(["deploy", "--tag", "deploytag", "--private"]);
        const deploy = await importDeploy();
        await expect(deploy()).resolves.toBeUndefined();
    });

    it("a plain redeploy (no flags) against a LIVE cluster-local app REFUSES, naming --public", async () => {
        captureKubectl
            .mockReturnValueOnce(okReconciled()) // prune preflight
            .mockReturnValueOnce(okReconciledPrivate()); // this guard's live read

        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(/--public/);
        // The refusal must happen BEFORE the real apply — runInherit (the
        // `kubectl apply`) must never have been called.
        expect(runInherit).not.toHaveBeenCalledWith(
            expect.arrayContaining(["apply"]),
        );
    });

    it("the SAME plain redeploy succeeds with --public despite the live app being cluster-local", async () => {
        // --public makes explicitPublic true, so the guard never reads live
        // state either — same call shape as the --private case.
        captureKubectl
            .mockReturnValueOnce(okReconciled())
            .mockReturnValue(okReconciled());

        setArgv(["deploy", "--tag", "deploytag", "--public"]);
        const deploy = await importDeploy();
        await expect(deploy()).resolves.toBeUndefined();

        const cfg = renderNextAppCR.mock.calls.at(-1)?.[0] as KnativeNextConfig;
        expect(cfg.networking?.visibility).toBe("public");
    });

    it("a fresh app (live NextApp not found) is never blocked, even with no --private/--public", async () => {
        captureKubectl
            .mockReturnValueOnce(okReconciled()) // prune preflight
            .mockReturnValueOnce(notFound()) // this guard's live read
            .mockReturnValue(okReconciled()); // reconcile-wait

        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).resolves.toBeUndefined();
    });

    it("a live-read failure for a reason OTHER than not-found FAILS CLOSED", async () => {
        captureKubectl
            .mockReturnValueOnce(okReconciled()) // prune preflight
            .mockReturnValueOnce(rbacFailure()); // this guard's live read

        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(/failing closed|Forbidden/i);
        expect(runInherit).not.toHaveBeenCalledWith(
            expect.arrayContaining(["apply"]),
        );
    });

    it("--private and --public together are rejected as a usage error", async () => {
        setArgv(["deploy", "--tag", "deploytag", "--private", "--public"]);
        const deploy = await importDeploy();
        await expect(deploy()).rejects.toThrow(/cannot both be set/);
    });
});
