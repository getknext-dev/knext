/**
 * The vinext → single-executable build path (ADR-0048).
 *
 * `kn-next build` previously ran only the app's `npm run build` and looked for
 * `.next/standalone`. ADR-0048 makes `build: vinext` + `runtime: bun` the only
 * supported target, so the CLI has to be able to PRODUCE that artifact rather
 * than merely describe where it lands.
 *
 * Two steps, mirroring `examples/bun-exec/build.sh`, which is the recipe this
 * was measured against:
 *
 *   1. `vite build`  — vinext emits a nitro **bun-preset** `.output`, entry
 *                      `.output/server/index.mjs`.
 *   2. `bun build --compile --minify --bytecode --target=<t>` — bakes that
 *      entry, every route it reaches, and V8 bytecode into one executable.
 *
 * The bytecode flag is not optional here and is the reason for the measured
 * cold start: 61 ms median against node-standalone's 884 ms on an identical
 * app (`docs/benchmarks/vinext-bun14-single-exec-2026-08-27.md`).
 *
 * ## The Bun floor is 1.4.0, and it is a floor rather than a preference
 *
 * Measured, both directions:
 *   - Bun 1.3.5 compiles a working binary but is **2× slower to cold start**
 *     (121 ms vs 61 ms) on the same source.
 *   - Bun 1.3.5 cannot serve a Next standalone tree at all (HTTP 500,
 *     `Expected CommonJS module to have a function`), which is why the retired
 *     `runtime: bun` + turbopack combination was never viable on it.
 *
 * So the build refuses to run under < 1.4.0 rather than silently producing a
 * slower artifact whose provenance nobody records.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuiet } from "./exec";
import { findLockfile, writeNativeIntegrityManifest } from "./native-integrity";
import { UsageError } from "./shared";

/** The first Bun that ADR-0048 accepts. See the docstring for the measurements. */
export const MIN_BUN_MAJOR = 1;
export const MIN_BUN_MINOR = 4;

/**
 * `bun build --compile` target triples, keyed by knext's arch names.
 *
 * The bare `linux-*` keys are MUSL, because that is what the shipped image is
 * (`FROM alpine` + `apk add libstdc++ libgcc` — see the reference Dockerfile and
 * `alpine-image.docker-e2e.test.ts`). The `-gnu` keys exist only for the
 * post-compile smoke (#894): those binaries are dynamically linked against musl
 * and a glibc host cannot execute them at all, so a smoke on a Debian/Ubuntu
 * runner has to compile against glibc or it would report a boot failure for
 * every CORRECT build. Nothing SHIPS a `-gnu` binary.
 */
const COMPILE_TARGETS: Record<string, string> = {
    "linux-x64": "bun-linux-x64-musl",
    "linux-arm64": "bun-linux-arm64-musl",
    "linux-x64-gnu": "bun-linux-x64",
    "linux-arm64-gnu": "bun-linux-arm64",
    "darwin-arm64": "bun-darwin-arm64",
    "darwin-x64": "bun-darwin-x64",
};

/** Smoke-only, glibc-linked: never put one of these in the alpine image. */
const SMOKE_ONLY_ARCHES = ["linux-x64-gnu", "linux-arm64-gnu"] as const;

/** Derived, never a second hand-maintained list — the two must stay disjoint. */
const SHIPPABLE_ARCHES = Object.keys(COMPILE_TARGETS).filter(
    (a) => !SMOKE_ONLY_ARCHES.includes(a as (typeof SMOKE_ONLY_ARCHES)[number]),
);

/**
 * `major.minor` of a Bun version string, or undefined if unreadable.
 *
 * Leading digits only, so a prerelease (`1.4.0-canary.x`) reads as 1.4 — a
 * canary of a release that carries the fix does carry it. NUMERIC compare:
 * `"1.10.0" < "1.4.0"` lexically, and a string comparison would reject a newer
 * Bun forever.
 */
export function parseBunVersion(
    version: string,
): { major: number; minor: number } | undefined {
    const m = /^(\d+)\.(\d+)/.exec(version.trim());
    if (!m) return undefined;
    return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Does this Bun meet ADR-0048's floor? Unparseable is NOT accepted. */
export function bunMeetsFloor(version: string): boolean {
    const v = parseBunVersion(version);
    if (!v) return false;
    if (v.major !== MIN_BUN_MAJOR) return v.major > MIN_BUN_MAJOR;
    return v.minor >= MIN_BUN_MINOR;
}

/**
 * The `bun build --compile` argv for this target and entry.
 *
 * Exported so a test can assert the flags rather than trusting prose: dropping
 * `--bytecode` would still produce a working binary, just a slow one, and that
 * is exactly the regression nobody would notice without an assertion.
 */
export function compileArgv(
    arch: string,
    entry: string,
    outFile: string,
): string[] {
    const target = COMPILE_TARGETS[arch];
    if (!target) {
        // The two lists are kept APART on purpose. Advertising the `-gnu` keys
        // as buildable invites someone to compile one and put it in the image,
        // where the alpine base has no glibc and it cannot run at all — the
        // exact class of failure the alpine e2e exists to catch. They are
        // reachable only through `hostSmokeArch()`.
        throw new UsageError(
            `Unknown build arch '${arch}'. Shippable targets: ${SHIPPABLE_ARCHES.join(", ")}.\n\n` +
                `(${SMOKE_ONLY_ARCHES.join(", ")} also compile, but exist ONLY for the post-compile smoke's\n` +
                "host-arch binary — they are glibc-linked and the shipped alpine image cannot run them.)",
        );
    }
    // `bun run <script>`, not `bun build`. The compile needs BUILD PLUGINS and
    // the CLI has no `--plugin`:
    //
    //   - `--bytecode` emits CommonJS, where the nitro bundle's `import.meta` is
    //     a syntax error — the bare command fails with `Failed to generate
    //     bytecode for ./index.js`;
    //   - sharp's native addon cannot be resolved from inside a compiled binary,
    //     so its loader is swapped for a `process.dlopen` shim. Without that,
    //     `/_next/image` silently serves unoptimized originals.
    //
    // The script ships in this package, so a user's `kn-next build` gets the same
    // treatment knext's own reference app does rather than a second copy that
    // drifts.
    return [
        "bun",
        "run",
        compileScriptPath(),
        "--entry",
        entry,
        "--outfile",
        outFile,
        "--target",
        target,
    ];
}

/**
 * The shipped compile script, resolved from THIS module rather than by package
 * name: the CLI is bundled to `dist/cli/`, and the script sits in
 * `dist/adapters/`, so a bare specifier would resolve against the consumer's
 * tree instead of ours.
 */
export function compileScriptPath(): string {
    return join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "adapters",
        "vinext-compile.js",
    );
}

/** glibc or musl, for a linux host. Injectable so both branches are testable. */
export type LinuxLibc = "gnu" | "musl";

/**
 * Which libc this linux host runs.
 *
 * `process.report` carries `glibcVersionRuntime` on a glibc build and omits it
 * on musl — the same signal node's own `detect-libc` consumers use. The
 * loader-path fallback covers a runtime that does not expose the report.
 */
export function detectLinuxLibc(): LinuxLibc {
    try {
        const report = process.report?.getReport();
        const header =
            typeof report === "object" && report !== null
                ? (report as { header?: { glibcVersionRuntime?: string } })
                      .header
                : undefined;
        if (header?.glibcVersionRuntime) return "gnu";
    } catch {
        // fall through to the loader probe
    }
    const muslLoaders = [
        "/lib/ld-musl-x86_64.so.1",
        "/lib/ld-musl-aarch64.so.1",
    ];
    return muslLoaders.some((p) => existsSync(p)) ? "musl" : "gnu";
}

/**
 * The arch key whose binary THIS machine can actually execute (#894).
 *
 * The smoke has to boot the thing it just compiled, and the ship target is
 * `bun-linux-*-musl` — unrunnable on a darwin host and on a glibc linux host
 * alike. Rather than a container run (which would put docker on the critical
 * path of every build), the smoke compiles a second, HOST-arch binary and boots
 * that; the cross-compiled linux-musl artifact stays proved by the alpine
 * container e2e, which is where a cross-target claim belongs.
 *
 * Throws rather than guessing on an unsupported host: a wrong guess produces a
 * binary that cannot exec, which the smoke would then report as a broken app.
 */
export function hostSmokeArch(
    platform: string = process.platform,
    arch: string = process.arch,
    libc: () => LinuxLibc = detectLinuxLibc,
): string {
    const key =
        platform === "darwin"
            ? `darwin-${arch}`
            : platform === "linux"
              ? libc() === "musl"
                  ? `linux-${arch}`
                  : `linux-${arch}-gnu`
              : "";
    if (!key || !COMPILE_TARGETS[key]) {
        throw new UsageError(
            `The post-compile smoke cannot run on ${platform}/${arch} — knext has no bun compile target for it.\n\n` +
                `Known targets: ${Object.keys(COMPILE_TARGETS).join(", ")}.\n` +
                "Pass --skip-smoke to build anyway; the binary will be UNVERIFIED.",
        );
    }
    return key;
}

/** What the smoke should boot: the ship binary itself, or a host-arch twin. */
export interface SmokeBinaryPlan {
    readonly arch: string;
    readonly outFile: string;
    readonly reuseShipBinary: boolean;
}

/**
 * Reuse the ship binary when the host IS the ship target, else plan a second
 * compile. The second compile costs seconds and is the price of booting the
 * artifact at all on a developer machine; reusing it when the arch matches
 * keeps the linux-musl CI path down to one.
 *
 * The name never contains a runtime word (`bun`, `node`): the asset-root
 * resolver classifies a compiled binary by basename, and those names make it
 * read the BUILD TREE's assets silently.
 */
export function smokeBinaryPlan(
    shipArch: string,
    hostArch: string,
): SmokeBinaryPlan {
    if (shipArch === hostArch) {
        return {
            arch: shipArch,
            outFile: `knext-exec-${shipArch}`,
            reuseShipBinary: true,
        };
    }
    return {
        arch: hostArch,
        outFile: `knext-smoke-${hostArch}`,
        reuseShipBinary: false,
    };
}

export interface VinextBuildOptions {
    /** App root. */
    readonly cwd: string;
    /** Target arch; defaults to the ship target. */
    readonly arch?: string;
    /** Output binary path, relative to cwd. */
    readonly outFile?: string;
    /** Injectable for tests; the real runner inherits stderr. */
    readonly run?: (argv: readonly string[]) => void;
    /** Injectable for tests. */
    readonly bunVersion?: string;
    /**
     * Skip step 1 (`vite build`) and compile an EXISTING `.output`. The caller
     * that sets this is `kn-next build`, which has just run the app's own
     * build script — running vite twice would double the slowest part of the
     * build for nothing. The `.output` existence check still runs either way.
     */
    readonly skipViteBuild?: boolean;
}

/**
 * Run the two-step vinext build. Returns the produced binary's path.
 *
 * Never names the output after a runtime (`bun`, `node`, …): the asset-root
 * resolver classifies a compiled binary by basename, so those names make it
 * read the BUILD TREE's assets silently.
 */
export function buildVinextExecutable(opts: VinextBuildOptions): string {
    const run = opts.run ?? runQuiet;
    const arch = opts.arch ?? "linux-x64";
    const outFile = opts.outFile ?? `knext-exec-${arch}`;

    const version = opts.bunVersion ?? detectBunVersion(run);
    if (!bunMeetsFloor(version)) {
        throw new UsageError(
            `The vinext single-executable target requires Bun ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0 or newer; found '${version}'.\n\n` +
                "Bun 1.3.x compiles a binary that boots roughly twice as slowly (121ms vs 61ms measured),\n" +
                "so knext refuses it rather than shipping a slower artifact silently. Upgrade with `bun upgrade`.",
        );
    }

    // 1. vinext → nitro bun-preset .output
    if (!opts.skipViteBuild) {
        run(["npx", "vite", "build"]);
    }

    const entry = join(".output", "server", "index.mjs");
    if (!existsSync(join(opts.cwd, entry))) {
        throw new UsageError(
            `The vinext build finished but '${entry}' is not there.\n\n` +
                "That entry is what gets compiled into the executable, so the image would have nothing to run.\n" +
                "Check that this app's vite config uses the nitro bun preset.",
        );
    }

    // 2. compile + bytecode
    run(compileArgv(arch, entry, outFile));

    // 3. stage sharp's native module beside the binary
    stageSharpNative(opts.cwd);

    return outFile;
}

/**
 * Copy sharp's native packages to `<cwd>/native`, which the generated Dockerfile
 * COPYs into the image.
 *
 * A compiled binary cannot resolve a package from disk, so sharp's addon has to
 * be a real file next to the executable, opened by absolute path. Without it
 * `/_next/image` answers 200 with the ORIGINAL bytes — working, and every image
 * full size, which is the kind of failure nobody reports.
 *
 * The directory is created even when the app has no sharp, because the
 * Dockerfile's `COPY native` would otherwise fail the build for every app that
 * does not use `next/image`.
 *
 * Whatever lands here is then PINNED — every staged `@img` package checked
 * against the app's `bun.lock` and every staged file hashed into
 * `native/.integrity.json`, which the dlopen shim re-checks in the image. This
 * copy is otherwise an unguarded path from the install store to native-code
 * privilege, and the closure SBOM does not cover `/app/native`.
 *
 * Everything present is copied rather than a per-platform pair: the package
 * manager installs only the optional packages matching this platform, so what is
 * there IS the right set — and mirroring sharp's own naming scheme here would be
 * a guess. (It is `linuxmusl`, one word, which is exactly the guess that failed.)
 */
export function stageSharpNative(cwd: string): void {
    const dest = join(cwd, "native");
    mkdirSync(dest, { recursive: true });

    const source = findImgPackages(cwd);
    if (source) {
        // `dereference` follows the symlinks a bun/pnpm isolated store uses;
        // copying the links would put dangling pointers in the image.
        cpSync(source, dest, { recursive: true, dereference: true });
    }

    // Unconditional, including the empty case: a `native/` with no manifest is
    // indistinguishable from one whose manifest was stripped, and the shim reads
    // absence as "legacy image, load unverified".
    writeNativeIntegrityManifest(dest, findLockfile(cwd));
}

/** `node_modules/@img`, wherever this install layout put it. */
function findImgPackages(cwd: string): string | undefined {
    const candidates = [
        join(cwd, "node_modules", "@img"),
        // bun's isolated store, and the workspace root above an app.
        join(cwd, "node_modules", ".bun", "node_modules", "@img"),
        join(cwd, "..", "..", "node_modules", "@img"),
        join(cwd, "..", "..", "node_modules", ".bun", "node_modules", "@img"),
    ];
    return candidates.find((c) => existsSync(c));
}

/** Reads `bun --version`. Separate so the floor check is testable without a Bun. */
function detectBunVersion(run: (argv: readonly string[]) => void): string {
    // `runQuiet` does not capture stdout, so shell the version into a file-free
    // read via execFileSync in the caller when a real detection is needed. The
    // default path here keeps the seam explicit rather than pretending.
    void run;
    try {
        // Lazily required so tests that inject `bunVersion` never spawn.
        const { execFileSync } =
            require("node:child_process") as typeof import("node:child_process");
        return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    } catch {
        throw new UsageError(
            "The vinext single-executable target needs `bun` on PATH (https://bun.sh), and it was not found.",
        );
    }
}
