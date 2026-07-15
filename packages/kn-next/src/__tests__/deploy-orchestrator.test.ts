/**
 * v5-P4 — deploy() orchestrator branch/safety tests.
 *
 * `deploy()` in cli/deploy.ts is the CLUSTER-MUTATING path (it ends in a
 * `kubectl apply -f` of the NextApp CR). CLAUDE.md §9 flags core build/deploy
 * paths as thin on coverage; this suite pins the orchestrator's failure and
 * skip branches HERMETICALLY — no live cluster, no docker, no next build —
 * by module-mocking the side-effecting seams:
 *
 *   - ./exec          → runQuiet / runInherit / runCapture (build, apply, gets)
 *   - ../utils/asset-upload → uploadAssets / getAssetPrefix
 *   - ./cr-builder    → renderNextAppCR / resolveDigest / validateCRImageRef
 *   - ./gc            → runAssetGC (best-effort post-deploy GC)
 *   - ./shared        → loadConfig
 *   - node:fs         → readFileSync (the .next/BUILD_ID skew guard reads this)
 *
 * We assert OBSERVABLE behavior and CALL ORDER, not internal call shapes.
 *
 * Invariants pinned:
 *  1. Happy path ORDER: next build → upload assets → kubectl apply, in that
 *     sequence.
 *  2. Skew guard (ADR-0011 / #93): a `.next/BUILD_ID` that != the deploy tag
 *     THROWS and aborts BEFORE the mutating apply; a MISSING BUILD_ID (ENOENT)
 *     WARNS and PROCEEDS to apply.
 *  3. --dry-run: the mutating `kubectl apply` is NEVER reached (load-bearing
 *     safety invariant — dry-run must not mutate the cluster).
 *  4. --skip-build / --skip-upload: those steps are observably skipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnativeNextConfig } from "../config";

// ---------------------------------------------------------------------------
// Module mocks for every side-effecting seam. deploy.ts imports these by name;
// vi.mock replaces them BEFORE deploy.ts is (dynamically) imported per test.
// ---------------------------------------------------------------------------

// Every spy is typed with an explicit variadic signature so the thin factory
// wrappers below can spread `...a` into them without a tuple-type TS error.
type AnyFn = (...args: unknown[]) => unknown;

const runQuiet = vi.fn<AnyFn>();
const runInherit = vi.fn<AnyFn>();
const runCapture = vi.fn<AnyFn>(() => "");
const isEntrypoint = vi.fn<AnyFn>(() => false); // never fire the CLI self-entry block under vitest

vi.mock("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: vi.fn(),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
}));

const uploadAssets = vi.fn<AnyFn>(async () => {});
const getAssetPrefix = vi.fn<AnyFn>(() => "https://cdn.example.com/_next");

vi.mock("../utils/asset-upload", () => ({
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
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

// node:fs is mocked so the skew guard's readFileSync(.next/BUILD_ID) is
// controllable. writeFileSync/mkdirSync are stubbed so a real apply-branch run
// doesn't touch disk. readFileSync default: return the deploy tag (match).
// deploy.ts uses NAMED imports (`import { readFileSync, writeSync }`), so the
// named overrides below are what it actually binds to. We ALSO expose a matching
// `default` (spread of the real default + the same overrides) so the mock stays
// correct if deploy.ts ever switches to a default `import fs from "node:fs"` —
// belt-and-suspenders, no behavior change to the current named-import path.
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

// ---------------------------------------------------------------------------
// A tiny ordered call log so we can assert the happy-path SEQUENCE across the
// different seams (build vs upload vs apply).
// ---------------------------------------------------------------------------
let order: string[];

function argvOf(call: unknown[]): string[] {
    return (call[0] as string[]) ?? [];
}

/**
 * Import a FRESH copy of deploy.ts (resetModules first) so the top-level
 * isEntrypoint guard re-evaluates against our mock and module state is clean.
 * Returns the module's exported deploy().
 */
async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

/** Set process.argv to a `kn-next deploy` invocation with the given flags. */
function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    order = [];

    // Default seam behaviors + order tagging.
    runQuiet.mockImplementation((...a: unknown[]) => {
        // `npm run build`
        const argv = a[0] as string[];
        if (argv?.includes("build")) order.push("build");
    });
    runInherit.mockImplementation((...a: unknown[]) => {
        const argv = a[0] as string[];
        if (argv?.[0] === "kubectl" && argv?.[1] === "apply")
            order.push("apply");
        if (argv?.[0] === "docker") order.push("docker");
    });
    runCapture.mockReturnValue("");
    uploadAssets.mockImplementation(async () => {
        order.push("upload");
    });
    resolveDigest.mockResolvedValue(
        "registry.example.com/my-app@sha256:deadbeef",
    );
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(baseConfig);
    // Skew guard reads .next/BUILD_ID — default: match the tag we pass.
    readFileSyncMock.mockReturnValue("deploytag");
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy() happy-path ordering", () => {
    it("runs next build → upload assets → kubectl apply IN THAT ORDER", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        // The mutating apply must have happened.
        expect(
            runInherit.mock.calls.some(
                (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
            ),
        ).toBe(true);

        // ORDER: build before upload, upload before apply.
        const iBuild = order.indexOf("build");
        const iUpload = order.indexOf("upload");
        const iApply = order.indexOf("apply");
        expect(iBuild).toBeGreaterThanOrEqual(0);
        expect(iUpload).toBeGreaterThanOrEqual(0);
        expect(iApply).toBeGreaterThanOrEqual(0);
        expect(iBuild).toBeLessThan(iUpload);
        expect(iUpload).toBeLessThan(iApply);
    });

    it("digest-pins the CR image ref (validateCRImageRef called) before apply", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();
        expect(resolveDigest).toHaveBeenCalledTimes(1);
        expect(validateCRImageRef).toHaveBeenCalledTimes(1);
    });
});

describe("deploy() skew guard (ADR-0011 / #93)", () => {
    it("THROWS and aborts BEFORE apply when .next/BUILD_ID != deploy tag", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        // BUILD_ID on disk is a different (random) id → mismatch.
        readFileSyncMock.mockReturnValue("some-random-nanoid");

        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(/BUILD_ID/);

        // The mutating apply must NEVER have run.
        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(false);
    });

    it("WARNS and PROCEEDS to apply when .next/BUILD_ID is MISSING (ENOENT)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        // Simulate a missing file: readFileSync throws ENOENT.
        readFileSyncMock.mockImplementation(() => {
            const err = new Error(
                "ENOENT: no such file",
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
        });

        const deploy = await importDeploy();

        // ENOENT is swallowed (warn) — deploy continues to the apply.
        await expect(deploy()).resolves.toBeUndefined();

        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(true);
    });
});

describe("deploy() --dry-run safety (no cluster mutation)", () => {
    it("NEVER reaches the mutating kubectl apply in --dry-run", async () => {
        setArgv(["deploy", "--dry-run", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        // The load-bearing invariant: no kubectl apply in dry-run.
        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(false);
    });

    it("--dry-run also skips upload + docker push (no side effects)", async () => {
        setArgv(["deploy", "--dry-run", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        expect(uploadAssets).not.toHaveBeenCalled();
        // No docker build/push either.
        expect(
            runInherit.mock.calls.some((c) => argvOf(c)[0] === "docker"),
        ).toBe(false);
    });
});

describe("deploy() skip flags", () => {
    it("--skip-build does NOT run next build (and never reads BUILD_ID)", async () => {
        setArgv(["deploy", "--skip-build", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        // No `npm run build`.
        expect(
            runQuiet.mock.calls.some((c) => argvOf(c).includes("build")),
        ).toBe(false);
        // Skew guard is inside the build branch → BUILD_ID never read.
        expect(readFileSyncMock).not.toHaveBeenCalled();
    });

    it("--skip-upload does NOT upload assets, but still applies the CR", async () => {
        setArgv(["deploy", "--skip-upload", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await deploy();

        expect(uploadAssets).not.toHaveBeenCalled();
        const applied = runInherit.mock.calls.some(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applied).toBe(true);
    });
});
