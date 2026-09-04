/**
 * #894 — the smoke is WIRED into `kn-next build`, fail-closed.
 *
 * The module next door proves the smoke can see each obligation go missing.
 * That is worth nothing if nothing calls it, or if a failed call is swallowed,
 * so these cases drive `build()` with the side-effecting seams mocked and
 * assert both halves: the smoke runs on the shape that produces a binary, and a
 * FAILING smoke stops the build before it uploads anything.
 *
 * The skip is the other half of the acceptance criteria. It exists for CI that
 * genuinely cannot execute the binary (a foreign-arch runner), it is EXPLICIT —
 * `--skip-smoke`, never inferred — and it is LOUD: a warn-level log naming what
 * was not checked. A silent skip is the anti-pattern this whole issue exists to
 * remove one level up.
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
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    PostCompileSmokeOptions,
    PostCompileSmokeResult,
} from "../cli/postcompile-smoke";
import type { VinextBuildOptions } from "../cli/vinext-build";

/** The host arch `build()` sees. Mutable so both plan branches are reachable. */
let hostArch = "darwin-arm64";

const runQuiet = (() => mock())();
const __knextRealExec = { ...(await import("../cli/exec")) };
mock.module("../cli/exec", () => ({
    // The REAL exports stay: the dynamic `import("../cli/build")` below pulls in
    // more of the graph than a hoisted one did, and a partial mock of a shared
    // module fails the whole file on the first missing export.
    ...__knextRealExec,
    runQuiet,
    isEntrypoint: () => false,
}));

const loadConfig = (() => mock())();
const __knextRealShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({ ...__knextRealShared, loadConfig }));

const uploadAssets = (() => mock(async () => {}))();
const __knextRealUpload = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", () => ({
    ...__knextRealUpload,
    uploadAssets,
}));

// TYPED mock signatures throughout, never `as` casts on `mock.calls[0][0]`:
// an untyped `mock()` infers its calls as `[]`, so indexing it is TS2493 and the
// cast that hides it is TS2352. The package typecheck (`bun run --filter
// @getknext/core typecheck`) catches this; the ROOT typecheck does not, because
// its config excludes `packages/`.
const buildVinextExecutable = (() =>
    mock((_opts: VinextBuildOptions): string => "knext-exec-linux-x64"))();
const __knextRealVinext = { ...(await import("../cli/vinext-build")) };
mock.module("../cli/vinext-build", () => ({
    ...__knextRealVinext,
    buildVinextExecutable,
    // Injectable so BOTH host-arch branches are reachable from a test: the
    // real one answers for whatever machine happens to be running, which is
    // exactly how a mechanism gets covered on one developer's laptop and
    // nowhere else.
    hostSmokeArch: () => hostArch,
}));

const SMOKE_OK: PostCompileSmokeResult = {
    appPort: 1,
    metricsPort: 2,
    healthStatus: 200,
    metricsStatus: 200,
    exitCode: 0,
    bootMs: 1,
    termMs: 1,
};
const runPostCompileSmoke = (() =>
    mock(
        async (
            _opts: PostCompileSmokeOptions,
        ): Promise<PostCompileSmokeResult> => SMOKE_OK,
    ))();
const __knextRealSmoke = { ...(await import("../cli/postcompile-smoke")) };
mock.module("../cli/postcompile-smoke", () => ({
    ...__knextRealSmoke,
    runPostCompileSmoke,
}));

const warn = (() => mock())();
const info = (() => mock())();
mock.module("../utils/logger", () => ({
    createLogger: () => ({ info, warn, error: mock(), debug: mock() }),
}));

const { PostCompileSmokeError } = __knextRealSmoke;

// DYNAMIC, and that is load-bearing: a static `import` is HOISTED above the
// `mock.module` calls above, so `build.ts` would evaluate — and capture a REAL
// logger in its module-scope `const log` — before the logger mock is
// registered. Function-valued seams survive that (mock.module rewrites the live
// binding); a value captured at module scope does not. Measured here: with the
// static import, `warn` recorded nothing at all.
const { build, buildMain, BUILD_HELP } = await import("../cli/build");
const { hostSmokeArch, smokeBinaryPlan } = __knextRealVinext;

let dir: string;
const savedCwd = process.cwd();

const cfg = (over: Record<string, unknown> = {}) => ({
    name: "my-app",
    registry: "reg",
    storage: { provider: "gcs", bucket: "b" },
    ...over,
});

/** Every warn/info argument flattened, so a claim about loudness is checkable. */
const logged = (m: typeof warn) =>
    m.mock.calls.map((c) => JSON.stringify(c)).join("\n");

beforeEach(() => {
    // realpath: macOS resolves /var → /private/var, and `build()` reports
    // `process.cwd()`, so the raw mkdtemp path would never compare equal.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "knext-smoke-wire-")));
    process.chdir(dir);
    jest.clearAllMocks();
    hostArch = "darwin-arm64"; // cross-arch by default: the developer-machine case
    buildVinextExecutable.mockReturnValue("knext-exec-linux-x64");
    runPostCompileSmoke.mockResolvedValue(SMOKE_OK);
});

/** The options `build()` handed the smoke on its first (only) call. */
const smokeArg = (): PostCompileSmokeOptions => {
    const call = runPostCompileSmoke.mock.calls[0];
    if (!call) throw new Error("the smoke was never called");
    return call[0];
};

/** The arches `build()` asked to compile, in order. */
const compiledArches = (): (string | undefined)[] =>
    buildVinextExecutable.mock.calls.map((c) => c[0]?.arch);

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

describe("#894 build() runs the smoke", () => {
    it("smokes the compiled binary on the default (vinext) shape", async () => {
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });

        expect(runPostCompileSmoke).toHaveBeenCalledTimes(1);
        expect(smokeArg().binaryPath).toContain(dir);
        expect(smokeArg().cwd).toBe(dir);
    });

    it("probes the app's CONFIGURED health path", async () => {
        loadConfig.mockResolvedValue(cfg({ healthCheckPath: "/healthz" }));
        await build({ skipNextBuild: true });
        expect(smokeArg().healthPath).toBe("/healthz");
    });

    it("does NOT smoke the turbopack shape — there is no binary to boot", async () => {
        loadConfig.mockResolvedValue(cfg({ build: "turbopack" }));
        mkdirSync(join(dir, ".next", "standalone"), { recursive: true });
        await build({ skipNextBuild: true });
        expect(buildVinextExecutable).not.toHaveBeenCalled();
        expect(runPostCompileSmoke).not.toHaveBeenCalled();
    });
});

describe("#894 a failing smoke FAILS the build", () => {
    it("rejects, and never uploads assets", async () => {
        loadConfig.mockResolvedValue(cfg());
        runPostCompileSmoke.mockRejectedValue(
            new PostCompileSmokeError("health", "no health route", 4242),
        );

        await expect(build({ skipNextBuild: true })).rejects.toThrow(/health/);
        // The build STOPS. Uploading the assets of an artifact that cannot boot
        // is how a broken revision reaches a bucket and then a cluster.
        expect(uploadAssets).not.toHaveBeenCalled();
    });

    it("does not downgrade the failure to a warning", async () => {
        loadConfig.mockResolvedValue(cfg());
        runPostCompileSmoke.mockRejectedValue(
            new PostCompileSmokeError("sigterm", "never drained", 4242),
        );
        await build({ skipNextBuild: true }).catch(() => {});
        // Non-vacuity for the case above: had the build swallowed it into a
        // log line, the rejection assertion would be the only thing to change.
        expect(logged(warn)).not.toContain("never drained");
    });
});

describe("#894 the skip is explicit and LOUD", () => {
    it("skips only when asked, and says so at warn level", async () => {
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true, skipSmoke: true });

        expect(runPostCompileSmoke).not.toHaveBeenCalled();
        const said = logged(warn);
        expect(said).toContain("SMOKE SKIPPED");
        // It must name what is now UNVERIFIED, not merely that a step was
        // skipped: "skipped a step" is ignorable, "health/metrics/SIGTERM were
        // not checked" is not.
        expect(said).toContain("health");
        expect(said).toContain("metrics");
        expect(said).toContain("SIGTERM");
    });

    it("is off by default — the compile alone never implies a skip", async () => {
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });
        expect(logged(warn)).not.toContain("SMOKE SKIPPED");
        expect(runPostCompileSmoke).toHaveBeenCalledTimes(1);
    });

    it("is reachable from argv, and documented in --help", async () => {
        loadConfig.mockResolvedValue(cfg());
        expect(await buildMain(["--skip-smoke"])).toBe(0);
        expect(runPostCompileSmoke).not.toHaveBeenCalled();
        expect(BUILD_HELP).toContain("--skip-smoke");
    });
});

describe("#894 build() HONOURS the host-arch plan", () => {
    it("compiles a second, host-arch binary on a cross-arch host, and smokes THAT", async () => {
        hostArch = "darwin-arm64";
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });

        // Without this case the whole host-arch mechanism could be deleted —
        // `build()` reusing the linux-musl ship binary everywhere — and nothing
        // would go red, because the plan's own unit test does not observe the
        // caller.
        expect(compiledArches()).toEqual(["linux-x64", "darwin-arm64"]);
        expect(smokeArg().binaryPath).toContain("knext-smoke-darwin-arm64");
        expect(smokeArg().binaryPath).not.toContain("knext-exec-");
    });

    it("compiles ONCE and smokes the ship binary when the host IS the ship target", async () => {
        hostArch = "linux-x64";
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });

        expect(compiledArches()).toEqual(["linux-x64"]);
        expect(smokeArg().binaryPath).toContain("knext-exec-linux-x64");
    });
});

describe("#894 the host-arch smoke binary is not left behind", () => {
    /** Stand in for the compile: drop a file where the plan says it will be. */
    const compileWritesTheBinary = () => {
        buildVinextExecutable.mockImplementation((opts: VinextBuildOptions) => {
            const out = opts.outFile ?? `knext-exec-${opts.arch}`;
            writeFileSync(join(dir, out), "#!/bin/sh\n");
            return out;
        });
    };

    it("deletes it after a PASSING smoke", async () => {
        hostArch = "darwin-arm64";
        compileWritesTheBinary();
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });

        // ~60-90 MB of scratch that matches neither `.gitignore`'s `knext-exec*`
        // nor the template `.dockerignore`, sitting in the app root.
        expect(existsSync(join(dir, "knext-smoke-darwin-arm64"))).toBe(false);
        // The SHIP binary is the build's product and must survive — the other
        // half, without which "delete the binary" could pass by deleting both.
        expect(existsSync(join(dir, "knext-exec-linux-x64"))).toBe(true);
    });

    it("deletes it after a FAILING smoke too", async () => {
        hostArch = "darwin-arm64";
        compileWritesTheBinary();
        loadConfig.mockResolvedValue(cfg());
        runPostCompileSmoke.mockRejectedValue(
            new PostCompileSmokeError("health", "no health route", 4242),
        );

        await build({ skipNextBuild: true }).catch(() => {});
        // This is the case that matters: a developer iterating on a broken entry
        // runs the failing build repeatedly.
        expect(existsSync(join(dir, "knext-smoke-darwin-arm64"))).toBe(false);
    });

    it("never deletes the ship binary when it IS the smoke binary", async () => {
        hostArch = "linux-x64";
        compileWritesTheBinary();
        loadConfig.mockResolvedValue(cfg());
        await build({ skipNextBuild: true });
        expect(existsSync(join(dir, "knext-exec-linux-x64"))).toBe(true);
    });
});

describe("#894 the smoke runs a HOST-arch binary", () => {
    it("reuses the ship binary only when the host IS the ship target", () => {
        const same = smokeBinaryPlan("linux-x64", "linux-x64");
        expect(same.reuseShipBinary).toBe(true);
        expect(same.arch).toBe("linux-x64");

        // A darwin developer's ship binary is a linux musl executable that this
        // machine cannot exec at all, so the smoke gets its own compile.
        const cross = smokeBinaryPlan("linux-x64", "darwin-arm64");
        expect(cross.reuseShipBinary).toBe(false);
        expect(cross.arch).toBe("darwin-arm64");
        expect(cross.outFile).not.toBe(same.outFile);
        // Never named after a runtime — the asset-root resolver classifies a
        // compiled binary by basename.
        expect(cross.outFile).not.toMatch(/(^|[^a-z])bun([^a-z]|$)/);
        expect(cross.outFile).not.toMatch(/(^|[^a-z])node([^a-z]|$)/);
    });

    it("picks a glibc target on a glibc linux host, musl on musl", () => {
        // The ship target is `bun-linux-x64-musl`, which a glibc host cannot
        // execute — so a smoke that reused the ship arch on linux would report
        // a boot failure for every correct build on a Debian/Ubuntu runner.
        expect(hostSmokeArch("linux", "x64", () => "gnu")).toBe(
            "linux-x64-gnu",
        );
        expect(hostSmokeArch("linux", "x64", () => "musl")).toBe("linux-x64");
        expect(hostSmokeArch("linux", "arm64", () => "gnu")).toBe(
            "linux-arm64-gnu",
        );
        expect(hostSmokeArch("darwin", "arm64")).toBe("darwin-arm64");
        expect(hostSmokeArch("darwin", "x64")).toBe("darwin-x64");
    });

    it("refuses a host it cannot compile for rather than guessing", () => {
        expect(() => hostSmokeArch("win32", "x64")).toThrow(/smoke/i);
        expect(() => hostSmokeArch("linux", "ppc64")).toThrow(/smoke/i);
    });

    it("every host arch it can return is a REAL compile target", () => {
        const { compileArgv } = __knextRealVinext;
        for (const arch of [
            "linux-x64",
            "linux-x64-gnu",
            "linux-arm64",
            "linux-arm64-gnu",
            "darwin-arm64",
            "darwin-x64",
        ]) {
            const argv = compileArgv(arch, "e.mjs", "out");
            const target = argv[argv.indexOf("--target") + 1];
            expect(target, `${arch} must map to a bun target`).toMatch(
                /^bun-(linux|darwin)-(x64|arm64)(-musl)?$/,
            );
            // The `-gnu` keys exist precisely BECAUSE they are not musl; the
            // bare linux keys stay musl (the alpine image ships them). darwin
            // has no libc variants at all.
            if (arch.startsWith("linux")) {
                expect(target.endsWith("-musl")).toBe(!arch.endsWith("-gnu"));
            }
        }
    });
});
