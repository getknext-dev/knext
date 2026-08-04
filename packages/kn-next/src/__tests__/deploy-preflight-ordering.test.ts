/**
 * T6 — ORDERING. The prune preflight runs before anything with a side effect.
 *
 * The defect this closes, verified before the fix: `uploadAssets` ran at
 * deploy.ts:332 and the CR apply at :500. Since #547 a skew-affected apply
 * hard-fails — AFTER the assets are already in the bucket, leaving an orphaned
 * `_next/static/<build-id>/` prefix for a build that never became a revision.
 * GC reclaims it eventually, so this is waste rather than corruption; the point
 * is that the user's first experience of the new hard failure was "it failed
 * *and* it wrote things."
 *
 * So the load-bearing assertion here is NOT "deploy exits non-zero" — that much
 * a warning-shaped implementation would also satisfy once. It is **the bucket
 * is unchanged**: nothing uploaded, nothing built, nothing pushed, nothing
 * applied. The fake bucket below exists so that clause cannot be quietly
 * dropped.
 *
 * Hermetic: the kubectl boundary is stubbed but the REAL preflight logic runs,
 * so this also covers the classification path end-to-end from deploy's side.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnativeNextConfig } from "../config";

type AnyFn = (...args: unknown[]) => unknown;

/** Everything with a side effect, in call order. */
const effects: string[] = [];
/** The fake bucket. If this is non-empty after a failed deploy, T6 has failed. */
const bucket: string[] = [];

const runQuiet = vi.fn<AnyFn>(() => {
    effects.push("next-build");
});
const runInherit = vi.fn<AnyFn>((argv: unknown) => {
    const a = argv as string[];
    effects.push(a[0] === "docker" ? "docker-build-push" : `${a[0]} ${a[1]}`);
});
/** `docker inspect` (digest resolution) and the post-apply status read. */
const runCapture = vi.fn<AnyFn>((argv: unknown) =>
    (argv as string[])[0] === "docker"
        ? `registry.example.com/my-app@sha256:${"a".repeat(64)}`
        : "",
);
const isEntrypoint = vi.fn<AnyFn>(() => false);

vi.mock("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: vi.fn(),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
}));

const uploadAssets = vi.fn<AnyFn>(async () => {
    effects.push("upload-assets");
    bucket.push("_next/static/deploytag/chunk.js");
});
const getAssetPrefix = vi.fn<AnyFn>(() => "https://cdn.example.com/_next");
const reclaimBuildPrefix = vi.fn<AnyFn>();

vi.mock("../utils/asset-upload", () => ({
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
}));

/** The kubectl boundary the preflight uses. Driven per-test. */
const kubectl = vi.fn<
    (argv: readonly string[]) => {
        ok: boolean;
        stdout: string;
        stderr: string;
    }
>(() => ({ ok: true, stdout: "", stderr: "" }));

vi.mock("../cli/schema/kubectl-capture", () => ({
    captureKubectl: (argv: readonly string[]) => {
        effects.push(
            `kubectl ${argv[1]}${argv.includes("--dry-run=server") ? " --dry-run=server" : ""}`,
        );
        return kubectl(argv);
    },
}));

vi.mock("../cli/gc", () => ({
    runAssetGC: vi.fn(() => ({ pruned: true })),
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
    database: {
        secretRef: { name: "app-db" },
        roSecretRef: { name: "app-db", key: "DATABASE_URL_RO" },
    },
    scaling: { minScale: 0, maxScale: 5 },
};

const loadConfig = vi.fn<AnyFn>(async () => baseConfig);
vi.mock("../cli/shared", () => ({
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
}));

const readFileSyncMock = vi.fn<(...a: unknown[]) => string>(() => "deploytag");
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    // #644: deploy now infers the docker build context from the real
    // filesystem (the lockfile walk in tracing-root.ts). Spreading
    // `importOriginal()` does NOT carry node-builtin named exports under
    // vitest, so every fs function the code touches must be listed here —
    // `existsSync` is passed through to the REAL one rather than stubbed, so
    // the walk still answers about the actual tree.
    const { createRequire } = await import("node:module");
    const realFs = createRequire(import.meta.url)(
        "node:fs",
    ) as typeof import("node:fs");
    const overrides = {
        existsSync: realFs.existsSync,
        // This suite also uses mkdtempSync itself (the lockfile-free cwd).
        mkdtempSync: realFs.mkdtempSync,
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

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

const savedArgv = process.argv;

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    effects.length = 0;
    bucket.length = 0;
    kubectl.mockReturnValue({ ok: true, stdout: "", stderr: "" });
    runCapture.mockImplementation((argv: unknown) =>
        (argv as string[])[0] === "docker"
            ? `registry.example.com/my-app@sha256:${"a".repeat(64)}`
            : "",
    );
    loadConfig.mockResolvedValue(baseConfig);
    readFileSyncMock.mockReturnValue("deploytag");
});

afterEach(() => {
    process.argv = savedArgv;
});

/** A CRD that does not know `spec.database.roSecretRef` — the named case. */
function skewInducingCluster(): void {
    kubectl.mockImplementation((argv) => {
        if (argv[1] === "apply") {
            return {
                ok: false,
                stdout: "",
                stderr:
                    'Error from server (BadRequest): error when creating "nextapp-cr.yaml": ' +
                    'NextApp in version "v1alpha1" cannot be handled as a NextApp: ' +
                    'strict decoding error: unknown field "spec.database.roSecretRef"',
            };
        }
        // Both schema reads denied — the restricted-kubeconfig case. The
        // verdict must not soften.
        return {
            ok: false,
            stdout: "",
            stderr: 'Error from server (Forbidden): forbidden: User "u" cannot get',
        };
    });
}

describe("deploy — the preflight is the first cluster call and precedes every side effect", () => {
    it("runs the server-side dry run BEFORE next build, the upload and the push", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        expect(effects[0]).toBe("kubectl apply --dry-run=server");
        expect(effects.indexOf("kubectl apply --dry-run=server")).toBeLessThan(
            effects.indexOf("upload-assets"),
        );
        expect(effects.indexOf("kubectl apply --dry-run=server")).toBeLessThan(
            effects.indexOf("next-build"),
        );
        // …and the real apply still happens afterwards.
        expect(effects).toContain("kubectl apply");
    });

    it("a skew-inducing CRD makes deploy exit non-zero AND leaves the bucket unchanged", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        skewInducingCluster();
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(/spec\.database\.roSecretRef/);

        // THE clause that is easy to omit, and the whole point of the ordering.
        expect(bucket).toEqual([]);
        expect(uploadAssets).not.toHaveBeenCalled();
        expect(runQuiet).not.toHaveBeenCalled(); // no `next build`
        expect(runInherit).not.toHaveBeenCalled(); // no docker build/push, no apply
        expect(reclaimBuildPrefix).not.toHaveBeenCalled(); // nothing to reclaim
    });

    it("names the field even when BOTH schema reads are denied (restricted kubeconfig)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        skewInducingCluster();
        const deploy = await importDeploy();

        const err = await deploy().then(
            () => undefined,
            (e: unknown) => e as Error,
        );
        expect(err?.message).toMatch(/spec\.database\.roSecretRef/);
        expect(err?.message).toMatch(/DATABASE_URL_RO/);
        // Hard failure, not a warning: the deploy did not proceed.
        expect(bucket).toEqual([]);
    });

    it("an RBAC-denied preflight is a hard failure, not a shrug", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        kubectl.mockReturnValue({
            ok: false,
            stdout: "",
            stderr:
                "Error from server (Forbidden): nextapps.apps.kn-next.dev is forbidden: " +
                'User "u" cannot create resource "nextapps" in the namespace "default"',
        });
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(/PREFLIGHT FAILED/);
        expect(bucket).toEqual([]);
    });

    it("--dry-run touches the cluster not at all", async () => {
        setArgv(["deploy", "--tag", "deploytag", "--dry-run"]);
        const deploy = await importDeploy();
        await deploy();

        expect(kubectl).not.toHaveBeenCalled();
        expect(bucket).toEqual([]);
    });
});

/**
 * #644 — the build-context resolution belongs in the SAME preflight phase.
 *
 * "Is there a lockfile above me?" is answerable at t=0, from the filesystem,
 * with no cluster and no build. Resolving it inside the docker task — after
 * `next build` has run and while the asset upload is already in flight — costs
 * the user a full build to learn a fact we had before we started, and on
 * `--skip-build`/split-stage CI it can leave exactly the orphaned
 * `_next/static/<id>/` prefix the block comment above exists to avoid.
 *
 * The real `requireBuildContext` runs here (no stub): the test moves cwd into a
 * lockfile-free temp directory, which is the genuine failing condition.
 */
describe("deploy — an unresolvable build context fails in preflight, before any side effect", () => {
    const savedCwd = process.cwd();
    let lockfileFreeDir: string;

    beforeEach(() => {
        // mkdtemp under the OS temp dir: no lockfile in it or above it.
        lockfileFreeDir = mkdtempSync(join(tmpdir(), "knext-no-lock-"));
        process.chdir(lockfileFreeDir);
    });

    afterEach(() => {
        process.chdir(savedCwd);
    });

    it("throws before next build, the upload, the push and the apply", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(/lockfile/i);

        expect(effects).toEqual([]);
        expect(bucket).toEqual([]);
        expect(runQuiet).not.toHaveBeenCalled(); // no `next build`
        expect(uploadAssets).not.toHaveBeenCalled();
        expect(runInherit).not.toHaveBeenCalled(); // no docker build/push
        expect(reclaimBuildPrefix).not.toHaveBeenCalled();
    });

    it("--skip-build fails the same way (the split-stage CI case)", async () => {
        // The leg where deferring the check is worst: nothing to rebuild, so
        // the first thing that happens is the upload.
        setArgv(["deploy", "--tag", "deploytag", "--skip-build"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(/lockfile/i);
        expect(bucket).toEqual([]);
        expect(uploadAssets).not.toHaveBeenCalled();
    });
});
