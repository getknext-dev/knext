/**
 * #1233 (coverage batch B2) — deploy.ts diagnostics no existing test drove:
 *
 *   - `applyOverrides`: `--bucket` with no `storage` block in the loaded
 *     config throws a UsageError explaining the mismatch (ADR-0047).
 *   - `describeFailedCRApply` / `localKubectlTooOldForStrict`: the two
 *     messages a failed `kubectl apply -f <CR>` can surface — the local
 *     client being too old for `--validate=strict` (pre-1.25, established
 *     from `kubectl version --client -o json`), and the generic
 *     differential when the local client is NOT the cause.
 *
 * Same hermetic seam set as `deploy-orchestrator.test.ts` (this file needs
 * the full pipeline to reach the mutating `kubectl apply` for the second
 * group) — `./exec`, `../utils/asset-upload`, `./cr-builder`,
 * `./runtime-image`, `./gc`, `./schema/kubectl-capture`, `../cli/shared`,
 * `node:fs`. `./doctor` is left REAL: `parseKubectlClientVersion` /
 * `supportsStrictValidation` are pure parsers over `runCapture`'s stdout, so
 * driving them through the real module (rather than re-stubbing their logic)
 * is what proves the two messages agree with what doctor.ts actually parses.
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

// biome-ignore lint/suspicious/noExplicitAny: see deploy-orchestrator.test.ts's identical note
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

const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    ...__knextReal1,
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
    verifyVinextStaticPrefix: (...a: unknown[]) =>
        verifyVinextStaticPrefix(...a),
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

mock.module("../cli/runtime-image", () => ({
    selectRuntimeImage: (
        config: { build?: string; runtime?: string },
        cwd: string,
    ) =>
        (config.build ?? "vinext") === "vinext"
            ? { kind: "app-dockerfile", dockerfile: `${cwd}/Dockerfile` }
            : {
                  kind: "standalone",
                  dockerfile: `${cwd}/Dockerfile.standalone`,
                  target:
                      config.runtime === "bun"
                          ? "standalone-bun"
                          : "standalone-node",
              },
    stageStandaloneBuildContext: () => ({ dockerfile: "" }),
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

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "my-bucket",
        publicUrl: "https://storage.googleapis.com/my-bucket",
    },
    scaling: { minScale: 0, maxScale: 5 },
};

const loadConfig = mock<AnyFn>(async () => baseConfig);
const __knextRealShared = { ...(await import("../cli/shared")) };

mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
}));

const pkgOr = (fallback: string) => (p: unknown) =>
    String(p).endsWith("package.json") ? '{"type":"module"}' : fallback;
const readFileSyncMock = mock<(...a: unknown[]) => string>(pkgOr(""));
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
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy() applyOverrides — --bucket with no storage block (ADR-0047)", () => {
    it("throws a UsageError naming --bucket and the missing storage block", async () => {
        loadConfig.mockResolvedValue({
            name: "my-app",
            registry: "registry.example.com",
            scaling: { minScale: 0, maxScale: 5 },
        } as KnativeNextConfig);
        setArgv([
            "deploy",
            "--tag",
            "deploytag",
            "--bucket",
            "override-bucket",
        ]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(
            /--bucket overrides storage\.bucket, but kn-next\.config\.ts has no `storage` block/,
        );
    });
});

describe("deploy() — failed kubectl apply diagnostics (describeFailedCRApply)", () => {
    function argv(call: unknown[]): string[] {
        return (call[0] as string[]) ?? [];
    }

    beforeEach(() => {
        // Drive the pipeline all the way to the mutating apply: build/push/
        // upload all succeed, and the apply call specifically throws.
        runInherit.mockImplementation((...a: unknown[]) => {
            const a0 = argv(a);
            if (a0[0] === "kubectl" && a0[1] === "apply") {
                throw new Error("connection refused");
            }
        });
    });

    it("names the local kubectl client and pre-1.25 --validate semantics when it IS the cause", async () => {
        runCapture.mockImplementation((...a: unknown[]) => {
            const a0 = argv(a);
            if (a0[0] === "kubectl" && a0[1] === "version") {
                return JSON.stringify({
                    clientVersion: { gitVersion: "v1.24.9" },
                });
            }
            return "";
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        let thrown: Error | undefined;
        try {
            await deploy();
        } catch (e) {
            thrown = e as Error;
        }
        expect(thrown?.message).toMatch(
            /your kubectl client \(v1\.24\.9\) is\s*older than v1\.25/,
        );
        expect(thrown?.message).toContain("kubectl version --client");
        expect(thrown?.message).toContain("kn-next doctor");
    });

    it("gives the generic differential (not a client-age claim) when the local client IS current", async () => {
        runCapture.mockImplementation((...a: unknown[]) => {
            const a0 = argv(a);
            if (a0[0] === "kubectl" && a0[1] === "version") {
                return JSON.stringify({
                    clientVersion: { gitVersion: "v1.31.0" },
                });
            }
            return "";
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        let thrown: Error | undefined;
        try {
            await deploy();
        } catch (e) {
            thrown = e as Error;
        }
        expect(thrown?.message).toContain(
            "kubectl apply of the NextApp CR FAILED (kubectl's own error is printed above",
        );
        expect(thrown?.message).toContain(
            "is older than this CLI and does not know that field",
        );
    });

    it("gives the generic differential when the local kubectl version cannot be parsed at all", async () => {
        runCapture.mockImplementation((...a: unknown[]) => {
            const a0 = argv(a);
            if (a0[0] === "kubectl" && a0[1] === "version") {
                return "not-json";
            }
            return "";
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(
            /kubectl apply of the NextApp CR FAILED \(kubectl's own error is printed above/,
        );
    });

    it("gives the generic differential when the kubectl-version PROBE ITSELF throws (a probe that cannot run must not replace the real error)", async () => {
        runCapture.mockImplementation((...a: unknown[]) => {
            const a0 = argv(a);
            if (a0[0] === "kubectl" && a0[1] === "version") {
                throw new Error("ENOENT: kubectl not found");
            }
            return "";
        });
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(
            /kubectl apply of the NextApp CR FAILED \(kubectl's own error is printed above/,
        );
    });
});
