/**
 * The in-process Rust refusals (ADR-0069 D14 round 4, D15) fire from EVERY
 * image-building command, including the legs that skip the project build:
 *
 *   - `knext build --skip-next`  (reuses .next; still compiles and stages)
 *   - `knext deploy --skip-build` (never calls compileArtifactForDeploy)
 *   - `knext preview deploy`
 *
 * Each runs against an app with `knext.ffi.json` and either `runtime: 'node'`
 * or `selfContained: true`, and must stop with the refusal BEFORE any build,
 * compile, freshness check, dispatch or image step. The side-effecting seams
 * are module-mocked spies; the preflight itself is the real one.
 */

import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnativeNextConfig } from "../config";

// biome-ignore lint/suspicious/noExplicitAny: spies return whatever the seam does
type AnyFn = (...args: unknown[]) => any;

const loadConfig = mock<AnyFn>();
const runProjectBuild = mock<AnyFn>();
const compileArtifactForDeploy = mock<AnyFn>(() => ({ compiled: false }));
const assertCompiledArtifactFresh = mock<AnyFn>();
const dispatchFfiVerb = mock<AnyFn>(async () => 0);

const realShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...realShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
}));
const realProjectBuild = { ...(await import("../cli/project-build")) };
mock.module("../cli/project-build", () => ({
    ...realProjectBuild,
    runProjectBuild: (...a: unknown[]) => runProjectBuild(...a),
}));
const realArtifact = { ...(await import("../cli/build-artifact")) };
mock.module("../cli/build-artifact", () => ({
    ...realArtifact,
    compileArtifactForDeploy: (...a: unknown[]) =>
        compileArtifactForDeploy(...a),
    assertCompiledArtifactFresh: (...a: unknown[]) =>
        assertCompiledArtifactFresh(...a),
}));
const realDispatch = { ...(await import("../cli/ffi-dispatch")) };
mock.module("../cli/ffi-dispatch", () => ({
    ...realDispatch,
    dispatchFfiVerb: (...a: unknown[]) => dispatchFfiVerb(...a),
}));

const { build } = await import("../cli/build");
const { deploy } = await import("../cli/deploy");
const { runPreviewDeploy } = await import("../cli/preview");
const { FFI_NODE_REFUSAL, FFI_SELF_CONTAINED_REFUSAL } = await import(
    "../cli/ffi-preflight"
);

const roots: string[] = [];
const savedCwd = process.cwd();
const savedArgv = process.argv;
afterAll(() => {
    process.chdir(savedCwd);
    for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function enterApp(optedIn: boolean): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "knext-ffi-callers-")));
    roots.push(dir);
    if (optedIn) writeFileSync(join(dir, "knext.ffi.json"), "{}\n");
    process.chdir(dir);
    return dir;
}

const CONFIG = {
    name: "zone",
    registry: "ghcr.io/acme",
    build: "turbopack",
} as const;

const CASES: Array<{
    label: string;
    config: Partial<KnativeNextConfig>;
    message: string;
}> = [
    {
        label: "runtime 'node'",
        config: { runtime: "node" },
        message: FFI_NODE_REFUSAL,
    },
    {
        label: "selfContained: true",
        config: { runtime: "bun", selfContained: true },
        message: FFI_SELF_CONTAINED_REFUSAL,
    },
];

beforeEach(() => {
    for (const m of [
        loadConfig,
        runProjectBuild,
        compileArtifactForDeploy,
        assertCompiledArtifactFresh,
        dispatchFfiVerb,
    ])
        m.mockClear();
});
afterEach(() => {
    process.argv = savedArgv;
    process.chdir(savedCwd);
});

function expectNoBuildWork() {
    expect(runProjectBuild).not.toHaveBeenCalled();
    expect(compileArtifactForDeploy).not.toHaveBeenCalled();
    expect(assertCompiledArtifactFresh).not.toHaveBeenCalled();
    expect(dispatchFfiVerb).not.toHaveBeenCalled();
}

describe("knext build --skip-next", () => {
    for (const c of [0, 1]) {
        it(`refuses an opted-in app with ${c === 0 ? "runtime 'node'" : "selfContained: true"} before any build step`, async () => {
            enterApp(true);
            const kase = CASES[c] as (typeof CASES)[number];
            loadConfig.mockResolvedValue({ ...CONFIG, ...kase.config });
            await expect(build({ skipNextBuild: true })).rejects.toThrow(
                kase.message,
            );
            expectNoBuildWork();
        });
    }

    it("the --self-contained flag alone is refused too", async () => {
        enterApp(true);
        loadConfig.mockResolvedValue({ ...CONFIG, runtime: "bun" });
        await expect(
            build({ skipNextBuild: true, selfContained: true }),
        ).rejects.toThrow(FFI_SELF_CONTAINED_REFUSAL);
        expectNoBuildWork();
    });

    it("an app without knext.ffi.json is not refused and never dispatches", async () => {
        enterApp(false);
        loadConfig.mockResolvedValue({ ...CONFIG, runtime: "node" });
        // It goes on to the build work (which fails later in this empty dir,
        // or not — either way, not with the refusal).
        let message = "";
        try {
            await build({ skipNextBuild: true, skipSmoke: true });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).not.toContain("in-process Rust");
        expect(compileArtifactForDeploy).toHaveBeenCalled();
        expect(dispatchFfiVerb).not.toHaveBeenCalled();
    });
});

describe("knext deploy --skip-build", () => {
    for (const c of [0, 1]) {
        it(`refuses an opted-in app with ${c === 0 ? "runtime 'node'" : "selfContained: true"} before the freshness check or any image step`, async () => {
            enterApp(true);
            const kase = CASES[c] as (typeof CASES)[number];
            loadConfig.mockResolvedValue({ ...CONFIG, ...kase.config });
            process.argv = ["node", "/path/to/kn-next.js", "--skip-build"];
            await expect(deploy()).rejects.toThrow(kase.message);
            expectNoBuildWork();
        });
    }

    it("refuses on the fresh-build leg too", async () => {
        enterApp(true);
        loadConfig.mockResolvedValue({ ...CONFIG, runtime: "node" });
        process.argv = ["node", "/path/to/kn-next.js", "--dry-run"];
        await expect(deploy()).rejects.toThrow(FFI_NODE_REFUSAL);
        expectNoBuildWork();
    });
});

describe("knext preview deploy", () => {
    for (const c of [0, 1]) {
        it(`refuses an opted-in app with ${c === 0 ? "runtime 'node'" : "selfContained: true"} before the preflight CR, build, push or apply`, async () => {
            enterApp(true);
            const kase = CASES[c] as (typeof CASES)[number];
            const deps = {
                apply: mock<AnyFn>(),
                capture: mock<AnyFn>(() => ""),
                buildAndPush: mock<AnyFn>(async () => "img@sha256:x"),
                preflight: mock<AnyFn>(),
                visibilityGuard: mock<AnyFn>(),
            };
            await expect(
                runPreviewDeploy(
                    { ...CONFIG, ...kase.config } as KnativeNextConfig,
                    { prId: "7", branch: "b", namespace: "default" },
                    deps as never,
                ),
            ).rejects.toThrow(kase.message);
            for (const d of Object.values(deps))
                expect(d).not.toHaveBeenCalled();
            expectNoBuildWork();
        });
    }
});
