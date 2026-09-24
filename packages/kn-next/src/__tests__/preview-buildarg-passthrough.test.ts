/**
 * preview-buildarg-passthrough — #1273 round 2.
 *
 * The #1273 fix threads `healthCheckPath`/`bakesCompileCache` from `config` and
 * `selectRuntimeImage`'s result into `dockerBuildxArgs` at `preview.ts:404-405`.
 * `deploy-orchestrator.test.ts` and the standalone/vinext-node docker-e2e suites
 * cover `deploy.ts`'s equivalent lines and `dockerBuildxArgs` in isolation, but
 * NOTHING exercised `preview.ts`'s own passthrough against the REAL
 * `selectRuntimeImage`/`dockerBuildxArgs` — deleting either `preview.ts` line
 * would stay green everywhere else, silently re-breaking the health-path fix
 * for previews specifically.
 *
 * This suite calls `defaultBuildAndPush` (exported for exactly this reason)
 * DIRECTLY, with the REAL `../cli/runtime-image` module (only
 * `stageStandaloneBuildContext` stubbed, since it writes real files — the pure
 * `selectRuntimeImage`/`dockerBuildxArgs` run for real) and every other
 * side-effecting seam (`runInherit`, `runCapture`, `resolveDigest`,
 * `runProjectBuild`, `requireBuildContext`) mocked. It asserts the captured
 * `docker buildx build` argv contains `--build-arg
 * KNEXT_HEALTH_CHECK_PATH=<configured>` for BOTH image shapes that bake a
 * compile cache: vinext-node (`build:'vinext', runtime:'node'`) and
 * standalone-node (`build:'turbopack', runtime:'node'`).
 *
 * MUTATION-PROVEN (not committed, per workflow.md — verified locally): deleting
 * `bakesCompileCache: selection.bakesCompileCache,` at preview.ts:405, or
 * `healthCheckPath: config.healthCheckPath,` at preview.ts:404, each turns this
 * suite red (no `--build-arg` in the captured argv) while every other suite in
 * the repo stays green.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: thin mock factory plumbing
type AnyFn = (...args: unknown[]) => any;

const __knextRealExec = { ...(await import("../cli/exec")) };
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
const isEntrypoint = mock<AnyFn>(() => false);
mock.module("../cli/exec", () => ({
    ...__knextRealExec,
    runQuiet: mock(),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
}));

const __knextRealProjectBuild = { ...(await import("../cli/project-build")) };
const runProjectBuild = mock<AnyFn>();
mock.module("../cli/project-build", () => ({
    ...__knextRealProjectBuild,
    runProjectBuild: (...a: unknown[]) => runProjectBuild(...a),
}));

// Real fs walk from a test process's cwd is not the app root this function
// assumes — stub the resolved build context to a fixed throwaway path. Spread
// the real module (same import-before-mock discipline as runtime-image below)
// so every OTHER named export (LOCKFILES, findTracingRoot, ...) stays intact
// for any other consumer transitively pulled in by ../cli/preview.
const __knextRealTracingRoot = { ...(await import("../cli/tracing-root")) };
const requireBuildContext = mock<AnyFn>(() => "/throwaway/build-context");
mock.module("../cli/tracing-root", () => ({
    ...__knextRealTracingRoot,
    requireBuildContext: (...a: unknown[]) => requireBuildContext(...a),
}));

const __knextRealCrBuilder = { ...(await import("../cli/cr-builder")) };
const resolveDigest = mock<AnyFn>(
    async () => "registry.example.com/preview-app@sha256:deadbeef",
);
mock.module("../cli/cr-builder", () => ({
    ...__knextRealCrBuilder,
    renderNextAppCR: mock(),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: mock(),
}));

// #1339 review finding #1: `defaultBuildAndPush` now compiles the
// standalone-bun/vinext executable via this shared step — stub it, same
// treatment as every other side-effecting seam here, so this suite stays
// about `dockerBuildxArgs`'s real build-arg passthrough. Named (not inline)
// so the wiring test below can assert it was actually called.
const compileArtifactForDeploy = mock<AnyFn>(() => ({ compiled: false }));
mock.module("../cli/build-artifact", () => ({
    compileArtifactForDeploy: (...a: unknown[]) =>
        compileArtifactForDeploy(...a),
    assertCompiledArtifactFresh: () => {},
}));

// The ONLY runtime-image seam stubbed is the file-writing one
// (`stageStandaloneBuildContext`). `selectRuntimeImage` and `dockerBuildxArgs`
// are left REAL — that is the entire point of this suite.
//
// The real module must be `import()`ed BEFORE `mock.module` registers the
// replacement, not inside the factory: an `await import(...)` inside a
// `mock.module` factory deadlocks under bun (the mock is already registered
// when the factory runs, so the import re-enters module resolution and waits
// on itself) — same discipline as deploy-orchestrator.test.ts's node:fs mock.
const __knextRealRuntimeImage = { ...(await import("../cli/runtime-image")) };
mock.module("../cli/runtime-image", () => ({
    ...__knextRealRuntimeImage,
    stageStandaloneBuildContext: () => ({ dockerfile: "" }),
}));

function argvOf(call: unknown[]): string[] {
    return (call[0] as string[]) ?? [];
}

function dockerArgv(): string[] | undefined {
    const call = runInherit.mock.calls.find((c) => argvOf(c)[0] === "docker");
    return call ? argvOf(call) : undefined;
}

beforeEach(() => {
    jest.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue(
        "registry.example.com/preview-app@sha256:deadbeef",
    );
    runProjectBuild.mockImplementation(() => {});
    requireBuildContext.mockReturnValue("/throwaway/build-context");
    delete process.env.NEXT_DEPLOYMENT_ID;
    delete process.env.ASSET_PREFIX;
});

const baseConfig: KnativeNextConfig = {
    name: "acme",
    registry: "registry.example.com/acme",
    healthCheckPath: "/healthz",
};

describe("preview.ts defaultBuildAndPush — the real dockerBuildxArgs call, both bake shapes (#1273)", () => {
    it("vinext-node (build:'vinext', runtime:'node') passes --build-arg KNEXT_HEALTH_CHECK_PATH=<configured>", async () => {
        const { defaultBuildAndPush } = await import("../cli/preview");
        const config: KnativeNextConfig = {
            ...baseConfig,
            build: "vinext",
            runtime: "node",
        };
        await defaultBuildAndPush("acme-pr-1", config, "feature/x");

        const argv = dockerArgv();
        expect(argv, "no `docker` argv captured by runInherit").toBeDefined();
        const i = argv?.indexOf("--build-arg") ?? -1;
        expect(i).toBeGreaterThan(-1);
        expect(argv?.[i + 1]).toBe("KNEXT_HEALTH_CHECK_PATH=/healthz");
        // No --target for the vinext-node app-dockerfile shape.
        expect(argv).not.toContain("--target");
    });

    it("standalone-node (build:'turbopack', runtime:'node') passes --build-arg KNEXT_HEALTH_CHECK_PATH=<configured>", async () => {
        const { defaultBuildAndPush } = await import("../cli/preview");
        const config: KnativeNextConfig = {
            ...baseConfig,
            build: "turbopack",
            runtime: "node",
        };
        await defaultBuildAndPush("acme-pr-1", config, "feature/x");

        const argv = dockerArgv();
        expect(argv, "no `docker` argv captured by runInherit").toBeDefined();
        const i = argv?.indexOf("--build-arg") ?? -1;
        expect(i).toBeGreaterThan(-1);
        expect(argv?.[i + 1]).toBe("KNEXT_HEALTH_CHECK_PATH=/healthz");
        expect(argv?.[(argv?.indexOf("--target") ?? -1) + 1]).toBe(
            "standalone-node",
        );
    });

    it("standalone-bun (no bake) never gets the build-arg even with healthCheckPath configured", async () => {
        const { defaultBuildAndPush } = await import("../cli/preview");
        const config: KnativeNextConfig = {
            ...baseConfig,
            build: "turbopack",
            runtime: "bun",
        };
        await defaultBuildAndPush("acme-pr-1", config, "feature/x");

        const argv = dockerArgv();
        expect(argv, "no `docker` argv captured by runInherit").toBeDefined();
        expect(argv).not.toContain("--build-arg");
    });
});

describe("preview.ts defaultBuildAndPush compiles the exec via the shared build-artifact step (#1339 finding #1)", () => {
    it("invokes compileArtifactForDeploy exactly once, after the project build", async () => {
        const { defaultBuildAndPush } = await import("../cli/preview");
        await defaultBuildAndPush("acme-pr-1", baseConfig, "feature/x");

        expect(compileArtifactForDeploy).toHaveBeenCalledTimes(1);
        expect(runProjectBuild.mock.invocationCallOrder[0]).toBeLessThan(
            compileArtifactForDeploy.mock.invocationCallOrder[0],
        );
    });

    it("MUTATION-PROOF: a compile failure aborts before the docker build", async () => {
        const { defaultBuildAndPush } = await import("../cli/preview");
        compileArtifactForDeploy.mockImplementationOnce(() => {
            throw new Error("compile boom");
        });

        await expect(
            defaultBuildAndPush("acme-pr-1", baseConfig, "feature/x"),
        ).rejects.toThrow(/compile boom/);
        expect(dockerArgv()).toBeUndefined();
    });
});
