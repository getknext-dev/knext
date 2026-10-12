/**
 * `knext deploy` (without --skip-build) reaches `runProjectBuild` directly, so
 * it must refuse Bun + turbopackModuleFragments before any build work.
 * Harness mirrors deploy-build-log-target.test.ts; `runProjectBuild` is REAL
 * and the app's next.config.ts is a real file in a temp cwd.
 */

import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";
import type { KnativeNextConfig } from "../config";
import { reconciledNextAppCapture } from "./helpers/reconciled-nextapp";

requireIsolatedProcess("deploy-turbopack-fragments-guard.test.ts");

// biome-ignore lint/suspicious/noExplicitAny: mock return type must be `any`
type AnyFn = (...args: unknown[]) => any;

const __realExec = { ...(await import("../cli/exec")) };
const runQuiet = mock<AnyFn>();
mock.module("../cli/exec", () => ({
    ...__realExec,
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: mock(),
    runCapture: mock(() => ""),
    runQuietAllowFail: mock(),
    isEntrypoint: () => false,
}));
const __realAssets = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    ...__realAssets,
    uploadAssets: async () => {},
    getAssetPrefix: () => "https://cdn.example.com/my-app",
    reclaimBuildPrefix: mock(),
}));
const __realCr = { ...(await import("../cli/cr-builder")) };
mock.module("../cli/cr-builder", () => ({
    ...__realCr,
    renderNextAppCR: () => "kind: NextApp\n",
    resolveDigest: async () => "reg/my-app@sha256:deadbeef",
    validateCRImageRef: mock(),
}));
const __realArtifact = { ...(await import("../cli/build-artifact")) };
mock.module("../cli/build-artifact", () => ({
    ...__realArtifact,
    compileArtifactForDeploy: () => ({ compiled: false }),
    assertCompiledArtifactFresh: () => {},
}));
const __realGc = { ...(await import("../cli/gc")) };
mock.module("../cli/gc", () => ({
    ...__realGc,
    runAssetGC: () => ({ pruned: true }),
}));
const __realCapture = { ...(await import("../cli/schema/kubectl-capture")) };
mock.module("../cli/schema/kubectl-capture", () => ({
    ...__realCapture,
    captureKubectl: () => reconciledNextAppCapture(),
}));
const config: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    build: "turbopack",
    runtime: "bun",
};
const loadConfig = mock<AnyFn>(async () => config);
const __realShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__realShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    handleUsageError: () => false,
    handleConfigNotFound: () => false,
}));
afterAll(() => {
    mock.module("../cli/exec", () => __realExec);
    mock.module("../utils/asset-upload", () => __realAssets);
    mock.module("../cli/cr-builder", () => __realCr);
    mock.module("../cli/build-artifact", () => __realArtifact);
    mock.module("../cli/gc", () => __realGc);
    mock.module("../cli/schema/kubectl-capture", () => __realCapture);
    mock.module("../cli/shared", () => __realShared);
});

const savedArgv = process.argv;
const saved = process.cwd();
beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ASSET_PREFIX;
});

describe("deploy refuses bun + turbopackModuleFragments", () => {
    it("refuses before running the project build", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-dep-frag-"));
        writeFileSync(
            join(dir, "next.config.ts"),
            "export default { experimental: { turbopackModuleFragments: true } };",
        );
        writeFileSync(join(dir, "package-lock.json"), "{}");
        process.chdir(dir);
        process.argv = ["node", "/path/to/kn-next.js", "deploy", "--tag", "t"];
        try {
            const { deploy } = (await import("../cli/deploy")) as {
                deploy: () => Promise<void>;
            };
            await expect(deploy()).rejects.toThrow(/turbopackModuleFragments/);
            expect(runQuiet).not.toHaveBeenCalled();
        } finally {
            process.chdir(saved);
            process.argv = savedArgv;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
