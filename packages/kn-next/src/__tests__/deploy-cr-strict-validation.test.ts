/**
 * The NextApp CR apply must ASSERT strict field validation — it must not
 * inherit it from whatever `kubectl` happens to be on the user's PATH.
 *
 * Empirically (live cluster, server-side dry-run against the structural CRD):
 *   - `kubectl apply --validate=strict` (kubectl's own default since 1.25)
 *     REJECTS an unknown field:
 *       Error from server (BadRequest): ... strict decoding error:
 *       unknown field "spec.template.spec.thisFieldDoesNotExistAnywhere"
 *   - `kubectl apply --validate=ignore` ACCEPTS it and the apiserver PRUNES it
 *     silently — for `spec.security.networkPolicy` that is a security
 *     invariant downgraded to a no-op while the CR still reports Ready=True.
 *
 * So the protection exists, but it was an EXTERNAL BINARY'S DEFAULT: it
 * disappears silently under an old kubectl, a shell alias, a kubectl config
 * default, or a wrapper that passes `--validate=ignore`. Passing the flag
 * explicitly makes the guarantee knext's.
 *
 * The argv assertion below is the regression guard that matters: the fix is
 * ONE WORD in an argv array and is trivially lost in a refactor.
 *
 * Hermetic — every side-effecting seam of deploy.ts is module-mocked (same
 * pattern as deploy-orchestrator.test.ts); no cluster, no docker, no build.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnativeNextConfig } from "../config";

type AnyFn = (...args: unknown[]) => unknown;

const runQuiet = vi.fn<AnyFn>();
const runInherit = vi.fn<AnyFn>();
const runCapture = vi.fn<AnyFn>(() => "");
const isEntrypoint = vi.fn<AnyFn>(() => false);

vi.mock("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: vi.fn(),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
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
const resolveDigest = vi.fn<AnyFn>(
    async () => "registry.example.com/my-app@sha256:deadbeef",
);
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

const loadConfig = vi.fn<AnyFn>(async () => baseConfig);
vi.mock("../cli/shared", () => ({
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
}));

const readFileSyncMock = vi.fn<(...a: unknown[]) => string>(() => "");
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

function argvOf(call: unknown[]): string[] {
    return (call[0] as string[]) ?? [];
}

/** The single mutating call: `kubectl apply …` of the NextApp CR. */
function applyArgv(): string[] | undefined {
    const call = runInherit.mock.calls.find(
        (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
    );
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
    vi.resetModules();
    vi.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue(
        "registry.example.com/my-app@sha256:deadbeef",
    );
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(baseConfig);
    readFileSyncMock.mockReturnValue("deploytag");
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("NextApp CR apply — asserted strict field validation", () => {
    it("passes --validate=strict explicitly on the kubectl apply argv", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = applyArgv();
        expect(argv, "the mutating kubectl apply must have run").toBeDefined();
        // THE regression guard: one word, trivially lost in a refactor.
        expect(argv).toContain("--validate=strict");
    });

    it("never weakens validation (no --validate=ignore/warn/false in the apply argv)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = applyArgv() ?? [];
        for (const weak of [
            "--validate=ignore",
            "--validate=warn",
            "--validate=false",
        ]) {
            expect(argv).not.toContain(weak);
        }
        // Exactly one --validate flag — a second one would silently win.
        expect(argv.filter((a) => a.startsWith("--validate")).length).toBe(1);
    });

    it("still applies the right file into the right namespace (the flag is additive)", async () => {
        setArgv(["deploy", "--tag", "deploytag", "--namespace", "prod"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = applyArgv() ?? [];
        expect(argv[0]).toBe("kubectl");
        expect(argv[1]).toBe("apply");
        expect(argv).toContain("-f");
        expect(argv[argv.indexOf("-f") + 1]).toMatch(/nextapp-cr\.yaml$/);
        expect(argv[argv.indexOf("-n") + 1]).toBe("prod");
    });
});

describe("NextApp CR apply — a rejected apply is never swallowed", () => {
    /** Make ONLY the `kubectl apply` leg fail, like a real strict rejection. */
    function failApplyWith(message: string): Error {
        const err = new Error(message);
        runInherit.mockImplementation((...a: unknown[]) => {
            const argv = a[0] as string[];
            if (argv?.[0] === "kubectl" && argv?.[1] === "apply") throw err;
        });
        return err;
    }

    it("fails loudly with an actionable message naming the likely cause (operator CRD older than the CLI)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        failApplyWith(
            'Command failed: kubectl apply -f nextapp-cr.yaml\nError from server (BadRequest): ... strict decoding error: unknown field "spec.security.networkPolicy"',
        );
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(
            /unknown field|strict decoding/i,
        );
        await expect(deploy()).rejects.toThrow(/older than this CLI/i);
        // Actionable: tells the user how to check the installed CRD.
        await expect(deploy()).rejects.toThrow(
            /kubectl get crd nextapps\.apps\.kn-next\.dev/,
        );
    });

    it("preserves the original kubectl error as `cause` (nothing is swallowed)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const original = failApplyWith("Command failed: kubectl apply ...");
        const deploy = await importDeploy();

        const caught = await deploy().then(
            () => undefined,
            (e: unknown) => e as Error,
        );
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error & { cause?: unknown }).cause).toBe(original);
    });

    it("does not reach the post-apply status read when the apply is rejected", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        failApplyWith("Command failed: kubectl apply ...");
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow();
        expect(
            runCapture.mock.calls.some(
                (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "get",
            ),
        ).toBe(false);
    });
});
