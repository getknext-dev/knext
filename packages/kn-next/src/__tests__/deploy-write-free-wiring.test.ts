/**
 * `knext deploy` → write-free facts → the rendered CR.
 *
 * `spec.security.writeFree` tells the operator to mount no writable volume,
 * so only the CLI that BUILT the image may assert it. This pins the wiring the
 * pure CR-builder tests cannot see:
 *
 *   - a deploy that builds passes `{ builtThisRun: true }` to the final CR
 *     render, with `imageCacheRouted` read back from THIS build's
 *     `.next/required-server-files.json` (trusted only when `.next/BUILD_ID`
 *     is the deploy tag);
 *   - `--skip-build` (and therefore `--image`) passes no facts at all, so the
 *     field can never be emitted for an image this run did not build;
 *   - the schema preflight renders the worst case (`imageCacheRouted: true`),
 *     so an operator CRD that predates the field is reported before any side
 *     effect rather than at the real apply.
 *
 * Harness shape copied from deploy-no-storage.test.ts (same mocks, same
 * reasons).
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

// Same reason as deploy-no-storage.test.ts: these mocks stand in for
// functions with many different return types, so the return must be `any`.
// biome-ignore lint/suspicious/noExplicitAny: the return must be `any`; see above
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

const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", async () => ({
    ...__knextReal1,
    uploadAssets: mock(async () => {}),
    getAssetPrefix: mock(() => "https://cdn.example.com/my-app"),
    reclaimBuildPrefix: mock(),
    verifyVinextStaticPrefix: mock(() => ({ ok: true })),
    verifyBuiltImageLockstep: mock(() => ({ ok: true })),
}));

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(async () => "reg/my-app@sha256:deadbeef");
mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: mock(),
}));

mock.module("../cli/build-artifact", () => ({
    compileArtifactForDeploy: () => ({ compiled: false }),
    assertCompiledArtifactFresh: () => {},
}));

mock.module("../cli/gc", () => ({
    runAssetGC: mock(() => ({ pruned: true })),
    gcMain: mock(),
}));

mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => reconciledNextAppCapture(),
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

const config: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
};

class MockUsageError extends Error {}
const __knextRealShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__knextRealShared,
    loadConfig: async () => config,
    excerpt: (s: string) => s,
    UsageError: MockUsageError,
    handleUsageError: () => false,
    handleConfigNotFound: () => false,
}));

/** `.next/required-server-files.json` as THIS build wrote it. */
let routedInBuild = false;
const fsRead = (p: unknown): string => {
    const path = String(p);
    if (path.endsWith("package.json")) return '{"type":"module"}';
    if (path.endsWith("required-server-files.json")) {
        return JSON.stringify({
            config: { images: { customCacheHandler: routedInBuild } },
        });
    }
    // `.next/BUILD_ID` and everything else: the deploy tag.
    return "deploytag";
};
const __knextReal2 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const overrides = {
        existsSync: __knextRealFs.existsSync,
        readFileSync: (...a: unknown[]) => fsRead(a[0]),
        writeFileSync: mock(),
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

async function runDeploy(flags: string[]): Promise<void> {
    process.argv = ["node", "/path/to/kn-next.js", "deploy", ...flags];
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    await mod.deploy();
}

/** The write-free facts (6th argument) of every renderNextAppCR call, in order. */
const factsPerRender = (): unknown[] =>
    renderNextAppCR.mock.calls.map((c) => c[5]);

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    jest.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue("reg/my-app@sha256:deadbeef");
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    routedInBuild = false;
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

describe("deploy → spec.security.writeFree facts", () => {
    it("a deploy that builds states it built the image, and reads the routing back from the build", async () => {
        routedInBuild = true;
        await runDeploy(["--tag", "deploytag"]);
        const facts = factsPerRender();
        // preflight render, then the applied render
        expect(facts.length).toBe(2);
        expect(facts.at(-1)).toEqual({
            builtThisRun: true,
            imageCacheRouted: true,
        });
    });

    it("a build that still writes images to disk is reported as not routed", async () => {
        routedInBuild = false;
        await runDeploy(["--tag", "deploytag"]);
        expect(factsPerRender().at(-1)).toEqual({
            builtThisRun: true,
            imageCacheRouted: false,
        });
    });

    it("--skip-build passes NO facts to the applied CR (the CLI did not build that image)", async () => {
        routedInBuild = true;
        await runDeploy(["--tag", "deploytag", "--skip-build"]);
        expect(factsPerRender().at(-1)).toBeUndefined();
    });

    it("the schema preflight renders the worst case, so an old CRD is caught before any side effect", async () => {
        await runDeploy(["--tag", "deploytag"]);
        expect(factsPerRender()[0]).toEqual({
            builtThisRun: true,
            imageCacheRouted: true,
        });
    });
});
