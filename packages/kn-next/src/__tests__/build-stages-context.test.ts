/**
 * `knext build` stages the standalone docker build context (the Dockerfile +
 * entry shims), the SAME bytes `knext deploy` stages, so an image can be built
 * on a remote builder (Cloud Build / CI) without calling an internal function.
 * Asserts both halves: build stages identical bytes; deploy/preview still stage.
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
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";
import type { PostCompileSmokeOptions } from "../cli/postcompile-smoke";
import type { StandaloneExecBuildOptions } from "../cli/standalone-exec-build";
import type { VinextBuildOptions } from "../cli/vinext-build";

// #965: installs process-global `mock.module` fakes of shared CLI modules that
// bun cannot unregister. MUST have the `bun test` process to itself — the
// suite of record (`scripts/bun-test.mjs`) gives it one; a hand-rolled batch
// gets a loud pointer there instead of phantom failures in a sibling.
requireIsolatedProcess("build-stages-context.test.ts");

const runQuiet = (() => mock())();
mock.module("../cli/exec", () => ({ runQuiet, isEntrypoint: () => false }));

const loadConfig = (() => mock())();
mock.module("../cli/shared", () => ({ loadConfig }));

const uploadAssets = (() => mock(async () => {}))();
const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    // keep the REAL hasStorage/notice exports (ADR-0047) — stub only the seams
    ...__knextReal1,
    uploadAssets,
}));

const healBunExportTargets = (() =>
    mock(() => ({ copied: [], skipped: [] })))();
mock.module("../adapters/standalone-bun-exports", () => ({
    healBunExportTargets,
}));

// TYPED signature: an untyped `mock()` infers `calls` as `[]`, so reading
// `calls[n][0].arch` in `shipCompiles()` below is a TS2493 under the PACKAGE
// typecheck (`bun run --filter @getknext/core typecheck`). The root typecheck
// excludes `packages/`, so it never sees it.
const buildVinextExecutable = (() =>
    mock((_opts: VinextBuildOptions): string => "knext-exec-linux-x64"))();
// #1298: mocked (not left real) so the "vinext × node" describe block below
// can assert build() actually WIRES this call — leaving it real would have
// let the wiring silently go missing, since every fixture there declares no
// sharp and the real function no-ops (`{ staged: false }`) in that case,
// which is exactly how this went unnoticed once (see build.ts's caller).
const stageSharpForVinextNode = (() =>
    mock((_cwd: string, _opts?: { arch?: string }): { staged: boolean } => ({
        staged: true,
    })))();
const __knextRealVinext = { ...(await import("../cli/vinext-build")) };
mock.module("../cli/vinext-build", () => ({
    ...__knextRealVinext,
    buildVinextExecutable,
    stageSharpForVinextNode,
}));

// The post-compile smoke (#894) BOOTS the compiled binary, and these cases mock
// the compile — so without this the smoke would spawn a path that was never
// produced and fail every vinext case here. Its own coverage is
// `postcompile-smoke.test.ts` (behaviour) + `postcompile-smoke-wiring.test.ts`
// (that build() calls it, fail-closed).
const runPostCompileSmoke = (() =>
    mock(async (_opts: PostCompileSmokeOptions) => ({
        appPort: 1,
        metricsPort: 2,
        healthStatus: 200,
        metricsStatus: 200,
        exitCode: 0,
        bootMs: 1,
        termMs: 1,
    })))();
const buildStandaloneExecutable = (() =>
    mock(
        (_opts: StandaloneExecBuildOptions): string =>
            "knext-standalone-exec-linux-x64",
    ))();
const __knextRealStandaloneExec = {
    ...(await import("../cli/standalone-exec-build")),
};
mock.module("../cli/standalone-exec-build", () => ({
    ...__knextRealStandaloneExec,
    buildStandaloneExecutable,
}));

const __knextRealSmoke = { ...(await import("../cli/postcompile-smoke")) };
mock.module("../cli/postcompile-smoke", () => ({
    ...__knextRealSmoke,
    runPostCompileSmoke,
}));

import { build } from "../cli/build";
import {
    STANDALONE_DOCKERFILE_NAME,
    stageStandaloneBuildContext,
} from "../cli/runtime-image";

let dir: string;
const savedCwd = process.cwd();

const cfg = (over: Record<string, unknown> = {}) => ({
    name: "my-app",
    registry: "reg",
    build: "turbopack",
    ...over,
});

const STAGED = [
    STANDALONE_DOCKERFILE_NAME,
    `${STANDALONE_DOCKERFILE_NAME}.dockerignore`,
    "knext-standalone-entry.mjs",
    "knext-compile-cache-bake.mjs",
    "knext-self-contained-server-shim.js",
];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-build-ctx-"));
    process.chdir(dir);
    jest.clearAllMocks();
    healBunExportTargets.mockReturnValue({ copied: [], skipped: [] });
    mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
    writeFileSync(join(dir, ".next", "standalone", "server.js"), "");
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

/** What deploy stages for the same cwd/context: the shared function, fresh dir. */
function reference(): string {
    const ref = mkdtempSync(join(tmpdir(), "knext-build-ctx-ref-"));
    stageStandaloneBuildContext({ cwd: ref, buildContext: ref });
    return ref;
}

describe("knext build stages the standalone docker build context", () => {
    for (const runtime of ["node", "bun"]) {
        it(`stages bytes identical to deploy's for turbopack x ${runtime}`, async () => {
            writeFileSync(join(dir, "package-lock.json"), "{}");
            loadConfig.mockResolvedValue(cfg({ runtime }));
            await build({ skipNextBuild: true });
            const ref = reference();
            try {
                for (const f of STAGED) {
                    expect(existsSync(join(dir, f))).toBe(true);
                    expect(readFileSync(join(dir, f), "utf8")).toBe(
                        readFileSync(join(ref, f), "utf8"),
                    );
                }
            } finally {
                rmSync(ref, { recursive: true, force: true });
            }
        });
    }

    it("stages for the self-contained compiled executable too", async () => {
        writeFileSync(join(dir, "package-lock.json"), "{}");
        loadConfig.mockResolvedValue(
            cfg({ runtime: "bun", selfContained: true }),
        );
        await build({ skipNextBuild: true });
        expect(existsSync(join(dir, STANDALONE_DOCKERFILE_NAME))).toBe(true);
        expect(
            existsSync(join(dir, "knext-self-contained-server-shim.js")),
        ).toBe(true);
    });

    it("does not stage the standalone recipe for a vinext app (deploy does not either)", async () => {
        writeFileSync(join(dir, "package-lock.json"), "{}");
        loadConfig.mockResolvedValue(cfg({ build: "vinext", runtime: "bun" }));
        await build({ skipNextBuild: true });
        expect(existsSync(join(dir, STANDALONE_DOCKERFILE_NAME))).toBe(false);
    });

    it("still builds (warning, no staging) when no lockfile fixes a build context", async () => {
        loadConfig.mockResolvedValue(cfg({ runtime: "node" }));
        await build({ skipNextBuild: true });
        expect(existsSync(join(dir, STANDALONE_DOCKERFILE_NAME))).toBe(false);
    });
});

describe("staged context is complete and failures are loud", () => {
    /** COPY/ADD sources (non --from) of one Dockerfile stage. */
    function copySources(dockerfile: string, target: string): string[] {
        const out: string[] = [];
        let inStage = false;
        for (const raw of dockerfile.split("\n")) {
            const line = raw.trim();
            if (/^FROM\s/i.test(line)) {
                inStage = new RegExp(`\\sAS\\s+${target}$`, "i").test(line);
                continue;
            }
            if (!inStage || !/^(COPY|ADD)\s/i.test(line)) continue;
            if (line.includes("--from")) continue;
            const parts = line
                .split(/\s+/)
                .slice(1)
                .filter((x) => !x.startsWith("--"));
            out.push(...parts.slice(0, -1));
        }
        return out;
    }

    const cases: [string, Record<string, unknown>, string][] = [
        ["node", { runtime: "node" }, "standalone-node"],
        ["bun", { runtime: "bun" }, "standalone-bun"],
        [
            "self-contained",
            { runtime: "bun", selfContained: true },
            "standalone-bun-self-contained",
        ],
    ];
    for (const [name, over, target] of cases) {
        it(`every COPY source of the ${name} stage exists after knext build`, async () => {
            writeFileSync(join(dir, "package-lock.json"), "{}");
            mkdirSync(join(dir, ".next", "static"), { recursive: true });
            mkdirSync(join(dir, "public"), { recursive: true });
            mkdirSync(join(dir, "node_modules", "@getknext", "core"), {
                recursive: true,
            });
            // the (mocked) compile's output
            writeFileSync(join(dir, "knext-standalone-exec-linux-x64"), "");
            loadConfig.mockResolvedValue(cfg(over));
            await build({ skipNextBuild: true });
            const sources = copySources(
                readFileSync(join(dir, STANDALONE_DOCKERFILE_NAME), "utf8"),
                target,
            );
            expect(sources.length).toBeGreaterThan(2);
            const missing = sources.filter((s) => !existsSync(join(dir, s)));
            expect(missing).toEqual([]);
        });
    }

    it("fails the build (loudly) when staging throws", async () => {
        writeFileSync(join(dir, "package-lock.json"), "{}");
        // a directory where the Dockerfile must be written makes staging throw
        mkdirSync(join(dir, STANDALONE_DOCKERFILE_NAME));
        loadConfig.mockResolvedValue(cfg({ runtime: "node" }));
        await expect(build({ skipNextBuild: true })).rejects.toThrow(
            /Could not stage the docker build context/,
        );
    });
});

describe("deploy and preview behaviour is unchanged", () => {
    const cli = (f: string) =>
        readFileSync(join(import.meta.dir, "..", "cli", f), "utf8");
    for (const f of ["deploy.ts", "preview.ts"]) {
        it(`${f} still stages through the shared function`, () => {
            expect(cli(f)).toMatch(/stageStandaloneBuildContext\(\{/);
        });
    }
});
