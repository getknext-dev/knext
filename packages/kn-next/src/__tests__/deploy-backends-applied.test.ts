/**
 * `knext deploy` carries the zone's function bindings (`backends` in the
 * config) into the NextApp it applies: the SAME file the schema preflight
 * dry-runs and `kubectl apply --validate=strict` sends, in that order. This is
 * the end of the chain the builder and validator tests do not reach.
 *
 * It uses the REAL `cr-builder` and the REAL config validation, and stubs only
 * the side-effecting seams (docker, kubectl, filesystem writes), same as
 * cr-apply-strict-validation.test.ts. What is applied is read back from the
 * bytes `deploy()` wrote and the argv it handed kubectl, not from a mock's
 * return value.
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { KnativeNextConfig } from "../config";
import { reconciledNextAppCapture } from "./helpers/reconciled-nextapp";

// biome-ignore lint/suspicious/noExplicitAny: the return must be `any` for bun's mock typing
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
const isEntrypoint = mock<AnyFn>(() => false);

// Resolved OUT HERE, before any `mock.module` registers (an `await import` in a
// mock factory deadlocks under bun; see cr-apply-strict-validation.test.ts).
const __knextRealShared = { ...(await import("../cli/shared")) };
const { createRequire: __knextCreateRequire } = await import("node:module");
const __knextRealFs = __knextCreateRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");
const __knextRealCrBuilder = {
    ...(await import("../cli/cr-builder")),
} as typeof import("../cli/cr-builder");

mock.module("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: mock(),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
}));

const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", async () => ({
    ...__knextReal1,
    uploadAssets: async () => {},
    getAssetPrefix: () => "https://cdn.example.com/_next",
    reclaimBuildPrefix: () => {},
    verifyVinextStaticPrefix: () => ({ ok: true }),
    verifyBuiltImageLockstep: () => ({ ok: true }),
}));

// The REAL renderer and validator; only the digest resolution (docker) is
// stubbed, exactly the seam the real one reaches through `runCapture`.
mock.module("../cli/cr-builder", () => ({
    ...__knextRealCrBuilder,
    resolveDigest: async () => "registry.example.com/my-app@sha256:deadbeef",
    validateCRImageRef: () => {},
}));

mock.module("../cli/build-artifact", () => ({
    compileArtifactForDeploy: () => ({ compiled: false }),
    assertCompiledArtifactFresh: () => {},
}));

// Preflight + post-apply reconcile poll both go through this boundary. The
// dry-run apply is recorded so ORDER can be asserted against the real apply.
const events: string[] = [];
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: (argv: string[]) => {
        if (argv.includes("apply")) events.push("preflight");
        return reconciledNextAppCapture();
    },
}));

mock.module("../cli/gc", () => ({
    runAssetGC: () => ({ pruned: true }),
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
    cache: {
        provider: "redis",
        url: "redis://redis:6379",
        keyPrefix: "my-app",
    },
    scaling: { minScale: 0, maxScale: 5 },
};

const loadConfig = mock<AnyFn>(async () => baseConfig);
mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    UsageError: class MockUsageError extends Error {},
}));

/** Every file `deploy()` wrote, by path, in write order. */
const written = new Map<string, string>();
const writeFileSyncMock = mock((path: unknown, data: unknown) => {
    written.set(String(path), String(data));
    if (String(path).endsWith(".yaml")) {
        events.push(
            String(path).includes("preflight") ? "write-preflight" : "write-cr",
        );
    }
});
const readFileSyncMock = mock<(...a: unknown[]) => string>((p: unknown) =>
    String(p).endsWith("package.json") ? '{"type":"module"}' : "deploytag",
);
const __knextReal2 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const overrides = {
        existsSync: __knextRealFs.existsSync,
        readFileSync: (...a: unknown[]) => readFileSyncMock(...(a as [string])),
        writeFileSync: (...a: unknown[]) =>
            writeFileSyncMock(...(a as [unknown, unknown])),
        mkdirSync: mock(),
        writeSync: mock(),
    };
    return {
        ...__knextReal2,
        ...overrides,
        default: {
            ...(__knextReal2 as { default?: object }).default,
            ...overrides,
        },
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

/** The parsed NextApp the real apply sent: the file named by its `-f`. */
function appliedNextApp(): {
    kind: string;
    spec: Record<string, unknown>;
} {
    const argv = applyArgv();
    if (!argv) throw new Error("deploy never ran kubectl apply");
    const file = argv[argv.indexOf("-f") + 1] as string;
    const yaml = written.get(file);
    if (yaml === undefined)
        throw new Error(`apply names ${file}, never written`);
    return YAML.parse(yaml);
}

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
    written.clear();
    events.length = 0;
    runCapture.mockReturnValue("");
    loadConfig.mockResolvedValue(baseConfig);
    process.argv = [
        "node",
        "/path/to/kn-next.js",
        "deploy",
        "--tag",
        "deploytag",
    ];
    readFileSyncMock.mockImplementation((p: unknown) =>
        String(p).endsWith("package.json") ? '{"type":"module"}' : "deploytag",
    );
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("knext deploy applies the zone's function bindings", () => {
    it("a configured function lands in the applied NextApp's spec.backends", async () => {
        loadConfig.mockResolvedValue({
            ...baseConfig,
            backends: [
                { name: "user-profile" },
                { name: "pricing", service: "price" },
            ],
        });
        const deploy = await importDeploy();
        await deploy();

        const applied = appliedNextApp();
        expect(applied.kind).toBe("NextApp");
        expect(applied.spec.backends).toEqual([
            { name: "user-profile", service: "user-profile" },
            { name: "pricing", service: "price" },
        ]);
    });

    it("the preflight dry-runs the same bindings, before the apply, under strict validation", async () => {
        loadConfig.mockResolvedValue({
            ...baseConfig,
            backends: [{ name: "user-profile" }],
        });
        const deploy = await importDeploy();
        await deploy();

        const preflight = YAML.parse(
            [...written].find(([p]) =>
                p.includes("nextapp-preflight-cr"),
            )?.[1] ?? "",
        ) as { spec: Record<string, unknown> };
        expect(preflight.spec.backends).toEqual([
            { name: "user-profile", service: "user-profile" },
        ]);
        // the cluster is touched for the first time by the dry-run, never the apply
        expect(events.indexOf("preflight")).toBeGreaterThanOrEqual(0);
        expect(events.indexOf("preflight")).toBeLessThan(
            events.indexOf("write-cr"),
        );
        // and the real apply is strict, exactly as for every other NextApp field
        expect(applyArgv()).toContain("--validate=strict");
    });

    it("writes only the NextApp: the one apply names the NextApp file and nothing else changes the cluster", async () => {
        loadConfig.mockResolvedValue({
            ...baseConfig,
            backends: [{ name: "user-profile" }],
        });
        const deploy = await importDeploy();
        await deploy();

        const applies = runInherit.mock.calls.filter(
            (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
        );
        expect(applies).toHaveLength(1);
        const forbidden = runInherit.mock.calls.filter((c) =>
            [
                "patch",
                "create",
                "delete",
                "label",
                "annotate",
                "replace",
            ].includes(argvOf(c)[1] as string),
        );
        expect(forbidden).toEqual([]);
        expect(JSON.stringify(appliedNextApp())).not.toContain(
            "BackendService",
        );
    });

    it("no backends configured: no field in the applied NextApp (an old operator is unaffected)", async () => {
        const deploy = await importDeploy();
        await deploy();

        const applied = appliedNextApp();
        expect(Object.keys(applied.spec)).not.toContain("backends");
        expect(
            [...written.values()].some((yaml) => yaml.includes("backends")),
        ).toBe(false);
    });

    it("an invalid name in the real config file is refused before anything is built, pushed or applied", async () => {
        // The REAL loadConfig (the one `deploy()` calls), reading a real
        // knext.config.ts: the validator runs inside it, so a stubbed loader
        // would prove nothing about the refusal.
        const dir = __knextRealFs.mkdtempSync(
            join(tmpdir(), "knext-backends-"),
        );
        const cwd = process.cwd();
        try {
            __knextRealFs.writeFileSync(
                join(dir, "knext.config.ts"),
                `export default ${JSON.stringify({
                    ...baseConfig,
                    backends: [{ name: "User_Profile" }],
                })};\n`,
            );
            process.chdir(dir);
            loadConfig.mockImplementation((...a: unknown[]) =>
                __knextRealShared.loadConfig(
                    ...(a as Parameters<typeof __knextRealShared.loadConfig>),
                ),
            );
            const deploy = await importDeploy();

            await expect(deploy()).rejects.toThrow(/backends\[0\]\.name/);
        } finally {
            process.chdir(cwd);
            __knextRealFs.rmSync(dir, { recursive: true, force: true });
        }
        expect(applyArgv()).toBeUndefined();
        expect(runInherit).not.toHaveBeenCalled();
        expect(written.size).toBe(0);
    });
});
