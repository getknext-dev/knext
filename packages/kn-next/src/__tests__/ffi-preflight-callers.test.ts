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
 *
 * The vinext × bun cell is supported, so it is refused only when nothing is
 * staged at native/ffi/<triple>/ — after the compile on `build --skip-next`,
 * and before the freshness check on `deploy --skip-build`. Never on
 * `deploy --image <pre-built ref>`: that image already carries its library and
 * nothing is built from the local tree (the runtime-target refusal still
 * applies there).
 *
 * Every deploy() here runs through `runDeploy`, which always passes
 * `--dry-run`: with a regressed refusal, deploy() runs on, and a dry run makes
 * no docker build/push and no cluster call. A scan at the bottom keeps it so.
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
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
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
// The real vinext compile shells out to `bun build --compile`; write a
// placeholder executable where it would land.
const buildVinextExecutable = mock<AnyFn>((opts: unknown) => {
    const { cwd, arch } = opts as { cwd: string; arch: string };
    const out = join(cwd, `knext-exec-${arch}`);
    writeFileSync(out, "binary");
    return out;
});

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
const realVinext = { ...(await import("../cli/vinext-build")) };
mock.module("../cli/vinext-build", () => ({
    ...realVinext,
    buildVinextExecutable: (...a: unknown[]) => buildVinextExecutable(...a),
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
    // A lockfile, so deploy() can resolve its docker build context: with a
    // regressed refusal, deploy() then really reaches the freshness check
    // (and goes red there) instead of stopping early for an unrelated reason.
    writeFileSync(
        join(dir, "package-lock.json"),
        '{ "lockfileVersion": 3, "packages": {} }\n',
    );
    process.chdir(dir);
    return dir;
}

/**
 * The ONLY way this spec runs deploy(). `--dry-run` is not optional: deploy.ts
 * skips the prune preflight, docker build/push and the CR apply on a dry run,
 * so a regressed refusal can never reach the ambient kube context.
 */
async function runDeploy(...flags: string[]): Promise<void> {
    process.argv = ["node", "/path/to/kn-next.js", "--dry-run", ...flags];
    return deploy();
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
        buildVinextExecutable,
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

/**
 * Run the dry-run deploy, then check the seams BEFORE the message: with the
 * refusal regressed, the dry run completes, and the first red names what it
 * reached — the freshness check on `--skip-build`, the ffi dispatch and
 * project build on the fresh-build leg — rather than "the promise resolved".
 */
async function expectDeployRefused(
    message: string,
    ...flags: string[]
): Promise<void> {
    const outcome = await runDeploy(...flags).then(
        () => undefined,
        (err: Error) => err,
    );
    expectNoBuildWork();
    expect(outcome?.message).toContain(message);
}

describe("knext deploy --skip-build", () => {
    for (const c of [0, 1]) {
        it(`refuses an opted-in app with ${c === 0 ? "runtime 'node'" : "selfContained: true"} before the freshness check or any image step`, async () => {
            enterApp(true);
            const kase = CASES[c] as (typeof CASES)[number];
            loadConfig.mockResolvedValue({ ...CONFIG, ...kase.config });
            await expectDeployRefused(kase.message, "--skip-build");
        });
    }

    it("refuses on the fresh-build leg too", async () => {
        enterApp(true);
        loadConfig.mockResolvedValue({ ...CONFIG, runtime: "node" });
        await expectDeployRefused(FFI_NODE_REFUSAL);
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
// ---------------------------------------------------------------------------
// vinext × bun: supported, but refused when nothing is staged for the image.
// ---------------------------------------------------------------------------

const TRIPLE = "x86_64-unknown-linux-musl";
const VINEXT_BUN = { ...CONFIG, build: "vinext", runtime: "bun" } as const;
const NOTHING_STAGED = new RegExp(`nothing is staged at native/ffi/${TRIPLE}/`);

describe("vinext × bun with knext.ffi.json and nothing staged at native/ffi/<triple>", () => {
    it("knext build --skip-next refuses after the compile, before the manifest or stamp", async () => {
        const app = enterApp(true);
        loadConfig.mockResolvedValue(VINEXT_BUN);
        compileArtifactForDeploy.mockImplementationOnce(
            realArtifact.compileArtifactForDeploy as AnyFn,
        );
        await expect(
            build({ skipNextBuild: true, skipSmoke: true }),
        ).rejects.toThrow(NOTHING_STAGED);
        expect(buildVinextExecutable).toHaveBeenCalledTimes(1);
        expect(runProjectBuild).not.toHaveBeenCalled();
        expect(dispatchFfiVerb).not.toHaveBeenCalled();
        expect(existsSync(join(app, "native", ".integrity.json"))).toBe(false);
    });

    it("knext build --skip-next with the library staged is not refused for it", async () => {
        const app = enterApp(true);
        mkdirSync(join(app, "native", "ffi", TRIPLE), { recursive: true });
        writeFileSync(join(app, "native", "ffi", TRIPLE, "libzone.so"), "lib");
        loadConfig.mockResolvedValue(VINEXT_BUN);
        compileArtifactForDeploy.mockImplementationOnce(
            realArtifact.compileArtifactForDeploy as AnyFn,
        );
        let message = "";
        try {
            await build({ skipNextBuild: true, skipSmoke: true });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).not.toMatch(NOTHING_STAGED);
        expect(buildVinextExecutable).toHaveBeenCalledTimes(1);
    });

    it("knext deploy --skip-build --dry-run refuses before the freshness check, naming --skip-build", async () => {
        enterApp(true);
        loadConfig.mockResolvedValue(VINEXT_BUN);
        // The freshness check stays the inert spy: the refusal is deploy()'s
        // own, on the --skip-build leg, not something the check does.
        const err = await runDeploy("--skip-build").then(
            () => undefined,
            (e: Error) => e,
        );
        expect(err?.message).toMatch(NOTHING_STAGED);
        expect(err?.message).toContain("--skip-build");
        expect(err?.message).not.toContain("--skip-next");
        expect(assertCompiledArtifactFresh).not.toHaveBeenCalled();
        expect(compileArtifactForDeploy).not.toHaveBeenCalled();
        expect(runProjectBuild).not.toHaveBeenCalled();
        expect(dispatchFfiVerb).not.toHaveBeenCalled();
    });

    it("without knext.ffi.json, deploy --skip-build --dry-run is not refused for it", async () => {
        enterApp(false);
        loadConfig.mockResolvedValue(VINEXT_BUN);
        assertCompiledArtifactFresh.mockImplementationOnce(
            realArtifact.assertCompiledArtifactFresh as AnyFn,
        );
        let message = "";
        try {
            await runDeploy("--skip-build");
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).not.toMatch(NOTHING_STAGED);
        expect(assertCompiledArtifactFresh).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// deploy --image <pre-built ref>: the image already carries the library and
// nothing is built or pushed, so local native/ffi/ is irrelevant. The runtime
// target is not — a Node image still cannot load the library.
// ---------------------------------------------------------------------------

const PREBUILT = `ghcr.io/acme/zone@sha256:${"a".repeat(64)}`;

describe("knext deploy --image <pre-built ref> with knext.ffi.json", () => {
    it("is not refused for nothing staged at native/ffi/<triple> (a clean CI checkout)", async () => {
        enterApp(true);
        loadConfig.mockResolvedValue(VINEXT_BUN);
        const err = await runDeploy("--image", PREBUILT).then(
            () => undefined,
            (e: Error) => e,
        );
        expect(err?.message ?? "").not.toMatch(NOTHING_STAGED);
        expect(err).toBeUndefined();
        // Nothing local ships under --image, so the local exec freshness
        // check does not run either (deploy-image-skips-freshness.test.ts).
        expect(assertCompiledArtifactFresh).not.toHaveBeenCalled();
        expect(compileArtifactForDeploy).not.toHaveBeenCalled();
        expect(runProjectBuild).not.toHaveBeenCalled();
        expect(dispatchFfiVerb).not.toHaveBeenCalled();
    });

    it("runtime 'node' is still refused by the target preflight", async () => {
        enterApp(true);
        loadConfig.mockResolvedValue({ ...CONFIG, runtime: "node" });
        await expectDeployRefused(FFI_NODE_REFUSAL, "--image", PREBUILT);
    });

    it("plain --skip-build (no --image) with nothing staged is still refused", async () => {
        enterApp(true);
        loadConfig.mockResolvedValue(VINEXT_BUN);
        const err = await runDeploy("--skip-build").then(
            () => undefined,
            (e: Error) => e,
        );
        expect(err?.message).toMatch(NOTHING_STAGED);
        expect(assertCompiledArtifactFresh).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Guard: every deploy() in this spec is a dry run.
// ---------------------------------------------------------------------------

describe("this spec never runs a non-dry-run deploy()", () => {
    const SOURCE = readFileSync(import.meta.path, "utf8");
    // One pass over comments and string/template literals, leftmost first, so
    // a quote inside a comment (or a slash inside a string) cannot desync it.
    // Built from a template literal, so the pattern itself is stripped too.
    const LITERALS = new RegExp(
        String.raw`/\*[\s\S]*?\*/|//[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60`,
        "g",
    );
    /** Comments removed, strings kept (for the argv literal). */
    const code = SOURCE.replace(LITERALS, (m) => (m.startsWith("/") ? "" : m));
    /** Comments AND strings removed: test names mention the command too. */
    const bare = SOURCE.replace(LITERALS, "");
    const FN = "deploy";

    it("the command is called exactly once, inside runDeploy", () => {
        const calls = [...bare.matchAll(new RegExp(`\\b${FN}\\s*\\(`, "g"))];
        expect(calls.length).toBe(1);
        const helper = bare.match(
            /async function runDeploy\([^)]*\)[^{]*\{([\s\S]*?)\n\}/,
        );
        expect(helper?.[1]).toMatch(new RegExp(`\\b${FN}\\(\\)`));
    });

    it("the command is never aliased or passed by reference", () => {
        // Every bare token: the destructuring import, and the one call.
        const tokens = [...bare.matchAll(new RegExp(`\\b${FN}\\b`, "g"))]
            .map((m) =>
                bare.slice(m.index ?? 0, (m.index ?? 0) + FN.length + 2),
            )
            .sort();
        expect(tokens).toEqual([`${FN} }`, `${FN}()`].sort());
    });

    it("the only argv assignment is runDeploy's, and it carries --dry-run unconditionally", () => {
        const assigns = [...code.matchAll(/process\.argv\s*=\s*([^;]+);/g)]
            .map((m) => (m[1] as string).trim())
            .sort();
        // runDeploy's, plus afterEach's restore of the saved argv.
        expect(assigns).toEqual(
            [
                '["node", "/path/to/kn-next.js", "--dry-run", ...flags]',
                "savedArgv",
            ].sort(),
        );
        // ...and nothing edits argv in place.
        expect(bare).not.toMatch(
            /process\.argv\s*(\.\s*(push|splice|unshift|pop|shift)\b|\[)/,
        );
    });
});
